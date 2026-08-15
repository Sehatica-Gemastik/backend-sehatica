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
import {
  formatPtmScoresJson,
  upsertDailyQuestionnaire,
  upsertWeeklyCheckin,
  type PtmScoresPayload,
  type WeeklySyncPayload,
} from '../services/portal/lifestyle-sync';
import {
  computePtmScoresForUser,
  recomputeLatestPtmScores,
  syncPtmScoresForDate,
} from '../services/portal/ptm-sync';
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

    const ptmScores = body.ptmScores as PtmScoresPayload | undefined;
    if (ptmScores) {
      await db
        .update(userDailyCompliance)
        .set({
          ptmOverallScore: String(ptmScores.overall ?? 0),
          ptmScoresJson: formatPtmScoresJson(ptmScores),
        })
        .where(eq(userDailyCompliance.id, row.id));
    }

    const questionnaire = body.questionnaire;
    if (questionnaire && typeof questionnaire === 'object') {
      await upsertDailyQuestionnaire(userId, body.date, questionnaire as Record<string, unknown>, {
        ptmScores: body.ptmScores as PtmScoresPayload | undefined,
      });
    }

    const weekly = body.weekly as WeeklySyncPayload | undefined;
    if (weekly?.weight_kg && weekly?.height_cm) {
      await upsertWeeklyCheckin(userId, weekly);
    }

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

/** POST /health/weekly-sync — mobile pushes weekly vitals */
health.post('/weekly-sync', async (c) => {
  try {
    const userId = c.get('userId') as number;
    const body = await c.req.json() as Partial<WeeklySyncPayload>;

    if (
      body.weight_kg == null ||
      body.height_cm == null ||
      body.bmi == null ||
      body.waist_cm == null ||
      body.systolic_bp == null ||
      body.diastolic_bp == null
    ) {
      return errorResponse(c, 'Data cek mingguan belum lengkap');
    }

    const row = await upsertWeeklyCheckin(userId, {
      weight_kg: Number(body.weight_kg),
      height_cm: Number(body.height_cm),
      bmi: Number(body.bmi),
      waist_cm: Number(body.waist_cm),
      systolic_bp: Number(body.systolic_bp),
      diastolic_bp: Number(body.diastolic_bp),
    });

    const ptmScores = await recomputeLatestPtmScores(userId);

    return successResponse(c, {
      completedAt: row.completedAt.toISOString(),
      ptmScores,
    });
  } catch (err) {
    console.error('Weekly sync error:', err);
    return errorResponse(c, 'Gagal sinkronisasi cek mingguan', 500);
  }
});

/** POST /health/questionnaire-sync — mobile pushes full daily questionnaire */
health.post('/questionnaire-sync', async (c) => {
  try {
    const userId = c.get('userId') as number;
    const body = await c.req.json() as {
      date?: string;
      questionnaire?: Record<string, unknown>;
      ptmScores?: PtmScoresPayload;
      weekly?: Partial<WeeklySyncPayload>;
    };

    if (!body.date || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
      return errorResponse(c, 'Field date (YYYY-MM-DD) wajib diisi');
    }
    if (!body.questionnaire || typeof body.questionnaire !== 'object') {
      return errorResponse(c, 'Payload kuisioner harian wajib diisi');
    }

    if (
      body.weekly?.weight_kg != null &&
      body.weekly?.height_cm != null &&
      body.weekly?.bmi != null &&
      body.weekly?.waist_cm != null &&
      body.weekly?.systolic_bp != null &&
      body.weekly?.diastolic_bp != null
    ) {
      await upsertWeeklyCheckin(userId, {
        weight_kg: Number(body.weekly.weight_kg),
        height_cm: Number(body.weekly.height_cm),
        bmi: Number(body.weekly.bmi),
        waist_cm: Number(body.weekly.waist_cm),
        systolic_bp: Number(body.weekly.systolic_bp),
        diastolic_bp: Number(body.weekly.diastolic_bp),
      });
    }

    const ptmScores =
      body.ptmScores ??
      (await computePtmScoresForUser(userId, body.date, body.questionnaire));

    const row = await upsertDailyQuestionnaire(userId, body.date, body.questionnaire, {
      ptmScores: ptmScores ?? undefined,
    });
    await upsertDailyCompliance(userId, {
      date: body.date,
      dailyLogCount: 1,
      ptmScreeningDone: true,
      ptmFactors: [],
      dailyLogs: [],
      scheduleSnapshot: [],
    });

    if (ptmScores) {
      await syncPtmScoresForDate(userId, body.date, body.questionnaire, ptmScores);
    }

    return successResponse(c, {
      date: row.questionnaireDate,
      aiSummary: row.aiSummary,
      completedAt: row.completedAt.toISOString(),
      ptmScores,
    });
  } catch (err) {
    console.error('Questionnaire sync error:', err);
    return errorResponse(c, 'Gagal sinkronisasi kuisioner harian', 500);
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
