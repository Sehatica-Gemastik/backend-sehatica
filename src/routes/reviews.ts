import { and, desc, eq, gt, lt, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { db } from '../db';
import { chatSessions, doctors, reviews, reviewItems, users } from '../db/schema';
import { authMiddleware, doctorMiddleware } from '../middlewares/auth';
import { errorResponse, successResponse } from '../utils/response';
import { generateAvatarInitials } from '../utils/password';

const reviewRoutes = new Hono();
reviewRoutes.use('*', authMiddleware);

async function deleteExpiredReviews() {
  await db.delete(reviews).where(lt(reviews.expiresAt, new Date()));
}

// POST /reviews — user submits a review request (Paid or Voluntary Open Pool)
reviewRoutes.post('/', async (c) => {
  if (c.get('userRole') !== 'user') return errorResponse(c, 'Hanya pasien yang dapat meminta review', 403);
  
  try {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object') return errorResponse(c, 'Data review tidak valid');

    const {
      doctorId,
      clientMessageId,
      patientQuestion,
      aiResponse,
      safetyLevel = 'general',
      patientNote,
      reviewScope = 'bubble', // 'bubble' | 'session' | 'history'
      reviewType = 'paid', // 'paid' | 'voluntary'
      sessionId,
      items = [], // Array of { clientMessageId, patientQuestion, aiResponse, safetyLevel }
    } = body;

    const userId = c.get('userId');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const qnaCount = Array.isArray(items) && items.length > 0 ? items.length : 1;

    let validSessionId: number | null = null;
    if (sessionId && !isNaN(Number(sessionId))) {
      const parsedSessId = Number(sessionId);
      const existingSession = await db.query.chatSessions.findFirst({
        where: and(eq(chatSessions.id, parsedSessId), eq(chatSessions.userId, userId)),
      });
      if (existingSession) {
        validSessionId = existingSession.id;
      }
    }

    try { await deleteExpiredReviews(); } catch { /* ignore expiration cleanup errors */ }

    if (reviewType === 'paid') {
      if (!doctorId || typeof doctorId !== 'number') {
        return errorResponse(c, 'Pilih dokter untuk review berbayar');
      }
      const doctor = await db.query.doctors.findFirst({
        where: and(eq(doctors.id, doctorId), eq(doctors.isAvailable, true)),
      });
      if (!doctor) return errorResponse(c, 'Dokter tidak tersedia', 404);

      const feePerQna = parseFloat(doctor.feePerQna ?? '25000');
      const calculatedFee = (qnaCount * feePerQna).toString();

      const created = await db.transaction(async (tx) => {
        const [rev] = await tx.insert(reviews).values({
          userId,
          doctorId,
          sessionId: validSessionId,
          reviewScope,
          reviewType: 'paid',
          requestStatus: 'accepted',
          isPaid: true,
          qnaCount,
          fee: calculatedFee,
          clientMessageId: clientMessageId ? Number(clientMessageId) : (items[0]?.clientMessageId ?? 1),
          patientQuestion: patientQuestion || (items[0]?.patientQuestion ?? 'Review Konsultasi Berbayar'),
          aiResponse: aiResponse || (items[0]?.aiResponse ?? 'Respon AI Heally'),
          safetyLevel: safetyLevel || 'general',
          patientNote: typeof patientNote === 'string' ? patientNote.trim() : null,
          status: 'pending',
          expiresAt,
        }).returning();

        if (Array.isArray(items) && items.length > 0) {
          for (const item of items) {
            if (item.clientMessageId && item.patientQuestion && item.aiResponse) {
              await tx.insert(reviewItems).values({
                reviewId: rev.id,
                clientMessageId: Number(item.clientMessageId),
                patientQuestion: String(item.patientQuestion),
                aiResponse: String(item.aiResponse),
                safetyLevel: item.safetyLevel || 'general',
                itemStatus: 'pending',
              });
            }
          }
        } else if (clientMessageId && patientQuestion && aiResponse) {
          await tx.insert(reviewItems).values({
            reviewId: rev.id,
            clientMessageId: Number(clientMessageId),
            patientQuestion: String(patientQuestion),
            aiResponse: String(aiResponse),
            safetyLevel: safetyLevel || 'general',
            itemStatus: 'pending',
          });
        }

        return rev;
      });

      return successResponse(c, created, 201);
    } else {
      // Voluntary Review -> Submitted to Open Pool (no doctor assigned yet)
      const created = await db.transaction(async (tx) => {
        const [rev] = await tx.insert(reviews).values({
          userId,
          sessionId: validSessionId,
          reviewScope,
          reviewType: 'voluntary',
          requestStatus: 'open_pool',
          isPaid: false,
          qnaCount,
          fee: '0',
          clientMessageId: clientMessageId ? Number(clientMessageId) : (items[0]?.clientMessageId ?? 1),
          patientQuestion: patientQuestion || (items[0]?.patientQuestion ?? 'Review Konsultasi Sukarela'),
          aiResponse: aiResponse || (items[0]?.aiResponse ?? 'Respon AI Heally'),
          safetyLevel: safetyLevel || 'general',
          patientNote: typeof patientNote === 'string' ? patientNote.trim() : null,
          status: 'pending',
          expiresAt,
        }).returning();

        if (Array.isArray(items) && items.length > 0) {
          for (const item of items) {
            if (item.clientMessageId && item.patientQuestion && item.aiResponse) {
              await tx.insert(reviewItems).values({
                reviewId: rev.id,
                clientMessageId: Number(item.clientMessageId),
                patientQuestion: String(item.patientQuestion),
                aiResponse: String(item.aiResponse),
                safetyLevel: item.safetyLevel || 'general',
                itemStatus: 'pending',
              });
            }
          }
        } else if (clientMessageId && patientQuestion && aiResponse) {
          await tx.insert(reviewItems).values({
            reviewId: rev.id,
            clientMessageId: Number(clientMessageId),
            patientQuestion: String(patientQuestion),
            aiResponse: String(aiResponse),
            safetyLevel: safetyLevel || 'general',
            itemStatus: 'pending',
          });
        }

        return rev;
      });

      return successResponse(c, created, 201);
    }
  } catch (err) {
    console.error('Submit review error:', err);
    return errorResponse(c, err instanceof Error ? err.message : 'Gagal menyimpan permintaan review', 500);
  }
});

// Rule 3: Doctor CANNOT initiate review requests to arbitrary users
reviewRoutes.post('/request-voluntary', doctorMiddleware, async (c) => {
  return errorResponse(c, 'Dokter tidak dapat mengajukan review ke pasien. Permintaan review harus berasal dari pasien.', 403);
});

// GET /reviews/voluntary-pool — Doctor lists open voluntary review requests in pool (ANONYMIZED)
reviewRoutes.get('/voluntary-pool', doctorMiddleware, async (c) => {
  await deleteExpiredReviews();

  const rows = await db
    .select({
      id: reviews.id,
      patientInitials: users.avatarInitials,
      reviewScope: reviews.reviewScope,
      qnaCount: reviews.qnaCount,
      safetyLevel: reviews.safetyLevel,
      requestStatus: reviews.requestStatus,
      createdAt: reviews.createdAt,
      expiresAt: reviews.expiresAt,
    })
    .from(reviews)
    .innerJoin(users, eq(reviews.userId, users.id))
    .where(and(
      eq(reviews.reviewType, 'voluntary'),
      eq(reviews.requestStatus, 'open_pool')
    ))
    .orderBy(desc(reviews.createdAt));

  // Explicitly return anonymized data without conversation contents
  const anonymized = rows.map((r) => ({
    id: r.id,
    patientInitials: r.patientInitials ?? 'PA',
    reviewScope: r.reviewScope,
    qnaCount: r.qnaCount,
    safetyLevel: r.safetyLevel,
    requestStatus: r.requestStatus,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
  }));

  return successResponse(c, anonymized);
});

// POST /reviews/:id/claim-voluntary — Doctor claims an open voluntary request & asks user for permission
reviewRoutes.post('/:id/claim-voluntary', doctorMiddleware, async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id < 1) return errorResponse(c, 'Review tidak valid');

  const doctor = await db.query.doctors.findFirst({ where: eq(doctors.userId, c.get('userId')) });
  if (!doctor) return errorResponse(c, 'Profil dokter tidak ditemukan', 403);

  const review = await db.query.reviews.findFirst({ where: eq(reviews.id, id) });
  if (!review) return errorResponse(c, 'Permintaan review tidak ditemukan', 404);

  if (review.reviewType !== 'voluntary' || review.requestStatus !== 'open_pool') {
    return errorResponse(c, 'Permintaan review ini tidak tersedia di pool sukarela', 409);
  }

  const [updated] = await db
    .update(reviews)
    .set({
      claimedDoctorId: doctor.id,
      requestStatus: 'permission_requested',
      updatedAt: new Date(),
    })
    .where(eq(reviews.id, id))
    .returning();

  return successResponse(c, updated);
});

