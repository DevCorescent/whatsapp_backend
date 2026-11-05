-- Let a number's calling availability follow the department's business hours.
--
-- Meta holds the live on/off state per number, so this column is the intent rather than
-- the state: a scheduler compares the department's hours with Meta's current setting and
-- switches it when they disagree. Keeping intent and state apart means a manual override
-- at Meta's end is visible as a disagreement instead of silently becoming the new intent.

ALTER TABLE public.whatsapp_integrations
  ADD COLUMN IF NOT EXISTS "callingFollowsBusinessHours" BOOLEAN NOT NULL DEFAULT false;
