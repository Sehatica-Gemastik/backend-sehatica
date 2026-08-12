import { db } from '../../db';
import { userDailyCompliance } from '../../db/schema';
import { and, eq } from 'drizzle-orm';

export type ScheduleSnapshotItem = {
  type: string;
  label: string;
  time: string;
  done: boolean;
  isAiGenerated?: boolean;
};

export type DailyLogSnapshot = {
  type: string;
  title: string;
  time: string;
  quantity?: string | null;
  detail?: string | null;
};

export type DailySyncPayload = {
  date: string;
  dailyLogCount: number;
  ptmScreeningDone: boolean;
  ptmFactors?: string[];
  dailyLogs?: DailyLogSnapshot[];
  scheduleSnapshot?: ScheduleSnapshotItem[];
};

export type DailyComplianceRow = {
  dailyLogCount: number;
  ptmScreeningDone: boolean;
  ptmFactors: string[];
  dailyLogs: DailyLogSnapshot[];
  scheduleSnapshot: ScheduleSnapshotItem[];
  pendingScheduleIntent: boolean;
};

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

export function isSchedulePrerequisitesMet(compliance: DailyComplianceRow | null): boolean {
  if (!compliance) return false;
  return compliance.ptmScreeningDone && compliance.dailyLogCount >= 1;
}

export function parseComplianceRow(
  row: typeof userDailyCompliance.$inferSelect | null | undefined
): DailyComplianceRow | null {
  if (!row) return null;
  let ptmFactors: string[] = [];
  let dailyLogs: DailyLogSnapshot[] = [];
  let scheduleSnapshot: ScheduleSnapshotItem[] = [];
  try {
    const parsedFactors = JSON.parse(row.ptmFactorsJson);
    if (Array.isArray(parsedFactors)) {
      ptmFactors = parsedFactors.filter((v): v is string => typeof v === 'string');
    }
  } catch {
    // ignore invalid json
  }
  try {
    const parsedLogs = JSON.parse(row.dailyLogsJson);
    if (Array.isArray(parsedLogs)) {
      dailyLogs = parsedLogs.filter(
        (v): v is DailyLogSnapshot =>
          v != null &&
          typeof v === 'object' &&
          typeof v.title === 'string' &&
          typeof v.time === 'string'
      );
    }
  } catch {
    // ignore invalid json
  }
  try {
    const parsedSchedule = JSON.parse(row.scheduleSnapshotJson);
    if (Array.isArray(parsedSchedule)) scheduleSnapshot = parsedSchedule;
  } catch {
    // ignore invalid json
  }
  return {
    dailyLogCount: row.dailyLogCount,
    ptmScreeningDone: row.ptmScreeningDone,
    ptmFactors,
    dailyLogs,
    scheduleSnapshot,
    pendingScheduleIntent: row.pendingScheduleIntent,
  };
}

export async function getDailyCompliance(
  userId: number,
  date = todayStr()
): Promise<DailyComplianceRow | null> {
  const row = await db.query.userDailyCompliance.findFirst({
    where: and(
      eq(userDailyCompliance.userId, userId),
      eq(userDailyCompliance.complianceDate, date)
    ),
  });
  return parseComplianceRow(row);
}

export function formatDailyLogsForContext(logs: DailyLogSnapshot[]): string {
  if (logs.length === 0) return 'Belum ada catatan harian hari ini.';
  return logs
    .slice(0, 20)
    .map((log) => {
      const qty = log.quantity ? ` (${log.quantity})` : '';
      const detail = log.detail ? ` — ${log.detail}` : '';
      return `- ${log.time} [${log.type}] ${log.title}${qty}${detail}`;
    })
    .join('\n');
}

