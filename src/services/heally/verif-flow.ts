import { db } from '../../db';
import { chatMessages, verifRequests, userDoctors, doctors } from '../../db/schema';
import { eq, desc } from 'drizzle-orm';

async function resolvePartnerDoctor(userId: number) {
  const links = await db.query.userDoctors.findMany({
    where: eq(userDoctors.userId, userId),
    orderBy: [desc(userDoctors.isPrimary), desc(userDoctors.createdAt)],
    limit: 1,
  });
  const link = links[0];
  if (!link) return null;

  return db.query.doctors.findFirst({
    where: eq(doctors.id, link.doctorId),
    with: { user: true },
  });
}

/** Create verif row + link to partner doctor when available. */
export async function createVerifForMessage(input: {
  userId: number;
  messageId: number;
  userQuestion: string;
  aiAnswer: string;
}) {
  const existing = await db.query.verifRequests.findFirst({
    where: eq(verifRequests.messageId, input.messageId),
  });
  if (existing) return existing;

  const partner = await resolvePartnerDoctor(input.userId);
  const doctorName = partner?.user?.name ?? null;

  const [verifReq] = await db
    .insert(verifRequests)
    .values({
      messageId: input.messageId,
      userId: input.userId,
      doctorId: partner?.id ?? null,
      doctorName,
      userQuestion: input.userQuestion,
      aiAnswer: input.aiAnswer,
      status: 'pending',
    })
    .returning();

  await db
    .update(chatMessages)
    .set({
      needsVerif: true,
      verifStatus: 'pending',
      verifDoctorId: partner?.id ?? null,
      verifDoctorName: doctorName,
    })
    .where(eq(chatMessages.id, input.messageId));

  return verifReq;
}

export async function getDoctorPatientUserIds(doctorUserId: number): Promise<number[]> {
  const doctorRecord = await db.query.doctors.findFirst({
    where: eq(doctors.userId, doctorUserId),
  });
  if (!doctorRecord) return [];

  const links = await db.query.userDoctors.findMany({
    where: eq(userDoctors.doctorId, doctorRecord.id),
  });
  return links.map((l) => l.userId);
}

export async function getDoctorRecordId(doctorUserId: number): Promise<number | null> {
  const doctorRecord = await db.query.doctors.findFirst({
    where: eq(doctors.userId, doctorUserId),
  });
  return doctorRecord?.id ?? null;
}
