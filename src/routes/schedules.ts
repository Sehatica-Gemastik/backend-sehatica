import { Hono } from 'hono';
import { db } from '../db';
import { schedules } from '../db/schema';
import { eq, desc, and } from 'drizzle-orm';
import { authMiddleware } from '../middlewares/auth';
import { successResponse, errorResponse } from '../utils/response';
import { generateSchedule } from '../services/ai';

const schedulesRoute = new Hono();

schedulesRoute.use('*', authMiddleware);

// Helper: today's date string
function todayStr() {
  return new Date().toISOString().split('T')[0];
}

const colorMap: Record<string, string> = {
  orange: 'bg-orange-100 text-orange-600',
  blue: 'bg-blue-100 text-blue-600',
  green: 'bg-green-100 text-green-600',
  cyan: 'bg-cyan-100 text-cyan-600',
  yellow: 'bg-yellow-100 text-yellow-600',
  red: 'bg-red-100 text-red-600',
  purple: 'bg-purple-100 text-purple-600',
};

// GET /schedules?date=YYYY-MM-DD — get schedule for a date
schedulesRoute.get('/', async (c) => {
  try {
    const userId = c.get('userId') as number;
    const date = c.req.query('date') ?? todayStr();

    const items = await db.query.schedules.findMany({
      where: and(eq(schedules.userId, userId), eq(schedules.scheduleDate, date)),
      orderBy: [schedules.time],
    });

    return successResponse(c, items);
  } catch {
    return errorResponse(c, 'Gagal mengambil jadwal', 500);
  }
});

// POST /schedules — create a schedule item
schedulesRoute.post('/', async (c) => {
  try {
    const userId = c.get('userId') as number;
    const body = await c.req.json();
    const { type, label, detail, time, scheduleDate, colorScheme } = body;

    if (!type || !label || !time) {
      return errorResponse(c, 'Tipe, label, dan waktu wajib diisi');
    }

    const color = colorMap[colorScheme ?? ''] ?? colorMap.blue;

    const [item] = await db.insert(schedules).values({
      userId,
      type,
      label,
      detail: detail ?? null,
      time,
      scheduleDate: scheduleDate ?? todayStr(),
      colorScheme: color,
    }).returning();

    return successResponse(c, item, 201);
  } catch {
    return errorResponse(c, 'Gagal menambah jadwal', 500);
  }
});

// PATCH /schedules/:id/toggle — toggle done status
schedulesRoute.patch('/:id/toggle', async (c) => {
  try {
    const userId = c.get('userId') as number;
    const id = parseInt(c.req.param('id'));

    const item = await db.query.schedules.findFirst({
      where: and(eq(schedules.id, id), eq(schedules.userId, userId)),
    });
    if (!item) return errorResponse(c, 'Item jadwal tidak ditemukan', 404);

    const [updated] = await db
      .update(schedules)
      .set({ done: !item.done })
      .where(eq(schedules.id, id))
      .returning();

    return successResponse(c, updated);
  } catch {
    return errorResponse(c, 'Terjadi kesalahan server', 500);
  }
});

// DELETE /schedules/:id
schedulesRoute.delete('/:id', async (c) => {
  try {
    const userId = c.get('userId') as number;
    const id = parseInt(c.req.param('id'));

    const item = await db.query.schedules.findFirst({
      where: and(eq(schedules.id, id), eq(schedules.userId, userId)),
    });
    if (!item) return errorResponse(c, 'Item jadwal tidak ditemukan', 404);

    await db.delete(schedules).where(eq(schedules.id, id));
    return successResponse(c, { deleted: true });
  } catch {
    return errorResponse(c, 'Terjadi kesalahan server', 500);
  }
});

// POST /schedules/ai-generate — generate AI schedule for today
schedulesRoute.post('/ai-generate', async (c) => {
  try {
    const userId = c.get('userId') as number;
    const today = todayStr();

    // Delete existing AI-generated schedules for today
    const existingAi = await db.query.schedules.findMany({
      where: and(
        eq(schedules.userId, userId),
        eq(schedules.scheduleDate, today),
        eq(schedules.isAiGenerated, true)
      ),
    });

    for (const s of existingAi) {
      await db.delete(schedules).where(eq(schedules.id, s.id));
    }

    // Generate new schedule
    const aiSchedule = await generateSchedule(userId);

    // Insert all items
    const insertedItems = [];
    for (const item of aiSchedule) {
      const color = colorMap[item.colorScheme] ?? colorMap.blue;
      const [inserted] = await db.insert(schedules).values({
        userId,
        type: item.type as any,
        label: item.label,
        detail: item.detail,
        time: item.time,
        scheduleDate: today,
        isAiGenerated: true,
        colorScheme: color,
      }).returning();
      insertedItems.push(inserted);
    }

    return successResponse(c, insertedItems, 201);
  } catch (err) {
    console.error('AI generate error:', err);
    return errorResponse(c, 'Gagal generate jadwal AI', 500);
  }
});

export default schedulesRoute;
