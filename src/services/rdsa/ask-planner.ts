import { db } from '../../db';
import {
  heallyAsks,
  chatMessages,
  notificationEvents,
  users,
} from '../../db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { recommendArm, recordSelection, recordReward } from './recommend';
import {
  appendAskCtas,
  getDailyCompliance,
} from '../heally/daily-compliance';

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
  ask: typeof heallyAsks.$inferSelect;
  message: typeof chatMessages.$inferSelect;
  notification: {
    title: string;
    body: string;
    askId: string;
  };
};

/**
 * Plan + deliver one Heally Ask into in-app chat (push payload for mobile).
 * Recommendation (RDSA) stays separate from channel delivery.
 */
export async function planAndDeliverAsk(
  userId: number,
  options?: { forceIntent?: string; localHour?: number }
): Promise<DeliveredAsk | null> {
  const selected = await recommendArm(userId, {
    localHour: options?.localHour,
    forceIntent: options?.forceIntent,
    channel: 'chat',
  });
  if (!selected) return null;

  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  const title = renderTemplate(selected.title, user?.name);
  const body = renderTemplate(selected.body, user?.name);
  const askId = newAskId();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const today = new Date().toISOString().slice(0, 10);
  const compliance = await getDailyCompliance(userId, today);

  const [ask] = await db
    .insert(heallyAsks)
    .values({
      id: askId,
      userId,
      armId: selected.armId,
      intent: selected.intent,
      title,
      body,
      status: 'delivered',
      channels: ['push', 'chat'],
      deliveredAt: new Date(),
      expiresAt,
    })
    .returning();

  let chatContent = `**${title}**\n\n${body}`;
  chatContent = appendAskCtas(chatContent, body, compliance);
  const [message] = await db
    .insert(chatMessages)
    .values({
      userId,
      role: 'assistant',
      content: chatContent,
      needsVerif: false,
      askId,
    })
    .returning();

  await db
    .update(heallyAsks)
    .set({ messageId: message.id })
    .where(eq(heallyAsks.id, askId));

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
    ask: { ...ask, messageId: message.id },
    message,
    notification: { title, body, askId },
  };
}

export async function listPendingAsks(userId: number) {
  return db.query.heallyAsks.findMany({
    where: and(
      eq(heallyAsks.userId, userId),
      inArray(heallyAsks.status, ['pending', 'delivered'])
    ),
  });
}

export async function acknowledgeAsk(userId: number, askId: string) {
  const ask = await db.query.heallyAsks.findFirst({
    where: and(eq(heallyAsks.id, askId), eq(heallyAsks.userId, userId)),
  });
  if (!ask) return null;
  if (ask.status === 'pending') {
    const [updated] = await db
      .update(heallyAsks)
      .set({ status: 'delivered', deliveredAt: new Date() })
      .where(eq(heallyAsks.id, askId))
      .returning();
    return updated;
  }
  return ask;
}

/** Binary reward v1: reply within window = 1, else caller may pass 0 on expire. */
export async function rewardAskOnUserReply(userId: number, askId?: string | null) {
  let ask =
    askId != null
      ? await db.query.heallyAsks.findFirst({
          where: and(eq(heallyAsks.id, askId), eq(heallyAsks.userId, userId)),
        })
      : null;

  if (!ask) {
    // attribute to latest unreplied delivered ask (2h window)
    const recent = await listPendingAsks(userId);
    const cutoff = Date.now() - 2 * 60 * 60 * 1000;
    ask =
      recent
        .filter((a) => a.status === 'delivered' && a.deliveredAt && a.deliveredAt.getTime() >= cutoff)
        .sort((a, b) => (b.deliveredAt?.getTime() ?? 0) - (a.deliveredAt?.getTime() ?? 0))[0] ?? null;
  }

  if (!ask || ask.status === 'replied') return null;

  const reward = 1;
  await db
    .update(heallyAsks)
    .set({ status: 'replied', repliedAt: new Date(), reward: String(reward) })
    .where(eq(heallyAsks.id, ask.id));

  await db
    .update(notificationEvents)
    .set({ reward: String(reward), rewardRecordedAt: new Date() })
    .where(eq(notificationEvents.askId, ask.id));

  await recordReward(ask.armId, reward, true);
  return ask;
}
