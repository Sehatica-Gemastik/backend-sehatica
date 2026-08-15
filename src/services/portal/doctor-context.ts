import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import { doctors, userDoctors } from '../../db/schema';

export async function getDoctorByUserId(userId: number) {
  return db.query.doctors.findFirst({
    where: eq(doctors.userId, userId),
    with: { user: true },
  });
}

export async function assertLinkedPatient(doctorUserId: number, patientUserId: number) {
  const doctor = await getDoctorByUserId(doctorUserId);
  if (!doctor) {
    throw new PortalError('Profil dokter tidak ditemukan', 404);
  }

  const link = await db.query.userDoctors.findFirst({
    where: and(
      eq(userDoctors.doctorId, doctor.id),
      eq(userDoctors.userId, patientUserId),
    ),
  });

  if (!link) {
    throw new PortalError('Pasien partner tidak ditemukan', 404);
  }

  return doctor;
}

export class PortalError extends Error {
  constructor(
    message: string,
    public status: 400 | 403 | 404 | 500 = 400,
  ) {
    super(message);
  }
}
