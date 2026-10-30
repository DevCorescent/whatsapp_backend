-- Which WhatsApp account a template belongs to.
--
-- A workspace can connect numbers from more than one account, and Meta refuses a
-- template sent from a number outside its own account with error 132001. Existing rows
-- stay null and are treated as "account unknown", so nothing already working is hidden.

ALTER TABLE "message_templates"
  ADD COLUMN IF NOT EXISTS "wabaId" TEXT;

CREATE INDEX IF NOT EXISTS "message_templates_businessId_wabaId_idx"
  ON "message_templates" ("businessId", "wabaId");

-- Backfill from the business's default number, which is where every template imported
-- so far came from.
UPDATE "message_templates" t
   SET "wabaId" = i."whatsappBusinessId"
  FROM "whatsapp_integrations" i
 WHERE t."wabaId" IS NULL
   AND i."businessId" = t."businessId"
   AND i."isDefault" = true
   AND i."whatsappBusinessId" IS NOT NULL;

-- Filtering a conversation list down to one number.
CREATE INDEX IF NOT EXISTS "conversations_businessId_whatsappIntegrationId_idx"
  ON "conversations" ("businessId", "whatsappIntegrationId");
