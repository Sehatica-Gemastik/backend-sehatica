import { Hono } from 'hono';
import { authMiddleware } from '../middlewares/auth';
import { errorResponse, successResponse } from '../utils/response';
import {
  createPatientAppointment,
  deletePatientAppointment,
  listPatientAppointments,
  updatePatientAppointment,
} from '../services/portal/appointments';

const appointmentsRoute = new Hono();

appointmentsRoute.use('*', authMiddleware);

/** GET /appointments — patient views doctor-created appointments */
appointmentsRoute.get('/', async (c) => {
  try {
    const userId = c.get('userId') as number;
    const from = c.req.query('from') ?? undefined;
    const to = c.req.query('to') ?? undefined;
    const rows = await listPatientAppointments(userId, from, to);
    return successResponse(c, rows);
  } catch (err) {
    console.error('List patient appointments error:', err);
    return errorResponse(c, 'Gagal mengambil jadwal janji', 500);
  }
});

/** POST /appointments — patient creates appointment with partner doctor */
appointmentsRoute.post('/', async (c) => {
  try {
    const userId = c.get('userId') as number;
    const body = await c.req.json();
    const doctorId = parseInt(String(body.doctorId), 10);
    const title = String(body.title ?? '').trim();
    if (!Number.isFinite(doctorId)) return errorResponse(c, 'Dokter wajib dipilih');
    if (!title) return errorResponse(c, 'Judul janji wajib diisi');

    const appointment = await createPatientAppointment(userId, {
      doctorId,
      title,
      notes: String(body.notes ?? ''),
      start: String(body.start),
      end: String(body.end),
    });
    return successResponse(c, appointment, 201);
  } catch (err) {
    if (err instanceof Error && err.message) return errorResponse(c, err.message);
    console.error('Create patient appointment error:', err);
    return errorResponse(c, 'Gagal membuat jadwal janji', 500);
  }
});

/** PATCH /appointments/:id — patient updates own appointment */
appointmentsRoute.patch('/:id', async (c) => {
  try {
    const userId = c.get('userId') as number;
    const id = parseInt(c.req.param('id'), 10);
    const body = await c.req.json();
    const doctorId = parseInt(String(body.doctorId), 10);
    const title = String(body.title ?? '').trim();
    if (!Number.isFinite(id)) return errorResponse(c, 'ID janji tidak valid');
    if (!Number.isFinite(doctorId)) return errorResponse(c, 'Dokter wajib dipilih');
    if (!title) return errorResponse(c, 'Judul janji wajib diisi');

    const appointment = await updatePatientAppointment(userId, id, {
      doctorId,
      title,
      notes: String(body.notes ?? ''),
      start: String(body.start),
      end: String(body.end),
    });
    if (!appointment) return errorResponse(c, 'Janji tidak ditemukan', 404);
    return successResponse(c, appointment);
  } catch (err) {
    if (err instanceof Error && err.message) return errorResponse(c, err.message);
    console.error('Update patient appointment error:', err);
    return errorResponse(c, 'Gagal mengubah jadwal janji', 500);
  }
});

/** DELETE /appointments/:id — patient deletes own appointment */
appointmentsRoute.delete('/:id', async (c) => {
  try {
    const userId = c.get('userId') as number;
    const id = parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id)) return errorResponse(c, 'ID janji tidak valid');

    const deleted = await deletePatientAppointment(userId, id);
    if (!deleted) return errorResponse(c, 'Janji tidak ditemukan', 404);
    return successResponse(c, { deleted: true });
  } catch (err) {
    console.error('Delete patient appointment error:', err);
    return errorResponse(c, 'Gagal menghapus jadwal janji', 500);
  }
});

export default appointmentsRoute;
