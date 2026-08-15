import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import { userDailyQuestionnaires, userWeeklyCheckins } from '../../db/schema';
import { generateQuestionnaireAiSummary } from './questionnaire-summarizer';
import type { PortalDailyQuestionnaireLog } from './questionnaire-mapper';

export type WeeklySyncPayload = {
  weight_kg: number;
  height_cm: number;
  bmi: number;
  waist_cm: number;
  systolic_bp: number;
  diastolic_bp: number;
};

export type PtmScoresPayload = {
  overall?: number;
  diabetes?: number;
  hypertension?: number;
  heart_disease?: number;
  stroke?: number;
};

export async function upsertWeeklyCheckin(userId: number, payload: WeeklySyncPayload) {
  const existing = await db.query.userWeeklyCheckins.findFirst({
    where: eq(userWeeklyCheckins.userId, userId),
  });

  const values = {
    weightKg: String(payload.weight_kg),
    heightCm: String(payload.height_cm),
    bmi: String(payload.bmi),
    waistCm: String(payload.waist_cm),
    systolicBp: payload.systolic_bp,
    diastolicBp: payload.diastolic_bp,
    completedAt: new Date(),
    updatedAt: new Date(),
  };

  if (existing) {
    const [updated] = await db
      .update(userWeeklyCheckins)
      .set(values)
      .where(eq(userWeeklyCheckins.id, existing.id))
      .returning();
    return updated;
  }

  const [created] = await db
    .insert(userWeeklyCheckins)
    .values({ userId, ...values })
    .returning();
  return created;
}

export async function upsertDailyQuestionnaire(
  userId: number,
  date: string,
  payload: Record<string, unknown>,
  options?: { ptmScores?: PtmScoresPayload | null },
) {
  const aiSummary = await generateQuestionnaireAiSummary(
    userId,
    date,
    payload,
    options?.ptmScores,
  );
  const completedAt = payload.completedAt
    ? new Date(String(payload.completedAt))
    : new Date();

  const existing = await db.query.userDailyQuestionnaires.findFirst({
    where: and(
      eq(userDailyQuestionnaires.userId, userId),
      eq(userDailyQuestionnaires.questionnaireDate, date),
    ),
  });

  const values = {
    payloadJson: JSON.stringify({ ...payload, date }),
    aiSummary,
    completedAt,
  };

  if (existing) {
    const [updated] = await db
      .update(userDailyQuestionnaires)
      .set(values)
      .where(eq(userDailyQuestionnaires.id, existing.id))
      .returning();
    return updated;
  }

  const [created] = await db
    .insert(userDailyQuestionnaires)
    .values({
      userId,
      questionnaireDate: date,
      ...values,
    })
    .returning();
  return created;
}

export function formatPtmScoresJson(scores?: PtmScoresPayload | null) {
  if (!scores) return '{}';
  return JSON.stringify({
    overall: scores.overall ?? 0,
    diabetes: scores.diabetes ?? 0,
    hypertension: scores.hypertension ?? 0,
    heart_disease: scores.heart_disease ?? 0,
    stroke: scores.stroke ?? 0,
  });
}

export type { PortalDailyQuestionnaireLog };
