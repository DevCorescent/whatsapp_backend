-- The Meta Commerce catalogue connected to a WhatsApp number.
--
-- Products live in Meta's Commerce Manager and are read from there on demand. Only the
-- pointer is kept here: copying the catalogue into this database would give two answers
-- to "what is this product's price", and the wrong one would be ours.

ALTER TABLE public.whatsapp_integrations
  ADD COLUMN IF NOT EXISTS "catalogId" TEXT;
