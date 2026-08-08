import { Hono } from 'hono';
import { db } from '../db';
import { chatMessages, verifRequests } from '../db/schema';
import { eq, asc } from 'drizzle-orm';
import { authMiddleware } from '../middlewares/auth';
import { rateLimit } from '../middlewares/rate-limit';
import { successResponse, errorResponse } from '../utils/response';
import { chatWithHeally } from '../services/gemini';
import { LlmRateLimitError } from '../services/llm/provider';
import { llmConfig, isDummyLlm } from '../config/llm';
import {
  planAndDeliverAsk,
  listPendingAsks,
  acknowledgeAsk,
  rewardAskOnUserReply,
} from '../services/rdsa/ask-planner';
import { seedNotificationArms } from '../scripts/seed-arms';
import { getThinkingDraftSteps } from '../services/heally/context';
import { createVerifForMessage } from '../services/heally/verif-flow';

const heally = new Hono();

heally.use('*', authMiddleware);

// GET /heally/messages — get chat history
heally.get('/messages', async (c) => {
  try {
    const userId = c.get('userId') as number;
    const limit = parseInt(c.req.query('limit') ?? '50');

    const messages = await db.query.chatMessages.findMany({
      where: eq(chatMessages.userId, userId),
      orderBy: [asc(chatMessages.createdAt)],
      limit,
    });

    return successResponse(c, messages);
  } catch {
    return errorResponse(c, 'Gagal mengambil riwayat chat', 500);
  }
});

// GET /heally/thinking-steps — labels for in-flight thinking UI
heally.get('/thinking-steps', (c) => {
  return successResponse(c, { steps: getThinkingDraftSteps() });
});

// GET /heally/llm-status — which provider is active (no secrets)
heally.get('/llm-status', (c) => {
  return successResponse(c, {
    provider: isDummyLlm() ? 'dummy' : llmConfig.provider,
    model: llmConfig.model || (isDummyLlm() ? 'dummy-local' : null),
    rateLimitPerMinute: llmConfig.rateLimitPerMinute,
  });
});

// POST /heally/chat — send message to Heally AI
heally.post('/chat', rateLimit({ keyPrefix: 'heally-chat' }), async (c) => {
  try {
    const userId = c.get('userId') as number;
    const body = await c.req.json();
    const { message, askId } = body as { message?: string; askId?: string };

    if (!message?.trim()) {
      return errorResponse(c, 'Pesan tidak boleh kosong');
    }

    // reward RDSA if this replies to an ask
    await rewardAskOnUserReply(userId, askId ?? null);

    const [userMsg] = await db.insert(chatMessages).values({
      userId,
      role: 'user',
      content: message.trim(),
      needsVerif: false,
      askId: askId ?? null,
    }).returning();

    const history = await db.query.chatMessages.findMany({
      where: eq(chatMessages.userId, userId),
      orderBy: [asc(chatMessages.createdAt)],
      limit: 10,
    });

    const conversationHistory = history
      .slice(0, -1)
      .map((msg) => ({
        role: msg.role === 'user' ? 'user' as const : 'model' as const,
        parts: [{ text: msg.content }],
      }));

    const { content, needsVerif, provider, model, thinkingSummary, thinkingDetail } =
      await chatWithHeally(userId, conversationHistory, message);

    const [aiMsg] = await db.insert(chatMessages).values({
      userId,
      role: 'assistant',
      content,
      needsVerif,
      verifStatus: needsVerif ? 'pending' as const : null,
      thinkingSummary,
      thinkingDetail,
    }).returning();

    let verifRequest = null;
    if (needsVerif) {
      verifRequest = await createVerifForMessage({
        userId,
        messageId: aiMsg.id,
        userQuestion: message,
        aiAnswer: content,
      });
    }

    const savedAi = verifRequest
      ? await db.query.chatMessages.findFirst({ where: eq(chatMessages.id, aiMsg.id) })
      : aiMsg;

    return successResponse(c, {
      userMessage: userMsg,
      aiMessage: savedAi ?? aiMsg,
      verifRequest,
      llm: { provider, model },
    });
  } catch (err) {
    console.error('Chat error:', err);
    if (err instanceof LlmRateLimitError) {
      return errorResponse(c, err.message, 429);
    }
    return errorResponse(c, 'Gagal menghubungi Heally AI. Silakan coba lagi.', 500);
  }
});

