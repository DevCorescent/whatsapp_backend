-- Migration: add WhatsApp error code fields to campaign_contacts
-- Run once against production DB:
--   psql $DATABASE_URL -f this_file.sql
-- Or via Neon/Supabase SQL editor.

ALTER TABLE campaign_contacts
  ADD COLUMN IF NOT EXISTS "errorCode"  INTEGER,
  ADD COLUMN IF NOT EXISTS "errorTitle" TEXT,
  ADD COLUMN IF NOT EXISTS "failedAt"   TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "campaign_contacts_errorCode_idx"
  ON campaign_contacts ("errorCode");
