ALTER TABLE "chatbot_flows"
  ADD COLUMN IF NOT EXISTS "webhookTokenHash" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "chatbot_flows_webhookTokenHash_key"
  ON "chatbot_flows" ("webhookTokenHash");
