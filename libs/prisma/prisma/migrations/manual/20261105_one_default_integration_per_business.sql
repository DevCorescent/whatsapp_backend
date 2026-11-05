-- At most one DEFAULT WhatsApp number per business.
--
-- A business holds several numbers, so `businessId` must NOT be unique. Only the row
-- marked isDefault = true is constrained, which is a PARTIAL unique index — something
-- Prisma's schema language cannot express. Writing it in schema.prisma as a plain
-- `@unique` was tried and is wrong twice over: Postgres would then forbid a second
-- number for the same business at all, and Prisma reads the relation as one-to-one, so
-- `Business.whatsappIntegrations` generates as a single optional row rather than a list
-- and `_count` on it stops compiling.
--
-- So it lives here instead, and schema.prisma carries a comment pointing at it.
-- Postgres treats NULLs as distinct, which does not matter here: isDefault is NOT NULL.
--
-- Already present in the live database; this file records it so a future reset rebuilds
-- it rather than silently losing the invariant.

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_integrations_one_default_per_business
  ON public.whatsapp_integrations ("businessId")
  WHERE ("isDefault" = true);
