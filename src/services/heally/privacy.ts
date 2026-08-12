import { db } from '../../db';
import { users, userDoctors } from '../../db/schema';
import type { User, MedicalRecord, Schedule } from '../../db/schema';
import { eq } from 'drizzle-orm';
import { isDummyLlm } from '../../config/llm';

const REDACT = '[disamarkan]';

export type PrivacyProfile = {
  pseudonym: string;
  ageRange: string | null;
  redactTerms: string[];
};

/** Cloud LLM calls are sanitized by default; dummy/local can skip via env. */
export function shouldSanitizeForLlm(): boolean {
  if (process.env.LLM_PRIVACY_SANITIZE === 'false') return false;
  return !isDummyLlm();
}

export function computeAgeYears(dateOfBirth: string | null | undefined): number | null {
  if (!dateOfBirth) return null;
  const dob = new Date(dateOfBirth);
  if (Number.isNaN(dob.getTime())) return null;

  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  const monthDiff = now.getMonth() - dob.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < dob.getDate())) {
    age -= 1;
  }
  return age >= 0 && age <= 120 ? age : null;
}

/** Age bucket ±1 year (width 3), e.g. 39 → "38-40 tahun". */
export function computeAgeRange(dateOfBirth: string | null | undefined): string | null {
  const age = computeAgeYears(dateOfBirth);
  if (age === null) return null;
  const low = Math.max(0, age - 1);
  const high = age + 1;
  return `${low}-${high} tahun`;
}

function nameParts(name: string): string[] {
  return name.split(/\s+/).filter((part) => part.length >= 2);
}

export function buildPrivacyProfile(
  user: Pick<User, 'name' | 'email' | 'phone' | 'dateOfBirth'> | null | undefined,
  extraRedactTerms: string[] = []
): PrivacyProfile {
  const terms = new Set<string>(extraRedactTerms.filter(Boolean));

  if (user?.name) {
    terms.add(user.name);
    for (const part of nameParts(user.name)) terms.add(part);
  }
  if (user?.email) terms.add(user.email);
  if (user?.phone) {
    terms.add(user.phone);
    const digits = user.phone.replace(/\D/g, '');
    if (digits.length >= 8) terms.add(digits);
  }

  return {
    pseudonym: 'Pasien',
    ageRange: computeAgeRange(user?.dateOfBirth),
    redactTerms: [...terms],
  };
}

const GENERIC_PATTERNS: Array<{ re: RegExp; repl: string }> = [
  { re: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi, repl: REDACT },
  { re: /(?:\+62|62|0)8[1-9]\d{6,10}/g, repl: REDACT },
  { re: /\b\d{16}\b/g, repl: '[NIK disamarkan]' },
  { re: /\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/g, repl: '[tanggal disamarkan]' },
  { re: /\b\d{4}-\d{2}-\d{2}\b/g, repl: '[tanggal disamarkan]' },
  { re: /(?:Jl\.?|Jalan)\s+[^\n,]{5,120}/gi, repl: '[alamat disamarkan]' },
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function sanitizeTextForLlm(text: string, profile: PrivacyProfile): string {
  if (!text) return text;

  let out = text;
  const sortedTerms = [...profile.redactTerms].sort((a, b) => b.length - a.length);

  for (const term of sortedTerms) {
    if (term.length < 2) continue;
    out = out.replace(new RegExp(escapeRegExp(term), 'gi'), REDACT);
  }

  for (const { re, repl } of GENERIC_PATTERNS) {
    out = out.replace(re, repl);
  }

  return out;
}

export function sanitizeChatHistory(
  history: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }>,
  profile: PrivacyProfile
): Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> {
  return history.map((turn) => ({
    role: turn.role,
    parts: turn.parts.map((part) => ({
      text: sanitizeTextForLlm(part.text, profile),
    })),
  }));
}

/** Approximate record date for LLM (month + year only). */
export function approximateRecordDate(recordDate: string | null, createdAt: Date): string {
  if (recordDate) {
    const isoMatch = recordDate.match(/(\d{4})-(\d{2})/);
    if (isoMatch) {
      const parsed = new Date(`${isoMatch[1]}-${isoMatch[2]}-01`);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed.toLocaleDateString('id-ID', { month: 'long', year: 'numeric' });
      }
    }

    const parsed = new Date(recordDate);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toLocaleDateString('id-ID', { month: 'long', year: 'numeric' });
    }

    return '[periode disamarkan]';
  }

  return createdAt.toLocaleDateString('id-ID', { month: 'long', year: 'numeric' });
}

