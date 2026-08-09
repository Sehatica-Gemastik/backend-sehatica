export type RegistrationInput = {
  name: string;
  email: string;
  password: string;
  phone: string | null;
};

type RegistrationResult =
  | { value: RegistrationInput }
  | { error: string };

export function parseRegistrationInput(input: unknown): RegistrationResult {
  if (!input || typeof input !== 'object') {
    return { error: 'Data registrasi tidak valid' };
  }

  const { name, email, password, phone } = input as Record<string, unknown>;
  if (
    typeof name !== 'string' ||
    typeof email !== 'string' ||
    typeof password !== 'string' ||
    !name.trim() ||
    !email.trim() ||
    !password.trim()
  ) {
    return { error: 'Nama, email, dan password wajib diisi' };
  }

  const normalizedName = name.trim();
  const normalizedEmail = email.trim().toLowerCase();
  if (normalizedName.length > 255) return { error: 'Nama maksimal 255 karakter' };
  if (normalizedEmail.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    return { error: 'Format email tidak valid' };
  }
  if (password.length < 8) return { error: 'Password minimal 8 karakter' };
  if (password.length > 128) return { error: 'Password maksimal 128 karakter' };
  if (phone != null && typeof phone !== 'string') {
    return { error: 'Nomor telepon tidak valid' };
  }

  const normalizedPhone = typeof phone === 'string' ? phone.trim() : '';
  if (normalizedPhone.length > 20) return { error: 'Nomor telepon maksimal 20 karakter' };

  return {
    value: {
      name: normalizedName,
      email: normalizedEmail,
      password,
      phone: normalizedPhone || null,
    },
  };
}
