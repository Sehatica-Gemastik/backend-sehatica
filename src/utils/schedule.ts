export type GeneratedScheduleItem = {
  type: 'food' | 'exercise' | 'water';
  label: string;
  detail: string | null;
  time: string;
  colorScheme: string | null;
};

export type GeneratedSchedule = {
  items: GeneratedScheduleItem[];
  warnings: string[];
};

const ALLOWED_TYPES = new Set<GeneratedScheduleItem['type']>(['food', 'exercise', 'water']);
const ALLOWED_COLORS = new Set(['orange', 'blue', 'green', 'cyan', 'yellow']);

export function parseGeneratedSchedule(raw: string): GeneratedSchedule {
  const warnings: string[] = [];
  let values: unknown[] = [];
  try {
    const json = raw.match(/\[[\s\S]*\]/)?.[0];
    const parsed = json ? JSON.parse(json) : null;
    if (Array.isArray(parsed)) values = parsed;
  } catch {
    warnings.push('Respons AI tidak dapat dibaca.');
  }

  const seen = new Set<string>();
  const items: GeneratedScheduleItem[] = [];
  for (const value of values.slice(0, 20)) {
    if (!value || typeof value !== 'object') continue;
    const candidate = value as Record<string, unknown>;
    if (candidate.type === 'pill') {
      if (!warnings.includes('Saran obat buatan AI diabaikan.')) {
        warnings.push('Saran obat buatan AI diabaikan.');
      }
      continue;
    }
    if (!ALLOWED_TYPES.has(candidate.type as GeneratedScheduleItem['type'])) continue;
    if (typeof candidate.label !== 'string' || !candidate.label.trim()) continue;
    if (typeof candidate.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(candidate.time)) continue;

    const label = candidate.label.trim().slice(0, 120);
    const key = `${candidate.time}:${candidate.type}:${label.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      type: candidate.type as GeneratedScheduleItem['type'],
      label,
      detail: typeof candidate.detail === 'string'
        ? candidate.detail.trim().slice(0, 300) || null
        : null,
      time: candidate.time,
      colorScheme: typeof candidate.colorScheme === 'string' && ALLOWED_COLORS.has(candidate.colorScheme)
        ? candidate.colorScheme
        : null,
    });
    if (items.length === 12) break;
  }

  return { items: items.sort((a, b) => a.time.localeCompare(b.time)), warnings };
}
