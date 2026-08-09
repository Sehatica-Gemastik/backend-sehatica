import { describe, expect, test } from 'bun:test';
import { parseReviewDecision, parseReviewSubmission } from './review';

describe('consented review input', () => {
  test('accepts the minimum bundle and rejects unsafe decisions', () => {
    expect(parseReviewSubmission({
      doctorId: 2,
      clientMessageId: 7,
      patientQuestion: 'Apakah saya boleh berolahraga?',
      aiResponse: 'Mulai secara bertahap.',
      safetyLevel: 'review',
    })).toEqual({
      doctorId: 2,
      clientMessageId: 7,
      patientQuestion: 'Apakah saya boleh berolahraga?',
      aiResponse: 'Mulai secara bertahap.',
      safetyLevel: 'review',
      patientNote: null,
    });
    expect(parseReviewDecision({ status: 'revised', note: '' }))
      .toBe('Revisi wajib menyertakan catatan dokter');
  });
});
