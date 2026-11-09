-- Keeps WhatsApp's own explanation of a failure, verbatim.
--
-- The status webhook carries errors[].error_data.details — a sentence in Meta's words
-- saying what went wrong — and we were reading only the code and the title and throwing
-- the rest away. When a client has to take a billing or eligibility failure to Meta
-- support, that sentence is the evidence, and ours is not a substitute for it.
--
-- Apply with:
--   node -e "..." or psql, then `npm run check:migrations` to confirm.

ALTER TABLE campaign_contacts ADD COLUMN IF NOT EXISTS "errorDetail" TEXT;
