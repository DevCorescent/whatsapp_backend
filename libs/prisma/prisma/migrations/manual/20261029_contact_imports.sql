-- Migration: contact_imports table (import history for the contacts spreadsheet importer)
-- Run once against production DB:
--   psql $DATABASE_URL -f this_file.sql
-- Or via Neon/Supabase SQL editor.

CREATE TABLE IF NOT EXISTS contact_imports (
  "id"         TEXT PRIMARY KEY,
  "tenantId"   TEXT NOT NULL REFERENCES tenants("id")     ON DELETE CASCADE,
  "businessId" TEXT NOT NULL REFERENCES businesses("id") ON DELETE CASCADE,
  "userId"     TEXT,
  "fileName"   TEXT,
  "sheetName"  TEXT,
  "mode"       TEXT NOT NULL DEFAULT 'skip',
  "total"      INTEGER NOT NULL DEFAULT 0,
  "created"    INTEGER NOT NULL DEFAULT 0,
  "updated"    INTEGER NOT NULL DEFAULT 0,
  "skipped"    INTEGER NOT NULL DEFAULT 0,
  "failed"     INTEGER NOT NULL DEFAULT 0,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "contact_imports_businessId_createdAt_idx"
  ON contact_imports ("businessId", "createdAt");
