import { and, desc, eq, lt } from 'drizzle-orm';
import { db } from '../../db';
import { userDailyCompliance, userDailyQuestionnaires, users, userWeeklyCheckins } from '../../db/schema';
import { isSummaryLlmConfigured } from '../../config/summary-llm';
import { generateGroqSummary } from '../llm/summary-provider';
import type { PtmScoresPayload } from './lifestyle-sync';
import {
  buildCompactDailyDelta,
  buildCompactHealthInput,
  buildFallbackDailyDelta,
  buildFallbackSummary,
} from './summary-input';

function parsePtmScores(json: string | null | undefined): PtmScoresPayload | null {
  try {
    const parsed = JSON.parse(json ?? '{}') as PtmScoresPayload;
    return parsed;
  } catch {
    return null;
  }
}

function parsePayload(json: string): Record<string, unknown> {
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function generateQuestionnaireAiSummary(
  userId: number,
  date: string,
  payload: Record<string, unknown>,
  ptmScores?: PtmScoresPayload | null,
): Promise<string> {
  const [user, weekly, previousRow, latestCompliance] = await Promise.all([
    db.query.users.findFirst({ where: eq(users.id, userId) }),
    db.query.userWeeklyCheckins.findFirst({ where: eq(userWeeklyCheckins.userId, userId) }),
    db.query.userDailyQuestionnaires.findFirst({
      where: and(
        eq(userDailyQuestionnaires.userId, userId),
        lt(userDailyQuestionnaires.questionnaireDate, date),
      ),
      orderBy: [desc(userDailyQuestionnaires.questionnaireDate)],
    }),
    db.query.userDailyCompliance.findFirst({
      where: eq(userDailyCompliance.userId, userId),
      orderBy: [desc(userDailyCompliance.complianceDate)],
    }),
  ]);

  const scores = ptmScores ?? parsePtmScores(latestCompliance?.ptmScoresJson);
  const weeklyContext = weekly
    ? {
        bmi: Number(weekly.bmi),
        waist_cm: Number(weekly.waistCm),
        systolic_bp: weekly.systolicBp,
        diastolic_bp: weekly.diastolicBp,
      }
    : null;

  const useDelta = Boolean(previousRow?.payloadJson);

  if (!isSummaryLlmConfigured()) {
    if (useDelta && previousRow) {
      const previousPayload = parsePayload(previousRow.payloadJson);
      const delta = buildCompactDailyDelta(payload, previousPayload);
      return buildFallbackDailyDelta(delta);
    }
    return buildFallbackSummary(payload);
  }

  try {
    if (useDelta && previousRow) {
      const previousPayload = parsePayload(previousRow.payloadJson);
      const delta = buildCompactDailyDelta(payload, previousPayload);
      return await generateGroqSummary('daily_delta', delta);
    }

    const compact = buildCompactHealthInput(payload, {
      age: user?.age,
      sex: user?.sex,
      weekly: weeklyContext,
      ptmScores: scores,
    });

    return await generateGroqSummary('health', compact);
  } catch (err) {
    console.error('[summary] Groq failed, using fallback:', err);
    if (useDelta) {
      const previousPayload = parsePayload(previousRow!.payloadJson);
      return buildFallbackDailyDelta(buildCompactDailyDelta(payload, previousPayload));
    }
    return buildFallbackSummary(payload);
  }
}
