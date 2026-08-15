import { isDummyLlm, llmConfig } from './llm';

export function isSummaryLlmConfigured(): boolean {
  return !isDummyLlm() && Boolean(llmConfig.model.trim());
}

export function requireSummaryModel(): string {
  const model = llmConfig.model.trim();
  if (!model) {
    throw new Error('LLM_MODEL wajib diisi di .env untuk ringkasan AI kuisioner.');
  }
  return model;
}

export function requireSummaryApiKey(): string {
  const key = llmConfig.apiKey.trim();
  if (!key) {
    throw new Error('LLM_API_KEY wajib diisi di .env untuk ringkasan AI.');
  }
  return key;
}
