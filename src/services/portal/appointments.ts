import { and, eq, gte, lte } from 'drizzle-orm';
import { db } from '../../db';
import { doctorAppointments, userDoctors } from '../../db/schema';
import { assertLinkedPatient, getDoctorByUserId } from './doctor-context';

function parseAppointmentWindow(start: string, end: string) {
  const startAt = new Date(start);
  const endAt = new Date(end);
  if (!Number.isFinite(startAt.getTime()) || !Number.isFinite(endAt.getTime())) {
    throw new Error('Waktu janji tidak valid');
  }
  if (endAt <= startAt) {
    throw new Error('Waktu selesai harus setelah waktu mulai');
  }
  return { startAt, endAt };
}

function mapAppointment(row: typeof doctorAppointments.$inferSelect) {
  return {
    id: String(row.id),
    patientId: row.patientId,
    title: row.title,
    notes: row.notes,
    start: row.startAt.toISOString(),
    end: row.endAt.toISOString(),
    status: row.status,
  };
}

export async function listDoctorAppointments(
  doctorUserId: number,
  options: { patientId?: number; from?: string; to?: string },
) {
  const doctor = await getDoctorByUserId(doctorUserId);
  if (!doctor) return [];

  const conditions = [eq(doctorAppointments.doctorId, doctor.id)];
  if (options.patientId) {
    await assertLinkedPatient(doctorUserId, options.patientId);
    conditions.push(eq(doctorAppointments.patientId, options.patientId));
  }
  if (options.from) {
    conditions.push(gte(doctorAppointments.startAt, new Date(`${options.from}T00:00:00`)));
  }
  if (options.to) {
    conditions.push(lte(doctorAppointments.startAt, new Date(`${options.to}T23:59:59`)));
  }

  const rows = await db.query.doctorAppointments.findMany({
    where: and(...conditions),
    orderBy: (table, { asc }) => [asc(table.startAt)],
  });

  return rows.map(mapAppointment);
}

export async function createDoctorAppointment(
  doctorUserId: number,
  input: {
    patientId: number;
    title: string;
    notes: string;
    start: string;
    end: string;
  },
) {
  const doctor = await assertLinkedPatient(doctorUserId, input.patientId);
  const { startAt, endAt } = parseAppointmentWindow(input.start, input.end);

  const [row] = await db
    .insert(doctorAppointments)
    .values({
      doctorId: doctor.id,
      patientId: input.patientId,
      title: input.title.trim(),
      notes: input.notes.trim(),
      startAt,
      endAt,
      status: 'scheduled',
    })
    .returning();

  return mapAppointment(row);
}

export async function updateDoctorAppointment(
  doctorUserId: number,
  appointmentId: number,
  input: {
    title: string;
    notes: string;
    start: string;
    end: string;
  },
) {
  const doctor = await getDoctorByUserId(doctorUserId);
  if (!doctor) throw new Error('Profil dokter tidak ditemukan');

  const existing = await db.query.doctorAppointments.findFirst({
    where: and(
      eq(doctorAppointments.id, appointmentId),
      eq(doctorAppointments.doctorId, doctor.id),
    ),
  });
  if (!existing) return null;

  const { startAt, endAt } = parseAppointmentWindow(input.start, input.end);
  const [row] = await db
    .update(doctorAppointments)
    .set({
      title: input.title.trim(),
      notes: input.notes.trim(),
      startAt,
      endAt,
      status: 'scheduled',
    })
    .where(eq(doctorAppointments.id, appointmentId))
    .returning();

  return mapAppointment(row);
}

export async function deleteDoctorAppointment(doctorUserId: number, appointmentId: number) {
  const doctor = await getDoctorByUserId(doctorUserId);
  if (!doctor) return false;

  const existing = await db.query.doctorAppointments.findFirst({
    where: and(
      eq(doctorAppointments.id, appointmentId),
      eq(doctorAppointments.doctorId, doctor.id),
    ),
  });
  if (!existing) return false;

  await db.delete(doctorAppointments).where(eq(doctorAppointments.id, appointmentId));
  return true;
}

export async function listPatientAppointments(patientUserId: number, from?: string, to?: string) {
  const conditions = [eq(doctorAppointments.patientId, patientUserId)];
  if (from) conditions.push(gte(doctorAppointments.startAt, new Date(`${from}T00:00:00`)));
  if (to) conditions.push(lte(doctorAppointments.startAt, new Date(`${to}T23:59:59`)));

  const rows = await db.query.doctorAppointments.findMany({
    where: and(...conditions),
    with: { doctor: { with: { user: true } } },
    orderBy: (table, { asc }) => [asc(table.startAt)],
  });

  return rows.map((row) => ({
    id: String(row.id),
    doctorId: row.doctorId,
    doctorName: row.doctor?.user?.name ?? 'Dokter',
    specialty: row.doctor?.specialty ?? '',
    patientId: row.patientId,
    title: row.title,
    notes: row.notes,
    start: row.startAt.toISOString(),
    end: row.endAt.toISOString(),
    status: row.status,
  }));
}

async function assertDoctorPartner(patientUserId: number, doctorId: number) {
  const link = await db.query.userDoctors.findFirst({
    where: and(
      eq(userDoctors.userId, patientUserId),
      eq(userDoctors.doctorId, doctorId),
    ),
  });
  if (!link) throw new Error('Dokter partner tidak ditemukan');
}

export async function createPatientAppointment(
  patientUserId: number,
  input: {
    doctorId: number;
    title: string;
    notes: string;
    start: string;
    end: string;
  },
) {
  await assertDoctorPartner(patientUserId, input.doctorId);
  const { startAt, endAt } = parseAppointmentWindow(input.start, input.end);

  const [row] = await db
    .insert(doctorAppointments)
    .values({
      doctorId: input.doctorId,
      patientId: patientUserId,
      title: input.title.trim(),
      notes: input.notes.trim(),
      startAt,
      endAt,
      status: 'scheduled',
    })
    .returning();

  return mapAppointment(row);
}

export async function updatePatientAppointment(
  patientUserId: number,
  appointmentId: number,
  input: {
    doctorId: number;
    title: string;
    notes: string;
    start: string;
    end: string;
  },
) {
  const existing = await db.query.doctorAppointments.findFirst({
    where: and(
      eq(doctorAppointments.id, appointmentId),
      eq(doctorAppointments.patientId, patientUserId),
    ),
  });
  if (!existing) return null;

  const doctorId = Number.isFinite(input.doctorId) ? input.doctorId : existing.doctorId;
  await assertDoctorPartner(patientUserId, doctorId);
  const { startAt, endAt } = parseAppointmentWindow(input.start, input.end);

  const [row] = await db
    .update(doctorAppointments)
    .set({
      doctorId,
      title: input.title.trim(),
      notes: input.notes.trim(),
      startAt,
      endAt,
      status: 'scheduled',
    })
    .where(eq(doctorAppointments.id, appointmentId))
    .returning();

  return mapAppointment(row);
}

export async function deletePatientAppointment(patientUserId: number, appointmentId: number) {
  const existing = await db.query.doctorAppointments.findFirst({
    where: and(
      eq(doctorAppointments.id, appointmentId),
      eq(doctorAppointments.patientId, patientUserId),
    ),
  });
  if (!existing) return false;

  await db.delete(doctorAppointments).where(eq(doctorAppointments.id, appointmentId));
  return true;
}
