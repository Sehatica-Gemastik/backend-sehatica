/**
 * Production-shaped LLM config — provider is never hard-fixed.
 */
export type LlmProviderName = 'dummy' | 'groq' | 'gemini' | 'openai' | 'anthropic';

export const llmConfig = {
  /** dummy | groq | gemini | openai | anthropic */
  provider: (process.env.LLM_PROVIDER ?? 'dummy').toLowerCase() as LlmProviderName,
  model: process.env.LLM_MODEL ?? '',
  baseUrl: process.env.LLM_BASE_URL ?? '',
  apiKey: process.env.LLM_API_KEY ?? '',
  groqApiKey: process.env.GROQ_API_KEY ?? '',
  geminiApiKey: process.env.GEMINI_API_KEY ?? '',
  openaiApiKey: process.env.OPENAI_API_KEY ?? '',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  temperature: Number(process.env.LLM_TEMPERATURE ?? '0.6'),
  maxOutputTokens: Number(process.env.LLM_MAX_OUTPUT_TOKENS ?? '2048'),
  topP: Number(process.env.LLM_TOP_P ?? '0.95'),
  reasoningEffort: process.env.LLM_REASONING_EFFORT ?? 'default',
  rateLimitPerMinute: Number(process.env.LLM_RATE_LIMIT_PER_MINUTE ?? '20'),
} as const;

export function resolveActiveApiKey(): string {
  const { provider, apiKey, groqApiKey, geminiApiKey, openaiApiKey, anthropicApiKey } =
    llmConfig;
  if (apiKey) return apiKey;
  if (provider === 'groq') return groqApiKey;
  if (provider === 'gemini') return geminiApiKey;
  if (provider === 'openai') return openaiApiKey;
  if (provider === 'anthropic') return anthropicApiKey;
  return '';
}

export function isDummyLlm(): boolean {
  if (llmConfig.provider === 'dummy') return true;
  if (llmConfig.provider !== 'dummy' && !resolveActiveApiKey()) return true;
  return false;
}

export function defaultModelForProvider(): string {
  if (llmConfig.provider === 'groq') return 'qwen/qwen3.6-27b';
  if (llmConfig.provider === 'gemini') return 'gemini-2.0-flash';
  return llmConfig.model || 'dummy-local';
}
