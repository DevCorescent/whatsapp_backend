-- Self-service wallet top-ups, off until switched on.
--
-- Two switches rather than one, because they answer different questions. The plan flag
-- says whether this tier includes a wallet at all — a commercial decision, per plan. The
-- platform flag on the PLATFORM tenant turns the whole feature off at once, which is what
-- you want while payment is still being set up and the only way to stop it everywhere
-- without editing every plan.
--
-- Both default to off: a wallet someone cannot actually fill is worse than no wallet.

ALTER TABLE public.plans
  ADD COLUMN IF NOT EXISTS "walletEnabled" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.tenant_settings
  ADD COLUMN IF NOT EXISTS "walletEnabled" BOOLEAN NOT NULL DEFAULT false;
