-- Carry real accounts across the auto-apply -> resume-readiness rewrite.
--
-- The new schema shares almost nothing with the old one, and the deploy path
-- runs `prisma db push`, which drops whatever does not match. Run without this,
-- that deletes every account on the box.
--
-- HOW IT SURVIVES `db push`
--
-- Prisma manages the `public` schema only. So the accounts are copied into a
-- separate `legacy` schema first, `db push` rebuilds `public` underneath them,
-- and they are copied back. No file round-trip, no window where the only copy
-- of a user is a CSV on the machine being rebuilt.
--
-- `legacy` is deliberately LEFT IN PLACE afterwards. It is a few kilobytes and
-- it is the in-database record of what the accounts looked like before the
-- rewrite. Drop it by hand once you are satisfied, not as part of this.
--
-- WHAT IS AND IS NOT CARRIED
--
--   carried   users: id, email, name, password_hash, google_id, role, created_at
--   dropped   applications, jobs, agent_runs, platform_credentials, browser_tasks,
--             user_answers, reports, notifications, the 60-column profile
--
-- The dropped tables describe a product that no longer exists: 260 applications
-- to job boards the new app never talks to. They are preserved OUTSIDE the
-- database as CSV before this runs, and every user can be given their own
-- history as a file. That is a migration; deleting them silently would not be.
--
-- USAGE
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/migrate-from-autoapply.sql
--   npx prisma db push --skip-generate
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/migrate-from-autoapply-restore.sql
--
-- Run the two halves either side of `db push`. Running this file twice is safe;
-- it refuses rather than overwriting a carry table that already exists.

BEGIN;

-- Precondition: this is the OLD schema. If `users` is already the new shape,
-- someone is running this after the migration and would archive the new rows
-- over the old carry table.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'applications'
  ) THEN
    RAISE EXCEPTION
      'public.applications is missing — this database is not the pre-pivot schema. Refusing.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'legacy' AND table_name = 'users_carry'
  ) THEN
    RAISE EXCEPTION
      'legacy.users_carry already exists — this migration has already run. Refusing.';
  END IF;
END $$;

CREATE SCHEMA legacy;

-- The carry table. Column list is explicit rather than SELECT *, so a column
-- that exists on this box but not in the schema I read cannot silently change
-- the shape of what gets restored.
--
-- Built with EXECUTE because the source columns are not guaranteed. This first
-- ran against production assuming `users.deleted_at` existed — it does not; the
-- rehearsal fixture had invented it by copying the NEW schema. The transaction
-- rolled back cleanly, but a migration that only works against the schema you
-- imagined is not a migration. Every optional column is now probed rather than
-- assumed, so a box that differs slightly still migrates instead of aborting
-- halfway.
DO $$
DECLARE
  has_deleted_at boolean;
  has_paid       boolean;
  has_status     boolean;
BEGIN
  SELECT count(*) > 0 INTO has_deleted_at FROM information_schema.columns
   WHERE table_schema='public' AND table_name='users' AND column_name='deleted_at';
  SELECT count(*) > 0 INTO has_paid FROM information_schema.columns
   WHERE table_schema='public' AND table_name='users' AND column_name='paid';
  SELECT count(*) > 0 INTO has_status FROM information_schema.columns
   WHERE table_schema='public' AND table_name='users' AND column_name='status';

  EXECUTE format($f$
    CREATE TABLE legacy.users_carry AS
    SELECT
      id,
      lower(btrim(email)) AS email,
      name,
      password_hash,
      google_id,
      -- Anything not literally 'admin' becomes a user. Defaulting to the lower
      -- privilege is the only safe way to read a string whose full range you
      -- are not certain of.
      CASE WHEN role = 'admin' THEN 'admin' ELSE 'user' END AS role,
      created_at,
      %s AS paid,
      %s AS legacy_plan,
      %s AS legacy_status
    FROM public.users
    %s
  $f$,
    CASE WHEN has_paid   THEN 'paid'   ELSE 'false'   END,
    'plan',
    CASE WHEN has_status THEN 'status' ELSE '''(none)''' END,
    CASE WHEN has_deleted_at THEN 'WHERE deleted_at IS NULL' ELSE '' END
  );
END $$;

-- Everything else the accounts touched, kept as a compressed record in-database
-- so "what did this user actually do" is answerable after cutover without
-- restoring a whole dump.
CREATE TABLE legacy.applications_archive AS SELECT * FROM public.applications;
CREATE TABLE legacy.profiles_archive     AS SELECT * FROM public.profiles;

-- Duplicate emails would fail the new unique index halfway through the restore,
-- leaving some accounts carried and some not. Catch it here, while the old
-- table is still intact.
DO $$
DECLARE dupes int;
BEGIN
  SELECT count(*) INTO dupes FROM (
    SELECT email FROM legacy.users_carry GROUP BY email HAVING count(*) > 1
  ) d;
  IF dupes > 0 THEN
    RAISE EXCEPTION
      '% email(s) differ only by case and would collide on the new unique index. Resolve first.',
      dupes;
  END IF;
END $$;

COMMIT;

\echo ''
\echo 'Carried to legacy schema:'
SELECT
  (SELECT count(*) FROM legacy.users_carry)            AS users,
  (SELECT count(*) FROM legacy.applications_archive)   AS applications_archived,
  (SELECT count(*) FROM legacy.profiles_archive)       AS profiles_archived;
\echo ''
\echo 'Now run:  npx prisma db push --skip-generate'
\echo 'Then run: scripts/migrate-from-autoapply-restore.sql'
\echo ''
