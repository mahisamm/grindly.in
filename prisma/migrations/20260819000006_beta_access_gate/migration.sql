-- The beta access gate.
--
-- HAND-WRITTEN for one line: the backfill.
--
-- The generated version adds `access_status` with its schema default, which is
-- `pending` — and applies it to every row already in the table. On a live
-- database that locks out everyone currently using the product, including the
-- operator, the moment the deploy lands. A gate that retroactively shuts the
-- people already inside is not a gate, it is an outage.
--
-- So the column is added, every existing account is marked approved with the
-- timestamp it was created, and only accounts created AFTER this point get the
-- default.

CREATE TYPE "AccessStatus" AS ENUM ('pending', 'approved', 'blocked');

ALTER TABLE "users"
  ADD COLUMN "access_status" "AccessStatus" NOT NULL DEFAULT 'pending',
  ADD COLUMN "approved_at" TIMESTAMP(3),
  ADD COLUMN "approved_by" TEXT;

-- Everyone who already had an account keeps it.
--
-- `approved_at` is set to when they signed up rather than to now: they have
-- been able to use the product since that moment, and stamping today's date
-- would make the audit trail claim they were reviewed on the day the gate was
-- built.
UPDATE "users"
   SET "access_status" = 'approved',
       "approved_at" = "created_at",
       "approved_by" = 'migration:beta_access_gate';

CREATE INDEX "users_access_status_created_at_idx" ON "users"("access_status", "created_at");
