export function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password);
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    return await Bun.password.verify(password, stored);
  } catch {
    return false;
  }
}

export function generateAvatarInitials(name: string): string {
  return name
    .split(' ')
    .slice(0, 2)
    .map((n) => n[0]?.toUpperCase() ?? '')
    .join('');
}