export async function setPendingScheduleIntent(
  userId: number,
  date: string,
  pending: boolean
): Promise<void> {
  const existing = await db.query.userDailyCompliance.findFirst({
    where: and(
      eq(userDailyCompliance.userId, userId),
      eq(userDailyCompliance.complianceDate, date)
    ),
  });

  if (existing) {
    await db
      .update(userDailyCompliance)
      .set({ pendingScheduleIntent: pending, syncedAt: new Date() })
      .where(eq(userDailyCompliance.id, existing.id));
    return;
  }

  await db.insert(userDailyCompliance).values({
    userId,
    complianceDate: date,
    pendingScheduleIntent: pending,
  });
}

export async function upsertDailyCompliance(userId: number, payload: DailySyncPayload) {
  const factors = (payload.ptmFactors ?? []).slice(0, 20);
  const snapshot = (payload.scheduleSnapshot ?? []).slice(0, 60);
  const logs = (payload.dailyLogs ?? []).slice(0, 40);
  const logCount = Math.max(0, payload.dailyLogCount, logs.length);

  const existing = await db.query.userDailyCompliance.findFirst({
    where: and(
      eq(userDailyCompliance.userId, userId),
      eq(userDailyCompliance.complianceDate, payload.date)
    ),
  });

  if (existing) {
    const [updated] = await db
      .update(userDailyCompliance)
      .set({
        dailyLogCount: logCount,
        ptmScreeningDone: payload.ptmScreeningDone,
        ptmFactorsJson: JSON.stringify(factors),
        dailyLogsJson: JSON.stringify(logs),
        scheduleSnapshotJson: JSON.stringify(snapshot),
        syncedAt: new Date(),
      })
      .where(eq(userDailyCompliance.id, existing.id))
      .returning();
    return updated;
  }

  const [created] = await db
    .insert(userDailyCompliance)
    .values({
      userId,
      complianceDate: payload.date,
      dailyLogCount: logCount,
      ptmScreeningDone: payload.ptmScreeningDone,
      ptmFactorsJson: JSON.stringify(factors),
      dailyLogsJson: JSON.stringify(logs),
      scheduleSnapshotJson: JSON.stringify(snapshot),
    })
    .returning();
  return created;
}

const DAILY_LOG_HINTS = [
  'catatan hari',
  'catat gejala',
  'skala 1',
  'energi hari',
  'nafsu makan',
  'minum air cukup',
  'sudah makan',
  'gejala hari',
  'catat aktivitas',
  'minum obat kemarin',
  'update kondisi',
  'balas singkat saja',
  'cerita singkat',
  'kondisi hari ini',
  'mau sehatica catat',
];

const PTM_HINTS = [
  'screening',
  'faktor risiko',
  'ptm',
  'perilaku merokok',
  'tekanan darah',
  'gula darah',
  'kolesterol',
  'berat badan',
  'cek faktor',
];

export function isDailyLogAsk(arm: { title: string; body: string; intent: string }): boolean {
  const text = `${arm.title} ${arm.body}`.toLowerCase();
  return DAILY_LOG_HINTS.some((hint) => text.includes(hint));
}

export function isPtmScreeningAsk(arm: { title: string; body: string; intent: string }): boolean {
  if (arm.intent === 'nudge.records') return true;
  const text = `${arm.title} ${arm.body}`.toLowerCase();
  return PTM_HINTS.some((hint) => text.includes(hint));
}

export function shouldSuppressArm(
  arm: { title: string; body: string; intent: string },
  compliance: DailyComplianceRow | null
): boolean {
  if (!compliance) return false;
  if (compliance.ptmScreeningDone && isPtmScreeningAsk(arm)) return true;
  if (compliance.dailyLogCount >= 1 && isDailyLogAsk(arm)) return true;
  return false;
}

export function scheduleFlagsFromSnapshot(snapshot: ScheduleSnapshotItem[]) {
  return {
    hasPill: snapshot.some((s) => s.type === 'pill'),
    hasExercise: snapshot.some((s) => s.type === 'exercise'),
    hasFood: snapshot.some((s) => s.type === 'food'),
    hasWater: snapshot.some((s) => s.type === 'water'),
    hasMissed: snapshot.some((s) => !s.done),
    hasAiGenerated: snapshot.some((s) => s.isAiGenerated),
  };
}