// POST /heally/asks/trigger — plan + deliver ask (RDSA) into chat + push payload
heally.post('/asks/trigger', rateLimit({ limit: 10, keyPrefix: 'heally-ask' }), async (c) => {
  try {
    const userId = c.get('userId') as number;
    const body = (await c.req.json().catch(() => ({}))) as {
      forceIntent?: string;
      localHour?: number;
    };

    const delivered = await planAndDeliverAsk(userId, {
      forceIntent: body.forceIntent,
      localHour: body.localHour ?? new Date().getHours(),
    });

    if (!delivered) {
      return successResponse(c, {
        delivered: false,
        reason: 'no_eligible_arm',
      });
    }

    return successResponse(c, {
      delivered: true,
      ask: delivered.ask,
      message: delivered.message,
      notification: delivered.notification,
    });
  } catch (err) {
    console.error('Ask trigger error:', err);
    return errorResponse(c, 'Gagal membuat Heally Ask', 500);
  }
});

// GET /heally/asks/pending — asks waiting for user (mobile polls + shows notif)
heally.get('/asks/pending', async (c) => {
  try {
    const userId = c.get('userId') as number;
    const asks = await listPendingAsks(userId);
    return successResponse(c, asks);
  } catch {
    return errorResponse(c, 'Gagal mengambil asks', 500);
  }
});

// POST /heally/asks/:askId/ack — mark delivered / seen on device
heally.post('/asks/:askId/ack', async (c) => {
  try {
    const userId = c.get('userId') as number;
    const askId = c.req.param('askId');
    const ask = await acknowledgeAsk(userId, askId);
    if (!ask) return errorResponse(c, 'Ask tidak ditemukan', 404);
    return successResponse(c, ask);
  } catch {
    return errorResponse(c, 'Gagal acknowledge ask', 500);
  }
});

// POST /heally/arms/seed — upsert templates from Heally_Message_Templates
heally.post('/arms/seed', async (c) => {
  try {
    const n = await seedNotificationArms();
    return successResponse(c, { upserted: n });
  } catch (err) {
    console.error('Seed arms error:', err);
    return errorResponse(c, 'Gagal seed arms', 500);
  }
});

// POST /heally/verif-request/:messageId — manually request verification for a message
heally.post('/verif-request/:messageId', async (c) => {
  try {
    const userId = c.get('userId') as number;
    const messageId = parseInt(c.req.param('messageId'));

    const message = await db.query.chatMessages.findFirst({
      where: eq(chatMessages.id, messageId),
    });

    if (!message || message.userId !== userId) {
      return errorResponse(c, 'Pesan tidak ditemukan', 404);
    }

    const existingVerif = await db.query.verifRequests.findFirst({
      where: eq(verifRequests.messageId, messageId),
    });

    if (existingVerif) {
      return successResponse(c, existingVerif);
    }

    const userMessages = await db.query.chatMessages.findMany({
      where: eq(chatMessages.userId, userId),
      orderBy: [asc(chatMessages.createdAt)],
    });
    const msgIndex = userMessages.findIndex((m) => m.id === messageId);
    const question = msgIndex > 0 ? userMessages[msgIndex - 1].content : 'Pertanyaan pengguna';

    const verifReq = await createVerifForMessage({
      userId,
      messageId,
      userQuestion: question,
      aiAnswer: message.content,
    });

    return successResponse(c, verifReq, 201);
  } catch {
    return errorResponse(c, 'Terjadi kesalahan server', 500);
  }
});

export default heally;
