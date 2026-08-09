import { describe, expect, test } from 'bun:test';
import { evaluateChatSafety } from './chat';

describe('Heally safety classifier', () => {
  test('escalates emergencies and medication topics conservatively', () => {
    expect(evaluateChatSafety('Saya nyeri dada dan sesak napas', 'Segera cari bantuan').level).toBe('urgent');
    expect(evaluateChatSafety('Boleh ubah dosis obat?', 'Jangan ubah tanpa dokter')).toEqual({
      level: 'review',
      reasons: ['medication_or_diagnostic_advice'],
      verificationRecommended: true,
    });
    expect(evaluateChatSafety('Cara tidur lebih teratur?', 'Jaga jadwal tidur').level).toBe('general');
  });
});
