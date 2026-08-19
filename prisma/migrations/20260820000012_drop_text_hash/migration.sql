-- Drop a column nothing reads, whose comment described behaviour that does not
-- exist.
--
-- `text_hash` was documented as "a re-score is skipped when this has not
-- changed, which is what stops the advice call re-running on every page load".
-- Nothing skipped anything: the value was written by the upload route and the
-- editor build and read by no query in the codebase, and the advice call is a
-- user-triggered POST behind a quota that was never at risk of firing on a page
-- load. Invalidation of the written review is already handled directly — the
-- build route sets advice_json to NULL when the text changes.
--
-- A dead column is tolerable. A dead column carrying a false description of how
-- the product works is a map that sends the next reader the wrong way, and it
-- cost a sha256 over up to 60 KB on every upload and every build to maintain.

ALTER TABLE "resumes" DROP COLUMN "text_hash";
