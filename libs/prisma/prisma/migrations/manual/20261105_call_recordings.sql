-- Call audio, captured in the agent's browser and stored on our side.
--
-- WhatsApp calling is WebRTC: audio goes straight between the customer's phone and the
-- agent's browser, never through Meta and never through us. There is therefore no server
-- in the media path to record from, and putting one there would mean running a media
-- server — a separate service with its own cost and latency. The agent's browser mixes
-- both sides and uploads the result instead.
--
-- One recording per call, enforced rather than assumed: a retried upload replaces the
-- row rather than leaving two files nobody can tell apart.

CREATE TABLE IF NOT EXISTS public.call_recordings (
  id            TEXT         PRIMARY KEY,
  "callId"      TEXT         NOT NULL UNIQUE REFERENCES public.calls(id)   ON DELETE CASCADE,
  "tenantId"    TEXT         NOT NULL REFERENCES public.tenants(id)        ON DELETE CASCADE,
  "businessId"  TEXT         NOT NULL,
  "storageKey"  TEXT         NOT NULL,
  "mimeType"    TEXT         NOT NULL,
  "sizeBytes"   INTEGER      NOT NULL,
  "durationSec" INTEGER,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "call_recordings_businessId_createdAt_idx"
  ON public.call_recordings ("businessId", "createdAt" DESC);
