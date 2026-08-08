import { llmConfig, isDummyLlm, resolveActiveApiKey } from '../../config/llm';

export type ChatTurn = { role: 'user' | 'model'; parts: Array<{ text: string }> };

export type LlmTextResult = { text: string; provider: string; model: string };

export class LlmRateLimitError extends Error {
  constructor(message = 'Kuota Gemini sementara penuh. Coba lagi sebentar.') {
    super(message);
    this.name = 'LlmRateLimitError';
  }
}

export class LlmAuthError extends Error {
  constructor(message = 'API key Gemini tidak valid.') {
    super(message);
    this.name = 'LlmAuthError';
  }
}

export interface LlmProvider {
  name: string;
  generateText(prompt: string, systemInstruction?: string): Promise<LlmTextResult>;
  generateChat(
    systemInstruction: string,
    history: ChatTurn[],
    userMessage: string
  ): Promise<LlmTextResult>;
}

const DUMMY_REPLIES = [
  'Halo! Saya Heally (mode dummy). Saya sudah menerima pesanmu. Untuk saran klinis nyata, set LLM_PROVIDER + API key di .env.',
  'Heally dummy: catatan diterima. Coba tanya soal jadwal obat, rekam medis, atau gejala — saya akan balas template lokal.',
  'Mode development aktif. Jawaban ini tidak dari model cloud. Backend sudah tersambung ke konfigurasi LLM production-ready via env.',
];

function pickDummy(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h + seed.charCodeAt(i) * (i + 1)) % DUMMY_REPLIES.length;
  return DUMMY_REPLIES[h];
}

export const dummyProvider: LlmProvider = {
  name: 'dummy',
  async generateText(prompt, systemInstruction) {
    const text = pickDummy((systemInstruction ?? '') + prompt);
    return { text, provider: 'dummy', model: llmConfig.model || 'dummy-local' };
  },
  async generateChat(systemInstruction, history, userMessage) {
    const lower = userMessage.toLowerCase();
    let text = pickDummy(userMessage + systemInstruction);
    if (lower.includes('obat')) {
      text =
        'Heally dummy: ingat minum obat sesuai jadwal di app. Jika ragu dosis, minta verifikasi dokter partner. ⚠️';
    } else if (lower.includes('jadwal') || lower.includes('olahraga')) {
      text =
        'Heally dummy: kamu bisa generate jadwal di tab Jadwal. Tandai selesai agar progress terupdate.';
    } else if (lower.includes('gejala') || lower.includes('pusing')) {
      text =
        'Heally dummy: catat gejala di rekam medis. Jika memberat, hubungi dokter. Ini bukan diagnosis.';
    }
    return { text, provider: 'dummy', model: llmConfig.model || 'dummy-local' };
  },
};

async function geminiFetch(body: Record<string, unknown>, model: string): Promise<Response> {
  const key = resolveActiveApiKey();
  const base = llmConfig.baseUrl || 'https://generativelanguage.googleapis.com/v1beta';
  const url = `${base}/models/${model}:generateContent?key=${key}`;
  const maxRetries = Number(process.env.GEMINI_429_RETRIES ?? '1');

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (res.ok) return res;

    if (res.status === 429 && attempt < maxRetries) {
      const retryAfter = res.headers.get('retry-after');
      const waitMs = retryAfter
        ? Math.min(Number(retryAfter) * 1000, 15_000)
        : Math.min(2000 * (attempt + 1), 8000);
      console.warn(`[llm] Gemini 429 — retry ${attempt + 1}/${maxRetries} in ${waitMs}ms`);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }

    const errText = await res.text();
    let errMessage = errText.slice(0, 300);
    try {
      const parsed = JSON.parse(errText) as { error?: { message?: string } };
      if (parsed.error?.message) errMessage = parsed.error.message;
    } catch {
      /* keep raw */
    }

    if (res.status === 400 || res.status === 401 || res.status === 403) {
      console.error('[llm] Gemini auth/config error:', errMessage);
      throw new LlmAuthError(
        errMessage.includes('API key')
          ? 'API key Gemini tidak valid. Buat key baru di aistudio.google.com/apikey (format AIzaSy...).'
          : errMessage
      );
    }
    if (res.status === 429) {
      console.warn('[llm] Gemini 429:', errMessage);
      throw new LlmRateLimitError();
    }
    throw new Error(`Gemini error: ${res.status} ${errMessage}`);
  }

  throw new LlmRateLimitError();
}

function parseGeminiText(data: {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
}): string {
  return (
    data.candidates?.[0]?.content?.parts?.[0]?.text ??
    'Maaf, saya tidak dapat memproses permintaan Anda saat ini.'
  );
}

async function geminiGenerateText(prompt: string, systemInstruction?: string): Promise<LlmTextResult> {
  const model = llmConfig.model || 'gemini-2.0-flash';
  const body: Record<string, unknown> = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: llmConfig.temperature,
      maxOutputTokens: llmConfig.maxOutputTokens,
    },
  };
  if (systemInstruction) {
    body.systemInstruction = { parts: [{ text: systemInstruction }] };
  }
  const res = await geminiFetch(body, model);
  const data = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  return { text: parseGeminiText(data), provider: 'gemini', model };
}

async function geminiGenerateChat(
  systemInstruction: string,
  history: ChatTurn[],
  userMessage: string
): Promise<LlmTextResult> {
  const model = llmConfig.model || 'gemini-2.0-flash';
  // free tier: keep last 8 turns to reduce tokens + 429 risk
  const trimmedHistory = history.slice(-8);
  const chatMaxTokens = Math.min(llmConfig.maxOutputTokens, 1024);

  const res = await geminiFetch(
    {
      systemInstruction: { parts: [{ text: systemInstruction }] },
      contents: [...trimmedHistory, { role: 'user', parts: [{ text: userMessage }] }],
      generationConfig: {
        temperature: llmConfig.temperature,
        maxOutputTokens: chatMaxTokens,
      },
    },
    model
  );

  const data = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  return { text: parseGeminiText(data), provider: 'gemini', model };
}

const geminiProvider: LlmProvider = {
  name: 'gemini',
  generateText: geminiGenerateText,
  generateChat: geminiGenerateChat,
};

const stubProvider = (name: string): LlmProvider => ({
  name,
  async generateText(prompt, system) {
    console.warn(`[llm] provider=${name} not fully implemented — using dummy`);
    return dummyProvider.generateText(prompt, system);
  },
  async generateChat(system, history, userMessage) {
    console.warn(`[llm] provider=${name} not fully implemented — using dummy`);
    return dummyProvider.generateChat(system, history, userMessage);
  },
});

export function getLlmProvider(): LlmProvider {
  if (isDummyLlm()) return dummyProvider;
  if (llmConfig.provider === 'gemini') return geminiProvider;
  if (llmConfig.provider === 'openai') return stubProvider('openai');
  if (llmConfig.provider === 'anthropic') return stubProvider('anthropic');
  return dummyProvider;
}