// GET /reviews/permission-requests — Mobile user lists pending permission requests from doctors
reviewRoutes.get('/permission-requests', async (c) => {
  await deleteExpiredReviews();
  const userId = c.get('userId');

  const rows = await db
    .select({
      id: reviews.id,
      doctorId: reviews.claimedDoctorId,
      doctorName: users.name,
      specialty: doctors.specialty,
      avatarInitials: users.avatarInitials,
      reviewScope: reviews.reviewScope,
      qnaCount: reviews.qnaCount,
      createdAt: reviews.createdAt,
    })
    .from(reviews)
    .innerJoin(doctors, eq(reviews.claimedDoctorId, doctors.id))
    .innerJoin(users, eq(doctors.userId, users.id))
    .where(and(
      eq(reviews.userId, userId),
      eq(reviews.reviewType, 'voluntary'),
      eq(reviews.requestStatus, 'permission_requested')
    ))
    .orderBy(desc(reviews.createdAt));

  return successResponse(c, rows);
});

// PATCH /reviews/:id/grant-permission — Mobile user grants or declines doctor access
reviewRoutes.patch('/:id/grant-permission', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id < 1) return errorResponse(c, 'Review tidak valid');

  const userId = c.get('userId');
  const body = await c.req.json().catch(() => null);
  const action = body?.action; // 'grant' | 'decline'

  if (action !== 'grant' && action !== 'decline') {
    return errorResponse(c, 'Aksi harus "grant" atau "decline"');
  }

  const review = await db.query.reviews.findFirst({
    where: and(eq(reviews.id, id), eq(reviews.userId, userId)),
  });

  if (!review) return errorResponse(c, 'Permintaan review tidak ditemukan', 404);
  if (review.requestStatus !== 'permission_requested' || !review.claimedDoctorId) {
    return errorResponse(c, 'Permintaan ini tidak dalam status menunggu izin', 409);
  }

  if (action === 'grant') {
    const [updated] = await db
      .update(reviews)
      .set({
        doctorId: review.claimedDoctorId,
        requestStatus: 'accepted',
        consentedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(reviews.id, id))
      .returning();

    return successResponse(c, updated);
  } else {
    const [updated] = await db
      .update(reviews)
      .set({
        requestStatus: 'declined',
        updatedAt: new Date(),
      })
      .where(eq(reviews.id, id))
      .returning();

    return successResponse(c, updated);
  }
});

