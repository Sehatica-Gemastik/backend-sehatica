import { db, closeDb } from '../src/db';
import { doctors, users } from '../src/db/schema';
import { generateAvatarInitials, hashPassword } from '../src/utils/password';
import { parseRegistrationInput } from '../src/utils/registration';

const [email, name, specialtyInput] = Bun.argv.slice(2);
const parsed = parseRegistrationInput({
  email,
  name,
  password: process.env.DOCTOR_PASSWORD,
});
const specialty = specialtyInput?.trim();

if ('error' in parsed || !specialty || specialty.length > 100) {
  console.error(parsed && 'error' in parsed ? parsed.error : 'Spesialisasi wajib diisi (maksimal 100 karakter)');
  console.error('Usage: DOCTOR_PASSWORD=<minimal 8 karakter> bun run doctor:create -- <email> <nama> <spesialisasi>');
  process.exitCode = 1;
} else {
  try {
    const passwordHash = await hashPassword(parsed.value.password);
    const created = await db.transaction(async (tx) => {
      const [user] = await tx.insert(users).values({
        name: parsed.value.name,
        email: parsed.value.email,
        passwordHash,
        role: 'doctor',
        avatarInitials: generateAvatarInitials(parsed.value.name),
      }).returning({ id: users.id, email: users.email });
      const [doctor] = await tx.insert(doctors).values({
        userId: user.id,
        specialty,
      }).returning({ id: doctors.id });
      return { id: doctor.id, email: user.email, specialty };
    });
    console.log(JSON.stringify(created));
  } catch (error) {
    const databaseError = error as { code?: string; cause?: { code?: string } };
    console.error((databaseError.code ?? databaseError.cause?.code) === '23505'
      ? 'Email dokter sudah terdaftar'
      : 'Gagal membuat akun dokter');
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}
