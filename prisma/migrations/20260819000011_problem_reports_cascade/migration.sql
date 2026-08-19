-- A deleted account must take its problem reports with it.
--
-- The table shipped with ON DELETE SET NULL, which detaches a report from its
-- author and keeps the text. api/account/route.ts performs a HARD delete and
-- states that every table hangs off User with onDelete: Cascade; this one did
-- not, so "delete my account and everything in it" quietly left behind free
-- text the person had written, which is where someone describing a problem puts
-- their own email address.
--
-- Rows whose user_id is already NULL are unaffected: this changes what happens
-- on a future delete, not what is in the table.

ALTER TABLE "problem_reports" DROP CONSTRAINT "problem_reports_user_id_fkey";
ALTER TABLE "problem_reports" ADD CONSTRAINT "problem_reports_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
