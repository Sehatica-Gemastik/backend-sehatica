import { Hono } from 'hono';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db';
import { medicalRecords } from '../db/schema';
import { authMiddleware } from '../middlewares/auth';
import { successResponse, errorResponse } from '../utils/response';
import { resolveRecordFilePath, saveRecordPdf } from '../services/record-files';

const records = new Hono();

records.use('*', authMiddleware);

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

records.get('/:id', async (c) => {
  try {
    const userId = c.get('userId') as number;
    const id = parseInt(c.req.param('id'), 10);

    const record = await db.query.medicalRecords.findFirst({
      where: and(eq(medicalRecords.id, id), eq(medicalRecords.userId, userId)),
    });

    if (!record) return errorResponse(c, 'Rekam medis tidak ditemukan', 404);
    return successResponse(c, record);
  } catch {
    return errorResponse(c, 'Terjadi kesalahan server', 500);
  }
});

/** POST /records — create text/note record (no AI summary) */
records.post('/', async (c) => {
  try {
    const userId = c.get('userId') as number;
    const body = await c.req.json();
    const { type, title, content, tags, doctorName, recordDate } = body;

    if (!type || !title) {
      return errorResponse(c, 'Tipe dan judul wajib diisi');
    }

    const [record] = await db.insert(medicalRecords).values({
      userId,
      type,
      title,
      content: content ?? null,
      summary: body.summary ?? null,
      tags: tags ?? [],
      doctorName: doctorName ?? null,
      recordDate: recordDate ?? null,
      isAiSummarized: false,
    }).returning();

    return successResponse(c, record, 201);
  } catch (err) {
    console.error(err);
    return errorResponse(c, 'Gagal menyimpan rekam medis', 500);
  }
});

/** POST /records/upload — upload PDF from mobile (no AI) */
records.post('/upload', async (c) => {
  try {
    const userId = c.get('userId') as number;
    const body = await c.req.json();
    const title = String(body.title ?? body.fileName ?? 'Dokumen PDF').trim();
    const fileName = String(body.fileName ?? 'document.pdf').trim();
    const mimeType = String(body.mimeType ?? 'application/pdf').trim();
    const fileBase64 = String(body.fileBase64 ?? '').replace(/^data:[^;]+;base64,/, '');

    if (!title) return errorResponse(c, 'Judul wajib diisi');
    if (!fileBase64) return errorResponse(c, 'File PDF wajib diisi');
    if (!mimeType.includes('pdf')) return errorResponse(c, 'Hanya PDF yang didukung');

    const saved = await saveRecordPdf({ userId, fileName, base64: fileBase64 });

    const [record] = await db.insert(medicalRecords).values({
      userId,
      type: 'image',
      title,
      content: null,
      summary: `PDF · ${fileName}`,
      fileUrl: null,
      fileKey: saved.fileKey,
      tags: ['PDF', 'Dokumen'],
      doctorName: null,
      recordDate: new Date().toISOString().slice(0, 10),
      isAiSummarized: false,
    }).returning();

    const fileUrl = `/api/v1/records/${record.id}/file`;
    const [updated] = await db
      .update(medicalRecords)
      .set({ fileUrl })
      .where(eq(medicalRecords.id, record.id))
      .returning();

    return successResponse(c, updated ?? { ...record, fileUrl }, 201);
  } catch (err) {
    console.error('Upload record error:', err);
    return errorResponse(c, 'Gagal mengunggah rekam medis', 500);
  }
});

/** GET /records/:id/file — download owned file */
records.get('/:id/file', async (c) => {
  try {
    const userId = c.get('userId') as number;
    const id = parseInt(c.req.param('id'), 10);
    const record = await db.query.medicalRecords.findFirst({
      where: and(eq(medicalRecords.id, id), eq(medicalRecords.userId, userId)),
    });
    if (!record?.fileKey) return errorResponse(c, 'File tidak ditemukan', 404);

    const fullPath = resolveRecordFilePath(record.fileKey);
    const file = Bun.file(fullPath);
    if (!(await file.exists())) return errorResponse(c, 'File tidak ditemukan', 404);

    return new Response(file, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${record.fileKey}"`,
      },
    });
  } catch (err) {
    console.error(err);
    return errorResponse(c, 'Gagal mengunduh file', 500);
  }
});

records.delete('/:id', async (c) => {
  try {
    const userId = c.get('userId') as number;
    const id = parseInt(c.req.param('id'), 10);

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
