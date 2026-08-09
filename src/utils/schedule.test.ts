import { describe, expect, test } from 'bun:test';
import { parseGeneratedSchedule } from './schedule';

describe('AI schedule parser', () => {
  test('keeps bounded wellness items and rejects invented medication', () => {
    const result = parseGeneratedSchedule(`Here is JSON: [
      {"type":"water","label":"Minum air","detail":"Ikuti target cairan Anda","time":"09:00","colorScheme":"cyan"},
      {"type":"pill","label":"Obat baru","detail":"10 mg","time":"10:00","colorScheme":"blue"},
      {"type":"exercise","label":"Jalan ringan","detail":"Sesuai kemampuan","time":"25:00"}
    ]`);

    expect(result.items).toEqual([{
      type: 'water',
      label: 'Minum air',
      detail: 'Ikuti target cairan Anda',
      time: '09:00',
      colorScheme: 'cyan',
    }]);
    expect(result.warnings).toContain('Saran obat buatan AI diabaikan.');
  });
});
