-- Migration: a wallet balance is never negative
-- Run once against production DB:
--   npx prisma db execute --file libs/prisma/prisma/migrations/manual/20261030_wallet_non_negative.sql
-- Idempotent.
--
-- Several debit paths subtracted without a floor, so a campaign could push a wallet into
-- debt. Debits are clamped in code now (WalletService); this is the backstop that makes
-- the invariant true of the data itself.

-- Heal any wallet already in debt, and leave a statement line explaining the correction
-- so the balance and the ledger still reconcile.
INSERT INTO wallet_transactions ("id", "tenantId", "type", "amountMinor", "balanceAfterMinor", "description", "referenceType", "createdAt")
SELECT gen_random_uuid()::text, w."tenantId", 'ADJUSTMENT', -w."balanceMinor", 0,
       'Balance correction — negative balance reset to zero', 'wallet_non_negative_migration', NOW()
FROM wallets w
WHERE w."balanceMinor" < 0;

UPDATE wallets SET "balanceMinor" = 0 WHERE "balanceMinor" < 0;

DO $$ BEGIN
  ALTER TABLE wallets ADD CONSTRAINT "wallets_balance_non_negative" CHECK ("balanceMinor" >= 0);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
