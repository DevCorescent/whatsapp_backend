-- An optional header of the receiver's choosing.
--
-- Every delivery already carries an HMAC signature, which proves it came from us. Some
-- receivers authenticate the other way round — they expect a key they issued — and had
-- no way to ask for one.
ALTER TABLE webhook_endpoints ADD COLUMN IF NOT EXISTS "headerKey"   TEXT;
ALTER TABLE webhook_endpoints ADD COLUMN IF NOT EXISTS "headerValue" TEXT;
