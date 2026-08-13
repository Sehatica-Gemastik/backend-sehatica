import { Hono } from 'hono';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '../db';
import { doctorChatMessages, doctors, userDoctors } from '../db/schema';
import { authMiddleware } from '../middlewares/auth';
import { successResponse, errorResponse } from '../utils/response';

const chatRoute = new Hono();

chatRoute.use('*', authMiddleware);

function formatMessage(row: typeof doctorChatMessages.$inferSelect) {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    createdAt: row.createdAt.toISOString(),
  };
}

async function assertPartner(userId: number, doctorId: number) {
  const link = await db.query.userDoctors.findFirst({
    where: and(eq(userDoctors.userId, userId), eq(userDoctors.doctorId, doctorId)),
  });
  if (!link) return null;

  return db.query.doctors.findFirst({
    where: eq(doctors.id, doctorId),
    with: { user: true },
  });
}

// GET /chat/:doctorId/messages
chatRoute.get('/:doctorId/messages', async (c) => {
  try {
    const userId = c.get('userId') as number;
    const doctorId = parseInt(c.req.param('doctorId'), 10);
    if (!Number.isFinite(doctorId)) {
      return errorResponse(c, 'ID dokter tidak valid');
    }

    const doctor = await assertPartner(userId, doctorId);
    if (!doctor) {
      return errorResponse(c, 'Dokter partner tidak ditemukan', 404);
    }

    const rows = await db.query.doctorChatMessages.findMany({
      where: and(
        eq(doctorChatMessages.userId, userId),
        eq(doctorChatMessages.doctorId, doctorId)
      ),
      orderBy: [asc(doctorChatMessages.createdAt)],
    });

    return successResponse(c, {
      doctor: {
        id: doctor.id,
        name: doctor.user?.name ?? 'Dokter',
        specialty: doctor.specialty,
        avatarInitials: doctor.user?.avatarInitials ?? 'DR',
        isAvailable: doctor.isAvailable,
      },
      messages: rows.map(formatMessage),
    });
  } catch {
    return errorResponse(c, 'Gagal mengambil pesan', 500);
  }
});

// POST /chat/:doctorId/messages
chatRoute.post('/:doctorId/messages', async (c) => {
  try {
    const userId = c.get('userId') as number;
    const doctorId = parseInt(c.req.param('doctorId'), 10);
    if (!Number.isFinite(doctorId)) {
      return errorResponse(c, 'ID dokter tidak valid');
    }

    const doctor = await assertPartner(userId, doctorId);
    if (!doctor) {
      return errorResponse(c, 'Dokter partner tidak ditemukan', 404);
    }

    if (!doctor.isAvailable) {
      return errorResponse(c, 'Dokter sedang tidak tersedia');
    }

    const body = await c.req.json();
    const content = String(body.content ?? '').trim();
    if (!content) {
      return errorResponse(c, 'Pesan tidak boleh kosong');
    }
    if (content.length > 4000) {
      return errorResponse(c, 'Pesan terlalu panjang (maks. 4000 karakter)');
    }

    const [inserted] = await db
      .insert(doctorChatMessages)
      .values({ userId, doctorId, role: 'user', content })
      .returning();

    return successResponse(c, formatMessage(inserted), 201);
  } catch {
    return errorResponse(c, 'Gagal mengirim pesan', 500);
  }
});

export default chatRoute;
