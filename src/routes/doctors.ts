import { Hono } from 'hono';
import { db } from '../db';
import { doctors, users } from '../db/schema';
import { eq, desc } from 'drizzle-orm';
import { authMiddleware, doctorMiddleware } from '../middlewares/auth';
import { successResponse, errorResponse } from '../utils/response';
import { generateAvatarInitials } from '../utils/password';

const doctorsRoute = new Hono();

doctorsRoute.use('*', authMiddleware);

// GET /doctors/me — current doctor's detailed profile
doctorsRoute.get('/me', doctorMiddleware, async (c) => {
  try {
    const userId = c.get('userId');
    const doctor = await db.query.doctors.findFirst({
      where: eq(doctors.userId, userId),
      with: { user: true },
    });

    if (!doctor) return errorResponse(c, 'Profil dokter tidak ditemukan', 404);

    return successResponse(c, {
      id: doctor.id,
      userId: doctor.userId,
      name: doctor.user?.name ?? 'Dokter',
      email: doctor.user?.email ?? '',
      phone: doctor.user?.phone ?? '',
      specialty: doctor.specialty,
      feePerQna: doctor.feePerQna ?? '25000',
      rating: parseFloat(doctor.rating ?? '5.0'),
      reviewCount: doctor.reviewCount,
      verifiedCount: doctor.verifiedCount,
      isAvailable: doctor.isAvailable,
      bio: doctor.bio,
      avatarInitials: doctor.user?.avatarInitials ?? 'DR',
    });
  } catch {
    return errorResponse(c, 'Gagal mengambil profil dokter', 500);
  }
});

// PATCH /doctors/me — update current doctor's profile, feePerQna & availability
doctorsRoute.patch('/me', doctorMiddleware, async (c) => {
  try {
    const userId = c.get('userId');
    const doctor = await db.query.doctors.findFirst({ where: eq(doctors.userId, userId) });
    if (!doctor) return errorResponse(c, 'Profil dokter tidak ditemukan', 404);

    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object') return errorResponse(c, 'Body request tidak valid');

    const { name, phone, specialty, feePerQna, bio, isAvailable } = body;

    await db.transaction(async (tx) => {
      const userUpdates: Record<string, unknown> = { updatedAt: new Date() };
      if (typeof name === 'string' && name.trim()) {
        userUpdates.name = name.trim();
        userUpdates.avatarInitials = generateAvatarInitials(name.trim());
      }
      if (phone !== undefined) userUpdates.phone = typeof phone === 'string' ? phone.trim() : null;

      if (Object.keys(userUpdates).length > 1) {
        await tx.update(users).set(userUpdates).where(eq(users.id, userId));
      }

      const doctorUpdates: Record<string, unknown> = {};
      if (typeof specialty === 'string' && specialty.trim()) doctorUpdates.specialty = specialty.trim();
      if (feePerQna !== undefined) {
        const parsedFee = parseFloat(String(feePerQna));
        doctorUpdates.feePerQna = isNaN(parsedFee) || parsedFee < 0 ? '25000' : parsedFee.toString();
      }
      if (bio !== undefined) doctorUpdates.bio = typeof bio === 'string' ? bio.trim() : null;
      if (typeof isAvailable === 'boolean') doctorUpdates.isAvailable = isAvailable;

      if (Object.keys(doctorUpdates).length > 0) {
        await tx.update(doctors).set(doctorUpdates).where(eq(doctors.id, doctor.id));
      }
    });

    const updatedDoctor = await db.query.doctors.findFirst({
      where: eq(doctors.id, doctor.id),
      with: { user: true },
    });

    return successResponse(c, {
      id: updatedDoctor!.id,
      name: updatedDoctor!.user?.name ?? 'Dokter',
      email: updatedDoctor!.user?.email ?? '',
      phone: updatedDoctor!.user?.phone ?? '',
      specialty: updatedDoctor!.specialty,
      feePerQna: updatedDoctor!.feePerQna ?? '25000',
      rating: parseFloat(updatedDoctor!.rating ?? '5.0'),
      reviewCount: updatedDoctor!.reviewCount,
      verifiedCount: updatedDoctor!.verifiedCount,
      isAvailable: updatedDoctor!.isAvailable,
      bio: updatedDoctor!.bio,
      avatarInitials: updatedDoctor!.user?.avatarInitials ?? 'DR',
    });
  } catch (err) {
    console.error('Update doctor profile error:', err);
    return errorResponse(c, 'Gagal memperbarui profil dokter', 500);
  }
});

// GET /doctors/patients — list non-doctor users for voluntary review selection
doctorsRoute.get('/patients', doctorMiddleware, async (c) => {
  try {
    const allUsers = await db.query.users.findMany({
      where: eq(users.role, 'user'),
      orderBy: [desc(users.createdAt)],
    });

    const formatted = allUsers.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      phone: u.phone,
      avatarInitials: u.avatarInitials ?? 'PA',
    }));

    return successResponse(c, formatted);
  } catch {
    return errorResponse(c, 'Gagal mengambil daftar pasien', 500);
  }
});

// GET /doctors — list all available doctors
doctorsRoute.get('/', async (c) => {
  try {
    const allDoctors = await db.query.doctors.findMany({
      with: { user: true },
      orderBy: [desc(doctors.verifiedCount)],
    });

    const formatted = allDoctors.map((d: any) => ({
      id: d.id,
      name: d.user?.name ?? 'Dokter',
      specialty: d.specialty,
      feePerQna: d.feePerQna ?? '25000',
      rating: parseFloat(d.rating ?? '5.0'),
      reviewCount: d.reviewCount,
      verifiedCount: d.verifiedCount,
      isAvailable: d.isAvailable,
      bio: d.bio,
      avatarInitials: d.user?.avatarInitials ?? 'DR',
      colorScheme: 'blue',
    }));

    return successResponse(c, formatted);
  } catch {
    return errorResponse(c, 'Gagal mengambil daftar dokter', 500);
  }
});

// GET /doctors/:id
doctorsRoute.get('/:id', async (c) => {
  try {
    const id = parseInt(c.req.param('id'));
    const doctor = await db.query.doctors.findFirst({
      where: eq(doctors.id, id),
      with: { user: true },
    });

    if (!doctor) return errorResponse(c, 'Dokter tidak ditemukan', 404);

    return successResponse(c, {
      id: doctor.id,
      name: (doctor as any).user?.name ?? 'Dokter',
      specialty: doctor.specialty,
      feePerQna: doctor.feePerQna ?? '25000',
      rating: parseFloat(doctor.rating ?? '5.0'),
      reviewCount: doctor.reviewCount,
      verifiedCount: doctor.verifiedCount,
      isAvailable: doctor.isAvailable,
      bio: doctor.bio,
      avatarInitials: (doctor as any).user?.avatarInitials ?? 'DR',
    });
  } catch {
    return errorResponse(c, 'Terjadi kesalahan server', 500);
  }
});

export default doctorsRoute;
