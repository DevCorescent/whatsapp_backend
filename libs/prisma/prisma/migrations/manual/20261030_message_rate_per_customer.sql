-- Migration: per-customer message pricing (MessageRate.tenantId)
-- Run once against production DB:
--   npx prisma db execute --file libs/prisma/prisma/migrations/manual/20261030_message_rate_per_customer.sql
-- Or via Neon/Supabase SQL editor. Every statement is idempotent.

ALTER TABLE message_rates
  ADD COLUMN IF NOT EXISTS "tenantId" TEXT REFERENCES tenants("id") ON DELETE CASCADE;

-- The old UNIQUE (category, "resellerId") could not actually stop duplicate platform rows,
-- because Postgres treats NULLs as distinct. Collapse any that slipped in, keeping the newest.
DELETE FROM message_rates a
USING message_rates b
WHERE a.category = b.category
  AND a."resellerId" IS NOT DISTINCT FROM b."resellerId"
  AND a."tenantId"   IS NOT DISTINCT FROM b."tenantId"
  AND (a."updatedAt" < b."updatedAt" OR (a."updatedAt" = b."updatedAt" AND a.id < b.id));

ALTER TABLE message_rates DROP CONSTRAINT IF EXISTS "message_rates_category_resellerId_key";
DROP INDEX IF EXISTS "message_rates_category_resellerId_key";

-- Superseded: this one keyed the platform scope on "resellerId IS NULL" alone, so a
-- per-customer row (which also has no resellerId) collided with the platform row.
DROP INDEX IF EXISTS "message_rates_platform_category_key";

-- One row per category per scope, enforced for real this time.
CREATE UNIQUE INDEX IF NOT EXISTS "message_rates_platform_key"
  ON message_rates (category)
  WHERE "resellerId" IS NULL AND "tenantId" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "message_rates_reseller_key"
  ON message_rates (category, "resellerId")
  WHERE "resellerId" IS NOT NULL AND "tenantId" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "message_rates_customer_key"
  ON message_rates (category, "tenantId")
  WHERE "tenantId" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "message_rates_tenantId_idx"   ON message_rates ("tenantId");
CREATE INDEX IF NOT EXISTS "message_rates_resellerId_idx" ON message_rates ("resellerId");
