import { sign, verify } from 'hono/jwt';

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET?.trim();
  if (!secret) {
    throw new Error(
      'JWT_SECRET belum diset. Salin .env.example ke .env dan isi JWT_SECRET (min. 32 karakter acak).'
    );
  }
  return secret;
}

const JWT_SECRET = getJwtSecret();
const JWT_EXPIRES_IN = 7 * 24 * 60 * 60; // 7 days in seconds
const JWT_REFRESH_EXPIRES_IN = 30 * 24 * 60 * 60; // 30 days

export interface JWTPayload {
  sub: number;
  email: string;
  role: string;
  iat?: number;
  exp?: number;
}

export async function signAccessToken(payload: Omit<JWTPayload, 'iat' | 'exp'>): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return sign(
    { ...payload, iat: now, exp: now + JWT_EXPIRES_IN },
    JWT_SECRET,
    'HS256'
  );
}

export async function signRefreshToken(userId: number): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return sign(
    { sub: userId, type: 'refresh', iat: now, exp: now + JWT_REFRESH_EXPIRES_IN },
    JWT_SECRET,
    'HS256'
  );
}

export async function verifyToken(token: string): Promise<JWTPayload> {
  const decoded = await verify(token, JWT_SECRET, 'HS256');
  return decoded as unknown as JWTPayload;
}
