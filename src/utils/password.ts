import { createHash, randomBytes } from 'crypto';

/**
 * Hash a password using SHA-256 with a salt.
 * For production, use bcrypt. This is a lightweight alternative for hackathon.
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = createHash('sha256').update(salt + password).digest('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  const computed = createHash('sha256').update(salt + password).digest('hex');
  return computed === hash;
}

export function generateAvatarInitials(name: string): string {
  return name
    .split(' ')
    .slice(0, 2)
    .map((n) => n[0]?.toUpperCase() ?? '')
    .join('');
}
