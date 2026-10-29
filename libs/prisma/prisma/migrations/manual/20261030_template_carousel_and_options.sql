-- Carousel templates and the rest of Meta's template creation surface.
--
-- Existing rows keep working: every column is nullable or has a default, and POSITIONAL /
-- STANDARD are what a template built before this change already was.

ALTER TABLE "message_templates"
  ADD COLUMN IF NOT EXISTS "parameterFormat"           TEXT    NOT NULL DEFAULT 'POSITIONAL',
  ADD COLUMN IF NOT EXISTS "templateType"              TEXT    NOT NULL DEFAULT 'STANDARD',
  ADD COLUMN IF NOT EXISTS "cards"                     JSONB,
  ADD COLUMN IF NOT EXISTS "ltoText"                   TEXT,
  ADD COLUMN IF NOT EXISTS "ltoHasExpiration"          BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "addSecurityRecommendation" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "codeExpirationMinutes"     INTEGER,
  ADD COLUMN IF NOT EXISTS "messageSendTtlSeconds"     INTEGER;

-- Templates whose body already uses named placeholders are NAMED, whatever the default says.
UPDATE "message_templates"
   SET "parameterFormat" = 'NAMED'
 WHERE "parameterFormat" = 'POSITIONAL'
   AND "body" ~ '\{\{[a-z][a-z0-9_]*\}\}'
   AND "body" !~ '\{\{[0-9]+\}\}';
