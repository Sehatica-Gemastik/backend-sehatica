import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { authMiddleware } from '../middlewares/auth';
import { successResponse, errorResponse } from '../utils/response';
import {
  chatWithHeallyTransient,
  generateScheduleFromContext,
  ocrMedicalDocument,
} from '../services/gemini';

const ai = new Hono();

ai.use('*', authMiddleware);

ai.post('/chat', bodyLimit({
  maxSize: 64 * 1024,
  onError: (c) => errorResponse(c, 'Konteks percakapan terlalu besar', 413),
}), async (c) => {
  try {
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) return errorResponse(c, 'Payload percakapan tidak valid', 422);
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    const locale = typeof body.locale === 'string' ? body.locale.trim() : '';
    const timezone = typeof body.timezone === 'string' ? body.timezone.trim() : '';
    const tail = Array.isArray(body.conversationTail) ? body.conversationTail : [];
    const healthContext = body.healthContext && typeof body.healthContext === 'object'
      ? body.healthContext
      : {};
    const contextLength = JSON.stringify(healthContext).length;

    if (
      !message || message.length > 2_000 ||
      !locale || locale.length > 20 ||
      !timezone || timezone.length > 80 ||
      tail.length > 12 || contextLength > 12_000
    ) {
      return errorResponse(c, 'Konteks percakapan tidak valid', 422);
    }

    const conversationTail: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    for (const value of tail) {
      if (!value || typeof value !== 'object') return errorResponse(c, 'Riwayat percakapan tidak valid', 422);
      const item = value as Record<string, unknown>;
      if (
        !['user', 'assistant'].includes(String(item.role)) ||
        typeof item.content !== 'string' ||
        !item.content.trim() ||
        item.content.length > 4_000
      ) {
        return errorResponse(c, 'Riwayat percakapan tidak valid', 422);
      }
      conversationTail.push({
        role: item.role as 'user' | 'assistant',
        content: item.content.trim(),
      });
    }

    return successResponse(c, await chatWithHeallyTransient({
      message,
      conversationTail,
      healthContext,
      locale,
      timezone,
    }));
  } catch {
    console.error('Heally chat request failed');
    return errorResponse(c, 'Gagal menghubungi Heally AI', 500);
  }
});

ai.post('/schedules/generate', bodyLimit({
  maxSize: 64 * 1024,
  onError: (c) => errorResponse(c, 'Konteks jadwal terlalu besar', 413),
}), async (c) => {
  try {
    const body = await c.req.json() as Record<string, unknown>;
    const date = typeof body.date === 'string' ? body.date : '';
    const timezone = typeof body.timezone === 'string' ? body.timezone.trim() : '';
    const healthContext = typeof body.healthContext === 'string' ? body.healthContext.trim() : '';
    const rawMedications = Array.isArray(body.explicitMedicationInstructions)
      ? body.explicitMedicationInstructions
      : [];

    const parsedDate = new Date(`${date}T00:00:00Z`);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      Number.isNaN(parsedDate.getTime()) ||
      parsedDate.toISOString().slice(0, 10) !== date
    ) {
      return errorResponse(c, 'Tanggal jadwal tidak valid', 422);
    }
    if (!timezone || timezone.length > 80 || healthContext.length > 6_000 || rawMedications.length > 20) {
      return errorResponse(c, 'Konteks jadwal tidak valid', 422);
    }

    const explicitMedicationInstructions: Array<{ label: string; detail: string | null; time: string }> = [];
    for (const value of rawMedications) {
      if (!value || typeof value !== 'object') return errorResponse(c, 'Instruksi obat tidak valid', 422);
      const medication = value as Record<string, unknown>;
      if (
        typeof medication.label !== 'string' || !medication.label.trim() || medication.label.length > 120 ||
        typeof medication.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(medication.time) ||
        (medication.detail != null && (typeof medication.detail !== 'string' || medication.detail.length > 300))
      ) {
        return errorResponse(c, 'Instruksi obat tidak valid', 422);
      }
      explicitMedicationInstructions.push({
        label: medication.label.trim(),
        detail: typeof medication.detail === 'string' ? medication.detail.trim() || null : null,
        time: medication.time,
      });
    }

    const generated = await generateScheduleFromContext({
      date,
      timezone,
      healthContext,
      explicitMedicationInstructions,
    });
    if (generated.items.length === 0) {
      return errorResponse(c, 'AI tidak menghasilkan jadwal yang aman', 422);
    }
    return successResponse(c, generated);
  } catch {
    console.error('Schedule generation failed');
    return errorResponse(c, 'Gagal membuat jadwal AI', 500);
  }
});

// POST /ai/ocr — transient OCR; the mobile app persists the result locally.
ai.post('/ocr', bodyLimit({
  maxSize: 15 * 1024 * 1024,
  onError: (c) => errorResponse(c, 'Payload gambar terlalu besar', 413),
}), async (c) => {
  try {
    const contentType = c.req.header('Content-Type') ?? '';
    let imageBase64: string;
    let mimeType = 'image/jpeg';

    if (contentType.includes('application/json')) {
      const body = await c.req.json();
      imageBase64 = body.imageBase64;
      mimeType = body.mimeType ?? mimeType;
    } else if (contentType.includes('multipart/form-data')) {
      const formData = await c.req.formData();
      const file = formData.get('file');
      if (!(file instanceof File)) return errorResponse(c, 'File gambar diperlukan');
      if (file.size > 10 * 1024 * 1024) {
        return errorResponse(c, 'File gambar terlalu besar', 413);
      }
      imageBase64 = Buffer.from(await file.arrayBuffer()).toString('base64');
      mimeType = file.type || mimeType;
    } else {
      return errorResponse(c, 'Content-Type tidak didukung');
    }

    if (typeof imageBase64 !== 'string' || !imageBase64 || imageBase64.length > 14_000_000) {
      return errorResponse(c, 'Data gambar tidak valid atau terlalu besar', 422);
    }
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) {
      return errorResponse(c, 'Format gambar tidak didukung', 422);
    }

    return successResponse(c, await ocrMedicalDocument(imageBase64, mimeType));
  } catch {
    console.error('OCR request failed');
    return errorResponse(c, 'Gagal memproses gambar', 500);
  }
});

export default ai;
