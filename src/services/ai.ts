import {
  getLlmProvider,
  dummyProvider,
  LlmRateLimitError,
  LlmAuthError,
} from './llm/provider';
import {
  buildClinicalContextForProvider,
  buildBehaviourContext,
  getHeallySystemPrompt,
  summarizeThinking,
} from './heally/context';
import {
  buildDailyHealthContextForLlm,
  formatDailyLogsForLlm,
  formatPtmFactorsForLlm,
  loadPrivacyProfile,
  sanitizeChatHistory,
  sanitizeTextForLlm,
  shouldSanitizeForLlm,
} from './heally/privacy';
import {
  appendCtasToContent,
  buildDailyHealthContextText,
  buildHeallyCtas,
  buildScheduleConfirmMessage,
  buildScheduleWaitingMessage,
  getDailyCompliance,
  getScheduleThinkingSteps,
  isScheduleIntentMessage,
  isSchedulePrerequisitesMet,
  setPendingScheduleIntent,
} from './heally/daily-compliance';
import {
  parseMedicalDocumentVision,
  standardRecordToLegacyOcr,
} from './medical-record/vision-parse';
import type { StandardMedicalRecord } from './medical-record/standard';

// ── Text generation via configurable LLM provider (default: dummy) ────────
async function generateText(prompt: string, systemInstruction?: string): Promise<string> {
  const result = await getLlmProvider().generateText(prompt, systemInstruction);
  return result.text;
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
  const [clinicalContext, behaviour, profile] = await Promise.all([
    buildClinicalContextForProvider(userId),
    buildBehaviourContext(userId),
    loadPrivacyProfile(userId),
  ]);
  const today = new Date().toISOString().slice(0, 10);
  const compliance = await getDailyCompliance(userId, today);
  const dailyHealthContext = shouldSanitizeForLlm()
    ? buildDailyHealthContextForLlm(compliance, profile, today)
    : buildDailyHealthContextText(compliance, today);
  let systemInstruction = getHeallySystemPrompt(
    clinicalContext,
    `${behaviour.text}\n\n${dailyHealthContext}`
  );
  let safeHistory = conversationHistory;
  let safeMessage = userMessage;

  if (shouldSanitizeForLlm()) {
    systemInstruction = sanitizeTextForLlm(systemInstruction, profile);
    safeHistory = sanitizeChatHistory(conversationHistory, profile);
    safeMessage = sanitizeTextForLlm(userMessage, profile);
  }

  const wantsSchedule = isScheduleIntentMessage(userMessage);
  const scheduleReady = isSchedulePrerequisitesMet(compliance);

  if (wantsSchedule && scheduleReady) {
    await setPendingScheduleIntent(userId, today, true);
    return {
      content: appendCtasToContent(
        buildScheduleConfirmMessage(compliance),
        ['[HEALLY_CTA:generate_schedule|Ya, buatkan jadwal]']
      ),
      needsVerif: false,
      provider: 'heally-rules',
      model: 'schedule-confirm',
      thinkingSummary: 'Konfirmasi buat jadwal',
      thinkingDetail: getScheduleThinkingSteps().join('\n'),
    };
  }

  if (wantsSchedule && !scheduleReady) {
    await setPendingScheduleIntent(userId, today, true);
    return {
      content: appendCtasToContent(
        buildScheduleWaitingMessage(compliance),
        buildHeallyCtas(compliance, userMessage)
      ),
      needsVerif: false,
      provider: 'heally-rules',
      model: 'compliance-gate',
      thinkingSummary: 'Menunggu screening PTM & catatan harian',
      thinkingDetail: [
        'Memeriksa kelengkapan screening PTM',
        'Memeriksa catatan harian',
        'Menyiapkan langkah berikutnya',
      ].join('\n'),
    };
  }

  const llm = getLlmProvider();

  let result;
  try {
    result = await llm.generateChat(systemInstruction, safeHistory, safeMessage);
  } catch (err) {
    if (llm.name !== 'dummy' && (err instanceof LlmRateLimitError || err instanceof LlmAuthError)) {
      const reason =
        err instanceof LlmAuthError
          ? err.message
          : `Kuota ${llm.name} sementara penuh. Tunggu ~1 menit lalu coba lagi.`;
      console.warn(`[heally] ${llm.name} unavailable —`, reason);
      const fallback = await dummyProvider.generateChat(
        systemInstruction,
        safeHistory,
        safeMessage
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

  const ctas = buildHeallyCtas(compliance, userMessage);
  const contentWithCtas = appendCtasToContent(content, ctas);

  return {
    content: contentWithCtas,
    needsVerif,
    provider: result.provider,
    model: result.model,
    thinkingSummary,
    thinkingDetail,
  };
}

/**
 * Parse medical document image via Groq Vision (Qwen multimodal).
 */
export async function parseMedicalRecordFromImage(
  userId: number | undefined,
  imageBase64: string,
  mimeType = 'image/jpeg'
): Promise<StandardMedicalRecord> {
  return parseMedicalDocumentVision(userId, imageBase64, mimeType);
}

/** @deprecated use parseMedicalRecordFromImage — kept for records route compat */
export async function ocrMedicalDocument(
  imageBase64: string,
  mimeType = 'image/jpeg',
  userId?: number
): Promise<{
  extractedText: string;
  title: string;
  summary: string;
  tags: string[];
  recordType: string;
  isMedicalDocument?: boolean;
  documentKind?: string;
  rejectionReason?: string | null;
  doctorName?: string | null;
  recordDate?: string | null;
}> {
  const parsed = await parseMedicalDocumentVision(userId, imageBase64, mimeType);
  return standardRecordToLegacyOcr(parsed);
}

/**
 * Generate AI daily health schedule (food / exercise / water; pills manual-only for mobile)
 */
export type GenerateScheduleInput = {
  date?: string;
  screeningSummary?: string;
  dailyLogsSummary?: string;
  healthContext?: string;
  manualPills?: Array<{ label: string; detail?: string | null; time: string }>;
};

export async function generateSchedule(
  userId: number,
  input: GenerateScheduleInput = {}
): Promise<{
  items: Array<{
    type: string;
    label: string;
    detail: string;
    time: string;
    colorScheme: string;
  }>;
  warnings: string[];
}> {
  const [clinicalContext, behaviour, profile, compliance] = await Promise.all([
    buildClinicalContextForProvider(userId),
    buildBehaviourContext(userId),
    loadPrivacyProfile(userId),
    getDailyCompliance(userId, input.date ?? new Date().toISOString().slice(0, 10)),
  ]);

  const screeningBlock =
    input.screeningSummary ??
    (compliance?.ptmFactors.length
      ? formatPtmFactorsForLlm(compliance.ptmFactors)
      : 'Screening PTM belum tersedia — gunakan pola hidup sehat umum.');

  const logsBlock =
    input.dailyLogsSummary ??
    (compliance && compliance.dailyLogs.length > 0
      ? formatDailyLogsForLlm(compliance.dailyLogs, profile)
      : compliance && compliance.dailyLogCount > 0
        ? `Catatan hari ini: ${compliance.dailyLogCount} entri (ringkasan agregat).`
        : 'Belum ada catatan harian hari ini.');

  const pillsBlock =
    input.manualPills?.length
      ? input.manualPills
          .map((p) => `- ${p.label} (${p.time}): ${p.detail ?? ''}`)
          .join('\n')
      : 'Tidak ada obat manual — jangan buat jadwal pill baru.';

  const today = new Date().toLocaleDateString('id-ID', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  let prompt = `${clinicalContext}

${behaviour.text}

KONTEKS HARIAN:
${screeningBlock}
${logsBlock}

OBAT MANUAL (jangan ubah/ditambah AI):
${pillsBlock}

${input.healthContext ? `REKAM MEDIS RINGKAS:\n${input.healthContext.slice(0, 4000)}` : ''}

Tanggal: ${today}

Buatkan jadwal harian personal. WAJIB:
- Sesuaikan olahraga & pola makan dengan faktor PTM di atas
- Tambahkan item harian spesifik jika ada faktor (mis. kurang aktivitas → jalan 15–20 menit)
- Hanya food, exercise, water — JANGAN pill (obat manual sudah ada)
- 8–12 item, urut waktu

Balas HANYA JSON array:
[
  {
    "type": "food|exercise|water",
    "label": "nama aktivitas",
    "detail": "detail singkat",
    "time": "HH:MM",
    "colorScheme": "orange|blue|green|cyan|yellow"
  }
]`;

  if (shouldSanitizeForLlm()) {
    prompt = sanitizeTextForLlm(prompt, profile);
  }

  const rawResponse = await generateText(prompt);

  try {
    const jsonMatch = rawResponse.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as Array<{
        type: string;
        label: string;
        detail: string;
        time: string;
        colorScheme: string;
      }>;
      const items = parsed.filter((item) => ['food', 'exercise', 'water'].includes(item.type));
      return {
        items,
        warnings: items.length < parsed.length
          ? ['Jadwal obat tidak dibuat oleh AI — tetap ikuti obat manual Anda.']
          : [],
      };
    }
  } catch {
    // fallback
  }

  return {
    items: [
      { type: 'food', label: 'Sarapan', detail: 'Makanan bergizi seimbang', time: '07:00', colorScheme: 'orange' },
      { type: 'water', label: 'Minum Air', detail: '2 gelas (500ml)', time: '09:00', colorScheme: 'cyan' },
      { type: 'exercise', label: 'Jalan kaki', detail: '15–20 menit ringan', time: '10:00', colorScheme: 'green' },
      { type: 'food', label: 'Makan Siang', detail: 'Nasi + sayur + protein', time: '12:00', colorScheme: 'orange' },
      { type: 'water', label: 'Minum Air', detail: '2 gelas (500ml)', time: '15:00', colorScheme: 'cyan' },
      { type: 'food', label: 'Makan Malam', detail: 'Porsi lebih kecil, kaya serat', time: '18:00', colorScheme: 'orange' },
    ],
    warnings: [],
  };
}

/**
 * Generate daily health insight
 */
export async function generateDailyInsight(userId: number): Promise<{
  mainInsight: string;
  tips: Array<{ text: string }>;
}> {
  const [clinicalContext, behaviour, profile] = await Promise.all([
    buildClinicalContextForProvider(userId),
    buildBehaviourContext(userId),
    loadPrivacyProfile(userId),
  ]);
  const today = new Date().toLocaleDateString('id-ID', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  let prompt = `${clinicalContext}

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

  if (shouldSanitizeForLlm()) {
    prompt = sanitizeTextForLlm(prompt, profile);
  }

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
export async function summarizeMedicalRecord(
  content: string,
  type: string,
  userId?: number
): Promise<string> {
  let prompt = `Buat ringkasan singkat (maksimal 2 kalimat dalam bahasa Indonesia) dari rekam medis berikut:

Tipe: ${type}
Konten: ${content}

Balas HANYA dengan ringkasan, tanpa penjelasan tambahan.`;

  if (userId && shouldSanitizeForLlm()) {
    const profile = await loadPrivacyProfile(userId);
    prompt = sanitizeTextForLlm(prompt, profile);
  }

  return generateText(prompt);
}
