import { Hono } from 'hono';
import { authMiddleware, doctorMiddleware } from '../middlewares/auth';
import { errorResponse, successResponse } from '../utils/response';
import { PortalError } from '../services/portal/doctor-context';
import { getDoctorPortalProfile, updateDoctorPortalProfile } from '../services/portal/profile';
import {
  createPatientRecord,
  getDailyQuestionnaireLog,
  getLatestAiSummary,
  getPatientMonitorDetail,
  listPartnerPatients,
  revokePartnerPatient,
} from '../services/portal/patient-monitor';
import {
  createDoctorAppointment,
  deleteDoctorAppointment,
  listDoctorAppointments,
  updateDoctorAppointment,
} from '../services/portal/appointments';

const portal = new Hono();

portal.use('*', authMiddleware, doctorMiddleware);

function handlePortalError(c: any, err: unknown) {
  if (err instanceof PortalError) return errorResponse(c, err.message, err.status);
  console.error('Portal error:', err);
  return errorResponse(c, 'Terjadi kesalahan server', 500);
}

portal.get('/me', async (c) => {
  try {
    const profile = await getDoctorPortalProfile(c.get('userId') as number);
    if (!profile) return errorResponse(c, 'Profil dokter tidak ditemukan', 404);
    return successResponse(c, profile);
  } catch (err) {
    return handlePortalError(c, err);
  }
});

portal.patch('/me', async (c) => {
  try {
    const body = await c.req.json();
    const profile = await updateDoctorPortalProfile(c.get('userId') as number, {
      name: body.name,
      phone: body.phone,
      specialty: body.specialty,
      bio: body.bio,
    });
    if (!profile) return errorResponse(c, 'Profil dokter tidak ditemukan', 404);
    return successResponse(c, profile);
  } catch (err) {
    return handlePortalError(c, err);
  }
});

portal.get('/patients', async (c) => {
  try {
    const patients = await listPartnerPatients(c.get('userId') as number);
    return successResponse(c, patients);
  } catch (err) {
    return handlePortalError(c, err);
  }
});

portal.get('/patients/:patientId', async (c) => {
  try {
    const patientId = parseInt(c.req.param('patientId'), 10);
    if (!Number.isFinite(patientId)) return errorResponse(c, 'ID pasien tidak valid');

    const detail = await getPatientMonitorDetail(c.get('userId') as number, patientId);
    if (!detail) return errorResponse(c, 'Pasien partner tidak ditemukan', 404);
    return successResponse(c, detail);
  } catch (err) {
    return handlePortalError(c, err);
  }
});

portal.delete('/patients/:patientId', async (c) => {
  try {
    const patientId = parseInt(c.req.param('patientId'), 10);
    if (!Number.isFinite(patientId)) return errorResponse(c, 'ID pasien tidak valid');

    const revoked = await revokePartnerPatient(c.get('userId') as number, patientId);
    if (!revoked) return errorResponse(c, 'Pasien partner tidak ditemukan', 404);
    return successResponse(c, { deleted: true });
  } catch (err) {
    return handlePortalError(c, err);
  }
});

portal.post('/patients/:patientId/records', async (c) => {
  try {
    const patientId = parseInt(c.req.param('patientId'), 10);
    if (!Number.isFinite(patientId)) return errorResponse(c, 'ID pasien tidak valid');

    const body = await c.req.json();
    const type = String(body.type ?? '').trim();
    const title = String(body.title ?? '').trim();
    if (!['consultation', 'image', 'voice', 'note'].includes(type)) {
      return errorResponse(c, 'Tipe rekam medis tidak valid');
    }
    if (!title) return errorResponse(c, 'Judul rekam medis wajib diisi');

    const record = await createPatientRecord(c.get('userId') as number, patientId, {
      type: type as 'consultation' | 'image' | 'voice' | 'note',
      title,
      content: body.content ?? null,
      summary: body.summary ?? null,
      tags: Array.isArray(body.tags) ? body.tags : [],
      doctorName: body.doctorName ?? null,
      recordDate: body.recordDate ?? null,
    });
    if (!record) return errorResponse(c, 'Pasien partner tidak ditemukan', 404);
    return successResponse(c, record, 201);
  } catch (err) {
    return handlePortalError(c, err);
  }
});

