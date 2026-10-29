-- Stop messaging people who have told WhatsApp to stop, and stop a campaign that cannot
-- succeed instead of retrying it recipient by recipient.
--
-- Existing rows are unaffected: every column is nullable or defaults to today's behaviour.

-- Where a blacklist entry came from, so someone opting back in clears the automatic
-- entry without undoing a block a person added by hand.
ALTER TABLE "blacklist_entries"
  ADD COLUMN IF NOT EXISTS "source"    TEXT NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN IF NOT EXISTS "errorCode" INTEGER;

-- Why a campaign stopped, and whether it stopped itself.
ALTER TABLE "campaigns"
  ADD COLUMN IF NOT EXISTS "haltedAt"     TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "haltReason"   TEXT,
  ADD COLUMN IF NOT EXISTS "haltErrorCode" INTEGER;

-- Recipients skipped without being anyone's fault are counted apart from real failures.
ALTER TABLE "campaigns"
  ADD COLUMN IF NOT EXISTS "skippedCount" INTEGER NOT NULL DEFAULT 0;

-- Finding everyone an error code affected, for the failure breakdown on a campaign.
CREATE INDEX IF NOT EXISTS "campaign_contacts_campaignId_errorCode_idx"
  ON "campaign_contacts" ("campaignId", "errorCode");

-- Opt-outs are looked up by number across the tenant on every launch.
CREATE INDEX IF NOT EXISTS "blacklist_entries_tenantId_source_idx"
  ON "blacklist_entries" ("tenantId", "source");
