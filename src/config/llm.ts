/**
 * Production-shaped LLM config — provider is never hard-fixed.
 */
export type LlmProviderName = 'dummy' | 'gemini' | 'openai' | 'anthropic';

export const llmConfig = {
  /** dummy | gemini | openai | anthropic — switch without code changes */
  provider: (process.env.LLM_PROVIDER ?? 'dummy').toLowerCase() as LlmProviderName,
  /** model id for the active provider (empty = provider default / dummy) */
  model: process.env.LLM_MODEL ?? '',
  /** optional shared base URL (OpenAI-compatible gateways, etc.) */
  baseUrl: process.env.LLM_BASE_URL ?? '',
  apiKey: process.env.LLM_API_KEY ?? '',
  /** provider-specific keys kept wired even when unused */
  geminiApiKey: process.env.GEMINI_API_KEY ?? '',
  openaiApiKey: process.env.OPENAI_API_KEY ?? '',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  temperature: Number(process.env.LLM_TEMPERATURE ?? '0.7'),
  maxOutputTokens: Number(process.env.LLM_MAX_OUTPUT_TOKENS ?? '2048'),
  /** hard cap calls per user per window (chat) */
  rateLimitPerMinute: Number(process.env.LLM_RATE_LIMIT_PER_MINUTE ?? '20'),
} as const;

export function resolveActiveApiKey(): string {
  const { provider, apiKey, geminiApiKey, openaiApiKey, anthropicApiKey } = llmConfig;
  if (apiKey) return apiKey;
  if (provider === 'gemini') return geminiApiKey;
  if (provider === 'openai') return openaiApiKey;
  if (provider === 'anthropic') return anthropicApiKey;
  return '';
}

export function isDummyLlm(): boolean {
  if (llmConfig.provider === 'dummy') return true;
  // production providers without a key fall back to dummy (safe local default)
  if (llmConfig.provider !== 'dummy' && !resolveActiveApiKey()) return true;
  return false;
}
