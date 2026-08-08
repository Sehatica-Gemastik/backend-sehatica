import { Hono } from 'hono';
import { db } from '../db';
import { verifRequests, chatMessages, doctors, users } from '../db/schema';
import { eq, desc, or, inArray } from 'drizzle-orm';
import { getDoctorPatientUserIds, getDoctorRecordId } from '../services/heally/verif-flow';
import { authMiddleware, doctorMiddleware } from '../middlewares/auth';
import { successResponse, errorResponse } from '../utils/response';

const verif = new Hono();

verif.use('*', authMiddleware);

// GET /verif — list verif requests for the current user
verif.get('/', async (c) => {
  try {
    const userId = c.get('userId') as number;
    const userRole = c.get('userRole') as string;

    let list;
    if (userRole === 'admin') {
      list = await db.query.verifRequests.findMany({
        with: { user: true, doctor: { with: { user: true } } },
        orderBy: [desc(verifRequests.createdAt)],
      });
    } else if (userRole === 'doctor') {
      const patientIds = await getDoctorPatientUserIds(userId);
      const doctorId = await getDoctorRecordId(userId);

      const conditions = [];
      if (doctorId) conditions.push(eq(verifRequests.doctorId, doctorId));
      if (patientIds.length > 0) conditions.push(inArray(verifRequests.userId, patientIds));

      list = await db.query.verifRequests.findMany({
        where: conditions.length > 0 ? or(...conditions) : eq(verifRequests.id, -1),
        with: { user: true, doctor: { with: { user: true } } },
        orderBy: [desc(verifRequests.createdAt)],
      });
    } else {
      // Users see their own requests
      list = await db.query.verifRequests.findMany({
        where: eq(verifRequests.userId, userId),
        with: { doctor: { with: { user: true } } },
        orderBy: [desc(verifRequests.createdAt)],
      });
    }

    // Format response
    const formatted = list.map((r: any) => ({
      id: r.id,
      messageId: r.messageId,
      userQuestion: r.userQuestion,
      aiAnswer: r.aiAnswer,
      status: r.status,
      doctorNote: r.doctorNote,
      doctorName: r.doctorName ?? r.doctor?.user?.name ?? '',
      userName: r.user?.name,
      userAvatar: r.user?.avatarInitials,
      requestedAt: r.createdAt,
      reviewedAt: r.reviewedAt,
    }));

    return successResponse(c, formatted);
  } catch (err) {
    console.error(err);
    return errorResponse(c, 'Terjadi kesalahan server', 500);
  }
});

// PATCH /verif/:id/approve — doctor approves
verif.patch('/:id/approve', async (c) => {
  try {
    const userId = c.get('userId') as number;
    const id = parseInt(c.req.param('id'));
    const userRole = c.get('userRole') as string;

    const req = await db.query.verifRequests.findFirst({
      where: eq(verifRequests.id, id),
    });
    if (!req) return errorResponse(c, 'Permintaan verifikasi tidak ditemukan', 404);

    // Find doctor record for this user
    const doctorRecord = await db.query.doctors.findFirst({
      where: eq(doctors.userId, userId),
      with: { user: true },
    });

    const doctorName = doctorRecord
      ? (doctorRecord as any).user?.name ?? 'Dokter'
      : 'Dokter';

    const [updated] = await db
      .update(verifRequests)
      .set({
        status: 'approved',
        doctorId: doctorRecord?.id ?? null,
        doctorName,
        reviewedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(verifRequests.id, id))
      .returning();

    // Update the linked chat message
    if (req.messageId) {
      await db.update(chatMessages)
        .set({ verifStatus: 'approved', verifDoctorName: doctorName })
        .where(eq(chatMessages.id, req.messageId));
    }

    // Increment doctor verified count
    if (doctorRecord) {
      await db.update(doctors)
        .set({ verifiedCount: (doctorRecord.verifiedCount ?? 0) + 1 })
        .where(eq(doctors.id, doctorRecord.id));
    }

    return successResponse(c, updated);
  } catch {
    return errorResponse(c, 'Terjadi kesalahan server', 500);
  }
});

// PATCH /verif/:id/revise — doctor submits revision
verif.patch('/:id/revise', async (c) => {
  try {
    const userId = c.get('userId') as number;
    const id = parseInt(c.req.param('id'));
    const body = await c.req.json();
    const { doctorNote } = body;

    if (!doctorNote?.trim()) {
      return errorResponse(c, 'Catatan revisi tidak boleh kosong');
    }

    const req = await db.query.verifRequests.findFirst({
      where: eq(verifRequests.id, id),
    });
    if (!req) return errorResponse(c, 'Permintaan verifikasi tidak ditemukan', 404);

    const doctorRecord = await db.query.doctors.findFirst({
      where: eq(doctors.userId, userId),
      with: { user: true },
    });

    const doctorName = doctorRecord
      ? (doctorRecord as any).user?.name ?? 'Dokter'
      : 'Dokter';

    const [updated] = await db
      .update(verifRequests)
      .set({
        status: 'revised',
        doctorNote: doctorNote.trim(),
        doctorId: doctorRecord?.id ?? null,
        doctorName,
        reviewedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(verifRequests.id, id))
      .returning();

    if (req.messageId) {
      await db.update(chatMessages)
        .set({
          verifStatus: 'revised',
          verifNote: doctorNote.trim(),
          verifDoctorName: doctorName,
        })
        .where(eq(chatMessages.id, req.messageId));
    }

    if (doctorRecord) {
      await db.update(doctors)
        .set({ verifiedCount: (doctorRecord.verifiedCount ?? 0) + 1 })
        .where(eq(doctors.id, doctorRecord.id));
    }

    return successResponse(c, updated);
  } catch {
    return errorResponse(c, 'Terjadi kesalahan server', 500);
  }
});

export default verif;