export function formatClinicalContextForLlm(
  user: User | null | undefined,
  records: MedicalRecord[],
  userSchedules: Schedule[],
  profile: PrivacyProfile
): string {
  const recordsContext = records
    .map((record) => {
      const dateLabel = approximateRecordDate(record.recordDate, record.createdAt);
      const title = sanitizeTextForLlm(record.title, profile);
      const body = sanitizeTextForLlm(record.summary ?? record.content ?? 'No details', profile);
      const doctor = record.doctorName ? ' · Dokter (nama disamarkan)' : '';
      return `- [${record.type}] ${title} (${dateLabel})${doctor}: ${body}`;
    })
    .join('\n');

  const medicationsContext = userSchedules
    .filter((item) => item.type === 'pill')
    .map((item) => {
      const label = sanitizeTextForLlm(item.label, profile);
      const detail = sanitizeTextForLlm(item.detail ?? '', profile);
      return `- ${label}: ${detail} (${item.time}, ${item.done ? 'selesai' : 'belum'})`;
    })
    .join('\n');

  const ageLine = profile.ageRange ? `Rentang usia: ${profile.ageRange}` : 'Rentang usia: tidak diketahui';
  const bloodType = user?.bloodType ? `Golongan darah: ${user.bloodType}` : '';

  return `
KONTEKS KLINIS (de-identified — tanpa identitas pribadi):
Identitas: ${profile.pseudonym} (nama, email, telepon disamarkan)
${ageLine}
${bloodType}
Kondisi Medis: ${sanitizeTextForLlm(user?.conditions ?? 'Tidak diketahui', profile)}
Alergi: ${sanitizeTextForLlm(user?.allergies ?? 'Tidak ada', profile)}

REKAM MEDIS TERBARU (5 terakhir, teks disanitasi):
${recordsContext || 'Belum ada rekam medis'}

OBAT & JADWAL PILL:
${medicationsContext || 'Tidak ada obat aktif'}
`.trim();
}

export async function loadPrivacyProfile(userId: number): Promise<PrivacyProfile> {
  const [user, links] = await Promise.all([
    db.query.users.findFirst({ where: eq(users.id, userId) }),
    db.query.userDoctors.findMany({
      where: eq(userDoctors.userId, userId),
      with: { doctor: { with: { user: true } } },
    }),
  ]);

  const extraTerms: string[] = [];
  for (const link of links) {
    const doctorUser = link.doctor?.user;
    if (doctorUser?.name) {
      extraTerms.push(doctorUser.name);
      extraTerms.push(...nameParts(doctorUser.name));
    }
  }

  return buildPrivacyProfile(user, extraTerms);
}

type DailyLogLike = {
  type: string;
  title: string;
  time: string;
  quantity?: string | null;
  detail?: string | null;
};

/** PTM factors only — no raw questionnaire answers. */
export function formatPtmFactorsForLlm(factors: string[]): string {
  if (factors.length === 0) {
    return 'Screening PTM selesai — tidak ada faktor risiko yang dilaporkan.';
  }
  return `Faktor risiko PTM (${factors.length}): ${factors.join(', ')}`;
}

export function formatDailyLogsAggregate(logs: DailyLogLike[]): string {
  if (logs.length === 0) return 'Belum ada catatan harian.';
  const byType: Record<string, number> = {};
  for (const log of logs) {
    byType[log.type] = (byType[log.type] ?? 0) + 1;
  }
  const breakdown = Object.entries(byType)
    .map(([type, count]) => `${type}: ${count}`)
    .join(', ');
  return `Total ${logs.length} entri (${breakdown})`;
}

/** Sanitized log lines for LLM — titles/details redacted, times kept. */
export function formatDailyLogsForLlm(logs: DailyLogLike[], profile: PrivacyProfile): string {
  if (logs.length === 0) return 'Belum ada catatan harian hari ini.';
  const aggregate = formatDailyLogsAggregate(logs);
  const lines = logs.slice(0, 12).map((log) => {
    const title = sanitizeTextForLlm(log.title, profile);
    const qty = log.quantity ? sanitizeTextForLlm(log.quantity, profile) : '';
    const detail = log.detail ? sanitizeTextForLlm(log.detail, profile) : '';
    const extra = [qty, detail].filter(Boolean).join(' · ');
    return `- ${log.time} [${log.type}] ${title}${extra ? ` (${extra})` : ''}`;
  });
  return `${aggregate}\n${lines.join('\n')}`;
}

export function buildDailyHealthContextForLlm(
  compliance: {
    dailyLogCount: number;
    ptmScreeningDone: boolean;
    ptmFactors: string[];
    dailyLogs: DailyLogLike[];
    scheduleSnapshot: Array<{ isAiGenerated?: boolean }>;
    pendingScheduleIntent: boolean;
  } | null,
  profile: PrivacyProfile,
  date: string
): string {
  if (!compliance) {
    return `
KONTEKS HARIAN (${date}, de-identified):
- Screening PTM: belum diisi
- Catatan harian: belum ada
`.trim();
  }

  const screeningLine = compliance.ptmScreeningDone
    ? formatPtmFactorsForLlm(compliance.ptmFactors)
    : 'belum diisi';

  const logsLine =
    compliance.dailyLogCount > 0
      ? formatDailyLogsForLlm(compliance.dailyLogs, profile)
      : 'belum ada';

  return `
KONTEKS HARIAN (${date}, de-identified):
- Screening PTM: ${screeningLine}
- Catatan harian:
${logsLine}
- Permintaan buat jadwal menunggu konfirmasi: ${compliance.pendingScheduleIntent ? 'ya' : 'tidak'}
`.trim();
}
