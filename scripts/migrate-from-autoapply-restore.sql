-- Second half of the pivot migration. Run AFTER `prisma migrate deploy`.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/migrate-from-autoapply-restore.sql
--
-- Puts the carried accounts back into the rebuilt `public.users`. Idempotent:
-- re-running it changes nothing, because the insert skips emails that are
-- already present.

BEGIN;

-- Preconditions, both directions. Between them they catch running this before
-- the schema was rebuilt (old table still there) and running it against a
-- database that was never prepared (no carry table).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'legacy' AND table_name = 'users_carry'
  ) THEN
    RAISE EXCEPTION
      'legacy.users_carry is missing — run scripts/migrate-from-autoapply.sql first.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'plan_expires_at'
  ) THEN
    RAISE EXCEPTION
      'public.users has no plan_expires_at — `prisma migrate deploy` has not run yet. Refusing.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'applications'
  ) THEN
    RAISE EXCEPTION
      'public.applications still exists — the schema was not rebuilt. Refusing.';
  END IF;
END $$;

-- UPSERT, not INSERT, and it stayed an upsert through a change of mechanism.
--
-- Under the old `prisma db push` cutover, `public.users` was NOT dropped: the
-- table existed in both schemas, so Prisma altered it in place and kept every
-- row — which made an insert-only restore fail on the primary key, and would
-- have left the survivors carrying their OLD values (plan 'plus'/'starter' from
-- a discontinued product, mixed-case emails, still-valid session tokens).
--
-- The cutover now drops `public` outright, so these rows genuinely are gone and
-- the insert is doing real work. The conflict clause is kept anyway: it is what
-- makes this file safe to re-run, and re-running a restore at 2am because you
-- are not sure the first one finished is a thing that happens.
INSERT INTO public.users (
  id, email, name, password_hash, google_id, role,
  plan, plan_expires_at, token_version, created_at, deleted_at
)
SELECT
  c.id,
  c.email,
  c.name,
  c.password_hash,
  c.google_id,
  c.role,
  -- Everyone lands on `free`. Nobody bought the NEW product, and quietly
  -- granting a paid tier because of a flag from a discontinued one would put
  -- entitlements in the database that no order row explains. Anyone who paid
  -- for the old product gets a pass granted by hand, on purpose, with an order
  -- behind it — see the report at the bottom for who that is.
  'free',
  NULL,
  -- Bumped well past whatever it was, so every session issued by the old
  -- product is dead. These people are about to open a different application;
  -- making them sign in again is both the honest boundary and the right thing
  -- to do with a cookie minted by code that no longer exists.
  1000,
  c.created_at,
  NULL
FROM legacy.users_carry c
ON CONFLICT (id) DO UPDATE SET
  email         = EXCLUDED.email,
  name          = EXCLUDED.name,
  password_hash = EXCLUDED.password_hash,
  google_id     = EXCLUDED.google_id,
  role          = EXCLUDED.role,
  plan          = EXCLUDED.plan,
  plan_expires_at = NULL,
  token_version = EXCLUDED.token_version,
  -- deleted_at is NOT touched. An account that was already soft-deleted stays
  -- soft-deleted: it is gone, its email stays claimed, and the deletion record
  -- survives the rewrite.
  created_at    = EXCLUDED.created_at;

COMMIT;

\echo ''
\echo 'Restored accounts:'
SELECT count(*) AS users_now FROM public.users;
\echo ''
\echo 'Anyone who had paid for the OLD product (grant a pass by hand if you owe them):'
SELECT email, legacy_plan, legacy_status
FROM legacy.users_carry
WHERE paid IS TRUE;
\echo ''
\echo 'Carried but NOT restored (should be empty — an email collision if not):'
SELECT c.email
FROM legacy.users_carry c
LEFT JOIN public.users u ON u.email = c.email
WHERE u.id IS NULL;
\echo ''
\echo 'legacy schema kept on purpose. Drop it once you are satisfied:'
\echo '  DROP SCHEMA legacy CASCADE;'
\echo ''
