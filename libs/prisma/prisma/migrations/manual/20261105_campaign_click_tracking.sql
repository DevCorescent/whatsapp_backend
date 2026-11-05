-- Click tracking for broadcast links.
--
-- The campaign already counted sends, deliveries, reads and replies but not clicks:
-- clickedCount and clickedAt existed and were only ever written as zero, because
-- nothing ever observed a click. A URL button in WhatsApp opens the browser directly,
-- so Meta sends no webhook for it — the only way to know is to be the link.
--
-- Each recipient therefore gets their own tracked URL whose destination is stored here.
-- Following it records the click and forwards them on.

ALTER TABLE public.campaign_contacts
  ADD COLUMN IF NOT EXISTS "clickUrl"   TEXT,
  ADD COLUMN IF NOT EXISTS "clickCount" INTEGER NOT NULL DEFAULT 0;
