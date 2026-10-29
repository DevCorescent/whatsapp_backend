-- Migration: revoking a workspace membership keeps the row
-- Run once against production DB:
--   npx prisma db execute --file libs/prisma/prisma/migrations/manual/20261030_user_membership_removed_at.sql
-- Idempotent.
--
-- Removing a team member used to delete the User row. `messages.sentById` is nullable, so
-- the delete cascaded to SET NULL and erased "sent by" across that person's entire history
-- in the workspace. Membership is now revoked by stamping removedAt.

ALTER TABLE users ADD COLUMN IF NOT EXISTS "removedAt" TIMESTAMP(3);

-- The team list and the workspace switcher both filter on this.
CREATE INDEX IF NOT EXISTS "users_email_removedAt_idx" ON users ("email", "removedAt");
