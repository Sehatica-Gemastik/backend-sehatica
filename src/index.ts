import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { prettyJSON } from 'hono/pretty-json';
import { secureHeaders } from 'hono/secure-headers';

import auth from './routes/auth';
import records from './routes/records';
import schedulesRoute from './routes/schedules';
import heally from './routes/heally';
import verif from './routes/verif';
import doctors from './routes/doctors';
import home from './routes/home';
import health from './routes/health';
import ai from './routes/ai';

const app = new Hono();

// ── Global Middlewares ──────────────────────────────────────────────────────
app.use('*', logger());
app.use('*', prettyJSON());
app.use('*', secureHeaders());
app.use('*', cors({
  origin: ['http://localhost:3001', 'http://localhost:8081', 'http://localhost:19006', '*'],
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));

// ── Health Check ────────────────────────────────────────────────────────────
app.get('/', (c) => {
  return c.json({
    service: 'Sehatica Backend API',
    version: '1.0.0',
    status: 'healthy',
    timestamp: new Date().toISOString(),
  });
});

app.get('/health', (c) => c.json({ status: 'ok' }));

// ── API Routes ──────────────────────────────────────────────────────────────
const api = app.basePath('/api/v1');

api.route('/auth', auth);
api.route('/records', records);
api.route('/schedules', schedulesRoute);
api.route('/heally', heally);
api.route('/verif', verif);
api.route('/doctors', doctors);
api.route('/home', home);
api.route('/health', health);
api.route('/ai', ai);

// ── 404 Handler ─────────────────────────────────────────────────────────────
app.notFound((c) => {
  return c.json({ success: false, error: `Route ${c.req.path} not found` }, 404);
});

// ── Error Handler ────────────────────────────────────────────────────────────
app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.json({ success: false, error: 'Internal server error' }, 500);
});

const port = parseInt(process.env.PORT ?? '3000');
console.log(`🚀 Sehatica API running on http://localhost:${port}`);

export default {
  port,
  fetch: app.fetch,
};
