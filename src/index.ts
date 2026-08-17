import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { prettyJSON } from 'hono/pretty-json';
import { secureHeaders } from 'hono/secure-headers';

import auth from './routes/auth';
import records from './routes/records';
import schedulesRoute from './routes/schedules';
import rdsa from './routes/rdsa';
import doctors from './routes/doctors';
import portal from './routes/portal';
import appointmentsRoute from './routes/appointments';
import home from './routes/home';
import health from './routes/health';
import ai from './routes/ai';

const app = new Hono();

const extraOrigins = [
  process.env.FRONTEND_URL,
  process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : undefined,
].filter((value): value is string => Boolean(value));

const allowedOrigins = [
  'http://localhost:3001',
  'http://localhost:8081',
  'http://localhost:19006',
  ...extraOrigins,
];

app.use('*', logger());
app.use('*', prettyJSON());
app.use('*', secureHeaders());
app.use(
  '*',
  cors({
    origin: (origin) => {
      if (!origin) return allowedOrigins[0];
      if (allowedOrigins.includes(origin)) return origin;
      if (origin.endsWith('.vercel.app')) return origin;
      return allowedOrigins[0];
    },
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  }),
);

app.get('/', (c) => {
  return c.json({
    service: 'Sehatica Backend API',
    version: '1.0.0',
    status: 'healthy',
    timestamp: new Date().toISOString(),
  });
});

app.get('/health', (c) => c.json({ status: 'ok' }));

const api = app.basePath('/api/v1');

api.route('/auth', auth);
api.route('/records', records);
api.route('/schedules', schedulesRoute);
api.route('/rdsa', rdsa);
api.route('/doctors', doctors);
api.route('/portal', portal);
api.route('/appointments', appointmentsRoute);
api.route('/home', home);
api.route('/health', health);
api.route('/ai', ai);

app.notFound((c) => {
  return c.json({ success: false, error: `Route ${c.req.path} not found` }, 404);
});

app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.json({ success: false, error: 'Internal server error' }, 500);
});

const port = parseInt(process.env.PORT ?? '3000', 10);
if (!process.env.VERCEL) {
  console.log(`Sehatica API running on http://localhost:${port}`);
}

export default app;
