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

export type VisionImageInput = { base64: string; mimeType: string };

export interface LlmProvider {
  name: string;
  generateText(prompt: string, systemInstruction?: string): Promise<LlmTextResult>;
  generateChat(
    systemInstruction: string,
    history: ChatTurn[],
    userMessage: string
  ): Promise<LlmTextResult>;
  generateVisionJson?(
    systemInstruction: string,
    userPrompt: string,
    images: VisionImageInput[]
  ): Promise<LlmTextResult>;
  generateStructuredJson?(
    systemInstruction: string,
    userPrompt: string
  ): Promise<LlmTextResult>;
}

const DUMMY_REPLIES = [
  'Mode dummy aktif. Set LLM_PROVIDER + API key di .env untuk fitur vision rekam medis.',
  'Backend tersambung. LLM cloud diperlukan untuk parse dokumen medis.',
  'Mode development aktif. Konfigurasi LLM via env.',
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
      text = 'Dummy: ingat minum obat sesuai jadwal di app. Jika ragu dosis, konsultasi dokter.';
    } else if (lower.includes('jadwal') || lower.includes('olahraga')) {
      text = 'Dummy: generate jadwal di tab Jadwal. Tandai selesai agar progress terupdate.';
    } else if (lower.includes('gejala') || lower.includes('pusing')) {
      text = 'Dummy: catat gejala di rekam medis. Jika memberat, hubungi dokter.';
    }
    return { text, provider: 'dummy', model: llmConfig.model || 'dummy-local' };
  },
  async generateVisionJson(_systemInstruction, _userPrompt, images) {
    const seed = images[0]?.base64.slice(0, 64) ?? '';
    const text = JSON.stringify({
      isMedicalDocument: seed.length > 80,
      documentKind: seed.length > 80 ? 'other_medical' : 'not_medical',
      confidence: 0.7,
      rejectionReason: seed.length > 80 ? null : 'Mode dummy: unggah dokumen medis nyata dengan LLM_API_KEY.',
      title: seed.length > 80 ? 'Dokumen Medis (dummy)' : 'Bukan dokumen medis',
      summary: seed.length > 80 ? 'Parsing vision dummy.' : 'Gambar tidak dikenali sebagai dokumen medis.',
      recordDate: null,
      recordType: seed.length > 80 ? 'image' : 'note',
      tags: seed.length > 80 ? ['Dokumen'] : [],
      doctorName: null,
      facilityName: null,
      sections: {},
    });
    return { text, provider: 'dummy', model: 'dummy-vision' };
  },
  async generateStructuredJson(_systemInstruction, userPrompt) {
    const seed = userPrompt.slice(0, 64);
    const text = JSON.stringify({
      isMedicalDocument: seed.length > 80,
      documentKind: seed.length > 80 ? 'other_medical' : 'not_medical',
      confidence: 0.7,
      rejectionReason: seed.length > 80 ? null : 'Mode dummy: unggah PDF medis nyata dengan LLM_API_KEY.',
      title: seed.length > 80 ? 'Dokumen Medis PDF (dummy)' : 'Bukan dokumen medis',
      summary: seed.length > 80 ? 'Parsing PDF dummy.' : 'PDF tidak dikenali sebagai dokumen medis.',
      recordDate: null,
      recordType: seed.length > 80 ? 'image' : 'note',
      tags: seed.length > 80 ? ['Dokumen'] : [],
      doctorName: null,
      facilityName: null,
      sections: { rawExtractedText: seed.length > 80 ? userPrompt.slice(0, 200) : null },
    });
    return { text, provider: 'dummy', model: 'dummy-text' };
  },
};

function splitThinkingFromContent(raw: string): {
  answer: string;
  thinkingDetail: string | null;
} {
  const trimmed = raw.trim();

  // case 1: <think>...</think> followed by answer
  const thinkClose = trimmed.match(/<think>([\s\S]*?)<\/think>\s*([\s\S]*)/i);
  if (thinkClose) {
    const thinking = thinkClose[1].trim();
    const answer = thinkClose[2].trim();
    return { answer: answer || '{}', thinkingDetail: thinking || null };
  }

  // case 2: starts with <think> but no closing tag (truncated thinking)
  // try to find JSON after thinking content
  if (/^<think>/i.test(trimmed)) {
    const jsonStart = trimmed.search(/\{[\s\S]*"isMedicalDocument"/);
    if (jsonStart !== -1) {
      const thinking = trimmed.slice(7, jsonStart).trim();
      return { answer: trimmed.slice(jsonStart).trim(), thinkingDetail: thinking || null };
    }
    // no JSON found at all — thinking consumed entire output
    return { answer: '{}', thinkingDetail: trimmed.slice(7).trim() };
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

    if (res.status === 401 || res.status === 403) {
      console.error(`[llm] ${label} auth error:`, errMessage);
      throw new LlmAuthError(errMessage);
    }
    if (res.status === 400) {
      console.error(`[llm] ${label} bad request:`, errMessage);
      throw new Error(`LLM request error: ${errMessage}`);
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
  messages: OpenAiMessage[] | Array<Record<string, unknown>>,
  maxTokens?: number,
  jsonMode = false
): Promise<LlmTextResult> {
  const key = resolveActiveApiKey();
  const model = llmConfig.model || defaultModelForProvider();
  const base = 'https://api.groq.com/openai/v1';

  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: llmConfig.temperature,
    max_completion_tokens: maxTokens ?? llmConfig.maxOutputTokens,
    top_p: llmConfig.topP,
    stream: false,
  };

  if (jsonMode) {
    body.response_format = { type: 'json_object' };
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
  async generateVisionJson(systemInstruction, userPrompt, images) {
    if (!images.length) {
      throw new Error('Tidak ada gambar dokumen untuk vision');
    }

    const visionModel = llmConfig.visionModel || defaultModelForProvider();
    const content: Array<Record<string, unknown>> = [{ type: 'text', text: userPrompt }];
    for (const img of images) {
      content.push({
        type: 'image_url',
        image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
      });
    }

    const messages = [
      { role: 'system', content: systemInstruction },
      { role: 'user', content },
    ];

    const key = resolveActiveApiKey();
    const base = 'https://api.groq.com/openai/v1';
    const body: Record<string, unknown> = {
      model: visionModel,
      messages,
      temperature: 0.2,
      max_completion_tokens: 8192,
      top_p: llmConfig.topP,
      stream: false,
    };

    const res = await fetchWithRetry('Groq Vision', `${base}/chat/completions`, {
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
        text: '{}',
        provider: 'groq',
        model: visionModel,
      };
    }

    return finalizeGroqResult(rawContent || extraReasoning || '{}', visionModel, extraReasoning);
  },
  async generateStructuredJson(systemInstruction, userPrompt) {
    const messages: OpenAiMessage[] = [
      { role: 'system', content: systemInstruction },
      { role: 'user', content: userPrompt },
    ];
    return groqChatCompletions(messages, 8192, false);
  },
};

export function getLlmProvider(): LlmProvider {
  if (isDummyLlm()) return dummyProvider;
  if (llmConfig.provider === 'groq') return groqProvider;
  return dummyProvider;
}
