import { Hono } from 'hono';
import { db } from '../db';
import { chatSessions, users } from '../db/schema';
import { eq, desc, and } from 'drizzle-orm';
import { authMiddleware } from '../middlewares/auth';
import { successResponse, errorResponse } from '../utils/response';

const sessionRoutes = new Hono();
sessionRoutes.use('*', authMiddleware);

// GET /sessions — list chat room sessions for current user
sessionRoutes.get('/', async (c) => {
  try {
    const userId = c.get('userId');
    const rows = await db.query.chatSessions.findMany({
      where: eq(chatSessions.userId, userId),
      orderBy: [desc(chatSessions.createdAt)],
    });
    return successResponse(c, rows);
  } catch {
    return errorResponse(c, 'Gagal mengambil daftar sesi percakapan', 500);
  }
});

// POST /sessions — create or sync a chat room session
sessionRoutes.post('/', async (c) => {
  try {
    const userId = c.get('userId');
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object') return errorResponse(c, 'Data sesi tidak valid');

    const { uuid, title } = body;
    if (typeof uuid !== 'string' || !uuid.trim()) {
      return errorResponse(c, 'UUID sesi wajib diisi');
    }

    const sessionTitle = (typeof title === 'string' && title.trim()) ? title.trim() : 'Konsultasi Kesehatan';

    const existing = await db.query.chatSessions.findFirst({
      where: eq(chatSessions.uuid, uuid.trim()),
    });

    if (existing) {
      const [updated] = await db
        .update(chatSessions)
        .set({ title: sessionTitle, updatedAt: new Date() })
        .where(eq(chatSessions.id, existing.id))
        .returning();
      return successResponse(c, updated);
    }

    const [created] = await db.insert(chatSessions).values({
      uuid: uuid.trim(),
      userId,
      title: sessionTitle,
    }).returning();

    return successResponse(c, created, 201);
  } catch (err) {
    console.error('Create session error:', err);
    return errorResponse(c, 'Gagal membuat sesi percakapan', 500);
  }
});

export default sessionRoutes;
