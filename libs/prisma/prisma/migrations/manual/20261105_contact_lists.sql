-- Hand-picked contact groups, for broadcasting to a chosen set of people.
--
-- Segments already answer "everyone matching this rule", re-evaluated each time. These
-- answer the other half: a fixed set someone assembled by hand, which does not change
-- under them between building it and sending to it.
--
-- Names are unique per business, not per tenant: departments keep separate contacts, so
-- two of them may each want a list called "VIP" without colliding.

CREATE TABLE IF NOT EXISTS public.contact_lists (
  id            TEXT         PRIMARY KEY,
  "tenantId"    TEXT         NOT NULL REFERENCES public.tenants(id)    ON DELETE CASCADE,
  "businessId"  TEXT         NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  name          TEXT         NOT NULL,
  description   TEXT,
  "createdById" TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "contact_lists_name_businessId_key"
  ON public.contact_lists (name, "businessId");
CREATE INDEX IF NOT EXISTS "contact_lists_tenantId_businessId_idx"
  ON public.contact_lists ("tenantId", "businessId");

-- Membership. The composite primary key makes a contact appearing twice in one list
-- impossible rather than merely unlikely, so adding the same people again is a no-op.
CREATE TABLE IF NOT EXISTS public.contact_list_members (
  "listId"    TEXT         NOT NULL REFERENCES public.contact_lists(id) ON DELETE CASCADE,
  "contactId" TEXT         NOT NULL REFERENCES public.contacts(id)      ON DELETE CASCADE,
  "addedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("listId", "contactId")
);

-- Deleting a contact should not require scanning every list to find it.
CREATE INDEX IF NOT EXISTS "contact_list_members_contactId_idx"
  ON public.contact_list_members ("contactId");
