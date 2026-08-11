import { Hono } from 'hono';
import { authMiddleware } from '../middlewares/auth';
import { chatWithHeallyTransient } from '../services/gemini';
import { errorResponse, successResponse } from '../utils/response';

const heallyRoutes = new Hono();

heallyRoutes.use('*', authMiddleware);

// POST /heally/chat — Heally AI Chat
heallyRoutes.post('/chat', async (c) => {
  try {
    const userId = c.get('userId');
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object') return errorResponse(c, 'Data percakapan tidak valid');

    const message = typeof body.message === 'string' ? body.message.trim() : '';
    const askId = typeof body.askId === 'string' ? body.askId.trim() : null;

    if (!message) return errorResponse(c, 'Pesan tidak boleh kosong');

    const result = await chatWithHeallyTransient({
      message,
      conversationTail: [],
      healthContext: {},
      locale: 'id-ID',
      timezone: 'Asia/Jakarta',
    });

    const now = new Date().toISOString();
    return successResponse(c, {
      userMessage: {
        id: Date.now(),
        userId,
        role: 'user',
        content: message,
        needsVerif: false,
        safetyLevel: 'general',
        safetyReasons: [],
        verifStatus: null,
        verifDoctorName: null,
        verifNote: null,
        fromWhatsApp: false,
        askId,
        createdAt: now,
      },
      aiMessage: {
        id: Date.now() + 1,
        userId,
        role: 'assistant',
        content: result.content,
        needsVerif: result.verificationRecommended,
        safetyLevel: result.safety.level,
        safetyReasons: result.safety.reasons,
        verifStatus: null,
        verifDoctorName: null,
        verifNote: null,
        fromWhatsApp: false,
        askId,
        createdAt: now,
      },
      verifRequest: null,
      llm: { provider: 'google', model: 'gemini-2.0-flash' },
    });
  } catch (err) {
    console.error('Heally chat error:', err);
    return errorResponse(c, 'Gagal menghubungi Heally AI', 500);
  }
});

// GET /heally/asks/pending — Pending proactive asks
heallyRoutes.get('/asks/pending', async (c) => {
  return successResponse(c, []);
});

// POST /heally/asks/trigger — Trigger proactive ask
heallyRoutes.post('/asks/trigger', async (c) => {
  return successResponse(c, { delivered: false, reason: 'no_trigger' });
});

// POST /heally/asks/:askId/ack — Acknowledge ask
heallyRoutes.post('/asks/:askId/ack', async (c) => {
  const askId = c.req.param('askId');
  return successResponse(c, { id: askId, status: 'replied' });
});

// POST /heally/verif-request/:messageId — Verify request
heallyRoutes.post('/verif-request/:messageId', async (c) => {
  return successResponse(c, { success: true });
});

export default heallyRoutes;
