import { and, desc, eq } from 'drizzle-orm';
import { db } from '../../db';
import {
  userDailyCompliance,
  userDailyQuestionnaires,
  users,
  userWeeklyCheckins,
} from '../../db/schema';
import { predictPtmRisk, type PtmInputFeatures, type PtmRiskResult } from '../ptm/inference';
import { formatPtmScoresJson, type PtmScoresPayload } from './lifestyle-sync';

function asFiniteNumber(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function asNonNegativeNumber(value: unknown): number | null {
  const n = asFiniteNumber(value);
  return n != null && n >= 0 ? n : null;
}

function buildPtmInput(
  user: typeof users.$inferSelect,
  questionnaire: Record<string, unknown>,
  weekly: typeof userWeeklyCheckins.$inferSelect | null | undefined,
): Partial<PtmInputFeatures> {
  const daily = questionnaire;

  return {
    age: asFiniteNumber(user.age),
    sex: asFiniteNumber(user.sex),
    race_ethnicity: asFiniteNumber(user.raceEthnicity),
    education: asFiniteNumber(user.education),
    income_poverty_ratio: asFiniteNumber(user.incomePovertyRatio),
    calories_day1: asNonNegativeNumber(daily.calories_day1),
    protein_g_day1: asNonNegativeNumber(daily.protein_g_day1),
    carbohydrate_g_day1: asNonNegativeNumber(daily.carbohydrate_g_day1),
    sugar_g_day1: asNonNegativeNumber(daily.sugar_g_day1),
    total_fat_g_day1: asNonNegativeNumber(daily.total_fat_g_day1),
    saturated_fat_g_day1: asNonNegativeNumber(daily.saturated_fat_g_day1),
    sodium_mg_day1: asNonNegativeNumber(daily.sodium_mg_day1),
    fiber_g_day1: asNonNegativeNumber(daily.fiber_g_day1),
    cholesterol_mg_day1: asNonNegativeNumber(daily.cholesterol_mg_day1),
    alcohol_g_day1: asNonNegativeNumber(daily.alcohol_g_day1),
    vigorous_work: asFiniteNumber(daily.vigorous_work) ?? undefined,
    vigorous_work_days: asFiniteNumber(daily.vigorous_work_days) ?? undefined,
    vigorous_work_minutes: asFiniteNumber(daily.vigorous_work_minutes) ?? undefined,
    moderate_work: asFiniteNumber(daily.moderate_work) ?? undefined,
    moderate_work_days: asFiniteNumber(daily.moderate_work_days) ?? undefined,
    moderate_work_minutes: asFiniteNumber(daily.moderate_work_minutes) ?? undefined,
    transport_walking_biking: asFiniteNumber(daily.transport_walking_biking) ?? undefined,
    transport_days: asFiniteNumber(daily.transport_days) ?? undefined,
    transport_minutes: asFiniteNumber(daily.transport_minutes) ?? undefined,
    vigorous_recreation: asFiniteNumber(daily.vigorous_recreation) ?? undefined,
    vigorous_recreation_days: asFiniteNumber(daily.vigorous_recreation_days) ?? undefined,
    vigorous_recreation_minutes: asFiniteNumber(daily.vigorous_recreation_minutes) ?? undefined,
    moderate_recreation: asFiniteNumber(daily.moderate_recreation) ?? undefined,
    moderate_recreation_days: asFiniteNumber(daily.moderate_recreation_days) ?? undefined,
    moderate_recreation_minutes: asFiniteNumber(daily.moderate_recreation_minutes) ?? undefined,
    sedentary_minutes: asFiniteNumber(daily.sedentary_minutes) ?? undefined,
    vigorous_work_est_met: asFiniteNumber(daily.vigorous_work_est_met) ?? undefined,
    moderate_work_est_met: asFiniteNumber(daily.moderate_work_est_met) ?? undefined,
    transport_walking_biking_est_met: asFiniteNumber(daily.transport_walking_biking_est_met) ?? undefined,
    vigorous_recreation_est_met: asFiniteNumber(daily.vigorous_recreation_est_met) ?? undefined,
    moderate_recreation_est_met: asFiniteNumber(daily.moderate_recreation_est_met) ?? undefined,
    work_total_minutes: asFiniteNumber(daily.work_total_minutes) ?? undefined,
    recreation_total_minutes: asFiniteNumber(daily.recreation_total_minutes) ?? undefined,
    vigorous_total_minutes: asFiniteNumber(daily.vigorous_total_minutes) ?? undefined,
    moderate_total_minutes: asFiniteNumber(daily.moderate_total_minutes) ?? undefined,
    total_activity_minutes: asFiniteNumber(daily.total_activity_minutes) ?? undefined,
    total_activity_est_met: asFiniteNumber(daily.total_activity_est_met) ?? undefined,
    alcohol_ever: asFiniteNumber(daily.alcohol_ever) ?? undefined,
    alcohol_frequency: asFiniteNumber(daily.alcohol_frequency) ?? undefined,
    alcohol_drinks_per_day: asFiniteNumber(daily.alcohol_drinks_per_day) ?? undefined,
    alcohol_binge_frequency: asFiniteNumber(daily.alcohol_binge_frequency) ?? undefined,
    weight_kg: weekly ? asFiniteNumber(weekly.weightKg) : null,
    height_cm: weekly ? asFiniteNumber(weekly.heightCm) : null,
    bmi: weekly ? asFiniteNumber(weekly.bmi) : null,
    waist_cm: weekly ? asFiniteNumber(weekly.waistCm) : null,
    systolic_bp: weekly?.systolicBp ?? null,
    diastolic_bp: weekly?.diastolicBp ?? null,
  };
}

export function ptmResultToScoresPayload(result: PtmRiskResult): PtmScoresPayload | null {
  if (!result.dataComplete) return null;

  const scores: PtmScoresPayload = { overall: result.overallScore };
  for (const risk of result.risks) {
    scores[risk.target] = risk.probability;
  }
  return scores;
}

export async function computePtmScoresForUser(
  userId: number,
  date: string,
  questionnaire?: Record<string, unknown>,
): Promise<PtmScoresPayload | null> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) return null;

  let qPayload = questionnaire;
  if (!qPayload) {
    const row = await db.query.userDailyQuestionnaires.findFirst({
      where: and(
        eq(userDailyQuestionnaires.userId, userId),
        eq(userDailyQuestionnaires.questionnaireDate, date),
      ),
    });
    if (!row) return null;
    qPayload = JSON.parse(row.payloadJson) as Record<string, unknown>;
  }

  const weekly = await db.query.userWeeklyCheckins.findFirst({
    where: eq(userWeeklyCheckins.userId, userId),
  });

  const input = buildPtmInput(user, qPayload, weekly);
  const result = predictPtmRisk(input);
  return ptmResultToScoresPayload(result);
}

