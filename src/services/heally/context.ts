import { db } from '../../db';
import {
  medicalRecords,
  schedules,
  users,
  heallyAsks,
  chatMessages,
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
 * Lightweight behavioural context from existing DB (v1 — no behaviour_events table yet).
 * Aligns with Heally_Plan §4 using schedules, asks, chat, RDSA events.
 */
export async function buildBehaviourContext(userId: number): Promise<{
  text: string;
  summaryLines: string[];
}> {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [schedulesList, asks, recentUserMsgs, recentEvents] = await Promise.all([
    db.query.schedules.findMany({ where: eq(schedules.userId, userId), limit: 40 }),
    db.query.heallyAsks.findMany({
      where: eq(heallyAsks.userId, userId),
      orderBy: [desc(heallyAsks.createdAt)],
      limit: 20,
    }),
    db.query.chatMessages.findMany({
      where: and(eq(chatMessages.userId, userId), eq(chatMessages.role, 'user')),
      orderBy: [desc(chatMessages.createdAt)],
      limit: 1,
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

  const lastUserMsg = recentUserMsgs[0];
  const silenceDays = lastUserMsg
    ? Math.floor((Date.now() - new Date(lastUserMsg.createdAt).getTime()) / (86400000))
    : null;

  const hour = new Date().getHours();
  const summaryLines: string[] = [];
  if (adherenceRate !== null) {
    summaryLines.push(`Kepatuhan jadwal hari ini: ${doneToday}/${totalToday} (${adherenceRate}%)`);
  }
  if (pendingAsks > 0) summaryLines.push(`${pendingAsks} ask Heally menunggu balasan`);
  if (silenceDays !== null && silenceDays > 0) {
    summaryLines.push(`Diam ${silenceDays} hari sejak chat terakhir`);
  }
  if (appReplyRate !== null) {
    summaryLines.push(`Reply rate ask app (rolling): ${appReplyRate}%`);
  }
  summaryLines.push(`Jam lokal: ${hour}:00 · channel utama: app (WhatsApp belum aktif)`);
  if (recentEvents.length > 0) {
    summaryLines.push(`Notifikasi/RDSA 7 hari: ${recentEvents.length} event`);
  }

  const text = `
KONTEKS PERILAKU (derived v1):
- Kepatuhan jadwal hari ini: ${adherenceRate !== null ? `${adherenceRate}% (${doneToday}/${totalToday})` : 'belum ada jadwal'}
- Ask pending: ${pendingAsks}
- Hari sejak balasan chat terakhir: ${silenceDays ?? 0}
- Reply rate ask in-app: ${appReplyRate !== null ? `${appReplyRate}%` : 'belum cukup data'}
- Notifikasi terkirim 7 hari: ${recentEvents.length}
- Prefer channel: app (WA sync belum live)
`.trim();

  return { text, summaryLines };
}

export function getHeallySystemPrompt(clinicalContext: string, behaviourContext: string): string {
  return `Kamu adalah Heally, asisten kesehatan AI dari aplikasi Sehatica yang cerdas, empatik, dan selalu membantu.

${clinicalContext}

${behaviourContext}

PANDUAN PENTING:
1. Gunakan bahasa Indonesia yang ramah, jelas, dan mudah dipahami
2. Personalisasi respons berdasarkan rekam medis, jadwal, DAN sinyal perilaku di atas
3. Untuk saran medis spesifik (dosis, terapi, lab), WAJIB tambahkan baris:
   [PERINGATAN] Saran ini dihasilkan AI dan perlu diverifikasi dokter sebelum diterapkan.
4. Jangan pernah menggantikan konsultasi dokter
5. Format respons dengan markdown standar:
   - gunakan ## untuk judul bagian dan - untuk bullet
   - **bold** untuk poin penting
   - code fence (tiga backtick) untuk contoh kode / dosis jika perlu
   - Baris peringatan diawali [PERINGATAN] (tanpa emoji)
6. Batasi respons maksimal 400 kata
7. Darurat medis → arahkan ke IGD/dokter
8. Jadwal harian dibuat per hari (food/exercise/water) berdasarkan screening PTM & catatan harian — obat manual tidak dibuat AI
9. Jika pasien belum screening PTM / catatan hari ini, arahkan lewat CTA (bukan teks panjang)
10. Format CTA opsional di akhir respons (server menambahkan): [HEALLY_CTA:generate_schedule|...] [HEALLY_CTA:open_screening|...] [HEALLY_CTA:open_daily_log|...]

Jika model reasoning aktif, pisahkan proses berpikir dari jawaban akhir. Jawaban ke user harus langsung actionable.`;
}

/** Steps shown in UI while waiting (matches context we inject). */
export function getThinkingDraftSteps(): string[] {
  return [
    'Memeriksa rekam medis & kondisi…',
    'Membaca screening PTM & catatan hari ini…',
    'Menilai jadwal obat hari ini…',
    'Menyusun jawaban personal…',
  ];
}

export function summarizeThinking(detail: string): string {
  const cleaned = detail.replace(/\s+/g, ' ').trim();
  if (!cleaned) return 'Proses berpikir Heally';
  return cleaned.length > 72 ? `${cleaned.slice(0, 69)}…` : cleaned;
}
