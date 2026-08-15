import postgres from 'postgres';
import { readFileSync } from 'fs';
import { join } from 'path';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const sql = postgres(url);
const migration = readFileSync(join(import.meta.dir, '../../scripts/portal-migration.sql'), 'utf8');

try {
  await sql.unsafe(migration);
  console.log('Portal migration applied.');
} finally {
  await sql.end();
}
