-- Migration: notifications, web push subscriptions, WhatsApp calls, calling plan flag
-- Run once against production DB:
--   psql $DATABASE_URL -f this_file.sql
-- Or via Neon/Supabase SQL editor. Every statement is idempotent.

DO $$ BEGIN
  CREATE TYPE "NotificationType" AS ENUM ('NEW_MESSAGE','MISSED_CALL','CAMPAIGN_COMPLETED','CONVERSATION_ASSIGNED','LEAD_ASSIGNED','SYSTEM');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "CallDirection" AS ENUM ('INBOUND','OUTBOUND');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "CallStatus" AS ENUM ('RINGING','CONNECTING','IN_PROGRESS','COMPLETED','MISSED','REJECTED','FAILED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE users                 ADD COLUMN IF NOT EXISTS "notificationPrefs" JSONB;
ALTER TABLE plans                 ADD COLUMN IF NOT EXISTS "callingEnabled"    BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE whatsapp_integrations ADD COLUMN IF NOT EXISTS "callingEnabled"    BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS notifications (
  "id"         TEXT PRIMARY KEY,
  "tenantId"   TEXT NOT NULL REFERENCES tenants("id") ON DELETE CASCADE,
  "businessId" TEXT,
  "userId"     TEXT NOT NULL REFERENCES users("id")   ON DELETE CASCADE,
  "type"       "NotificationType" NOT NULL,
  "title"      TEXT NOT NULL,
  "body"       TEXT,
  "href"       TEXT,
  "data"       JSONB,
  "readAt"     TIMESTAMP(3),
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "notifications_userId_readAt_createdAt_idx" ON notifications ("userId", "readAt", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "notifications_tenantId_createdAt_idx"      ON notifications ("tenantId", "createdAt");

CREATE TABLE IF NOT EXISTS push_subscriptions (
  "id"         TEXT PRIMARY KEY,
  "userId"     TEXT NOT NULL REFERENCES users("id") ON DELETE CASCADE,
  "endpoint"   TEXT NOT NULL UNIQUE,
  "p256dh"     TEXT NOT NULL,
  "auth"       TEXT NOT NULL,
  "userAgent"  TEXT,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUsedAt" TIMESTAMP(3)
);
CREATE INDEX IF NOT EXISTS "push_subscriptions_userId_idx" ON push_subscriptions ("userId");

CREATE TABLE IF NOT EXISTS calls (
  "id"                    TEXT PRIMARY KEY,
  "waCallId"              TEXT NOT NULL UNIQUE,
  "tenantId"              TEXT NOT NULL REFERENCES tenants("id")                ON DELETE CASCADE,
  "businessId"            TEXT NOT NULL REFERENCES businesses("id")            ON DELETE CASCADE,
  "whatsappIntegrationId" TEXT NOT NULL REFERENCES whatsapp_integrations("id") ON DELETE CASCADE,
  "contactId"             TEXT NOT NULL REFERENCES contacts("id")              ON DELETE CASCADE,
  "conversationId"        TEXT REFERENCES conversations("id")                  ON DELETE SET NULL,
  "direction"             "CallDirection" NOT NULL,
  "status"                "CallStatus"    NOT NULL DEFAULT 'RINGING',
  "answeredById"          TEXT REFERENCES users("id")                          ON DELETE SET NULL,
  "fromPhone"             TEXT NOT NULL,
  "toPhone"               TEXT NOT NULL,
  "ringingAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "answeredAt"            TIMESTAMP(3),
  "endedAt"               TIMESTAMP(3),
  "durationSec"           INTEGER,
  "errorCode"             INTEGER,
  "errorTitle"            TEXT,
  "metadata"              JSONB,
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "calls_businessId_createdAt_idx" ON calls ("businessId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "calls_businessId_status_idx"    ON calls ("businessId", "status");
CREATE INDEX IF NOT EXISTS "calls_contactId_idx"            ON calls ("contactId");
