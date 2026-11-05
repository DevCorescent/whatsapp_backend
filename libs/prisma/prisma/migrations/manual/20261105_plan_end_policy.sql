-- What happens when a trial or paid period runs out.
--
-- Read from the PLATFORM tenant's row: this is a policy for the whole product, not a
-- per-customer preference. It lives on tenant_settings rather than in a table of its own
-- so a reseller can later be given its own answer for its own clients without another
-- migration — the column is already there, only the lookup would change.

ALTER TABLE public.tenant_settings
  ADD COLUMN IF NOT EXISTS "planEndBehaviour" TEXT    NOT NULL DEFAULT 'GRACE',
  ADD COLUMN IF NOT EXISTS "planEndGraceDays" INTEGER NOT NULL DEFAULT 7;
