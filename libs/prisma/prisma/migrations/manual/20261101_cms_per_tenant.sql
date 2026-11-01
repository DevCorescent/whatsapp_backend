-- Whose homepage a CMS section belongs to.
--
-- Until now there was one set of sections for the whole platform. A white-label reseller
-- sells under its own brand on its own domain, so it needs its own content — but only
-- for the sections it has actually edited. Everything it leaves alone falls back to the
-- platform's defaults, so a new brand looks like the product rather than an empty page.

ALTER TABLE "cms_sections"
  ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

ALTER TABLE "cms_sections"
  DROP CONSTRAINT IF EXISTS "cms_sections_page_key_key";

-- Postgres treats NULLs as distinct in a unique constraint, so one index cannot keep
-- both halves honest: without the first, the platform could end up with two rows for the
-- same section and no way to tell which one is live.
CREATE UNIQUE INDEX IF NOT EXISTS "cms_sections_platform_page_key"
  ON "cms_sections" ("page", "key") WHERE "tenantId" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "cms_sections_tenant_page_key"
  ON "cms_sections" ("tenantId", "page", "key") WHERE "tenantId" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "cms_sections_tenantId_page_idx"
  ON "cms_sections" ("tenantId", "page");

-- A brand's content goes when the brand does.
ALTER TABLE "cms_sections"
  DROP CONSTRAINT IF EXISTS "cms_sections_tenantId_fkey";
ALTER TABLE "cms_sections"
  ADD CONSTRAINT "cms_sections_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
