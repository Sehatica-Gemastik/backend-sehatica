import { Hono } from 'hono';
import { db } from '../db';
import { chatMessages, verifRequests } from '../db/schema';
import { eq, asc } from 'drizzle-orm';
import { authMiddleware } from '../middlewares/auth';
import { successResponse, errorResponse } from '../utils/response';
import { chatWithHeally } from '../services/gemini';

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

// POST /heally/chat — send message to Heally AI
heally.post('/chat', async (c) => {
  try {
    const userId = c.get('userId') as number;
    const body = await c.req.json();
    const { message } = body;

    if (!message?.trim()) {
      return errorResponse(c, 'Pesan tidak boleh kosong');
    }

    // Save user message
    const [userMsg] = await db.insert(chatMessages).values({
      userId,
      role: 'user',
      content: message.trim(),
      needsVerif: false,
    }).returning();

    // Get recent conversation history (last 10 pairs = 20 messages)
    const history = await db.query.chatMessages.findMany({
      where: eq(chatMessages.userId, userId),
      orderBy: [asc(chatMessages.createdAt)],
      limit: 20,
    });

    // Build Gemini-format conversation (exclude the latest user message)
    const conversationHistory = history
      .slice(0, -1) // exclude the one we just inserted
      .map((msg) => ({
        role: msg.role === 'user' ? 'user' as const : 'model' as const,
        parts: [{ text: msg.content }],
      }));

    // Get AI response
    const { content, needsVerif } = await chatWithHeally(userId, conversationHistory, message);

    // Save AI response
    const [aiMsg] = await db.insert(chatMessages).values({
      userId,
      role: 'assistant',
      content,
      needsVerif,
      verifStatus: needsVerif ? 'pending' as any : null,
    }).returning();

    // If needs verif, create a verif request automatically
    let verifRequest = null;
    if (needsVerif) {
      [verifRequest] = await db.insert(verifRequests).values({
        messageId: aiMsg.id,
        userId,
        userQuestion: message,
        aiAnswer: content,
        status: 'pending',
      }).returning();

      // Update message with verif status
      await db.update(chatMessages).set({ verifStatus: 'pending' }).where(eq(chatMessages.id, aiMsg.id));
    }

    return successResponse(c, {
      userMessage: userMsg,
      aiMessage: { ...aiMsg, verifStatus: needsVerif ? 'pending' : null },
      verifRequest,
    });
  } catch (err) {
    console.error('Chat error:', err);
    return errorResponse(c, 'Gagal menghubungi Heally AI. Silakan coba lagi.', 500);
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

    // Check if verif request already exists
    const existingVerif = await db.query.verifRequests.findFirst({
      where: eq(verifRequests.messageId, messageId),
    });

    if (existingVerif) {
      return successResponse(c, existingVerif);
    }

    // Find the preceding user message as "question"
    const userMessages = await db.query.chatMessages.findMany({
      where: eq(chatMessages.userId, userId),
      orderBy: [asc(chatMessages.createdAt)],
    });
    const msgIndex = userMessages.findIndex((m) => m.id === messageId);
    const question = msgIndex > 0 ? userMessages[msgIndex - 1].content : 'Pertanyaan pengguna';

    const [verifReq] = await db.insert(verifRequests).values({
      messageId,
      userId,
      userQuestion: question,
      aiAnswer: message.content,
      status: 'pending',
    }).returning();

    await db.update(chatMessages)
      .set({ needsVerif: true, verifStatus: 'pending' })
      .where(eq(chatMessages.id, messageId));

    return successResponse(c, verifReq, 201);
  } catch {
    return errorResponse(c, 'Terjadi kesalahan server', 500);
  }
});

export default heally;
