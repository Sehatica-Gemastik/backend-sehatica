import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { userDailyCompliance } from '../db/schema';
import { authMiddleware } from '../middlewares/auth';
import { successResponse, errorResponse } from '../utils/response';
import {
  upsertDailyCompliance,
  type DailySyncPayload,
} from '../services/compliance/daily-compliance';
import { predictPtmRisk, type PtmInputFeatures } from '../services/ptm/inference';

const health = new Hono();

health.use('*', authMiddleware);

/** POST /health/daily-sync — mobile pushes PTM + daily log + schedule snapshot */
health.post('/daily-sync', async (c) => {
  try {
    const userId = c.get('userId') as number;
    const body = await c.req.json() as Partial<DailySyncPayload>;

    if (!body.date || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
      return errorResponse(c, 'Field date (YYYY-MM-DD) wajib diisi');
    }

    const existing = await db.query.userDailyCompliance.findFirst({
      where: and(
        eq(userDailyCompliance.userId, userId),
        eq(userDailyCompliance.complianceDate, body.date)
      ),
    });
    const wasPendingSchedule = existing?.pendingScheduleIntent ?? false;

    const row = await upsertDailyCompliance(userId, {
      date: body.date,
      dailyLogCount: Math.max(0, Number(body.dailyLogCount ?? 0)),
      ptmScreeningDone: Boolean(body.ptmScreeningDone),
      ptmFactors: Array.isArray(body.ptmFactors)
        ? body.ptmFactors.filter((v): v is string => typeof v === 'string')
        : [],
      dailyLogs: Array.isArray(body.dailyLogs)
        ? body.dailyLogs.filter(
            (v): v is NonNullable<DailySyncPayload['dailyLogs']>[number] =>
              v != null &&
              typeof v === 'object' &&
              typeof v.title === 'string' &&
              typeof v.time === 'string'
          )
        : [],
      scheduleSnapshot: Array.isArray(body.scheduleSnapshot) ? body.scheduleSnapshot : [],
    });

    return successResponse(c, {
      date: row.complianceDate,
      syncedAt: row.syncedAt,
      wasPendingSchedule,
    });
  } catch (err) {
    console.error('Daily sync error:', err);
    return errorResponse(c, 'Gagal sinkronisasi data harian', 500);
  }
});

/** POST /health/ptm-risk — predict PTM risk from lifestyle + clinical features */
health.post('/ptm-risk', async (c) => {
  try {
    const body = await c.req.json() as Partial<PtmInputFeatures>;
    const result = predictPtmRisk(body);
    return successResponse(c, result);
  } catch (err) {
    console.error('PTM risk error:', err);
    return errorResponse(c, 'Gagal menghitung risiko PTM', 500);
  }
});

export default health;
