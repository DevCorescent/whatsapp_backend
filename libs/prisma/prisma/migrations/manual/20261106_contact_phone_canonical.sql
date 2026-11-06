-- Collapses the two spellings of a phone number into one row, and stops a third appearing.
--
-- Contacts are stored as bare digits when WhatsApp creates them (a webhook's `wa_id` has
-- no `+`) and as `+91…` when the dashboard's phone field does. Nothing reconciled the
-- two, so `contacts(phone, "businessId")` was unique over each spelling separately: one
-- person could hold two rows in the same business, each with its own conversation and
-- its own half of the history. A campaign built from both sent the customer the message
-- twice, and the review screen printed `++91…` because it added a `+` to a value that
-- already had one.
--
-- Four such pairs existed when this was written. The surviving row is the one with the
-- conversation, since that is where the history is; ties go to the older row.
--
-- Apply with:
--   npx prisma db execute --schema libs/prisma/prisma/schema.prisma \
--     --file libs/prisma/prisma/migrations/manual/20261106_contact_phone_canonical.sql

BEGIN;

CREATE TEMP TABLE phone_merge ON COMMIT DROP AS
WITH ranked AS (
  SELECT c.id,
         c."businessId",
         regexp_replace(c.phone, '[^0-9]', '', 'g') AS digits,
         ROW_NUMBER() OVER (
           PARTITION BY c."businessId", regexp_replace(c.phone, '[^0-9]', '', 'g')
           ORDER BY (SELECT count(*) FROM conversations v WHERE v."contactId" = c.id) DESC,
                    c."createdAt" ASC,
                    c.id ASC
         ) AS rn
  FROM contacts c
  WHERE regexp_replace(c.phone, '[^0-9]', '', 'g') <> ''
)
SELECT w.id AS winner_id, l.id AS loser_id
FROM ranked w
JOIN ranked l ON l."businessId" = w."businessId" AND l.digits = w.digits
WHERE w.rn = 1 AND l.rn > 1;

-- The row the dashboard created usually carries the real name while the webhook's carries
-- the number as its name. Take whichever detail is actually filled in, so merging never
-- loses the better of the two.
UPDATE contacts w SET
  name        = COALESCE(NULLIF(NULLIF(w.name, ''), w.phone), l.name, w.name),
  email       = COALESCE(w.email,       l.email),
  company     = COALESCE(w.company,     l.company),
  designation = COALESCE(w.designation, l.designation),
  location    = COALESCE(w.location,    l.location),
  notes       = COALESCE(w.notes,       l.notes)
FROM phone_merge m
JOIN contacts l ON l.id = m.loser_id
WHERE w.id = m.winner_id;

-- Children with a composite primary key can already hold the winner, so drop the losing
-- row's copy first and move only what would not collide.
DELETE FROM contact_tags t
USING phone_merge m
WHERE t."contactId" = m.loser_id
  AND EXISTS (SELECT 1 FROM contact_tags k WHERE k."contactId" = m.winner_id AND k."tagId" = t."tagId");

DELETE FROM contact_list_members lm
USING phone_merge m
WHERE lm."contactId" = m.loser_id
  AND EXISTS (SELECT 1 FROM contact_list_members k WHERE k."contactId" = m.winner_id AND k."listId" = lm."listId");

UPDATE contact_tags        t  SET "contactId" = m.winner_id FROM phone_merge m WHERE t."contactId"  = m.loser_id;
UPDATE contact_list_members lm SET "contactId" = m.winner_id FROM phone_merge m WHERE lm."contactId" = m.loser_id;
UPDATE conversations       v  SET "contactId" = m.winner_id FROM phone_merge m WHERE v."contactId"  = m.loser_id;
UPDATE campaign_contacts   cc SET "contactId" = m.winner_id FROM phone_merge m WHERE cc."contactId" = m.loser_id;
UPDATE calls               ca SET "contactId" = m.winner_id FROM phone_merge m WHERE ca."contactId" = m.loser_id;
UPDATE leads               ld SET "contactId" = m.winner_id FROM phone_merge m WHERE ld."contactId" = m.loser_id;
UPDATE flow_runs           fr SET "contactId" = m.winner_id FROM phone_merge m WHERE fr."contactId" = m.loser_id;
UPDATE faq_interactions    fi SET "contactId" = m.winner_id FROM phone_merge m WHERE fi."contactId" = m.loser_id;

DELETE FROM contacts c USING phone_merge m WHERE c.id = m.loser_id;

-- Every surviving row to the canonical spelling, including the ones that never had a twin.
UPDATE contacts
   SET phone = regexp_replace(phone, '[^0-9]', '', 'g')
 WHERE phone ~ '[^0-9]';

-- The unique index could not do this job while two spellings were allowed through. With
-- one spelling it can, and the check keeps it that way should a write path be missed —
-- a rejected insert is a bug that surfaces, unlike a silent duplicate.
ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_phone_digits_only;
ALTER TABLE contacts ADD  CONSTRAINT contacts_phone_digits_only CHECK (phone ~ '^[0-9]+$');

COMMIT;
