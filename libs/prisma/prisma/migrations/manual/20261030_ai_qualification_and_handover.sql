-- AI lead qualification, and handing a conversation from the AI to a person.
--
-- Everything added here is optional or defaults to today's behaviour: a business with no
-- config row behaves exactly as it does now, and existing leads read as MANUAL.

-- ── Leads: what the model concluded, kept beside the human-editable fields ──
ALTER TABLE "leads"
  ADD COLUMN IF NOT EXISTS "qualifiedBy"      TEXT NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN IF NOT EXISTS "aiQualifiedAt"    TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "aiScore"          INTEGER,
  ADD COLUMN IF NOT EXISTS "aiConfidence"     INTEGER,
  ADD COLUMN IF NOT EXISTS "aiSummary"        TEXT,
  ADD COLUMN IF NOT EXISTS "aiIntent"         TEXT,
  ADD COLUMN IF NOT EXISTS "aiNextStep"       TEXT,
  ADD COLUMN IF NOT EXISTS "aiModel"          TEXT,
  ADD COLUMN IF NOT EXISTS "aiBreakdown"      JSONB,
  ADD COLUMN IF NOT EXISTS "aiConversationId" TEXT;

CREATE INDEX IF NOT EXISTS "leads_businessId_scoreLabel_idx"   ON "leads" ("businessId", "scoreLabel");
CREATE INDEX IF NOT EXISTS "leads_businessId_aiQualifiedAt_idx" ON "leads" ("businessId", "aiQualifiedAt");

