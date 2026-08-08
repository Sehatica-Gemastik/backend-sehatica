import {
  llmConfig,
  isDummyLlm,
  resolveActiveApiKey,
  defaultModelForProvider,
} from '../../config/llm';

export type ChatTurn = { role: 'user' | 'model'; parts: Array<{ text: string }> };

export type LlmTextResult = {
  text: string;
  provider: string;
  model: string;
  thinkingDetail?: string | null;
  thinkingSummary?: string | null;
};

export class LlmRateLimitError extends Error {
  constructor(message = 'Kuota LLM sementara penuh. Coba lagi sebentar.') {
    super(message);
    this.name = 'LlmRateLimitError';
  }
}

export class LlmAuthError extends Error {
  constructor(message = 'API key LLM tidak valid.') {
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
  'Halo! Saya Heally (mode dummy). Saya sudah menerima pesanmu. Set LLM_PROVIDER + API key di .env untuk balasan cloud.',
  'Heally dummy: catatan diterima. Coba tanya soal jadwal obat, rekam medis, atau gejala.',
  'Mode development aktif. Backend sudah tersambung ke konfigurasi LLM via env.',
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
        'Heally dummy: ingat minum obat sesuai jadwal di app. Jika ragu dosis, minta verifikasi dokter partner. [PERINGATAN]';
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

function splitThinkingFromContent(raw: string): {
  answer: string;
  thinkingDetail: string | null;
} {
  const trimmed = raw.trim();
  // Qwen / reasoning models: ... answer
  const thinkClose = trimmed.match(/([\s\S]*?)<\/think>\s*([\s\S]+)/i);
  if (thinkClose) {
    const thinking = thinkClose[1].replace(/^[\s\S]*?``?/i, '').trim();
    return { answer: thinkClose[2].trim(), thinkingDetail: thinking || null };
  }
  // ... only block at start
  const redacted = trimmed.match(/^([\s\S]{20,}?)<\/think>\s*([\s\S]+)/);
  if (redacted) {
    return { answer: redacted[2].trim(), thinkingDetail: redacted[1].trim() };
  }
  return { answer: trimmed, thinkingDetail: null };
}

function summarizeThinking(detail: string): string {
  const line = detail.split('\n').map((l) => l.trim()).find(Boolean) ?? detail;
  return line.length > 72 ? `${line.slice(0, 69)}…` : line;
}

function finalizeGroqResult(
  rawContent: string,
  model: string,
  extraThinking?: string | null
): LlmTextResult {
  const { answer, thinkingDetail } = splitThinkingFromContent(rawContent);
  const detail = thinkingDetail ?? extraThinking ?? null;
  return {
    text: answer,
    provider: 'groq',
    model,
    thinkingDetail: detail,
    thinkingSummary: detail ? summarizeThinking(detail) : null,
  };
}

function parseApiError(errText: string): string {
  try {
    const parsed = JSON.parse(errText) as { error?: { message?: string } };
    if (parsed.error?.message) return parsed.error.message;
  } catch {
    /* keep raw */
  }
  return errText.slice(0, 300);
}

async function fetchWithRetry(
  label: string,
  url: string,
  init: RequestInit
): Promise<Response> {
  const maxRetries = Number(process.env.LLM_429_RETRIES ?? '1');

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, init);
    if (res.ok) return res;

    if (res.status === 429 && attempt < maxRetries) {
      const retryAfter = res.headers.get('retry-after');
      const waitMs = retryAfter
        ? Math.min(Number(retryAfter) * 1000, 15_000)
        : Math.min(2000 * (attempt + 1), 8000);
      console.warn(`[llm] ${label} 429 — retry ${attempt + 1}/${maxRetries} in ${waitMs}ms`);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }

    const errMessage = parseApiError(await res.text());

    if (res.status === 400 || res.status === 401 || res.status === 403) {
      console.error(`[llm] ${label} auth/config error:`, errMessage);
      throw new LlmAuthError(errMessage);
    }
    if (res.status === 429) {
      console.warn(`[llm] ${label} 429:`, errMessage);
      throw new LlmRateLimitError();
    }
    throw new Error(`${label} error: ${res.status} ${errMessage}`);
  }

  throw new LlmRateLimitError();
}

type OpenAiMessage = { role: 'system' | 'user' | 'assistant'; content: string };

