import { isSummaryLlmConfigured, requireSummaryApiKey, requireSummaryModel } from '../../config/summary-llm';
import { LlmRateLimitError, LlmAuthError } from './provider';

const SUMMARY_MAX_TOKENS = 320;
const SUMMARY_TEMPERATURE = 0.5;

export type SummaryKind = 'health' | 'daily_delta' | 'doctor';

const HEALTH_SYSTEM = `Kamu adalah asisten kesehatan Sehatica (Health Buddy).
Tulis ringkasan untuk pasien dalam bahasa Indonesia natural dan empatik.
Jangan mendiagnosis. Jangan menambah fakta di luar data.`;

const HEALTH_PROMPT = `Buat ringkasan kesehatan singkat berdasarkan data berikut.

Jelaskan:
1. kondisi/kebiasaan utama,
2. hal yang perlu diperhatikan,
3. 2-3 saran kebiasaan yang realistis.

Maksimal 4-5 kalimat. Bahasa Indonesia.

DATA:
`;

const DAILY_DELTA_PROMPT = `Buat ringkasan singkat perubahan kesehatan harian berdasarkan perbandingan hari ini vs sebelumnya.

Fokus pada perubahan yang terlihat. Jangan mendiagnosis. Maksimal 2-3 kalimat, bahasa Indonesia natural.

DATA:
`;

const DOCTOR_PROMPT = `Buat ringkasan progres pasien untuk dokter berdasarkan data berikut.

Sertakan pola kebiasaan, area yang membaik, dan area yang perlu diperhatikan.
Maksimal 5-6 kalimat. Bahasa Indonesia profesional. Jangan mendiagnosis.

DATA:
`;

async function groqSummaryRequest(prompt: string, system: string): Promise<string> {
  const model = requireSummaryModel();
  const apiKey = requireSummaryApiKey();

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
      temperature: SUMMARY_TEMPERATURE,
      max_completion_tokens: SUMMARY_MAX_TOKENS,
      stream: false,
    }),
  });

  if (res.status === 401 || res.status === 403) {
    throw new LlmAuthError(await res.text());
  }
  if (res.status === 429) {
    throw new LlmRateLimitError();
  }
  if (!res.ok) {
    throw new Error(`Groq summary error: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) {
    throw new Error('Groq summary returned empty content');
  }
  return text;
}

export async function generateGroqSummary(
  kind: SummaryKind,
  compactData: Record<string, unknown>,
): Promise<string> {
  if (!isSummaryLlmConfigured()) {
    throw new Error('Summary LLM belum dikonfigurasi (LLM_PROVIDER + LLM_API_KEY + LLM_MODEL).');
  }

  const json = JSON.stringify(compactData, null, 0);
  let prompt: string;

  switch (kind) {
    case 'daily_delta':
      prompt = `${DAILY_DELTA_PROMPT}${json}`;
      break;
    case 'doctor':
      prompt = `${DOCTOR_PROMPT}${json}`;
      break;
    default:
      prompt = `${HEALTH_PROMPT}${json}`;
  }

  return groqSummaryRequest(prompt, HEALTH_SYSTEM);
}