-- ── Departments ──
CREATE TABLE IF NOT EXISTS "departments" (
  "id"          TEXT         NOT NULL,
  "tenantId"    TEXT         NOT NULL,
  "businessId"  TEXT         NOT NULL,
  "name"        TEXT         NOT NULL,
  "description" TEXT,
  "color"       TEXT         NOT NULL DEFAULT 'slate',
  "order"       INTEGER      NOT NULL DEFAULT 0,
  "enabled"     BOOLEAN      NOT NULL DEFAULT true,
  "isDefault"   BOOLEAN      NOT NULL DEFAULT false,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "departments_businessId_name_key" ON "departments" ("businessId", "name");
CREATE INDEX IF NOT EXISTS "departments_businessId_order_idx" ON "departments" ("businessId", "order");

CREATE TABLE IF NOT EXISTS "department_members" (
  "id"           TEXT         NOT NULL,
  "departmentId" TEXT         NOT NULL,
  "userId"       TEXT         NOT NULL,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "department_members_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "department_members_departmentId_userId_key"
  ON "department_members" ("departmentId", "userId");
CREATE INDEX IF NOT EXISTS "department_members_userId_idx" ON "department_members" ("userId");

-- ── Handover settings ──
CREATE TABLE IF NOT EXISTS "handover_configs" (
  "id"                   TEXT         NOT NULL,
  "tenantId"             TEXT         NOT NULL,
  "businessId"           TEXT         NOT NULL,
  "enabled"              BOOLEAN      NOT NULL DEFAULT true,
  "onCustomerRequest"    BOOLEAN      NOT NULL DEFAULT true,
  "requestKeywords"      TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
  "onAiUnsure"           BOOLEAN      NOT NULL DEFAULT false,
  "aiUnsureThreshold"    INTEGER      NOT NULL DEFAULT 50,
  "afterAiReplies"       INTEGER      NOT NULL DEFAULT 0,
  "onNegativeSentiment"  BOOLEAN      NOT NULL DEFAULT false,
  "offHours"             BOOLEAN      NOT NULL DEFAULT false,
  "strategy"             TEXT         NOT NULL DEFAULT 'LEAST_BUSY',
  "departmentId"         TEXT,
  "assignToId"           TEXT,
  "onlineOnly"           BOOLEAN      NOT NULL DEFAULT false,
  "pauseAi"              BOOLEAN      NOT NULL DEFAULT true,
  "notifyAgent"          BOOLEAN      NOT NULL DEFAULT true,
  "notifyManagers"       BOOLEAN      NOT NULL DEFAULT false,
  "customerMessage"      TEXT,
  "escalateAfterMinutes" INTEGER      NOT NULL DEFAULT 0,
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "handover_configs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "handover_configs_businessId_key" ON "handover_configs" ("businessId");

-- ── Handover queue ──
CREATE TABLE IF NOT EXISTS "handover_requests" (
  "id"             TEXT         NOT NULL,
  "tenantId"       TEXT         NOT NULL,
  "businessId"     TEXT         NOT NULL,
  "conversationId" TEXT         NOT NULL,
  "contactId"      TEXT,
  "reason"         TEXT         NOT NULL,
  "note"           TEXT,
  "trigger"        TEXT,
  "departmentId"   TEXT,
  "assignedToId"   TEXT,
  "status"         TEXT         NOT NULL DEFAULT 'PENDING',
  "requestedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "assignedAt"     TIMESTAMP(3),
  "acceptedAt"     TIMESTAMP(3),
  "resolvedAt"     TIMESTAMP(3),
  "escalatedAt"    TIMESTAMP(3),
  CONSTRAINT "handover_requests_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "handover_requests_businessId_status_requestedAt_idx"
  ON "handover_requests" ("businessId", "status", "requestedAt");
CREATE INDEX IF NOT EXISTS "handover_requests_conversationId_idx"
  ON "handover_requests" ("conversationId");

-- ── Lead qualification settings ──
CREATE TABLE IF NOT EXISTS "lead_qualification_configs" (
  "id"                  TEXT         NOT NULL,
  "tenantId"            TEXT         NOT NULL,
  "businessId"          TEXT         NOT NULL,
  "enabled"             BOOLEAN      NOT NULL DEFAULT false,
  "trigger"             TEXT         NOT NULL DEFAULT 'AFTER_MESSAGES',
  "afterMessages"       INTEGER      NOT NULL DEFAULT 6,
  "requalify"           BOOLEAN      NOT NULL DEFAULT true,
  "requalifyAfterHours" INTEGER      NOT NULL DEFAULT 24,
  "keywords"            TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
  "minScore"            INTEGER      NOT NULL DEFAULT 0,
  "autoCreate"          BOOLEAN      NOT NULL DEFAULT true,
  "autoAssign"          BOOLEAN      NOT NULL DEFAULT true,
  "instructions"        TEXT,
  "productContext"      TEXT,
  "weights"             JSONB,
  "stageMap"            JSONB,
  "model"               TEXT,
  "notifyAboveScore"    INTEGER      NOT NULL DEFAULT 0,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "lead_qualification_configs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "lead_qualification_configs_businessId_key"
  ON "lead_qualification_configs" ("businessId");

-- ── Foreign keys ──
-- Added separately and guarded, so re-running the file is safe.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'departments_tenantId_fkey') THEN
    ALTER TABLE "departments"
      ADD CONSTRAINT "departments_tenantId_fkey" FOREIGN KEY ("tenantId")
      REFERENCES "tenants"("id") ON DELETE CASCADE,
      ADD CONSTRAINT "departments_businessId_fkey" FOREIGN KEY ("businessId")
      REFERENCES "businesses"("id") ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'department_members_departmentId_fkey') THEN
    ALTER TABLE "department_members"
      ADD CONSTRAINT "department_members_departmentId_fkey" FOREIGN KEY ("departmentId")
      REFERENCES "departments"("id") ON DELETE CASCADE,
      ADD CONSTRAINT "department_members_userId_fkey" FOREIGN KEY ("userId")
      REFERENCES "users"("id") ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'handover_configs_tenantId_fkey') THEN
    ALTER TABLE "handover_configs"
      ADD CONSTRAINT "handover_configs_tenantId_fkey" FOREIGN KEY ("tenantId")
      REFERENCES "tenants"("id") ON DELETE CASCADE,
      ADD CONSTRAINT "handover_configs_businessId_fkey" FOREIGN KEY ("businessId")
      REFERENCES "businesses"("id") ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'handover_requests_tenantId_fkey') THEN
    ALTER TABLE "handover_requests"
      ADD CONSTRAINT "handover_requests_tenantId_fkey" FOREIGN KEY ("tenantId")
      REFERENCES "tenants"("id") ON DELETE CASCADE,
      ADD CONSTRAINT "handover_requests_businessId_fkey" FOREIGN KEY ("businessId")
      REFERENCES "businesses"("id") ON DELETE CASCADE,
      ADD CONSTRAINT "handover_requests_conversationId_fkey" FOREIGN KEY ("conversationId")
      REFERENCES "conversations"("id") ON DELETE CASCADE,
      ADD CONSTRAINT "handover_requests_departmentId_fkey" FOREIGN KEY ("departmentId")
      REFERENCES "departments"("id") ON DELETE SET NULL,
      ADD CONSTRAINT "handover_requests_assignedToId_fkey" FOREIGN KEY ("assignedToId")
      REFERENCES "users"("id") ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lead_qualification_configs_tenantId_fkey') THEN
    ALTER TABLE "lead_qualification_configs"
      ADD CONSTRAINT "lead_qualification_configs_tenantId_fkey" FOREIGN KEY ("tenantId")
      REFERENCES "tenants"("id") ON DELETE CASCADE,
      ADD CONSTRAINT "lead_qualification_configs_businessId_fkey" FOREIGN KEY ("businessId")
      REFERENCES "businesses"("id") ON DELETE CASCADE;
  END IF;
END $$;

-- A handover is worth a notification of its own, so it can be styled and routed apart
-- from a generic system notice.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'HANDOVER_REQUESTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'LEAD_QUALIFIED';