// GET /reviews/mine — Mobile user views all their submitted review requests & doctor decisions
reviewRoutes.get('/mine', async (c) => {
  await deleteExpiredReviews();
  const userId = c.get('userId');

  const rows = await db
    .select({
      id: reviews.id,
      clientMessageId: reviews.clientMessageId,
      status: reviews.status,
      reviewScope: reviews.reviewScope,
      reviewType: reviews.reviewType,
      requestStatus: reviews.requestStatus,
      isPaid: reviews.isPaid,
      fee: reviews.fee,
      qnaCount: reviews.qnaCount,
      doctorName: users.name,
      doctorNote: reviews.doctorNote,
      doctorSummaryNote: reviews.doctorSummaryNote,
      expiresAt: reviews.expiresAt,
      decidedAt: reviews.decidedAt,
    })
    .from(reviews)
    .leftJoin(doctors, eq(reviews.doctorId, doctors.id))
    .leftJoin(users, eq(doctors.userId, users.id))
    .where(eq(reviews.userId, userId))
    .orderBy(desc(reviews.createdAt));

  const fullRows = await Promise.all(rows.map(async (r) => {
    const items = await db.query.reviewItems.findMany({
      where: eq(reviewItems.reviewId, r.id),
    });
    return { ...r, items, doctorName: r.doctorName ?? 'Dokter' };
  }));

  return successResponse(c, fullRows);
});

