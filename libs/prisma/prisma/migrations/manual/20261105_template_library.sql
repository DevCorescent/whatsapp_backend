-- Ready-made templates to copy into your own account.
--
-- A WhatsApp template is approved by Meta per account, so one cannot be shared the way a
-- document can — every business submits its own copy. This table therefore holds starting
-- points, not live templates: copying one creates a real template in the copier's
-- business, which they submit for approval themselves.
--
-- Platform-curated on purpose. A tenant publishing into a shared library would put one
-- customer's wording into another's account, which is nobody's expectation.

CREATE TABLE IF NOT EXISTS public.template_library_items (
  id            TEXT         PRIMARY KEY,
  name          TEXT         NOT NULL UNIQUE,
  "displayName" TEXT         NOT NULL,
  description   TEXT,
  category      TEXT         NOT NULL,
  language      TEXT         NOT NULL DEFAULT 'en',
  spec          JSONB        NOT NULL,
  industry      TEXT,
  "isActive"    BOOLEAN      NOT NULL DEFAULT true,
  "useCount"    INTEGER      NOT NULL DEFAULT 0,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "template_library_items_isActive_industry_idx"
  ON public.template_library_items ("isActive", industry);
