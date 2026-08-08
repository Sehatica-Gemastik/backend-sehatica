import { Hono } from 'hono';
import { db } from '../db';
import { medicalRecords, schedules, verifRequests, chatMessages, dailyInsights } from '../db/schema';
import { eq, desc, and } from 'drizzle-orm';
import { authMiddleware } from '../middlewares/auth';
import { successResponse, errorResponse } from '../utils/response';
import { generateDailyInsight } from '../services/ai';

const home = new Hono();

home.use('*', authMiddleware);

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

// GET /home/dashboard — full dashboard data
home.get('/dashboard', async (c) => {
  try {
    const userId = c.get('userId') as number;
    const today = todayStr();

    // Fetch all data in parallel
    const [recentRecords, todaySchedule, recentVerif, existingInsight] = await Promise.all([
      db.query.medicalRecords.findMany({
        where: eq(medicalRecords.userId, userId),
        orderBy: [desc(medicalRecords.createdAt)],
        limit: 3,
      }),
      db.query.schedules.findMany({
        where: and(eq(schedules.userId, userId), eq(schedules.scheduleDate, today)),
        orderBy: [schedules.time],
      }),
      db.query.verifRequests.findMany({
        where: eq(verifRequests.userId, userId),
        orderBy: [desc(verifRequests.createdAt)],
        limit: 3,
      }),
      db.query.dailyInsights.findFirst({
        where: and(eq(dailyInsights.userId, userId), eq(dailyInsights.insightDate, today)),
      }),
    ]);

    // Generate daily insight if not cached
    let insight = existingInsight
      ? JSON.parse(existingInsight.content)
      : null;

    if (!insight) {
      try {
        insight = await generateDailyInsight(userId);
        await db.insert(dailyInsights).values({
          userId,
          content: JSON.stringify(insight),
          insightDate: today,
        });
      } catch {
        insight = {
          mainInsight: 'Jaga kesehatan Anda hari ini.',
          tips: [
            { text: 'Minum obat sesuai jadwal' },
            { text: 'Cukupi kebutuhan air minum' },
            { text: 'Lakukan aktivitas fisik ringan' },
          ],
        };
      }
    }

    const doneCount = todaySchedule.filter((s) => s.done).length;

    return successResponse(c, {
      today,
      scheduleProgress: {
        done: doneCount,
        total: todaySchedule.length,
        percentage: todaySchedule.length > 0
          ? Math.round((doneCount / todaySchedule.length) * 100)
          : 0,
      },
      nextScheduleItem: todaySchedule.find((s) => !s.done) ?? null,
      todaySchedule: todaySchedule.slice(0, 5),
      recentRecords,
      recentVerif,
      dailyInsight: insight,
    });
  } catch (err) {
    console.error('Dashboard error:', err);
    return errorResponse(c, 'Gagal mengambil data dashboard', 500);
  }
});

export default home;
