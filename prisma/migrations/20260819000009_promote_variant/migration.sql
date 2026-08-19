-- "Use as my resume": a pointer that moves, and the two columns a promotion
-- needs to be lossless.
--
-- Everything here is additive and nullable. There is no backfill and no data
-- change: existing variants get a null struct and an empty text, which is
-- exactly what "this rebuild predates promotion" should look like, and the UI
-- reads that null rather than discovering it when someone presses the button.
--
-- users.primary_resume_id is intentionally NOT a foreign key. See the schema
-- comment: Cascade would delete an account along with its primary resume, and
-- SetNull would put a constraint check on every resume delete for a column that
-- reads correctly as a dangling id.

ALTER TABLE "users" ADD COLUMN "primary_resume_id" TEXT;

ALTER TABLE "variants" ADD COLUMN "struct_json" JSONB;
ALTER TABLE "variants" ADD COLUMN "text" TEXT NOT NULL DEFAULT '';

ALTER TABLE "resumes" ADD COLUMN "from_variant_id" TEXT;
ALTER TABLE "resumes" ADD COLUMN "parent_resume_id" TEXT;
