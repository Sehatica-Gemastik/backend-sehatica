export type OcrResult = {
  extractedText: string;
  title: string;
  summary: string;
  tags: string[];
  recordType: 'image';
};

export function parseOcrResult(raw: string): OcrResult {
  try {
    const json = raw.match(/\{[\s\S]*\}/)?.[0];
    const value = json ? JSON.parse(json) : null;
    if (value && typeof value === 'object') {
      return {
        extractedText: typeof value.extractedText === 'string' ? value.extractedText : raw,
        title: typeof value.title === 'string' && value.title.trim()
          ? value.title.trim()
          : 'Dokumen Medis',
        summary: typeof value.summary === 'string' ? value.summary : 'Dokumen medis yang diunggah',
        tags: Array.isArray(value.tags)
          ? value.tags.filter((tag: unknown): tag is string => typeof tag === 'string').slice(0, 8)
          : ['Dokumen'],
        recordType: 'image',
      };
    }
  } catch {
    // Fall through to a safe result that preserves the provider text.
  }

  return {
    extractedText: raw,
    title: 'Dokumen Medis',
    summary: 'Dokumen medis yang diunggah',
    tags: ['Dokumen'],
    recordType: 'image',
  };
}
