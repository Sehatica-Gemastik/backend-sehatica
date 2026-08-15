import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { doctors, users } from '../../db/schema';
import { getDoctorByUserId } from './doctor-context';

export async function getDoctorPortalProfile(doctorUserId: number) {
  const doctor = await getDoctorByUserId(doctorUserId);
  if (!doctor?.user) return null;

  return {
    id: doctor.id,
    userId: doctor.userId,
    name: doctor.user.name,
    email: doctor.user.email,
    phone: doctor.user.phone,
    specialty: doctor.specialty,
    feePerQna: String(doctor.feePerQna),
    rating: Number(doctor.rating),
    reviewCount: doctor.reviewCount,
    verifiedCount: doctor.verifiedCount,
    isAvailable: doctor.isAvailable,
    bio: doctor.bio,
    avatarInitials: doctor.user.avatarInitials ?? 'DR',
  };
}

export async function updateDoctorPortalProfile(
  doctorUserId: number,
  input: { name?: string; phone?: string; specialty?: string; bio?: string },
) {
  const doctor = await getDoctorByUserId(doctorUserId);
  if (!doctor) return null;

  const userPatch: Partial<typeof users.$inferInsert> = {};
  if (input.name?.trim()) userPatch.name = input.name.trim();
  if (input.phone !== undefined) userPatch.phone = input.phone.trim() || null;

  if (Object.keys(userPatch).length > 0) {
    await db.update(users).set(userPatch).where(eq(users.id, doctor.userId));
  }

  const doctorPatch: Partial<typeof doctors.$inferInsert> = {};
  if (input.specialty?.trim()) doctorPatch.specialty = input.specialty.trim();
  if (input.bio !== undefined) doctorPatch.bio = input.bio.trim() || null;

  if (Object.keys(doctorPatch).length > 0) {
    await db.update(doctors).set(doctorPatch).where(eq(doctors.id, doctor.id));
  }

  return getDoctorPortalProfile(doctorUserId);
}
