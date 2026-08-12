import { Hono } from 'hono';
import { authMiddleware } from '../middlewares/auth';
import { rateLimit } from '../middlewares/rate-limit';
import { successResponse, errorResponse } from '../utils/response';
import {
  planAndDeliverAsk,
  listPendingAsks,
  acknowledgeAsk,
} from '../services/rdsa/ask-planner';
import { seedNotificationArms } from '../scripts/seed-arms';

const rdsa = new Hono();

rdsa.use('*', authMiddleware);

// POST /rdsa/asks/trigger — plan + deliver smart notification (push payload)
rdsa.post('/asks/trigger', rateLimit({ limit: 10, keyPrefix: 'rdsa-ask' }), async (c) => {
  try {
    const userId = c.get('userId') as number;
    const body = (await c.req.json().catch(() => ({}))) as {
      forceIntent?: string;
      localHour?: number;
    };

    const delivered = await planAndDeliverAsk(userId, {
      forceIntent: body.forceIntent,
      localHour: body.localHour ?? new Date().getHours(),
    });

    if (!delivered) {
      return successResponse(c, {
        delivered: false,
        reason: 'no_eligible_arm',
      });
    }

    return successResponse(c, {
      delivered: true,
      ask: delivered.ask,
      notification: delivered.notification,
    });
  } catch (err) {
    console.error('RDSA ask trigger error:', err);
    return errorResponse(c, 'Gagal membuat smart notification', 500);
  }
});

// GET /rdsa/asks/pending — asks waiting for user (mobile polls + shows notif)
rdsa.get('/asks/pending', async (c) => {
  try {
    const userId = c.get('userId') as number;
    const asks = await listPendingAsks(userId);
    return successResponse(c, asks);
  } catch {
    return errorResponse(c, 'Gagal mengambil asks', 500);
  }
});

// POST /rdsa/asks/:askId/ack — mark notification seen on device
rdsa.post('/asks/:askId/ack', async (c) => {
  try {
    const userId = c.get('userId') as number;
    const askId = c.req.param('askId');
    const ask = await acknowledgeAsk(userId, askId);
    if (!ask) return errorResponse(c, 'Ask tidak ditemukan', 404);
    return successResponse(c, ask);
  } catch {
    return errorResponse(c, 'Gagal acknowledge ask', 500);
  }
});

// POST /rdsa/arms/seed — upsert notification arm templates
rdsa.post('/arms/seed', async (c) => {
  try {
    const n = await seedNotificationArms();
    return successResponse(c, { upserted: n });
  } catch (err) {
    console.error('Seed arms error:', err);
    return errorResponse(c, 'Gagal seed arms', 500);
  }
});

export default rdsa;
