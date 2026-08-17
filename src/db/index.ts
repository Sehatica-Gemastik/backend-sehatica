import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

const databaseUrl = (process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/sehatica')
  .replace(/[?&]channel_binding=require/g, '');
const isServerless = Boolean(process.env.VERCEL);
const usesPooler = databaseUrl.includes('-pooler') || databaseUrl.includes('neon.tech');

const queryClient = postgres(databaseUrl, {
  max: isServerless ? 1 : 10,
  idle_timeout: 20,
  connect_timeout: 10,
  prepare: !usesPooler,
});

export const db = drizzle(queryClient, { schema });
export type DB = typeof db;
