import { db } from '../../db';
import {
  rdsaAsks,
  notificationEvents,
  users,
} from '../../db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { recommendArm, recordSelection, recordReward } from './recommend';

function renderTemplate(text: string, name?: string | null): string {
  const suffix = name ? `, ${name.split(' ')[0]}` : '';
  return text
    .replaceAll('{{name_suffix}}', suffix)
    .replaceAll('{{name}}', name?.split(' ')[0] ?? 'kamu')
    .replaceAll('{{user_name}}', name ?? 'kamu');
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
  const title = renderTemplate(selected.title, user?.name);
  const body = renderTemplate(selected.body, user?.name);
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

export async function listPendingAsks(userId: number) {
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
    return rewarded;
  }

  return updated;
}