// GET /reviews/assigned — Doctor views assigned review queue (Paid + Granted Voluntary)
reviewRoutes.get('/assigned', doctorMiddleware, async (c) => {
  await deleteExpiredReviews();
  const doctor = await db.query.doctors.findFirst({ where: eq(doctors.userId, c.get('userId')) });
  if (!doctor) return errorResponse(c, 'Profil dokter tidak ditemukan', 403);

  const rows = await db
    .select({
      id: reviews.id,
      userId: reviews.userId,
      patientName: users.name,
      patientEmail: users.email,
      patientPhone: users.phone,
      patientQuestion: reviews.patientQuestion,
      aiResponse: reviews.aiResponse,
      safetyLevel: reviews.safetyLevel,
      patientNote: reviews.patientNote,
      reviewScope: reviews.reviewScope,
      reviewType: reviews.reviewType,
      requestStatus: reviews.requestStatus,
      isPaid: reviews.isPaid,
      fee: reviews.fee,
      qnaCount: reviews.qnaCount,
      status: reviews.status,
      doctorNote: reviews.doctorNote,
      doctorSummaryNote: reviews.doctorSummaryNote,
      consentedAt: reviews.consentedAt,
      decidedAt: reviews.decidedAt,
      expiresAt: reviews.expiresAt,
    })
    .from(reviews)
    .innerJoin(users, eq(reviews.userId, users.id))
    .where(and(
      eq(reviews.doctorId, doctor.id),
      eq(reviews.requestStatus, 'accepted') // Strictly requires user permission granted or paid
    ))
    .orderBy(sql`${reviews.status} = 'pending' DESC`, desc(reviews.createdAt));

  const fullRows = await Promise.all(rows.map(async (r) => {
    const items = await db.query.reviewItems.findMany({
      where: eq(reviewItems.reviewId, r.id),
    });
    return { ...r, items };
  }));

  return successResponse(c, fullRows);
});

// PATCH /reviews/:id — Doctor submits review decision with per-bubble notes & master summary
reviewRoutes.patch('/:id', doctorMiddleware, async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id < 1) return errorResponse(c, 'Review tidak valid');

  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') return errorResponse(c, 'Body keputusan tidak valid');

  const { status, doctorSummaryNote, doctorNote, items = [] } = body;
  if (status !== 'approved' && status !== 'revised') {
    return errorResponse(c, 'Status harus "approved" atau "revised"');
  }

  const doctor = await db.query.doctors.findFirst({ where: eq(doctors.userId, c.get('userId')) });
  if (!doctor) return errorResponse(c, 'Profil dokter tidak ditemukan', 403);

  const decidedAt = new Date();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  const updated = await db.transaction(async (tx) => {
    const [review] = await tx.update(reviews).set({
      status,
      doctorNote: typeof doctorNote === 'string' ? doctorNote.trim() : null,
      doctorSummaryNote: typeof doctorSummaryNote === 'string' ? doctorSummaryNote.trim() : (doctorNote || null),
      decidedAt,
      expiresAt,
      updatedAt: decidedAt,
    }).where(and(
      eq(reviews.id, id),
      eq(reviews.doctorId, doctor.id),
      eq(reviews.requestStatus, 'accepted'),
      eq(reviews.status, 'pending'),
      gt(reviews.expiresAt, decidedAt),
    )).returning();

    if (!review) return null;

    if (Array.isArray(items)) {
      for (const item of items) {
        if (item.clientMessageId) {
          await tx.update(reviewItems).set({
            doctorItemNote: item.doctorItemNote ? String(item.doctorItemNote).trim() : null,
            itemStatus: item.itemStatus === 'revised' ? 'revised' : 'approved',
          }).where(and(
            eq(reviewItems.reviewId, id),
            eq(reviewItems.clientMessageId, Number(item.clientMessageId))
          ));
        }
      }
    }

    await tx.update(doctors).set({
      verifiedCount: sql`${doctors.verifiedCount} + 1`,
    }).where(eq(doctors.id, doctor.id));

    return review;
  });

  if (!updated) return errorResponse(c, 'Review tidak tersedia atau sudah diputuskan', 409);
  return successResponse(c, updated);
});

export default reviewRoutes;
