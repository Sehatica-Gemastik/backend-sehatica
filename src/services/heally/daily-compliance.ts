import { db } from '../../db';
import { chatMessages, userDailyCompliance } from '../../db/schema';
import { and, desc, eq } from 'drizzle-orm';

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
  checkResume?: boolean;
};

export type DailyComplianceRow = {
  dailyLogCount: number;
  ptmScreeningDone: boolean;
  ptmFactors: string[];
  dailyLogs: DailyLogSnapshot[];
  scheduleSnapshot: ScheduleSnapshotItem[];
  pendingScheduleIntent: boolean;
};

export type ScheduleConfirmPromptResult = {
  confirmPromptSent: true;
  messageId: number;
  content: string;
};

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

export function isSchedulePrerequisitesMet(compliance: DailyComplianceRow | null): boolean {
  if (!compliance) return false;
  return compliance.ptmScreeningDone && compliance.dailyLogCount >= 1;
}

export function isScheduleIntentMessage(message: string): boolean {
  return /jadwal|schedule|rutin harian|buatkan.*(makan|olahraga)|generate.*schedule/i.test(
    message
  );
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

export function buildDailyHealthContextText(compliance: DailyComplianceRow | null, date: string): string {
  if (!compliance) {
    return `
KONTEKS HARIAN (${date}):
- Screening PTM: belum diisi
- Catatan harian: belum ada
- Jadwal AI hari ini: belum dibuat
`.trim();
  }

  const screeningLine = compliance.ptmScreeningDone
    ? `sudah diisi — faktor: ${compliance.ptmFactors.join(', ') || 'tidak ada'}`
    : 'belum diisi';

  const logsLine =
    compliance.dailyLogCount > 0
      ? `${compliance.dailyLogCount} entri`
      : 'belum ada';

  const aiSchedule = compliance.scheduleSnapshot.some((s) => s.isAiGenerated);

  return `
KONTEKS HARIAN (${date}):
- Screening PTM: ${screeningLine}
- Catatan harian: ${logsLine}
${compliance.dailyLogCount > 0 ? formatDailyLogsForContext(compliance.dailyLogs) : ''}
- Jadwal AI hari ini: ${aiSchedule ? 'sudah ada' : 'belum dibuat'}
- Menunggu kelengkapan untuk buat jadwal: ${compliance.pendingScheduleIntent ? 'ya' : 'tidak'}
`.trim();
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

export async function tryScheduleReadyConfirmation(
  userId: number,
  date: string
): Promise<ScheduleConfirmPromptResult | null> {
  const row = await db.query.userDailyCompliance.findFirst({
    where: and(
      eq(userDailyCompliance.userId, userId),
      eq(userDailyCompliance.complianceDate, date)
    ),
  });
  const compliance = parseComplianceRow(row);
  if (!compliance?.pendingScheduleIntent || !isSchedulePrerequisitesMet(compliance)) {
    return null;
  }

  const recent = await db.query.chatMessages.findMany({
    where: eq(chatMessages.userId, userId),
    orderBy: [desc(chatMessages.createdAt)],
    limit: 12,
  });
  const alreadyPrompted = recent.some(
    (msg) =>
      msg.role === 'assistant' &&
      msg.content.includes('Apakah mau saya buatkan jadwal') &&
      msg.createdAt.toISOString().slice(0, 10) === date
  );
  if (alreadyPrompted) return null;

  const content = appendCtasToContent(
    buildScheduleConfirmMessage(compliance),
    ['[HEALLY_CTA:generate_schedule|Ya, buatkan jadwal]']
  );

  const [aiMsg] = await db
    .insert(chatMessages)
    .values({
      userId,
      role: 'assistant',
      content,
      needsVerif: false,
      thinkingSummary: 'Konfirmasi buat jadwal',
      thinkingDetail: [
        'Memverifikasi screening PTM',
        'Memverifikasi catatan harian',
        'Menyiapkan konfirmasi jadwal',
      ].join('\n'),
    })
    .returning();

  return {
    confirmPromptSent: true,
    messageId: aiMsg.id,
    content,
  };
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
  'mau heally catat',
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

export function buildHeallyCtas(
  compliance: DailyComplianceRow | null,
  userMessage?: string
): string[] {
  const ctas: string[] = [];
  const wantsSchedule = isScheduleIntentMessage(userMessage ?? '');
  const ready = isSchedulePrerequisitesMet(compliance);

  if (!compliance?.ptmScreeningDone) {
    ctas.push('[HEALLY_CTA:open_screening|Isi screening risiko PTM]');
  }
  if ((compliance?.dailyLogCount ?? 0) < 1) {
    ctas.push('[HEALLY_CTA:open_daily_log|Catat aktivitas hari ini]');
  }
  if (ready && (wantsSchedule || compliance?.pendingScheduleIntent)) {
    ctas.push('[HEALLY_CTA:generate_schedule|Ya, buatkan jadwal]');
  }
  return ctas;
}

export function appendCtasToContent(content: string, ctas: string[]): string {
  if (ctas.length === 0) return content;
  const block = ctas.join('\n');
  if (content.includes('[HEALLY_CTA:')) return content;
  return `${content.trim()}\n\n${block}`;
}

export function appendAskCtas(content: string, body: string, compliance: DailyComplianceRow | null): string {
  if (/jadwal|olahraga ringan|jadwalmu/i.test(body)) {
    if (isSchedulePrerequisitesMet(compliance)) {
      return appendCtasToContent(content, ['[HEALLY_CTA:generate_schedule|Buat jadwal sekarang]']);
    }
  }
  return content;
}

export function buildScheduleConfirmMessage(compliance: DailyComplianceRow | null): string {
  const factorCount = compliance?.ptmFactors.length ?? 0;
  const logCount = compliance?.dailyLogCount ?? 0;
  const factorLine =
    factorCount > 0
      ? `${factorCount} faktor risiko PTM perlu diperhatikan`
      : 'screening PTM selesai tanpa faktor tambahan';

  return `Screening dan catatan hari ini sudah lengkap (${factorLine}, ${logCount} catatan).

**Apakah mau saya buatkan jadwal harian** berdasarkan data tersebut?`;
}

export function buildScheduleWaitingMessage(compliance: DailyComplianceRow | null): string {
  const missing: string[] = [];
  if (!compliance?.ptmScreeningDone) missing.push('**screening risiko PTM**');
  if ((compliance?.dailyLogCount ?? 0) < 1) missing.push('**catatan hari ini**');

  if (missing.length === 0) {
    return 'Data sudah lengkap. Buka chat ini lagi nanti — saya akan konfirmasi apakah Anda ingin jadwal dibuat.';
  }

  return `Sebelum jadwal bisa dibuat, lengkapi dulu ${missing.join(' dan ')}. Setelah selesai, saya akan **konfirmasi** apakah Anda ingin jadwal dibuat — tidak otomatis.`;
}

export function getScheduleThinkingSteps(): string[] {
  return [
    'Membaca screening risiko PTM…',
    'Membaca catatan harian…',
    'Menyusun jadwal makan & olahraga…',
    'Menyesuaikan dengan kondisi pasien…',
  ];
}