portal.get('/patients/:patientId/questionnaires/latest-summary', async (c) => {
  try {
    const patientId = parseInt(c.req.param('patientId'), 10);
    if (!Number.isFinite(patientId)) return errorResponse(c, 'ID pasien tidak valid');

    const summary = await getLatestAiSummary(c.get('userId') as number, patientId);
    return successResponse(c, summary);
  } catch (err) {
    return handlePortalError(c, err);
  }
});

portal.get('/patients/:patientId/questionnaires/:date', async (c) => {
  try {
    const patientId = parseInt(c.req.param('patientId'), 10);
    const date = c.req.param('date');
    if (!Number.isFinite(patientId)) return errorResponse(c, 'ID pasien tidak valid');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return errorResponse(c, 'Format tanggal tidak valid');

    const log = await getDailyQuestionnaireLog(c.get('userId') as number, patientId, date);
    if (!log) return errorResponse(c, 'Log kuisioner harian tidak ditemukan', 404);
    return successResponse(c, log);
  } catch (err) {
    return handlePortalError(c, err);
  }
});

portal.get('/appointments', async (c) => {
  try {
    const patientId = c.req.query('patientId');
    const from = c.req.query('from') ?? undefined;
    const to = c.req.query('to') ?? undefined;
    const parsedPatientId = patientId ? parseInt(patientId, 10) : undefined;

    const appointments = await listDoctorAppointments(c.get('userId') as number, {
      patientId: Number.isFinite(parsedPatientId) ? parsedPatientId : undefined,
      from,
      to,
    });
    return successResponse(c, appointments);
  } catch (err) {
    return handlePortalError(c, err);
  }
});

portal.post('/appointments', async (c) => {
  try {
    const body = await c.req.json();
    const patientId = parseInt(String(body.patientId), 10);
    const title = String(body.title ?? '').trim();
    if (!Number.isFinite(patientId)) return errorResponse(c, 'Pasien wajib dipilih');
    if (!title) return errorResponse(c, 'Judul janji wajib diisi');

    const appointment = await createDoctorAppointment(c.get('userId') as number, {
      patientId,
      title,
      notes: String(body.notes ?? ''),
      start: String(body.start),
      end: String(body.end),
    });

    return successResponse(c, appointment, 201);
  } catch (err) {
    if (err instanceof Error && err.message) return errorResponse(c, err.message);
    return handlePortalError(c, err);
  }
});

portal.patch('/appointments/:id', async (c) => {
  try {
    const id = parseInt(c.req.param('id'), 10);
    const body = await c.req.json();
    const title = String(body.title ?? '').trim();
    if (!Number.isFinite(id)) return errorResponse(c, 'ID janji tidak valid');
    if (!title) return errorResponse(c, 'Judul janji wajib diisi');

    const appointment = await updateDoctorAppointment(c.get('userId') as number, id, {
      title,
      notes: String(body.notes ?? ''),
      start: String(body.start),
      end: String(body.end),
    });
    if (!appointment) return errorResponse(c, 'Janji tidak ditemukan', 404);
    return successResponse(c, appointment);
  } catch (err) {
    if (err instanceof Error && err.message) return errorResponse(c, err.message);
    return handlePortalError(c, err);
  }
});

portal.delete('/appointments/:id', async (c) => {
  try {
    const id = parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id)) return errorResponse(c, 'ID janji tidak valid');

    const deleted = await deleteDoctorAppointment(c.get('userId') as number, id);
    if (!deleted) return errorResponse(c, 'Janji tidak ditemukan', 404);
    return successResponse(c, { deleted: true });
  } catch (err) {
    return handlePortalError(c, err);
  }
});

export default portal;
