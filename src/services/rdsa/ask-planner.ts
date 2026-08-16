import { db } from '../../db';
import {
  rdsaAsks,
  notificationEvents,
  users,
  schedules,
} from '../../db/schema';
import { and, asc, eq, inArray, isNull, lt } from 'drizzle-orm';
import { recommendArm, recordSelection, recordReward, recordIntentOutcome } from './recommend';

const SCHEDULE_TYPES = ['pill', 'food', 'water', 'exercise'] as const;
const COMPLIANCE_WINDOW_MS = Number(process.env.RDSA_COMPLIANCE_WINDOW_HOURS ?? '2') * 60 * 60 * 1000;

type ScheduleContext = {
  id: number;
  label: string;
  time: string;
  detail: string | null;
};

async function findScheduleContext(
  userId: number,
  intent: string
): Promise<ScheduleContext | null> {
  const scheduleType = intent.startsWith('schedule.') ? intent.slice('schedule.'.length) : null;
  if (!scheduleType || !SCHEDULE_TYPES.includes(scheduleType as (typeof SCHEDULE_TYPES)[number])) {
    return null;
  }

  const today = new Date().toISOString().slice(0, 10);
  const match = await db.query.schedules.findFirst({
    where: and(
      eq(schedules.userId, userId),
      eq(schedules.type, scheduleType as (typeof SCHEDULE_TYPES)[number]),
      eq(schedules.scheduleDate, today)
    ),
    orderBy: [asc(schedules.done)],
  });

  if (!match) return null;
  return { id: match.id, label: match.label, time: match.time, detail: match.detail };
}

function renderTemplate(
  text: string,
  name?: string | null,
  schedule?: ScheduleContext | null
): string {
  const suffix = name ? `, ${name.split(' ')[0]}` : '';
  return text
    .replaceAll('{{name_suffix}}', suffix)
    .replaceAll('{{name}}', name?.split(' ')[0] ?? 'kamu')
    .replaceAll('{{user_name}}', name ?? 'kamu')
    .replaceAll('{{label}}', schedule?.label ?? 'jadwal kamu')
    .replaceAll('{{time}}', schedule?.time ?? 'sebentar lagi')
    .replaceAll('{{detail}}', schedule?.detail ? ` — ${schedule.detail}` : '');
}

function newAskId(): string {
  return `ask_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export type DeliveredAsk = {
  ask: typeof rdsaAsks.$inferSelect;
  notification: {
    title: string;
    body: string;
    askId: string;
  };
};

/**
 * Plan + deliver one smart notification (push payload for mobile).
 * Recommendation (RDSA) stays separate from channel delivery.
 */
export async function planAndDeliverAsk(
  userId: number,
  options?: { forceIntent?: string; localHour?: number }
): Promise<DeliveredAsk | null> {
  const selected = await recommendArm(userId, {
    localHour: options?.localHour,
    forceIntent: options?.forceIntent,
    channel: 'push',
  });
  if (!selected) return null;

  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  const scheduleContext = await findScheduleContext(userId, selected.intent);
  const title = renderTemplate(selected.title, user?.name, scheduleContext);
  const body = renderTemplate(selected.body, user?.name, scheduleContext);
  const askId = newAskId();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  const [ask] = await db
    .insert(rdsaAsks)
    .values({
      id: askId,
      userId,
      armId: selected.armId,
      intent: selected.intent,
      title,
      body,
      status: 'delivered',
      channels: ['push'],
      deliveredAt: new Date(),
      expiresAt,
      scheduleId: scheduleContext?.id ?? null,
    })
    .returning();

  await db.insert(notificationEvents).values({
    userId,
    armId: selected.armId,
    askId,
    sentAt: new Date(),
    contextJson: JSON.stringify({
      score: selected.score,
      probability: selected.probability,
      intent: selected.intent,
    }),
  });

  await recordSelection(selected.armId);

  return {
    ask,
    notification: { title, body, askId },
  };
}

export async function expireStaleAsks(userId: number) {
  await db
    .update(rdsaAsks)
    .set({ status: 'expired' })
    .where(
      and(
        eq(rdsaAsks.userId, userId),
        inArray(rdsaAsks.status, ['pending', 'delivered']),
        lt(rdsaAsks.expiresAt, new Date())
      )
    );
}

/**
 * For asks tied to a specific schedule (schedule.* intents), the real success
 * signal is "did the patient actually complete the schedule", not just tapping
 * the notification. Once the compliance window has passed, resolve success/
 * failure into rdsaIntentStatistics based on schedules.done.
 */
export async function resolveAskOutcomes(userId: number) {
  const candidates = await db.query.rdsaAsks.findMany({
    where: and(
      eq(rdsaAsks.userId, userId),
      isNull(rdsaAsks.outcomeResolvedAt)
    ),
  });

  const now = Date.now();

  for (const ask of candidates) {
    if (ask.scheduleId === null) continue;
    if (now - ask.createdAt.getTime() < COMPLIANCE_WINDOW_MS) continue;

    const schedule = await db.query.schedules.findFirst({
      where: eq(schedules.id, ask.scheduleId),
    });
    const success = schedule?.done === true;

    await recordIntentOutcome(ask.userId, ask.intent, success);
    await db
      .update(rdsaAsks)
      .set({ outcomeResolvedAt: new Date() })
      .where(eq(rdsaAsks.id, ask.id));
  }
}

export async function listPendingAsks(userId: number) {
  await expireStaleAsks(userId);
  await resolveAskOutcomes(userId);
  return db.query.rdsaAsks.findMany({
    where: and(
      eq(rdsaAsks.userId, userId),
      inArray(rdsaAsks.status, ['pending', 'delivered'])
    ),
  });
}

export async function acknowledgeAsk(userId: number, askId: string) {
  const ask = await db.query.rdsaAsks.findFirst({
    where: and(eq(rdsaAsks.id, askId), eq(rdsaAsks.userId, userId)),
  });
  if (!ask) return null;

  let updated = ask;

  if (ask.status === 'pending') {
    const [delivered] = await db
      .update(rdsaAsks)
      .set({ status: 'delivered', deliveredAt: new Date() })
      .where(eq(rdsaAsks.id, askId))
      .returning();
    updated = delivered;
  }

  if (updated.status !== 'replied' && !updated.reward) {
    const reward = 1;

    const [rewarded] = await db
      .update(rdsaAsks)
      .set({
        status: 'replied',
        repliedAt: new Date(),
        reward: String(reward),
      })
      .where(eq(rdsaAsks.id, askId))
      .returning();

    await db
      .update(notificationEvents)
      .set({ reward: String(reward), rewardRecordedAt: new Date() })
      .where(eq(notificationEvents.askId, askId));

    await recordReward(updated.armId, reward, true);

    // Schedule-linked asks (schedule.* intents) get their success/failure from
    // actual schedule completion via resolveAskOutcomes, not from tapping ack —
    // only record here for intents with no linked schedule (ask.checkin, insight.tip, etc).
    if (updated.scheduleId === null) {
      await recordIntentOutcome(updated.userId, updated.intent, true);
    }

    return rewarded;
  }

  return updated;
}
