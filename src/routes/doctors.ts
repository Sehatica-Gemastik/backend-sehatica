import { Hono } from 'hono';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db';
import { doctors, userDoctors, recordTransfers } from '../db/schema';
import { authMiddleware } from '../middlewares/auth';
import { successResponse, errorResponse } from '../utils/response';

const doctorsRoute = new Hono();

doctorsRoute.use('*', authMiddleware);

function formatDoctor(d: any) {
  return {
    id: d.id,
    name: d.user?.name ?? 'Dokter',
    email: d.user?.email,
    phone: d.user?.phone ?? null,
    specialty: d.specialty,
    isAvailable: d.isAvailable,
    avatarInitials: d.user?.avatarInitials ?? 'DR',
    qrPayload: `sehatica:doctor:${d.id}`,
  };
}

/** Parse QR / kode: sehatica:doctor:12 | sehatica://doctor/12 | plain number */
function parseDoctorCode(raw: string): number | null {
  const value = raw.trim();
  if (!value) return null;

  const patterns = [
    /^sehatica:doctor:(\d+)$/i,
    /^sehatica:\/\/doctor\/(\d+)$/i,
    /^mobilesehatica:\/\/doctor\/(\d+)$/i,
    /^DOC-(\d+)$/i,
    /^(\d+)$/,
  ];

  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match) {
      const id = parseInt(match[1], 10);
      return Number.isFinite(id) ? id : null;
    }
  }

  try {
    const json = JSON.parse(value);
    if (json?.type === 'doctor' && json?.id) return parseInt(String(json.id), 10);
    if (json?.sehatica === 'doctor' && json?.id) return parseInt(String(json.id), 10);
  } catch {
    // not json
  }

  return null;
}

// GET /doctors/partners — linked partners only (mobile)
doctorsRoute.get('/partners', async (c) => {
  try {
    const userId = c.get('userId') as number;
    const links = await db.query.userDoctors.findMany({
      where: eq(userDoctors.userId, userId),
      with: { doctor: { with: { user: true } } },
      orderBy: [desc(userDoctors.createdAt)],
    });

    return successResponse(
      c,
      links
        .filter((l: any) => l.doctor)
        .map((l: any) => formatDoctor(l.doctor))
    );
  } catch {
    return errorResponse(c, 'Gagal mengambil dokter partner', 500);
  }
});

// POST /doctors/partners — add partner via QR / kode
doctorsRoute.post('/partners', async (c) => {
  try {
    const userId = c.get('userId') as number;
    const body = await c.req.json();
    const code = String(body.code ?? body.qr ?? body.doctorId ?? '').trim();

    if (!code) {
      return errorResponse(c, 'Kode QR dokter wajib diisi');
    }

    const doctorId = parseDoctorCode(code);
    if (!doctorId) {
      return errorResponse(c, 'Kode QR tidak valid. Format: sehatica:doctor:{id}');
    }

    const doctor = await db.query.doctors.findFirst({
      where: eq(doctors.id, doctorId),
      with: { user: true },
    });

    if (!doctor) {
      return errorResponse(c, 'Dokter tidak ditemukan', 404);
    }

    const existing = await db.query.userDoctors.findFirst({
      where: and(eq(userDoctors.userId, userId), eq(userDoctors.doctorId, doctorId)),
    });

    if (existing) {
      return successResponse(c, {
        alreadyLinked: true,
        doctor: formatDoctor(doctor),
      });
    }

    await db.insert(userDoctors).values({ userId, doctorId });

    return successResponse(
      c,
      {
        alreadyLinked: false,
        doctor: formatDoctor(doctor),
      },
      201
    );
  } catch (err) {
    console.error('Add partner error:', err);
    return errorResponse(c, 'Gagal menambahkan dokter partner', 500);
  }
});

// DELETE /doctors/partners/:doctorId — revoke a linked partner (patient-initiated)
doctorsRoute.delete('/partners/:doctorId', async (c) => {
  try {
    const userId = c.get('userId') as number;
    const doctorId = parseInt(c.req.param('doctorId'), 10);
    if (!Number.isFinite(doctorId)) {
      return errorResponse(c, 'ID dokter tidak valid');
    }

    const link = await db.query.userDoctors.findFirst({
      where: and(eq(userDoctors.userId, userId), eq(userDoctors.doctorId, doctorId)),
    });
    if (!link) {
      return errorResponse(c, 'Dokter partner tidak ditemukan', 404);
    }

    await db.delete(userDoctors).where(eq(userDoctors.id, link.id));

    return successResponse(c, { deleted: true });
  } catch (err) {
    console.error('Revoke partner error:', err);
    return errorResponse(c, 'Gagal mencabut dokter partner', 500);
  }
});

// POST /doctors/partners/:doctorId/record-transfers — log Bluetooth file transfer
doctorsRoute.post('/partners/:doctorId/record-transfers', async (c) => {
  try {
    const userId = c.get('userId') as number;
    const doctorId = parseInt(c.req.param('doctorId'), 10);
    if (!Number.isFinite(doctorId)) {
      return errorResponse(c, 'ID dokter tidak valid');
    }

    const link = await db.query.userDoctors.findFirst({
      where: and(eq(userDoctors.userId, userId), eq(userDoctors.doctorId, doctorId)),
    });
    if (!link) {
      return errorResponse(c, 'Dokter partner tidak ditemukan', 404);
    }

    const body = await c.req.json();
    const recordTitle = String(body.recordTitle ?? body.title ?? 'Dokumen PDF').trim();
    if (!recordTitle) {
      return errorResponse(c, 'Judul dokumen wajib diisi');
    }

    const [row] = await db
      .insert(recordTransfers)
      .values({
        userId,
        doctorId,
        localRecordId: Number.isFinite(Number(body.recordId)) ? Number(body.recordId) : null,
        recordTitle,
        fileName: body.fileName ? String(body.fileName) : null,
        byteSize: Math.max(0, Number(body.byteSize ?? 0)),
        transferMethod: 'bluetooth',
        status: 'completed',
      })
      .returning();

    return successResponse(c, {
      id: row.id,
      doctorId: row.doctorId,
      recordTitle: row.recordTitle,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
    }, 201);
  } catch (err) {
    console.error('Record transfer log error:', err);
    return errorResponse(c, 'Gagal mencatat transfer dokumen', 500);
  }
});

// GET /doctors/:id — must stay after /partners
doctorsRoute.get('/:id', async (c) => {
  try {
    const id = parseInt(c.req.param('id'));
    if (!Number.isFinite(id)) {
      return errorResponse(c, 'ID dokter tidak valid');
    }

    const doctor = await db.query.doctors.findFirst({
      where: eq(doctors.id, id),
      with: { user: true },
    });

    if (!doctor) return errorResponse(c, 'Dokter tidak ditemukan', 404);

    return successResponse(c, formatDoctor(doctor));
  } catch {
    return errorResponse(c, 'Terjadi kesalahan server', 500);
  }
});

export default doctorsRoute;
