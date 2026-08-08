import { db } from '../db';
import { medicalRecords, schedules, users } from '../db/schema';
import { eq, desc } from 'drizzle-orm';
import { getLlmProvider, dummyProvider, LlmRateLimitError, LlmAuthError } from './llm/provider';
import { isDummyLlm, llmConfig, resolveActiveApiKey } from '../config/llm';

// ── Text generation via configurable LLM provider (default: dummy) ────────
async function generateText(prompt: string, systemInstruction?: string): Promise<string> {
  const result = await getLlmProvider().generateText(prompt, systemInstruction);
  return result.text;
}

// ── Vision OCR — still Gemini when key present; dummy OCR otherwise ───────
async function generateTextWithImage(prompt: string, imageBase64: string, mimeType = 'image/jpeg'): Promise<string> {
  if (isDummyLlm() || !resolveActiveApiKey()) {
    return JSON.stringify({
      extractedText: '(dummy OCR) Teks dokumen tidak diekstrak — set LLM_PROVIDER=gemini + GEMINI_API_KEY.',
      title: 'Dokumen Medis (dummy)',
      summary: 'OCR dummy untuk local development.',
      tags: ['Dokumen', 'Dummy'],
      recordType: 'image',
    });
  }

  const model = llmConfig.model || 'gemini-2.0-flash';
  const base = llmConfig.baseUrl || 'https://generativelanguage.googleapis.com/v1beta';
  const key = resolveActiveApiKey();
  const body = {
    contents: [{
      role: 'user',
      parts: [
        { text: prompt },
        { inlineData: { mimeType, data: imageBase64 } },
      ],
    }],
    generationConfig: { temperature: 0.3, maxOutputTokens: 4096 },
  };

  const response = await fetch(
    `${base}/models/${model}:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );

  if (!response.ok) {
    throw new Error(`Gemini Vision error: ${response.status}`);
  }

  const data = await response.json() as {
    candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
  };

  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}

// ── Build user medical context for system prompt ───────────────────────────
async function buildUserContext(userId: number): Promise<string> {
  const [user, records, todaySchedules] = await Promise.all([
    db.query.users.findFirst({ where: eq(users.id, userId) }),
    db.query.medicalRecords.findMany({
      where: eq(medicalRecords.userId, userId),
      orderBy: [desc(medicalRecords.createdAt)],
      limit: 5,
    }),
    db.query.schedules.findMany({
      where: eq(schedules.userId, userId),
      limit: 20,
    }),
  ]);

  const recordsContext = records.map(r =>
    `- [${r.type}] ${r.title} (${r.recordDate ?? r.createdAt.toLocaleDateString('id-ID')}): ${r.summary ?? r.content ?? 'No details'}`
  ).join('\n');

  const medicationsContext = todaySchedules
    .filter(s => s.type === 'pill')
    .map(s => `- ${s.label}: ${s.detail}`)
    .join('\n');

  const conditions = user?.conditions ?? 'Tidak diketahui';

  return `
KONTEKS PASIEN:
Nama: ${user?.name ?? 'Pasien'}
Kondisi Medis: ${conditions}
Alergi: ${user?.allergies ?? 'Tidak ada'}

REKAM MEDIS TERBARU (5 terakhir):
${recordsContext || 'Belum ada rekam medis'}

OBAT AKTIF:
${medicationsContext || 'Tidak ada obat aktif'}
`.trim();
}

// ── Heally System Prompt ───────────────────────────────────────────────────
function getHeallySystemPrompt(userContext: string): string {
  return `Kamu adalah Heally, asisten kesehatan AI dari aplikasi Sehatica yang cerdas, empatik, dan selalu membantu.

${userContext}

PANDUAN PENTING:
1. Gunakan bahasa Indonesia yang ramah, jelas, dan mudah dipahami
2. Selalu personalisasi respons berdasarkan rekam medis dan kondisi pasien di atas
3. Untuk setiap saran medis yang spesifik (dosis obat, perubahan terapi, interpretasi hasil lab), WAJIB tambahkan:
   ⚠️ *Saran ini dihasilkan AI dan perlu diverifikasi dokter sebelum diterapkan.*
4. Jangan pernah menggantikan konsultasi dokter
5. Format respons dengan markdown sederhana (bold, bullet points)
6. Batasi respons maksimal 400 kata untuk kenyamanan membaca di mobile
7. Untuk pertanyaan darurat medis, selalu arahkan ke IGD/dokter terdekat

Saran medis kritis yang HARUS ditandai untuk verifikasi dokter:
- Interaksi obat-obatan
- Perubahan dosis atau jadwal obat
- Interpretasi hasil laboratorium
- Rekomendasi diet khusus untuk kondisi medis
- Gejala yang memerlukan evaluasi medis`;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Chat with Heally AI
 */
export async function chatWithHeally(
  userId: number,
  conversationHistory: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }>,
  userMessage: string
): Promise<{ content: string; needsVerif: boolean; provider: string; model: string }> {
  const userContext = await buildUserContext(userId);
  const systemInstruction = getHeallySystemPrompt(userContext);
  const llm = getLlmProvider();

  let result;
  try {
    result = await llm.generateChat(systemInstruction, conversationHistory, userMessage);
  } catch (err) {
    if (llm.name === 'gemini' && (err instanceof LlmRateLimitError || err instanceof LlmAuthError)) {
      const reason =
        err instanceof LlmAuthError
          ? err.message
          : 'Kuota Gemini free tier penuh sementara. Tunggu ~1 menit lalu coba lagi.';
      console.warn('[heally] Gemini unavailable —', reason);
      const fallback = await dummyProvider.generateChat(
        systemInstruction,
        conversationHistory,
        userMessage
      );
      result = {
        text: `*${reason}*\n\n${fallback.text}`,
        provider: 'dummy-fallback',
        model: 'dummy-local',
      };
    } else {
      throw err;
    }
  }

  const content = result.text;

  const lower = content.toLowerCase();
  const needsVerif =
    content.includes('⚠️') ||
    lower.includes('verifikasi dokter') ||
    lower.includes('konsultasikan dengan dokter') ||
    /\b(dosis|interaksi obat)\b/i.test(content);

  return { content, needsVerif, provider: result.provider, model: result.model };
}

/**
 * OCR medical document image
 */
export async function ocrMedicalDocument(imageBase64: string, mimeType = 'image/jpeg'): Promise<{
  extractedText: string;
  title: string;
  summary: string;
  tags: string[];
  recordType: string;
}> {
  const prompt = `Kamu adalah sistem OCR untuk dokumen medis Indonesia. Analisis gambar ini dan:

1. Ekstrak SEMUA teks yang terlihat dari dokumen
2. Identifikasi jenis dokumen (hasil lab, resep, catatan dokter, dll)
3. Buat judul singkat dokumen
4. Buat ringkasan 1-2 kalimat dalam bahasa Indonesia
5. Berikan 2-4 tag relevan (contoh: Laboratorium, Hipertensi, Resep)

Balas HANYA dalam format JSON berikut:
{
  "extractedText": "teks lengkap yang diekstrak",
  "title": "judul dokumen",
  "summary": "ringkasan singkat",
  "tags": ["tag1", "tag2"],
  "recordType": "image"
}`;

  const rawResponse = await generateTextWithImage(prompt, imageBase64, mimeType);

  try {
    // Extract JSON from response
    const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch {
    // fallback
  }

  return {
    extractedText: rawResponse,
    title: 'Dokumen Medis',
    summary: 'Dokumen medis yang diunggah',
    tags: ['Dokumen'],
    recordType: 'image',
  };
}

/**
 * Generate AI daily health schedule
 */
export async function generateSchedule(userId: number): Promise<Array<{
  type: string;
  label: string;
  detail: string;
  time: string;
  colorScheme: string;
}>> {
  const userContext = await buildUserContext(userId);
  const today = new Date().toLocaleDateString('id-ID', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  const prompt = `${userContext}

Tanggal: ${today}

Buatkan jadwal harian yang komprehensif dan personal untuk pasien ini. Jadwal harus mencakup:
- Waktu makan (sarapan, makan siang, makan malam, snack jika perlu)
- Jadwal obat berdasarkan kondisi dan obat aktif
- Olahraga yang sesuai kondisi
- Pengingat minum air

Balas HANYA dalam format JSON array berikut (8-12 item):
[
  {
    "type": "food|pill|exercise|water",
    "label": "nama aktivitas",
    "detail": "detail singkat",
    "time": "HH:MM",
    "colorScheme": "orange|blue|green|cyan|yellow"
  }
]

Urutkan berdasarkan waktu. Pastikan jadwal obat sesuai petunjuk medis (pagi/malam, sebelum/sesudah makan).`;

  const rawResponse = await generateText(prompt);

  try {
    const jsonMatch = rawResponse.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch {
    // fallback
  }

  // Default schedule
  return [
    { type: 'food', label: 'Sarapan', detail: 'Makanan bergizi seimbang', time: '07:00', colorScheme: 'orange' },
    { type: 'water', label: 'Minum Air', detail: '2 gelas (500ml)', time: '09:00', colorScheme: 'cyan' },
    { type: 'food', label: 'Makan Siang', detail: 'Nasi + sayur + protein', time: '12:00', colorScheme: 'orange' },
    { type: 'water', label: 'Minum Air', detail: '2 gelas (500ml)', time: '15:00', colorScheme: 'cyan' },
    { type: 'food', label: 'Makan Malam', detail: 'Porsi lebih kecil, kaya serat', time: '18:00', colorScheme: 'orange' },
  ];
}

/**
 * Generate daily health insight
 */
export async function generateDailyInsight(userId: number): Promise<{
  mainInsight: string;
  tips: Array<{ emoji: string; text: string }>;
}> {
  const userContext = await buildUserContext(userId);
  const today = new Date().toLocaleDateString('id-ID', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  const prompt = `${userContext}

Tanggal: ${today}

Buat insight kesehatan harian yang personal dan actionable untuk pasien ini. Harus mencakup:
1. Satu kalimat insight utama tentang kondisi terpenting pasien
2. 3 tips konkret berdasarkan kondisi, obat, atau rekam medis pasien

Format JSON ONLY:
{
  "mainInsight": "satu paragraf insight utama yang personal dan bermanfaat",
  "tips": [
    {"emoji": "emoji relevan", "text": "tip konkret 1"},
    {"emoji": "emoji relevan", "text": "tip konkret 2"},
    {"emoji": "emoji relevan", "text": "tip konkret 3"}
  ]
}`;

  const rawResponse = await generateText(prompt);

  try {
    const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch {
    // fallback
  }

  return {
    mainInsight: 'Jaga kesehatan Anda hari ini dengan rutin minum obat dan makan teratur.',
    tips: [
      { emoji: '💊', text: 'Pastikan tidak melewatkan jadwal obat hari ini' },
      { emoji: '💧', text: 'Minum minimal 8 gelas air putih sehari' },
      { emoji: '🚶', text: 'Lakukan aktivitas ringan 30 menit untuk menjaga kesehatan' },
    ],
  };
}

/**
 * Summarize a medical record text
 */
export async function summarizeMedicalRecord(content: string, type: string): Promise<string> {
  const prompt = `Buat ringkasan singkat (maksimal 2 kalimat dalam bahasa Indonesia) dari rekam medis berikut:

Tipe: ${type}
Konten: ${content}

Balas HANYA dengan ringkasan, tanpa penjelasan tambahan.`;

  return generateText(prompt);
}
