import { and, desc, eq, gt, lt, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { db } from '../db';
import { doctors, reviews, users } from '../db/schema';
import { authMiddleware, doctorMiddleware } from '../middlewares/auth';
import { errorResponse, successResponse } from '../utils/response';
import { parseReviewDecision, parseReviewSubmission } from '../utils/review';

const reviewRoutes = new Hono();
reviewRoutes.use('*', authMiddleware);

async function deleteExpiredReviews() {
  await db.delete(reviews).where(lt(reviews.expiresAt, new Date()));
}

reviewRoutes.post('/', async (c) => {
  if (c.get('userRole') !== 'user') return errorResponse(c, 'Hanya pasien yang dapat meminta review', 403);
  const parsed = parseReviewSubmission(await c.req.json().catch(() => null));
  if (typeof parsed === 'string') return errorResponse(c, parsed);

  await deleteExpiredReviews();
  const doctor = await db.query.doctors.findFirst({
    where: and(eq(doctors.id, parsed.doctorId), eq(doctors.isAvailable, true)),
  });
  if (!doctor) return errorResponse(c, 'Dokter tidak tersedia', 404);

  const userId = c.get('userId');
  const existing = await db.query.reviews.findFirst({
    where: and(eq(reviews.userId, userId), eq(reviews.clientMessageId, parsed.clientMessageId)),
  });
  if (existing) return errorResponse(c, 'Pesan ini sudah dikirim untuk review', 409);

  // ponytail: pending bundle lives seven days; make this policy configurable when retention is approved.
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const [created] = await db.insert(reviews).values({
    ...parsed,
    userId,
    expiresAt,
  }).returning({ id: reviews.id, status: reviews.status, expiresAt: reviews.expiresAt });

  return successResponse(c, created, 201);
});

reviewRoutes.get('/mine', async (c) => {
  await deleteExpiredReviews();
  const rows = await db
    .select({
      id: reviews.id,
      clientMessageId: reviews.clientMessageId,
      status: reviews.status,
      doctorName: users.name,
      doctorNote: reviews.doctorNote,
      expiresAt: reviews.expiresAt,
      decidedAt: reviews.decidedAt,
    })
    .from(reviews)
    .innerJoin(doctors, eq(reviews.doctorId, doctors.id))
    .innerJoin(users, eq(doctors.userId, users.id))
    .where(eq(reviews.userId, c.get('userId')))
    .orderBy(desc(reviews.createdAt));
  return successResponse(c, rows);
});

reviewRoutes.get('/assigned', doctorMiddleware, async (c) => {
  await deleteExpiredReviews();
  const doctor = await db.query.doctors.findFirst({ where: eq(doctors.userId, c.get('userId')) });
  if (!doctor) return errorResponse(c, 'Profil dokter tidak ditemukan', 403);

  const rows = await db
    .select({
      id: reviews.id,
      patientName: users.name,
      patientQuestion: reviews.patientQuestion,
      aiResponse: reviews.aiResponse,
      safetyLevel: reviews.safetyLevel,
      patientNote: reviews.patientNote,
      status: reviews.status,
      doctorNote: reviews.doctorNote,
      consentedAt: reviews.consentedAt,
      decidedAt: reviews.decidedAt,
      expiresAt: reviews.expiresAt,
    })
    .from(reviews)
    .innerJoin(users, eq(reviews.userId, users.id))
    .where(eq(reviews.doctorId, doctor.id))
    .orderBy(sql`${reviews.status} = 'pending' DESC`, desc(reviews.createdAt));
  return successResponse(c, rows);
});

reviewRoutes.patch('/:id', doctorMiddleware, async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id < 1) return errorResponse(c, 'Review tidak valid');
  const decision = parseReviewDecision(await c.req.json().catch(() => null));
  if (typeof decision === 'string') return errorResponse(c, decision);
  const doctor = await db.query.doctors.findFirst({ where: eq(doctors.userId, c.get('userId')) });
  if (!doctor) return errorResponse(c, 'Profil dokter tidak ditemukan', 403);

  const decidedAt = new Date();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const updated = await db.transaction(async (tx) => {
    const [review] = await tx.update(reviews).set({
      status: decision.status,
      doctorNote: decision.note,
      decidedAt,
      expiresAt,
      updatedAt: decidedAt,
    }).where(and(
      eq(reviews.id, id),
      eq(reviews.doctorId, doctor.id),
      eq(reviews.status, 'pending'),
      gt(reviews.expiresAt, decidedAt),
    )).returning({ id: reviews.id, status: reviews.status, doctorNote: reviews.doctorNote });

    if (!review) return null;
    await tx.update(doctors).set({
      verifiedCount: sql`${doctors.verifiedCount} + 1`,
    }).where(eq(doctors.id, doctor.id));
    return review;
  });

  if (!updated) return errorResponse(c, 'Review tidak tersedia atau sudah diputuskan', 409);
  return successResponse(c, updated);
});

export default reviewRoutes;
