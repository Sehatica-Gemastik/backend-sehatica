import { db } from '../../db';
import {
  notificationArms,
  notificationArmStatistics,
  notificationEvents,
  schedules,
  rdsaAsks,
} from '../../db/schema';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import {
  getDailyCompliance,
  scheduleFlagsFromSnapshot,
  shouldSuppressArm,
} from '../compliance/daily-compliance';

export type RecommendContext = {
  localHour?: number;
  channel?: 'push' | 'whatsapp';
  forceIntent?: string;
};

export type ScoredArm = {
  armId: string;
  intent: string;
  title: string;
  body: string;
  channels: string[];
  score: number;
  probability: number;
};

const PRIOR = 0.5;
const TEMPERATURE = Number(process.env.RDSA_SOFTMAX_TEMPERATURE ?? '0.35');
const RECENCY_HALF_LIFE_DAYS = Number(process.env.RDSA_RECENCY_HALF_LIFE_DAYS ?? '3');
const MAX_ASKS_PER_DAY = Number(process.env.RDSA_MAX_ASKS_PER_DAY ?? '5');
const QUIET_START = Number(process.env.RDSA_QUIET_HOURS_START ?? '22');
const QUIET_END = Number(process.env.RDSA_QUIET_HOURS_END ?? '6');

function differenceScore(muPlus: number, muMinus: number): number {
  return muPlus - muMinus;
}

function recencyPenalty(daysSince: number | null): number {
  if (daysSince === null) return 0;
  // recovering: penalty decays with time since last send
  return Math.exp(-daysSince / RECENCY_HALF_LIFE_DAYS) * 0.4;
}

function softmax(scores: number[], temperature: number): number[] {
  const t = Math.max(temperature, 0.05);
  const scaled = scores.map((s) => s / t);
  const max = Math.max(...scaled);
  const exps = scaled.map((s) => Math.exp(s - max));
  const sum = exps.reduce((a, b) => a + b, 0) || 1;
  return exps.map((e) => e / sum);
}

function pickWeighted(weights: number[]): number {
  const r = Math.random();
  let acc = 0;
  for (let i = 0; i < weights.length; i++) {
    acc += weights[i];
    if (r <= acc) return i;
  }
  return weights.length - 1;
}

function hourToIntents(hour: number): string[] {
  if (hour >= 5 && hour < 11) return ['time.morning', 'schedule.pill', 'schedule.food', 'ask.checkin'];
  if (hour >= 11 && hour < 15) return ['time.afternoon', 'schedule.water', 'schedule.progress', 'ask.checkin'];
  if (hour >= 15 && hour < 19) return ['time.evening', 'schedule.exercise', 'schedule.pill', 'ask.checkin'];
  if (hour >= 19 && hour < 22) return ['time.night', 'schedule.pill', 'insight.tip', 'ask.checkin'];
  return ['ask.checkin', 'insight.tip'];
}

function inQuietHours(hour: number): boolean {
  if (QUIET_START > QUIET_END) {
    return hour >= QUIET_START || hour < QUIET_END;
  }
  return hour >= QUIET_START && hour < QUIET_END;
}

/**
 * Eligibility before RDSA smart notifications.
 */
export async function getEligibleArms(userId: number, ctx: RecommendContext) {
  const hour = ctx.localHour ?? new Date().getHours();
  if (inQuietHours(hour) && !ctx.forceIntent) {
    return [];
  }

  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const todaysAsks = await db
    .select({ id: rdsaAsks.id })
    .from(rdsaAsks)
    .where(and(eq(rdsaAsks.userId, userId), gte(rdsaAsks.createdAt, dayStart)));
  if (todaysAsks.length >= MAX_ASKS_PER_DAY && !ctx.forceIntent) {
    return [];
  }

  const allArms = await db.query.notificationArms.findMany({
    where: eq(notificationArms.enabled, true),
  });

  const today = new Date().toISOString().slice(0, 10);
  const compliance = await getDailyCompliance(userId, today);

  const userSchedules = await db.query.schedules.findMany({
    where: eq(schedules.userId, userId),
    limit: 50,
  });

  const snapshotFlags = compliance?.scheduleSnapshot.length
    ? scheduleFlagsFromSnapshot(compliance.scheduleSnapshot)
    : null;

  const hasPill = snapshotFlags?.hasPill ?? userSchedules.some((s) => s.type === 'pill');
  const hasExercise = snapshotFlags?.hasExercise ?? userSchedules.some((s) => s.type === 'exercise');
  const hasFood = snapshotFlags?.hasFood ?? userSchedules.some((s) => s.type === 'food');
  const hasWater = snapshotFlags?.hasWater ?? userSchedules.some((s) => s.type === 'water');
  const hasMissed = snapshotFlags?.hasMissed ?? userSchedules.some((s) => !s.done);

  const preferred = new Set(
    ctx.forceIntent ? [ctx.forceIntent] : [...hourToIntents(hour), 'ask.checkin', 'insight.tip']
  );

  return allArms.filter((arm) => {
    if (ctx.forceIntent) return arm.intent === ctx.forceIntent;
    if (shouldSuppressArm(arm, compliance)) return false;
    // RDSA push-only — skip legacy chat / verif arms
    if (!arm.channels.includes('push')) return false;
    if (arm.intent.startsWith('chat.') || arm.intent.startsWith('verif.')) return false;
    if (!preferred.has(arm.intent)) return false;
    if (arm.intent === 'schedule.pill' && !hasPill) return false;
    if (arm.intent === 'schedule.exercise' && !hasExercise) return false;
    if (arm.intent === 'schedule.food' && !hasFood) return false;
    if (arm.intent === 'schedule.water' && !hasWater) return false;
    if (arm.intent === 'nudge.missed' && !hasMissed) return false;
    const channel = ctx.channel ?? 'push';
    if (!arm.channels.includes(channel)) return false;
    return true;
  });
}

