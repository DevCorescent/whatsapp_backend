-- Presence has two halves and only one of them belongs in a table.
--
-- Whether someone is online is decided by whether they have a socket open; storing that
-- would leave everyone permanently "online" after a crash or a closed laptop. What does
-- need storing is the status they chose for themselves — Away or Busy — because it has
-- to survive a reload and be visible to a colleague who was not connected when it was set.
ALTER TABLE users ADD COLUMN IF NOT EXISTS "presenceStatus"    TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS "presenceUpdatedAt" TIMESTAMP(3);
