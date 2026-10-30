-- Which WhatsApp account a template belongs to.
--
-- A workspace can connect numbers from more than one account, and Meta refuses a
-- template sent from a number outside its own account with error 132001. A row whose
-- account is unknown stays null and is offered for every number, so nothing already
-- working is hidden.

ALTER TABLE "message_templates"
  ADD COLUMN IF NOT EXISTS "wabaId" TEXT;

CREATE INDEX IF NOT EXISTS "message_templates_businessId_wabaId_idx"
  ON "message_templates" ("businessId", "wabaId");

-- Backfill only where the business has a single connected account, so the answer is not a
-- guess. Where several are connected, the account is left unknown and a template sync
-- fills it in from Meta, which is the only authority on where a template actually lives.
UPDATE "message_templates" t
   SET "wabaId" = one."whatsappBusinessId"
  FROM (
         SELECT "businessId", MIN("whatsappBusinessId") AS "whatsappBusinessId"
           FROM "whatsapp_integrations"
          WHERE "whatsappBusinessId" IS NOT NULL
          GROUP BY "businessId"
         HAVING COUNT(DISTINCT "whatsappBusinessId") = 1
       ) one
 WHERE t."wabaId" IS NULL
   AND one."businessId" = t."businessId";

-- Filtering a conversation list down to one number.
CREATE INDEX IF NOT EXISTS "conversations_businessId_whatsappIntegrationId_idx"
  ON "conversations" ("businessId", "whatsappIntegrationId");
