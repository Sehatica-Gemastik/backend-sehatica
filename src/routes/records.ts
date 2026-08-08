import { Hono } from 'hono';
import { db } from '../db';
import { medicalRecords } from '../db/schema';
import { eq, desc, and } from 'drizzle-orm';
import { authMiddleware } from '../middlewares/auth';
import { successResponse, errorResponse } from '../utils/response';
import { ocrMedicalDocument, summarizeMedicalRecord } from '../services/ai';

const records = new Hono();

// All routes require auth
records.use('*', authMiddleware);

// GET /records — list user's medical records
records.get('/', async (c) => {
  try {
    const userId = c.get('userId') as number;
    const type = c.req.query('type');

    const where = type
      ? and(eq(medicalRecords.userId, userId), eq(medicalRecords.type, type as any))
      : eq(medicalRecords.userId, userId);

    const list = await db.query.medicalRecords.findMany({
      where,
      orderBy: [desc(medicalRecords.createdAt)],
    });

    return successResponse(c, list);
  } catch (err) {
    console.error(err);
    return errorResponse(c, 'Gagal mengambil rekam medis', 500);
  }
});

// GET /records/:id — get single record
records.get('/:id', async (c) => {
  try {
    const userId = c.get('userId') as number;
    const id = parseInt(c.req.param('id'));

    const record = await db.query.medicalRecords.findFirst({
      where: and(eq(medicalRecords.id, id), eq(medicalRecords.userId, userId)),
    });

    if (!record) return errorResponse(c, 'Rekam medis tidak ditemukan', 404);
    return successResponse(c, record);
  } catch {
    return errorResponse(c, 'Terjadi kesalahan server', 500);
  }
});

// POST /records — create text/note record
records.post('/', async (c) => {
  try {
    const userId = c.get('userId') as number;
    const body = await c.req.json();
    const { type, title, content, tags, doctorName, recordDate } = body;

    if (!type || !title) {
      return errorResponse(c, 'Tipe dan judul wajib diisi');
    }

    let summary = body.summary;
    if (content && !summary) {
      try {
        summary = await summarizeMedicalRecord(content, type);
      } catch {
        summary = null;
      }
    }

    const [record] = await db.insert(medicalRecords).values({
      userId,
      type,
      title,
      content: content ?? null,
      summary,
      tags: tags ?? [],
      doctorName: doctorName ?? null,
      recordDate: recordDate ?? null,
      isAiSummarized: !!summary,
    }).returning();

    return successResponse(c, record, 201);
  } catch (err) {
    console.error(err);
    return errorResponse(c, 'Gagal menyimpan rekam medis', 500);
  }
});

// POST /records/ocr — OCR image and create record
records.post('/ocr', async (c) => {
  try {
    const userId = c.get('userId') as number;

    // Support both JSON (base64) and FormData
    const contentType = c.req.header('Content-Type') ?? '';

    let imageBase64: string;
    let mimeType = 'image/jpeg';

    if (contentType.includes('application/json')) {
      const body = await c.req.json();
      imageBase64 = body.imageBase64;
      mimeType = body.mimeType ?? 'image/jpeg';
    } else if (contentType.includes('multipart/form-data')) {
      const formData = await c.req.formData();
      const file = formData.get('file') as File;
      if (!file) return errorResponse(c, 'File gambar diperlukan');
      const arrayBuffer = await file.arrayBuffer();
      imageBase64 = Buffer.from(arrayBuffer).toString('base64');
      mimeType = file.type || 'image/jpeg';
    } else {
      return errorResponse(c, 'Content-Type tidak didukung');
    }

    if (!imageBase64) {
      return errorResponse(c, 'Data gambar diperlukan');
    }

    // Run OCR via Gemini Vision
    const ocrResult = await ocrMedicalDocument(imageBase64, mimeType);

    // Save record
    const [record] = await db.insert(medicalRecords).values({
      userId,
      type: 'image',
      title: ocrResult.title,
      content: ocrResult.extractedText,
      summary: ocrResult.summary,
      tags: ocrResult.tags,
      isAiSummarized: true,
    }).returning();

    return successResponse(c, record, 201);
  } catch (err) {
    console.error('OCR error:', err);
    return errorResponse(c, 'Gagal memproses gambar', 500);
  }
});

// POST /records/voice — create voice record with transcription text
records.post('/voice', async (c) => {
  try {
    const userId = c.get('userId') as number;
    const body = await c.req.json();
    const { title, transcription, durationSeconds } = body;

    if (!title) return errorResponse(c, 'Judul diperlukan');

    let summary = null;
    if (transcription) {
      try {
        summary = await summarizeMedicalRecord(transcription, 'voice');
      } catch { /* skip */ }
    }

    const detail = durationSeconds
      ? `Durasi: ${Math.floor(durationSeconds / 60)}:${String(durationSeconds % 60).padStart(2, '0')} menit`
      : 'Rekaman suara';

    const [record] = await db.insert(medicalRecords).values({
      userId,
      type: 'voice',
      title,
      content: transcription ?? detail,
      summary: summary ?? detail,
      tags: ['Rekaman', 'Suara'],
      isAiSummarized: !!summary,
    }).returning();

    return successResponse(c, record, 201);
  } catch {
    return errorResponse(c, 'Terjadi kesalahan server', 500);
  }
});

// DELETE /records/:id
records.delete('/:id', async (c) => {
  try {
    const userId = c.get('userId') as number;
    const id = parseInt(c.req.param('id'));

    const record = await db.query.medicalRecords.findFirst({
      where: and(eq(medicalRecords.id, id), eq(medicalRecords.userId, userId)),
    });
    if (!record) return errorResponse(c, 'Rekam medis tidak ditemukan', 404);

    await db.delete(medicalRecords).where(eq(medicalRecords.id, id));
    return successResponse(c, { deleted: true });
  } catch {
    return errorResponse(c, 'Terjadi kesalahan server', 500);
  }
});

export default records;
