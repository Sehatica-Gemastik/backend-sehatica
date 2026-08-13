/**
 * LLM config — Groq only (dummy for local dev without key).
 */
export type LlmProviderName = 'dummy' | 'groq';

const DEFAULT_MODEL = 'qwen/qwen3.6-27b';

export const llmConfig = {
  provider: (process.env.LLM_PROVIDER ?? 'dummy').toLowerCase() as LlmProviderName,
  apiKey: process.env.LLM_API_KEY ?? '',
  model: process.env.LLM_MODEL ?? DEFAULT_MODEL,
  temperature: Number(process.env.LLM_TEMPERATURE ?? '0.6'),
  maxOutputTokens: Number(process.env.LLM_MAX_OUTPUT_TOKENS ?? '2048'),
  topP: Number(process.env.LLM_TOP_P ?? '0.95'),
  rateLimitPerMinute: Number(process.env.LLM_RATE_LIMIT_PER_MINUTE ?? '20'),
  /** Vision uses same Groq multimodal model by default */
  visionModel: process.env.LLM_VISION_MODEL ?? process.env.LLM_MODEL ?? DEFAULT_MODEL,
} as const;

export function resolveActiveApiKey(): string {
  return llmConfig.apiKey;
}

export function isDummyLlm(): boolean {
  if (llmConfig.provider === 'dummy') return true;
  if (llmConfig.provider === 'groq' && !llmConfig.apiKey) return true;
  return false;
}

export function defaultModelForProvider(): string {
  return llmConfig.model || DEFAULT_MODEL;
}
