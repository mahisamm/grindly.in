-- First-touch acquisition labels for the existing first-party page-view log.
-- We store short UTM values and a referring HOST only; never a full URL,
-- query string, IP address, advertising click id or browser fingerprint.
ALTER TABLE "page_views"
  ADD COLUMN "utm_source" TEXT,
  ADD COLUMN "utm_medium" TEXT,
  ADD COLUMN "utm_campaign" TEXT,
  ADD COLUMN "referrer_host" TEXT;

CREATE INDEX "page_views_utm_source_created_at_idx"
  ON "page_views"("utm_source", "created_at");
