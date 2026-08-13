import { Hono } from 'hono';
import { authMiddleware } from '../middlewares/auth';
import { rateLimit } from '../middlewares/rate-limit';
import { successResponse, errorResponse } from '../utils/response';
import { parseMedicalRecordFromImage } from '../services/ai';
import { standardRecordToLegacyOcr } from '../services/medical-record/vision-parse';
import { LlmRateLimitError } from '../services/llm/provider';

const ai = new Hono();

ai.use('*', authMiddleware);

/** POST /ai/medical-vision — Groq VLM parse to standard medical record JSON */
ai.post('/medical-vision', rateLimit({ keyPrefix: 'ai-vision', limit: 15 }), async (c) => {
  try {
    const userId = c.get('userId') as number;
    const body = await c.req.json() as { imageBase64?: string; mimeType?: string };

    if (!body.imageBase64?.trim()) {
      return errorResponse(c, 'imageBase64 wajib diisi');
    }

    const parsed = await parseMedicalRecordFromImage(
      userId,
      body.imageBase64,
      body.mimeType ?? 'image/jpeg'
    );

    return successResponse(c, {
      standard: parsed,
      legacy: standardRecordToLegacyOcr(parsed),
    });
  } catch (err) {
    console.error('Medical vision error:', err);
    if (err instanceof LlmRateLimitError) {
      return errorResponse(c, err.message, 429);
    }
    return errorResponse(
      c,
      err instanceof Error ? err.message : 'Gagal memparse dokumen medis',
      500
    );
  }
});

/** POST /ai/ocr — alias for mobile backward compatibility */
ai.post('/ocr', rateLimit({ keyPrefix: 'ai-vision', limit: 15 }), async (c) => {
  try {
    const userId = c.get('userId') as number;
    const body = await c.req.json() as { imageBase64?: string; mimeType?: string };

    if (!body.imageBase64?.trim()) {
      return errorResponse(c, 'imageBase64 wajib diisi');
    }

    const parsed = await parseMedicalRecordFromImage(
      userId,
      body.imageBase64,
      body.mimeType ?? 'image/jpeg'
    );

    return successResponse(c, standardRecordToLegacyOcr(parsed));
  } catch (err) {
    console.error('AI OCR/vision error:', err);
    if (err instanceof LlmRateLimitError) {
      return errorResponse(c, err.message, 429);
    }
    return errorResponse(
      c,
      err instanceof Error ? err.message : 'Gagal memparse dokumen medis',
      500
    );
  }
});

export default ai;
