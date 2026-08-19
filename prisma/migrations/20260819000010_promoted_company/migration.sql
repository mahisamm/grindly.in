-- The employer a promoted resume was rebuilt for, kept on the resume itself.
--
-- Additive, with a default, and no backfill: every existing row is an uploaded
-- resume or a promotion made minutes ago in the same deploy, and neither has an
-- employer that this migration could infer without guessing at a label.

ALTER TABLE "resumes" ADD COLUMN "target_name" TEXT NOT NULL DEFAULT '';
