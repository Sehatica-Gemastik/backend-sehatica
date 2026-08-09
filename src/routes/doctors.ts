import { Hono } from 'hono';
import { db } from '../db';
import { doctors, users } from '../db/schema';
import { eq, desc } from 'drizzle-orm';
import { authMiddleware } from '../middlewares/auth';
import { successResponse, errorResponse } from '../utils/response';

const doctorsRoute = new Hono();

doctorsRoute.use('*', authMiddleware);

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
