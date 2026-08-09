import { describe, expect, test } from 'bun:test';

process.env.JWT_SECRET = 'test-only-secret-with-at-least-32-characters';

const {
  hashRefreshToken,
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  verifyRefreshTokenHash,
} = await import('./jwt');
const { hashPassword, verifyPassword } = await import('./password');

describe('password security', () => {
  test('hashes with Argon2id and verifies without exposing the password', async () => {
    const password = 'aman-sekali-123';
    const hash = await hashPassword(password);

    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(hash).not.toContain(password);
    expect(await verifyPassword(password, hash)).toBe(true);
    expect(await verifyPassword('password-salah', hash)).toBe(false);
  });
});

describe('JWT purpose separation', () => {
  test('does not accept a refresh token as an access token', async () => {
    const refreshToken = await signRefreshToken(7);
    await expect(verifyAccessToken(refreshToken)).rejects.toThrow('Invalid access token');
  });

  test('does not accept an access token as a refresh token', async () => {
    const accessToken = await signAccessToken({
      sub: 7,
      email: 'user@example.com',
      role: 'user',
    });
    await expect(verifyRefreshToken(accessToken)).rejects.toThrow('Invalid refresh token');
  });

  test('creates unique refresh tokens and compares only their digests', async () => {
    const first = await signRefreshToken(7);
    const second = await signRefreshToken(7);
    const storedHash = hashRefreshToken(first);

    expect(first).not.toBe(second);
    expect(storedHash).not.toContain(first);
    expect(verifyRefreshTokenHash(first, storedHash)).toBe(true);
    expect(verifyRefreshTokenHash(second, storedHash)).toBe(false);
  });
});
