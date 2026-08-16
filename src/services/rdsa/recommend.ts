import { db } from '../../db';
import {
  notificationArms,
  notificationArmStatistics,
  notificationEvents,
  rdsaIntentStatistics,
  schedules,
  rdsaAsks,
} from '../../db/schema';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import {
  getDailyCompliance,
  scheduleFlagsFromSnapshot,
  shouldSuppressArm,
} from '../compliance/daily-compliance';
import { pickByThompsonSampling } from './thompson-sampling';

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
const MAX_ASKS_PER_DAY = Number(process.env.RDSA_MAX_ASKS_PER_DAY ?? '5');
const QUIET_START = Number(process.env.RDSA_QUIET_HOURS_START ?? '22');
const QUIET_END = Number(process.env.RDSA_QUIET_HOURS_END ?? '6');
/** How many of the most-recently-sent arms (any intent) to avoid repeating verbatim. */
const RECENT_ARM_AVOID_COUNT = 5;

function differenceScore(muPlus: number, muMinus: number): number {
  return muPlus - muMinus;
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

async function getOrCreateIntentStats(userId: number, intent: string) {
  const existing = await db.query.rdsaIntentStatistics.findFirst({
    where: and(eq(rdsaIntentStatistics.userId, userId), eq(rdsaIntentStatistics.intent, intent)),
  });
  if (existing) return existing;

  const [created] = await db
    .insert(rdsaIntentStatistics)
    .values({ userId, intent })
    .onConflictDoNothing()
    .returning();

  return (
    created ??
    (await db.query.rdsaIntentStatistics.findFirst({
      where: and(eq(rdsaIntentStatistics.userId, userId), eq(rdsaIntentStatistics.intent, intent)),
    }))!
  );
}

async function getRecentlySentArmIds(userId: number, limit: number): Promise<Set<string>> {
  const recent = await db.query.notificationEvents.findMany({
    where: eq(notificationEvents.userId, userId),
    orderBy: [desc(notificationEvents.sentAt)],
    limit,
  });
  return new Set(recent.map((event) => event.armId));
}

/**
 * Two-stage pick:
 * 1. Thompson Sampling over eligible *intents* (schedule.pill, ask.checkin, ...) —
 *    this is the level where we actually have enough signal to learn per user.
 * 2. Plain rotation over the arms (exact wording) within the winning intent —
 *    wording variety doesn't need statistics, just avoid repeating recently-sent text.
 */
export async function recommendArm(
  userId: number,
  ctx: RecommendContext = {}
): Promise<ScoredArm | null> {
  const eligible = await getEligibleArms(userId, ctx);
  if (eligible.length === 0) return null;

  const armsByIntent = new Map<string, typeof eligible>();
  for (const arm of eligible) {
    const list = armsByIntent.get(arm.intent) ?? [];
    list.push(arm);
    armsByIntent.set(arm.intent, list);
  }
  const intents = [...armsByIntent.keys()];

  const statsByIntent = new Map<string, { successCount: number; failureCount: number }>();
  for (const intent of intents) {
    const stats = await getOrCreateIntentStats(userId, intent);
    statsByIntent.set(intent, { successCount: stats.successCount, failureCount: stats.failureCount });
  }

  const chosenIntent = pickByThompsonSampling(intents, (intent) => statsByIntent.get(intent)!);
  const armsForIntent = armsByIntent.get(chosenIntent)!;

  const recentArmIds = await getRecentlySentArmIds(userId, RECENT_ARM_AVOID_COUNT);
  const freshArms = armsForIntent.filter((arm) => !recentArmIds.has(arm.armId));
  const pool = freshArms.length > 0 ? freshArms : armsForIntent;
  const chosenArm = pool[Math.floor(Math.random() * pool.length)];

  const chosenStats = statsByIntent.get(chosenIntent)!;
  const total = chosenStats.successCount + chosenStats.failureCount;
  const empiricalRate = total > 0 ? chosenStats.successCount / total : PRIOR;

  return {
    armId: chosenArm.armId,
    intent: chosenArm.intent,
    title: chosenArm.title,
    body: chosenArm.body,
    channels: chosenArm.channels,
    score: empiricalRate,
    probability: empiricalRate,
  };
}

/** Success/failure signal for the (userId, intent) Thompson Sampling stats. */
export async function recordIntentOutcome(userId: number, intent: string, success: boolean) {
  const existing = await db.query.rdsaIntentStatistics.findFirst({
    where: and(eq(rdsaIntentStatistics.userId, userId), eq(rdsaIntentStatistics.intent, intent)),
  });

  if (!existing) {
    await db.insert(rdsaIntentStatistics).values({
      userId,
      intent,
      successCount: success ? 1 : 0,
      failureCount: success ? 0 : 1,
    });
    return;
  }

  await db
    .update(rdsaIntentStatistics)
    .set({
      successCount: success ? existing.successCount + 1 : existing.successCount,
      failureCount: success ? existing.failureCount : existing.failureCount + 1,
      updatedAt: new Date(),
    })
    .where(eq(rdsaIntentStatistics.id, existing.id));
}

/**
 * Legacy per-arm bookkeeping (notification_arm_statistics). Kept for descriptive
 * analytics ("which exact wording gets sent/acked most") — no longer used to
 * choose which arm to send; that's rdsaIntentStatistics + Thompson Sampling above.
 */
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
