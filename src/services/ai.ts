import { isDummyLlm, llmConfig, resolveActiveApiKey } from '../config/llm';
import {
  getLlmProvider,
  dummyProvider,
  LlmRateLimitError,
  LlmAuthError,
} from './llm/provider';
import {
  buildClinicalContext,
  buildBehaviourContext,
  getHeallySystemPrompt,
  summarizeThinking,
} from './heally/context';

// ── Text generation via configurable LLM provider (default: dummy) ────────
async function generateText(prompt: string, systemInstruction?: string): Promise<string> {
  const result = await getLlmProvider().generateText(prompt, systemInstruction);
  return result.text;
}

// ── Vision OCR — Gemini only; Groq/text providers use dummy OCR ───────────
async function generateTextWithImage(prompt: string, imageBase64: string, mimeType = 'image/jpeg'): Promise<string> {
  if (llmConfig.provider !== 'gemini' || isDummyLlm() || !resolveActiveApiKey()) {
    return JSON.stringify({
      extractedText: '(OCR tidak tersedia) Provider saat ini tidak mendukung vision. Upload teks manual atau ganti ke Gemini untuk OCR.',
      title: 'Dokumen Medis',
      summary: 'Dokumen diunggah — OCR vision belum aktif untuk provider ini.',
      tags: ['Dokumen'],
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

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Chat with Heally AI
 */
export async function chatWithHeally(
  userId: number,
  conversationHistory: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }>,
  userMessage: string
): Promise<{
  content: string;
  needsVerif: boolean;
  provider: string;
  model: string;
  thinkingSummary: string | null;
  thinkingDetail: string | null;
}> {
  const [clinicalContext, behaviour] = await Promise.all([
    buildClinicalContext(userId),
    buildBehaviourContext(userId),
  ]);
  const systemInstruction = getHeallySystemPrompt(clinicalContext, behaviour.text);
  const llm = getLlmProvider();

  let result;
  try {
    result = await llm.generateChat(systemInstruction, conversationHistory, userMessage);
  } catch (err) {
    if (llm.name !== 'dummy' && (err instanceof LlmRateLimitError || err instanceof LlmAuthError)) {
      const reason =
        err instanceof LlmAuthError
          ? err.message
          : `Kuota ${llm.name} sementara penuh. Tunggu ~1 menit lalu coba lagi.`;
      console.warn(`[heally] ${llm.name} unavailable —`, reason);
      const fallback = await dummyProvider.generateChat(
        systemInstruction,
        conversationHistory,
        userMessage
      );
      result = {
        text: `*${reason}*\n\n${fallback.text}`,
        provider: 'dummy-fallback',
        model: 'dummy-local',
        thinkingDetail: behaviour.summaryLines.join('\n'),
        thinkingSummary: behaviour.summaryLines[0] ?? 'Konteks perilaku lokal',
      };
    } else {
      throw err;
    }
  }

  let thinkingDetail = result.thinkingDetail ?? null;
  let thinkingSummary = result.thinkingSummary ?? null;

  // synthesize thinking preview from behaviour when model returns none
  if (!thinkingDetail && behaviour.summaryLines.length > 0) {
    thinkingDetail = behaviour.summaryLines.join('\n');
    thinkingSummary = behaviour.summaryLines[0];
  } else if (thinkingDetail && !thinkingSummary) {
    thinkingSummary = summarizeThinking(thinkingDetail);
  }

  const content = result.text;

  const lower = content.toLowerCase();
  const needsVerif =
    content.includes('[PERINGATAN]') ||
    lower.includes('verifikasi dokter') ||
    lower.includes('konsultasikan dengan dokter') ||
    /\b(dosis|interaksi obat)\b/i.test(content);

  return {
    content,
    needsVerif,
    provider: result.provider,
    model: result.model,
    thinkingSummary,
    thinkingDetail,
  };
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
  const clinicalContext = await buildClinicalContext(userId);
  const behaviour = await buildBehaviourContext(userId);
  const today = new Date().toLocaleDateString('id-ID', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  const prompt = `${clinicalContext}

${behaviour.text}

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
  tips: Array<{ text: string }>;
}> {
  const clinicalContext = await buildClinicalContext(userId);
  const behaviour = await buildBehaviourContext(userId);
  const today = new Date().toLocaleDateString('id-ID', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  const prompt = `${clinicalContext}

${behaviour.text}

Tanggal: ${today}

Buat insight kesehatan harian yang personal dan actionable untuk pasien ini. Harus mencakup:
1. Satu kalimat insight utama tentang kondisi terpenting pasien
2. 3 tips konkret berdasarkan kondisi, obat, atau rekam medis pasien

Format JSON ONLY:
{
  "mainInsight": "satu paragraf insight utama yang personal dan bermanfaat",
  "tips": [
    {"text": "tip konkret 1"},
    {"text": "tip konkret 2"},
    {"text": "tip konkret 3"}
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
      { text: 'Pastikan tidak melewatkan jadwal obat hari ini' },
      { text: 'Minum minimal 8 gelas air putih sehari' },
      { text: 'Lakukan aktivitas ringan 30 menit untuk menjaga kesehatan' },
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