function toChatMessages(
  systemInstruction: string,
  history: ChatTurn[],
  userMessage: string
): OpenAiMessage[] {
  const messages: OpenAiMessage[] = [{ role: 'system', content: systemInstruction }];
  for (const turn of history.slice(-8)) {
    messages.push({
      role: turn.role === 'user' ? 'user' : 'assistant',
      content: turn.parts[0]?.text ?? '',
    });
  }
  messages.push({ role: 'user', content: userMessage });
  return messages;
}

async function groqChatCompletions(
  messages: OpenAiMessage[],
  maxTokens?: number
): Promise<LlmTextResult> {
  const key = resolveActiveApiKey();
  const model = llmConfig.model || defaultModelForProvider();
  const base = llmConfig.baseUrl || 'https://api.groq.com/openai/v1';

  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: llmConfig.temperature,
    max_completion_tokens: maxTokens ?? llmConfig.maxOutputTokens,
    top_p: llmConfig.topP,
    stream: false,
  };

  if (llmConfig.reasoningEffort) {
    body.reasoning_effort = llmConfig.reasoningEffort;
  }

  const res = await fetchWithRetry('Groq', `${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  });

  const data = (await res.json()) as {
    choices?: Array<{
      message?: { content?: string; reasoning?: string; reasoning_content?: string };
    }>;
  };

  const message = data.choices?.[0]?.message;
  const rawContent = message?.content?.trim() ?? '';
  const extraReasoning = message?.reasoning ?? message?.reasoning_content ?? null;

  if (!rawContent && !extraReasoning) {
    return {
      text: 'Maaf, saya tidak dapat memproses permintaan Anda saat ini.',
      provider: 'groq',
      model,
    };
  }

  return finalizeGroqResult(rawContent || extraReasoning || '', model, extraReasoning);
}

const groqProvider: LlmProvider = {
  name: 'groq',
  async generateText(prompt, systemInstruction) {
    const messages: OpenAiMessage[] = [];
    if (systemInstruction) {
      messages.push({ role: 'system', content: systemInstruction });
    }
    messages.push({ role: 'user', content: prompt });
    return groqChatCompletions(messages);
  },
  async generateChat(systemInstruction, history, userMessage) {
    const messages = toChatMessages(systemInstruction, history, userMessage);
    const chatMaxTokens = Math.min(llmConfig.maxOutputTokens, 2048);
    return groqChatCompletions(messages, chatMaxTokens);
  },
};

// legacy optional provider (REST, no SDK)
async function geminiFetch(body: Record<string, unknown>, model: string): Promise<Response> {
  const key = resolveActiveApiKey();
  const base = llmConfig.baseUrl || 'https://generativelanguage.googleapis.com/v1beta';
  return fetchWithRetry(
    'Gemini',
    `${base}/models/${model}:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
}

function parseGeminiText(data: {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
}): string {
  return (
    data.candidates?.[0]?.content?.parts?.[0]?.text ??
    'Maaf, saya tidak dapat memproses permintaan Anda saat ini.'
  );
}

const geminiProvider: LlmProvider = {
  name: 'gemini',
  async generateText(prompt, systemInstruction) {
    const model = llmConfig.model || defaultModelForProvider();
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
  },
  async generateChat(systemInstruction, history, userMessage) {
    const model = llmConfig.model || defaultModelForProvider();
    const res = await geminiFetch(
      {
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents: [
          ...history.slice(-8),
          { role: 'user', parts: [{ text: userMessage }] },
        ],
        generationConfig: {
          temperature: llmConfig.temperature,
          maxOutputTokens: Math.min(llmConfig.maxOutputTokens, 1024),
        },
      },
      model
    );
    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    return { text: parseGeminiText(data), provider: 'gemini', model };
  },
};

const stubProvider = (name: string): LlmProvider => ({
  name,
  async generateText(prompt, system) {
    console.warn(`[llm] provider=${name} not implemented — using dummy`);
    return dummyProvider.generateText(prompt, system);
  },
  async generateChat(system, history, userMessage) {
    console.warn(`[llm] provider=${name} not implemented — using dummy`);
    return dummyProvider.generateChat(system, history, userMessage);
  },
});

export function getLlmProvider(): LlmProvider {
  if (isDummyLlm()) return dummyProvider;
  if (llmConfig.provider === 'groq') return groqProvider;
  if (llmConfig.provider === 'gemini') return geminiProvider;
  if (llmConfig.provider === 'openai') return stubProvider('openai');
  if (llmConfig.provider === 'anthropic') return stubProvider('anthropic');
  return dummyProvider;
}
