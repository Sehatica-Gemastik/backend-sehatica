/**
 * Seed demo data for doctor portal E2E testing.
 * Questionnaire logs are NOT seeded — fill via mobile sync for E2E.
 * Run: bun run db:seed-portal
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import {
  doctors,
  doctorAppointments,
  userDailyCompliance,
  userDailyQuestionnaires,
  userDoctors,
  users,
  userWeeklyCheckins,
} from '../db/schema';
import { hashPassword, generateAvatarInitials } from '../utils/password';

const DOCTOR_EMAIL = 'dokter@sehatica.test';
const DOCTOR_PASSWORD = 'password123';

const PATIENTS = [
  { email: 'demo@sehatica.test', name: 'Demo User', age: 58, sex: 1, race: 6, education: 3, income: '2' },
  { email: 'patient2@sehatica.test', name: 'Sehatica', age: 45, sex: 2, race: 6, education: 5, income: '3' },
  { email: 'patient3@sehatica.test', name: 'Muhammad Rizain Firdaus', age: 60, sex: 1, race: 6, education: 4, income: '2' },
];

async function ensureUser(input: typeof PATIENTS[number]) {
  const existing = await db.query.users.findFirst({ where: eq(users.email, input.email) });
  if (existing) return existing;

  const [created] = await db
    .insert(users)
    .values({
      name: input.name,
      email: input.email,
      passwordHash: hashPassword('password123'),
      role: 'user',
      avatarInitials: generateAvatarInitials(input.name),
      age: input.age,
      sex: input.sex,
      raceEthnicity: input.race,
      education: input.education,
      incomePovertyRatio: input.income,
      identityCompletedAt: new Date(),
    })
    .returning();
  return created;
}

async function ensureDoctor() {
  const existing = await db.query.users.findFirst({ where: eq(users.email, DOCTOR_EMAIL) });
  if (existing) {
    const doctor = await db.query.doctors.findFirst({ where: eq(doctors.userId, existing.id) });
    if (doctor) return { user: existing, doctor };
  }

  const [user] = existing
    ? [existing]
    : await db
        .insert(users)
        .values({
          name: 'Dr. Sehatica',
          email: DOCTOR_EMAIL,
          passwordHash: hashPassword(DOCTOR_PASSWORD),
          role: 'doctor',
          avatarInitials: 'DS',
          phone: '+6281234567890',
        })
        .returning();

  let doctor = await db.query.doctors.findFirst({ where: eq(doctors.userId, user.id) });
  if (!doctor) {
    [doctor] = await db
      .insert(doctors)
      .values({
        userId: user.id,
        specialty: 'Dokter Umum',
        bio: 'Praktik di klinik Sehatica, fokus PTM dan edukasi gaya hidup.',
        isAvailable: true,
      })
      .returning();
  }

  return { user, doctor };
}

async function linkPatient(doctorId: number, userId: number) {
  const existing = await db.query.userDoctors.findFirst({
    where: and(eq(userDoctors.doctorId, doctorId), eq(userDoctors.userId, userId)),
  });
  if (existing) return;

  await db.insert(userDoctors).values({ doctorId, userId });
}

async function clearQuestionnaireLogs(patientIds: number[]) {
  if (patientIds.length === 0) return;

  await db.delete(userDailyQuestionnaires).where(inArray(userDailyQuestionnaires.userId, patientIds));
  await db.delete(userDailyCompliance).where(inArray(userDailyCompliance.userId, patientIds));

  console.log(`Cleared questionnaire + compliance logs for ${patientIds.length} demo patient(s).`);
}

async function seedWeeklyCheckin(userId: number, patientIndex: number) {
  await db
    .insert(userWeeklyCheckins)
    .values({
      userId,
      weightKg: String(70 + patientIndex * 4),
      heightCm: String(165 + patientIndex),
      bmi: String(24 + patientIndex * 0.8),
      waistCm: String(80 + patientIndex * 4),
      systolicBp: 120 + patientIndex * 8,
      diastolicBp: 78 + patientIndex * 4,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: userWeeklyCheckins.userId,
      set: {
        updatedAt: new Date(),
      },
    });
}

async function seedAppointments(doctorId: number, patients: { id: number }[]) {
  const existing = await db.query.doctorAppointments.findFirst({
    where: eq(doctorAppointments.doctorId, doctorId),
  });
  if (existing) return;

  const weekStart = new Date();
  weekStart.setDate(weekStart.getDate() - weekStart.getDay() + 1);
  weekStart.setHours(9, 0, 0, 0);

  const slots = [
    { dayOffset: 1, hour: 9, patientIndex: 0, title: 'Kontrol gula darah' },
    { dayOffset: 3, hour: 14, patientIndex: 0, title: 'Follow-up diet' },
    { dayOffset: 2, hour: 10, patientIndex: 1, title: 'Konsultasi jantung' },
  ];

  for (const slot of slots) {
    const start = new Date(weekStart);
    start.setDate(start.getDate() + slot.dayOffset);
    start.setHours(slot.hour, 0, 0, 0);
    const end = new Date(start);
    end.setHours(start.getHours() + 2);

    await db.insert(doctorAppointments).values({
      doctorId,
      patientId: patients[slot.patientIndex].id,
      title: slot.title,
      notes: 'Janji dari seed demo portal.',
      startAt: start,
      endAt: end,
      status: 'scheduled',
    });
  }
}

async function main() {
  console.log('Seeding doctor portal demo data (no questionnaire logs)...');
  const { doctor } = await ensureDoctor();
  const patientUsers = [];

  for (const patient of PATIENTS) {
    const user = await ensureUser(patient);
    patientUsers.push(user);
    await linkPatient(doctor.id, user.id);
  }

  await clearQuestionnaireLogs(patientUsers.map((p) => p.id));

  for (const [index, user] of patientUsers.entries()) {
    await seedWeeklyCheckin(user.id, index);
  }

  await seedAppointments(doctor.id, patientUsers);

  console.log('Done.');
  console.log(`Doctor login: ${DOCTOR_EMAIL} / ${DOCTOR_PASSWORD}`);
  console.log(`Patients linked: ${patientUsers.map((p) => p.email).join(', ')}`);
  console.log('Kuisioner harian: isi dari mobile (daily-checkin) lalu cek di web monitor.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
