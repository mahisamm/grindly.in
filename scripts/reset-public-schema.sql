-- The irreversible step of the pivot cutover: drop the old product's schema so
-- `prisma migrate deploy` can build the new one on clean ground.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/reset-public-schema.sql
--
-- WHY THIS FILE EXISTS RATHER THAN `db push --accept-data-loss`
--
-- The old runbook reached the same end state by running `prisma db push
-- --accept-data-loss`, which asks Prisma to look at a live production database,
-- invent a plan to reconcile it with the schema, and then promises in advance
-- not to object to anything in that plan. The plan is computed on the box, at
-- deploy time, and nobody reads it. That is a lot of trust to place in a diff
-- nobody has seen, on the one run where it is destructive by design.
--
-- This does the destruction explicitly and the construction deterministically:
-- this file drops, `prisma/migrations` creates. The SQL that builds production
-- is then the exact SQL that built the developer's machine and CI's, reviewed
-- in a diff, rather than something generated in the moment.
--
-- WHAT IS LOST
--
-- Everything in `public`. That is the point. The accounts must already be in
-- the `legacy` schema — the precondition below refuses to run otherwise, which
-- makes it impossible to perform this step before the carry.
--
-- `backup_health` goes too. It is drill history rather than user data, it is
-- recreated by the baseline migration, and the drill result that gates this
-- cutover was recorded off the box in step 0 of docs/PIVOT-DEPLOY.md. Losing a
-- log of past drills is not a reason to complicate a destructive step.
--
-- AFTER THIS RUNS, ROLLBACK REQUIRES THE DUMP. See step 0.

BEGIN;

DO $$
BEGIN
  -- Precondition 1: this is the pre-pivot database. A second run, or a run
  -- against an already-migrated box, would drop a live new-product schema.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'applications'
  ) THEN
    RAISE EXCEPTION
      'public.applications is missing — this is not the pre-pivot schema. Refusing.';
  END IF;

  -- Precondition 2: the accounts are already out of the way. Without this the
  -- ordering of the runbook is a convention; with it, running the steps out of
  -- order is impossible rather than merely discouraged.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'legacy' AND table_name = 'users_carry'
  ) THEN
    RAISE EXCEPTION
      'legacy.users_carry is missing — run scripts/migrate-from-autoapply.sql first. Refusing.';
  END IF;

  -- Precondition 3: the carry is not empty. An empty carry table means the
  -- first half ran against the wrong database, and dropping `public` here would
  -- destroy the accounts it was supposed to protect.
  IF (SELECT count(*) FROM legacy.users_carry) = 0 THEN
    RAISE EXCEPTION
      'legacy.users_carry is empty — the carry did not capture any accounts. Refusing.';
  END IF;
END $$;

COMMIT;

\echo ''
\echo 'Accounts safely in the legacy schema:'
SELECT count(*) AS carried FROM legacy.users_carry;
\echo ''
\echo 'About to drop public. Tables that will be destroyed:'
SELECT count(*) AS tables_dropped
FROM information_schema.tables WHERE table_schema = 'public';
\echo ''

-- Not inside the transaction above: the preconditions are a read-only gate, and
-- keeping them separate means a failed gate leaves nothing half-done.
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;

-- Restore the grants a fresh database would have had. Without these, `migrate
-- deploy` connects and cannot create a table in the schema it just made.
GRANT ALL ON SCHEMA public TO CURRENT_USER;
GRANT ALL ON SCHEMA public TO public;
COMMENT ON SCHEMA public IS 'standard public schema';

\echo ''
\echo 'public dropped and recreated, empty. Next:'
\echo '  npx prisma migrate deploy'
\echo '  psql ... -f scripts/migrate-from-autoapply-restore.sql'
\echo ''