export async function persistPtmScoresToCompliance(
  userId: number,
  date: string,
  scores: PtmScoresPayload,
): Promise<void> {
  const existing = await db.query.userDailyCompliance.findFirst({
    where: and(
      eq(userDailyCompliance.userId, userId),
      eq(userDailyCompliance.complianceDate, date),
    ),
  });

  const ptmValues = {
    ptmOverallScore: String(scores.overall ?? 0),
    ptmScoresJson: formatPtmScoresJson(scores),
    ptmScreeningDone: true,
  };

  if (existing) {
    await db
      .update(userDailyCompliance)
      .set({ ...ptmValues, syncedAt: new Date() })
      .where(eq(userDailyCompliance.id, existing.id));
    return;
  }

  await db.insert(userDailyCompliance).values({
    userId,
    complianceDate: date,
    dailyLogCount: 1,
    ptmFactorsJson: '[]',
    dailyLogsJson: '[]',
    scheduleSnapshotJson: '[]',
    ...ptmValues,
  });
}

export async function syncPtmScoresForDate(
  userId: number,
  date: string,
  questionnaire?: Record<string, unknown>,
  overrideScores?: PtmScoresPayload | null,
): Promise<PtmScoresPayload | null> {
  const scores = overrideScores ?? (await computePtmScoresForUser(userId, date, questionnaire));
  if (!scores) return null;
  await persistPtmScoresToCompliance(userId, date, scores);
  return scores;
}

export async function recomputeLatestPtmScores(userId: number): Promise<PtmScoresPayload | null> {
  const latest = await db.query.userDailyQuestionnaires.findFirst({
    where: eq(userDailyQuestionnaires.userId, userId),
    orderBy: [desc(userDailyQuestionnaires.questionnaireDate)],
  });
  if (!latest) return null;

  const payload = JSON.parse(latest.payloadJson) as Record<string, unknown>;
  return syncPtmScoresForDate(userId, latest.questionnaireDate, payload);
}
