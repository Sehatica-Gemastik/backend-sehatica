import { sign, verify } from 'hono/jwt';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

function loadJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('JWT_SECRET must contain at least 32 characters');
  }
  return secret;
}

const JWT_SECRET = loadJwtSecret();
const JWT_EXPIRES_IN = 15 * 60; // 15 minutes
const JWT_REFRESH_EXPIRES_IN = 30 * 24 * 60 * 60; // 30 days

export interface AccessTokenPayload {
  sub: number;
  email: string;
  role: 'user' | 'doctor' | 'admin';
  type: 'access';
  iat?: number;
  exp?: number;
}

export interface RefreshTokenPayload {
  sub: number;
  type: 'refresh';
  jti: string;
  iat?: number;
  exp?: number;
}

export async function signAccessToken(
  payload: Omit<AccessTokenPayload, 'type' | 'iat' | 'exp'>
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return sign(
    { ...payload, type: 'access', iat: now, exp: now + JWT_EXPIRES_IN },
    JWT_SECRET,
    'HS256'
  );
}

export async function signRefreshToken(userId: number): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return sign(
    {
      sub: userId,
      type: 'refresh',
      jti: randomUUID(),
      iat: now,
      exp: now + JWT_REFRESH_EXPIRES_IN,
    },
    JWT_SECRET,
    'HS256'
  );
}

export async function verifyAccessToken(token: string): Promise<AccessTokenPayload> {
  const decoded = await verify(token, JWT_SECRET, 'HS256');
  if (
    decoded.type !== 'access' ||
    !Number.isInteger(decoded.sub) ||
    typeof decoded.email !== 'string' ||
    !['user', 'doctor', 'admin'].includes(String(decoded.role))
  ) {
    throw new Error('Invalid access token');
  }
  return decoded as unknown as AccessTokenPayload;
}

export async function verifyRefreshToken(token: string): Promise<RefreshTokenPayload> {
  const decoded = await verify(token, JWT_SECRET, 'HS256');
  if (
    decoded.type !== 'refresh' ||
    !Number.isInteger(decoded.sub) ||
    typeof decoded.jti !== 'string'
  ) {
    throw new Error('Invalid refresh token');
  }
  return decoded as unknown as RefreshTokenPayload;
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function verifyRefreshTokenHash(token: string, storedHash: string): boolean {
  const candidate = Buffer.from(hashRefreshToken(token));
  const stored = Buffer.from(storedHash);
  return candidate.length === stored.length && timingSafeEqual(candidate, stored);
}