export async function recommendArm(
  userId: number,
  ctx: RecommendContext = {}
): Promise<ScoredArm | null> {
  const eligible = await getEligibleArms(userId, ctx);
  if (eligible.length === 0) return null;

  const candidates: Array<ScoredArm & { rawScore: number }> = [];

  for (const arm of eligible) {
    let stats = await db.query.notificationArmStatistics.findFirst({
      where: eq(notificationArmStatistics.armId, arm.armId),
    });
    if (!stats) {
      const [created] = await db
        .insert(notificationArmStatistics)
        .values({ armId: arm.armId })
        .onConflictDoNothing()
        .returning();
      stats =
        created ??
        (await db.query.notificationArmStatistics.findFirst({
          where: eq(notificationArmStatistics.armId, arm.armId),
        }));
    }

    const muPlus = stats ? Number(stats.muPlus) : PRIOR;
    const muMinus = stats ? Number(stats.muMinus) : PRIOR;
    const base = differenceScore(muPlus, muMinus);

    const last = await db.query.notificationEvents.findFirst({
      where: and(eq(notificationEvents.userId, userId), eq(notificationEvents.armId, arm.armId)),
      orderBy: [desc(notificationEvents.sentAt)],
    });
    const daysSince = last
      ? (Date.now() - last.sentAt.getTime()) / (1000 * 60 * 60 * 24)
      : null;

    const rawScore = base - recencyPenalty(daysSince);
    candidates.push({
      armId: arm.armId,
      intent: arm.intent,
      title: arm.title,
      body: arm.body,
      channels: arm.channels,
      score: rawScore,
      probability: 0,
      rawScore,
    });
  }

  const probs = softmax(
    candidates.map((c) => c.rawScore),
    TEMPERATURE
  );
  candidates.forEach((c, i) => {
    c.probability = probs[i];
  });

  const idx = pickWeighted(probs);
  const chosen = candidates[idx];

  // mark eligible-not-selected for counterfactual stats (count only)
  for (let i = 0; i < candidates.length; i++) {
    if (i === idx) continue;
    await db
      .insert(notificationArmStatistics)
      .values({
        armId: candidates[i].armId,
        eligibleNotSelectedCount: 1,
      })
      .onConflictDoUpdate({
        target: notificationArmStatistics.armId,
        set: {
          eligibleNotSelectedCount: sql`${notificationArmStatistics.eligibleNotSelectedCount} + 1`,
          updatedAt: new Date(),
        },
      });
  }

  return {
    armId: chosen.armId,
    intent: chosen.intent,
    title: chosen.title,
    body: chosen.body,
    channels: chosen.channels,
    score: chosen.score,
    probability: chosen.probability,
  };
}

export async function recordSelection(armId: string) {
  await db
    .insert(notificationArmStatistics)
    .values({ armId, selectedCount: 1 })
    .onConflictDoUpdate({
      target: notificationArmStatistics.armId,
      set: {
        selectedCount: sql`${notificationArmStatistics.selectedCount} + 1`,
        updatedAt: new Date(),
      },
    });
}

export async function recordReward(armId: string, reward: number, wasSelected: boolean) {
  const stats = await db.query.notificationArmStatistics.findFirst({
    where: eq(notificationArmStatistics.armId, armId),
  });
  if (!stats) {
    await db.insert(notificationArmStatistics).values({ armId });
  }

  if (wasSelected) {
    await db
      .update(notificationArmStatistics)
      .set({
        selectedRewardSum: sql`${notificationArmStatistics.selectedRewardSum} + ${reward}`,
        updatedAt: new Date(),
      })
      .where(eq(notificationArmStatistics.armId, armId));
  } else {
    await db
      .update(notificationArmStatistics)
      .set({
        eligibleNotSelectedRewardSum: sql`${notificationArmStatistics.eligibleNotSelectedRewardSum} + ${reward}`,
        updatedAt: new Date(),
      })
      .where(eq(notificationArmStatistics.armId, armId));
  }

  const refreshed = await db.query.notificationArmStatistics.findFirst({
    where: eq(notificationArmStatistics.armId, armId),
  });
  if (!refreshed) return;

  const sel = Math.max(refreshed.selectedCount, 1);
  const ens = Math.max(refreshed.eligibleNotSelectedCount, 1);
  const muPlus =
    (PRIOR + Number(refreshed.selectedRewardSum)) / (1 + sel);
  const muMinus =
    (PRIOR + Number(refreshed.eligibleNotSelectedRewardSum)) / (1 + ens);
  const base = differenceScore(muPlus, muMinus);

  await db
    .update(notificationArmStatistics)
    .set({
      muPlus: String(muPlus),
      muMinus: String(muMinus),
      baseScore: String(base),
      updatedAt: new Date(),
    })
    .where(eq(notificationArmStatistics.armId, armId));
}
