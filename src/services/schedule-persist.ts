import { db } from '../db';
import { schedules } from '../db/schema';
import { and, eq } from 'drizzle-orm';

const colorMap: Record<string, string> = {
  orange: 'bg-orange-100 text-orange-600',
  blue: 'bg-blue-100 text-blue-600',
  green: 'bg-green-100 text-green-600',
  cyan: 'bg-cyan-100 text-cyan-600',
  yellow: 'bg-yellow-100 text-yellow-600',
  red: 'bg-red-100 text-red-600',
  purple: 'bg-purple-100 text-purple-600',
};

export type GeneratedScheduleItem = {
  type: string;
  label: string;
  detail: string;
  time: string;
  colorScheme: string;
};

export async function persistGeneratedSchedule(
  userId: number,
  date: string,
  items: GeneratedScheduleItem[]
) {
  const safeItems = items.filter((item) => ['food', 'exercise', 'water'].includes(item.type));

  const existingAi = await db.query.schedules.findMany({
    where: and(
      eq(schedules.userId, userId),
      eq(schedules.scheduleDate, date),
      eq(schedules.isAiGenerated, true)
    ),
  });
  for (const s of existingAi) {
    await db.delete(schedules).where(eq(schedules.id, s.id));
  }

  for (const item of safeItems) {
    const color = colorMap[item.colorScheme] ?? colorMap.blue;
    await db.insert(schedules).values({
      userId,
      type: item.type as 'food' | 'exercise' | 'water',
      label: item.label,
      detail: item.detail,
      time: item.time,
      scheduleDate: date,
      isAiGenerated: true,
      colorScheme: color,
    });
  }

  return safeItems;
}
