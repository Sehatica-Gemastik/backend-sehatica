import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { prettyJSON } from 'hono/pretty-json';
import { secureHeaders } from 'hono/secure-headers';

import auth from './routes/auth';
import ai from './routes/ai';
import doctors from './routes/doctors';
import reviews from './routes/reviews';
import sessions from './routes/sessions';
import heally from './routes/heally';

const app = new Hono();
const allowedOrigins = (process.env.CORS_ORIGINS
  ?? 'http://localhost:3001,http://localhost:8081,http://localhost:19006')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

// ── Global Middlewares ──────────────────────────────────────────────────────
app.use('*', logger());
app.use('*', prettyJSON());
app.use('*', secureHeaders());
app.use('*', cors({
  origin: allowedOrigins,
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
api.route('/ai', ai);
api.route('/doctors', doctors);
api.route('/reviews', reviews);
api.route('/sessions', sessions);
api.route('/heally', heally);

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
