import { describe, expect, test } from 'bun:test';
import { parseRegistrationInput } from './registration';

describe('registration input', () => {
  test('normalizes valid input', () => {
    expect(parseRegistrationInput({
      name: '  Andi  ',
      email: '  ANDI@example.com ',
      password: 'rahasia8',
      phone: ' +628123456789 ',
    })).toEqual({
      value: {
        name: 'Andi',
        email: 'andi@example.com',
        password: 'rahasia8',
        phone: '+628123456789',
      },
    });
  });

  test('rejects invalid input before it reaches the database', () => {
    expect(parseRegistrationInput(null)).toEqual({ error: 'Data registrasi tidak valid' });
    expect(parseRegistrationInput({ name: 'Andi', email: 'andi@example.com', password: '123456' }))
      .toEqual({ error: 'Password minimal 8 karakter' });
    expect(parseRegistrationInput({ name: 'Andi', email: 'bukan-email', password: 'rahasia8' }))
      .toEqual({ error: 'Format email tidak valid' });
    expect(parseRegistrationInput({
      name: 'Andi',
      email: 'andi@example.com',
      password: 'rahasia8',
      phone: '1'.repeat(21),
    })).toEqual({ error: 'Nomor telepon maksimal 20 karakter' });
  });
});
