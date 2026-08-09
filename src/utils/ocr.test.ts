import { describe, expect, test } from 'bun:test';
import { parseOcrResult } from './ocr';

describe('OCR response parser', () => {
  test('normalizes provider JSON and falls back without losing extracted text', () => {
    expect(parseOcrResult('```json\n{"extractedText":"Hb 12","title":"Hasil Lab","summary":"Normal","tags":["Lab",7]}\n```'))
      .toEqual({
        extractedText: 'Hb 12',
        title: 'Hasil Lab',
        summary: 'Normal',
        tags: ['Lab'],
        recordType: 'image',
      });

    expect(parseOcrResult('teks tanpa JSON').extractedText).toBe('teks tanpa JSON');
  });
});
