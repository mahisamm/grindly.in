-- Keep older generated PDFs available in the user's resume library.
-- Existing rows are current; only future replacements receive a timestamp.
ALTER TABLE "variants" ADD COLUMN "archived_at" TIMESTAMP(3);

CREATE INDEX "variants_resume_id_archived_at_created_at_idx"
  ON "variants"("resume_id", "archived_at", "created_at");
