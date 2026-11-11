-- The icons a brand needs beyond a favicon.
--
-- A white-label reseller could set a logo and a favicon and nothing else, so its brand
-- stopped at the browser tab: added to an iOS home screen it got a cropped screenshot,
-- shared into WhatsApp or LinkedIn it showed nothing, and installed as an app it was
-- called "Waboxa" with Waboxa's icons — the one place a white label must not leak.
--
-- Apply with:
--   node -e "..." or psql, then `npm run check:migrations` to confirm.

ALTER TABLE white_label_configs ADD COLUMN IF NOT EXISTS "appleIconUrl" TEXT;
ALTER TABLE white_label_configs ADD COLUMN IF NOT EXISTS "ogImageUrl"   TEXT;
ALTER TABLE white_label_configs ADD COLUMN IF NOT EXISTS "themeColor"   TEXT;
