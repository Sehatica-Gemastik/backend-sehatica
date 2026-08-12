import { db } from '../../db';
import {
  medicalRecords,
  schedules,
  users,
  rdsaAsks,
  notificationEvents,
} from '../../db/schema';
import { eq, desc, and, gte } from 'drizzle-orm';
import {
  formatClinicalContextForLlm,
  loadPrivacyProfile,
  shouldSanitizeForLlm,
} from './privacy';

async function fetchClinicalBundle(userId: number) {
  return Promise.all([
    db.query.users.findFirst({ where: eq(users.id, userId) }),
    db.query.medicalRecords.findMany({
      where: eq(medicalRecords.userId, userId),
      orderBy: [desc(medicalRecords.createdAt)],
      limit: 5,
    }),
    db.query.schedules.findMany({
      where: eq(schedules.userId, userId),
      limit: 30,
    }),
  ]);
}

/** Clinical context — full profile for internal/DB use. */
export async function buildClinicalContext(userId: number): Promise<string> {
  const [user, records, userSchedules] = await fetchClinicalBundle(userId);

  const recordsContext = records
    .map(
      (r) =>
        `- [${r.type}] ${r.title} (${r.recordDate ?? r.createdAt.toLocaleDateString('id-ID')}): ${r.summary ?? r.content ?? 'No details'}`
    )
    .join('\n');

  const medicationsContext = userSchedules
    .filter((s) => s.type === 'pill')
    .map((s) => `- ${s.label}: ${s.detail ?? ''} (${s.time}, ${s.done ? 'selesai' : 'belum'})`)
    .join('\n');

  return `
KONTEKS KLINIS:
Nama: ${user?.name ?? 'Pasien'}
Kondisi Medis: ${user?.conditions ?? 'Tidak diketahui'}
Alergi: ${user?.allergies ?? 'Tidak ada'}

REKAM MEDIS TERBARU (5 terakhir):
${recordsContext || 'Belum ada rekam medis'}

OBAT & JADWAL PILL:
${medicationsContext || 'Tidak ada obat aktif'}
`.trim();
}

/** De-identified clinical context for external cloud LLM APIs. */
export async function buildClinicalContextForLlm(userId: number): Promise<string> {
  const [user, records, userSchedules] = await fetchClinicalBundle(userId);
  const profile = await loadPrivacyProfile(userId);
  return formatClinicalContextForLlm(user, records, userSchedules, profile);
}

export async function buildClinicalContextForProvider(userId: number): Promise<string> {
  if (shouldSanitizeForLlm()) {
    return buildClinicalContextForLlm(userId);
  }
  return buildClinicalContext(userId);
}

/**
 * Lightweight behavioural context from existing DB (schedules, asks, RDSA events).
 */
export async function buildBehaviourContext(userId: number): Promise<{
  text: string;
  summaryLines: string[];
}> {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [schedulesList, asks, recentEvents] = await Promise.all([
    db.query.schedules.findMany({ where: eq(schedules.userId, userId), limit: 40 }),
    db.query.rdsaAsks.findMany({
      where: eq(rdsaAsks.userId, userId),
      orderBy: [desc(rdsaAsks.createdAt)],
      limit: 20,
    }),
    db.query.notificationEvents.findMany({
      where: and(eq(notificationEvents.userId, userId), gte(notificationEvents.sentAt, weekAgo)),
      limit: 30,
    }),
  ]);

  const today = new Date().toISOString().slice(0, 10);
  const todaySchedules = schedulesList.filter((s) => s.scheduleDate === today);
  const doneToday = todaySchedules.filter((s) => s.done).length;
  const totalToday = todaySchedules.length;
  const adherenceRate =
    totalToday > 0 ? Math.round((doneToday / totalToday) * 100) : null;

  const deliveredAsks = asks.filter((a) => a.status === 'delivered' || a.status === 'replied');
  const repliedAsks = asks.filter((a) => a.status === 'replied');
  const appReplyRate =
    deliveredAsks.length > 0
      ? Math.round((repliedAsks.length / deliveredAsks.length) * 100)
      : null;

  const pendingAsks = asks.filter((a) => a.status === 'delivered').length;

  const lastReplied = repliedAsks.sort(
    (a, b) => (b.repliedAt?.getTime() ?? 0) - (a.repliedAt?.getTime() ?? 0)
  )[0];
  const silenceDays = lastReplied?.repliedAt
    ? Math.floor((Date.now() - lastReplied.repliedAt.getTime()) / 86400000)
    : null;

  const hour = new Date().getHours();
  const summaryLines: string[] = [];
  if (adherenceRate !== null) {
    summaryLines.push(`Kepatuhan jadwal hari ini: ${doneToday}/${totalToday} (${adherenceRate}%)`);
  }
  if (pendingAsks > 0) summaryLines.push(`${pendingAsks} notifikasi menunggu ack`);
  if (silenceDays !== null && silenceDays > 0) {
    summaryLines.push(`Diam ${silenceDays} hari sejak ack notifikasi terakhir`);
  }
  if (appReplyRate !== null) {
    summaryLines.push(`Ack rate notifikasi (rolling): ${appReplyRate}%`);
  }
  summaryLines.push(`Jam lokal: ${hour}:00 · channel utama: push`);
  if (recentEvents.length > 0) {
    summaryLines.push(`Notifikasi/RDSA 7 hari: ${recentEvents.length} event`);
  }

  const text = `
KONTEKS PERILAKU (derived v1):
- Kepatuhan jadwal hari ini: ${adherenceRate !== null ? `${adherenceRate}% (${doneToday}/${totalToday})` : 'belum ada jadwal'}
- Notifikasi pending ack: ${pendingAsks}
- Hari sejak ack notifikasi terakhir: ${silenceDays ?? 0}
- Ack rate notifikasi: ${appReplyRate !== null ? `${appReplyRate}%` : 'belum cukup data'}
- Notifikasi terkirim 7 hari: ${recentEvents.length}
- Prefer channel: push
`.trim();

  return { text, summaryLines };
}
