-- Fix partial Heally → RDSA migration after failed `bun run db:push`
-- Run: docker compose exec -T postgres psql -U postgres -d sehatica < scripts/fix-rdsa-migration.sql

BEGIN;

-- Ensure table name is rdsa_asks (skip if already renamed)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'heally_asks'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'rdsa_asks'
  ) THEN
    ALTER TABLE heally_asks RENAME TO rdsa_asks;
  END IF;
END $$;

-- Drop legacy Heally chat / verif (data loss OK — chat removed from product)
DROP TABLE IF EXISTS verif_requests CASCADE;
DROP TABLE IF EXISTS chat_messages CASCADE;

-- Remove chat link column (FK may already be gone from CASCADE)
ALTER TABLE IF EXISTS rdsa_asks DROP COLUMN IF EXISTS message_id;

COMMIT;
