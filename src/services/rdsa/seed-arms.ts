import { db } from '../../db';
import { notificationArms, notificationArmStatistics } from '../../db/schema';
import armsSeed from '../../data/notification-arms.json';

type SeedArm = {
  arm_id: string;
  intent: string;
  channels: string[];
  title: string;
  body: string;
  tone?: string;
  locale?: string;
};

export async function seedNotificationArms() {
  const arms = armsSeed as SeedArm[];
  let upserted = 0;
  for (const arm of arms) {
    await db
      .insert(notificationArms)
      .values({
        armId: arm.arm_id,
        intent: arm.intent,
        channels: arm.channels,
        title: arm.title,
        body: arm.body,
        tone: arm.tone ?? 'warm',
        locale: arm.locale ?? 'id',
        enabled: true,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: notificationArms.armId,
        set: {
          intent: arm.intent,
          channels: arm.channels,
          title: arm.title,
          body: arm.body,
          tone: arm.tone ?? 'warm',
          updatedAt: new Date(),
        },
      });
    await db
      .insert(notificationArmStatistics)
      .values({ armId: arm.arm_id })
      .onConflictDoNothing();
    upserted += 1;
  }
  return upserted;
}
