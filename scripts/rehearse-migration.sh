#!/usr/bin/env bash
# Rehearse the pivot migration end to end against a throwaway database.
# The SQL files are copied into the container by this script — an earlier
# version expected them to be there already, which made a green rehearsal
# dependent on a manual step nobody records.
set -uo pipefail

# Git Bash rewrites anything that looks like a POSIX path into a Windows one
# before it reaches the process, so `-f /tmp/m1.sql` arrived at psql INSIDE the
# container as C:/Users/.../Temp/m1.sql. The file is in the container, not here.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

REPO="c:/Users/mahendhar/OneDrive/Desktop/Experiments/Grindly"
DB=grindly_rehearsal
ADMIN="postgresql://grindly:grindly_local@localhost:5432/postgres"
TARGET="postgresql://grindly:grindly_local@localhost:5432/${DB}"
HOSTURL="postgresql://grindly:grindly_local@localhost:5433/${DB}"

q() { docker exec -i grindly-postgres psql -v ON_ERROR_STOP=1 "$@"; }

# The three halves of the cutover, put where psql inside the container can read
# them. m3 is the destructive step; it sits between the carry and the restore.
docker cp "${REPO}/scripts/migrate-from-autoapply.sql"         grindly-postgres:/tmp/m1.sql >/dev/null
docker cp "${REPO}/scripts/migrate-from-autoapply-restore.sql" grindly-postgres:/tmp/m2.sql >/dev/null
docker cp "${REPO}/scripts/reset-public-schema.sql"            grindly-postgres:/tmp/m3.sql >/dev/null
say() { printf '\n=== %s ===\n' "$1"; }
fail=0
check() { if [ "$2" = "$3" ]; then echo "  ok   $1 = $2"; else echo "  FAIL $1: got '$2', want '$3'"; fail=1; fi; }

say "reset scratch database"
q "$ADMIN" -c "DROP DATABASE IF EXISTS ${DB};" >/dev/null
q "$ADMIN" -c "CREATE DATABASE ${DB};" >/dev/null

say "build a replica of the OLD schema and seed it"
q "$TARGET" >/dev/null <<'SQL'
-- NO deleted_at. The real pre-pivot users table does not have one — this
-- fixture invented it by copying the NEW schema, so the rehearsal passed
-- against a database that did not exist and the migration then failed on
-- production at the first statement that touched it.
CREATE TABLE users (
  id text PRIMARY KEY, email text UNIQUE NOT NULL, name text,
  password_hash text, google_id text UNIQUE, phone text,
  created_at timestamptz DEFAULT now(), paid boolean DEFAULT false,
  plan text DEFAULT 'free', status text DEFAULT 'registered',
  role text DEFAULT 'user', token_version int DEFAULT 0);
-- The enum columns are here because the real pre-pivot `applications` had
-- them, and half 1 converts them to text before the cutover drops the types.
-- Without them in the fixture, those conversions were never exercised — which
-- is how three unguarded ALTER statements sat in a migration nobody could run
-- to completion.
CREATE TYPE application_status AS ENUM ('queued','submitted','failed');
CREATE TYPE application_outcome AS ENUM ('pending','rejected','interview');
CREATE TABLE applications (
  id text PRIMARY KEY, user_id text REFERENCES users(id) ON DELETE CASCADE,
  company text, created_at timestamptz DEFAULT now(),
  status application_status DEFAULT 'queued',
  failure_reason text, outcome application_outcome DEFAULT 'pending');
CREATE TABLE profiles (
  id text PRIMARY KEY, user_id text UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  skills text DEFAULT '[]');

INSERT INTO users (id,email,name,password_hash,google_id,paid,plan,status,role,token_version) VALUES
 ('u1','A.Student@Gmail.com','Aarav','scrypt$x','g1',false,'free','active','user',3),
 ('u2','b.student@gmail.com','Bhavya',NULL,'g2',true,'plus','active','user',1),
 ('u3','c.student@gmail.com','Chirag','scrypt$y',NULL,false,'free','paused','user',0),
 ('u4','d.student@miet.ac.in','Divya','scrypt$z','g4',false,'free','active','user',7),
 ('u5','e.student@gmail.com','Esha','scrypt$w','g5',false,'starter','active','admin',2),
 ('u6','f.student@gmail.com','Farhan','scrypt$v','g6',false,'free','active','user',0);
INSERT INTO applications (id,user_id,company,status)
SELECT 'a'||g,'u'||((g % 5)+1),'Company '||g,
       (ARRAY['queued','submitted','failed']::application_status[])[(g % 3)+1]
FROM generate_series(1,260) g;
INSERT INTO profiles (id,user_id) SELECT 'p'||id,id FROM users;
SQL

BEFORE=$(q "$TARGET" -tAc "SELECT count(*) FROM users;" | tr -d '[:space:]')
echo "  seeded: ${BEFORE} users, 260 applications"

say "half 1 — carry into the legacy schema"
q "$TARGET" -f /tmp/m1.sql || { echo "  half 1 FAILED"; exit 1; }

say "drop the old public schema — the irreversible step"
q "$TARGET" -f /tmp/m3.sql || { echo "  drop FAILED"; exit 1; }

say "prisma migrate deploy — builds the new schema from prisma/migrations"
( cd "$REPO" && DATABASE_URL="$HOSTURL" npx prisma migrate deploy 2>&1 | grep -E "migration|applied|Error" | tail -3 )

say "half 2 — restore the accounts"
q "$TARGET" -f /tmp/m2.sql || { echo "  half 2 FAILED"; exit 1; }

say "ASSERTIONS"
g() { q "$TARGET" -tAc "$1" | tr -d '[:space:]'; }
# `users` no longer survives the rebuild: reset-public-schema.sql drops the
# whole schema, so the restore genuinely re-inserts from legacy.users_carry
# rather than normalising rows that happened to live through a `db push`. The
# upsert in half 2 covers both, which is why it did not need changing.
check "users carried"                  "$(g 'SELECT count(*) FROM users;')" "$BEFORE"
check "emails normalised to lowercase" "$(g 'SELECT count(*) FROM users WHERE email <> lower(email);')" "0"
check "admin role preserved"           "$(g "SELECT count(*) FROM users WHERE role='admin';")" "1"
check "nobody silently granted a plan" "$(g "SELECT count(*) FROM users WHERE plan <> 'free';")" "0"
check "sessions invalidated"           "$(g 'SELECT count(*) FROM users WHERE token_version < 1000;')" "0"
check "google-only account kept"       "$(g 'SELECT count(*) FROM users WHERE password_hash IS NULL AND google_id IS NOT NULL;')" "1"
check "applications archived"          "$(g 'SELECT count(*) FROM legacy.applications_archive;')" "260"
# The archive must not depend on a type that the cutover dropped, or the whole
# record of what those 260 applications were goes with it.
check "archived enums frozen as text"  "$(g "SELECT count(*) FROM information_schema.columns WHERE table_schema='legacy' AND table_name='applications_archive' AND column_name IN ('status','outcome') AND data_type='text';")" "2"
check "archived statuses readable"     "$(g "SELECT count(DISTINCT status) FROM legacy.applications_archive;")" "3"
check "every account present"           "$(g "SELECT count(*) FROM users WHERE email='f.student@gmail.com';")" "1"
check "new tables exist"               "$(g "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('resumes','variants','targets');")" "3"
check "old tables gone"                "$(g "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='applications';")" "0"
# The new schema was built by the migration files rather than by a diff computed
# on the box. If this row is missing, `migrate deploy` did not run and something
# else created those tables.
check "migration recorded"             "$(g "SELECT count(*) FROM _prisma_migrations WHERE migration_name='00000000000000_baseline_pivot_schema' AND finished_at IS NOT NULL;")" "1"

say "idempotency — half 2 twice must not duplicate"
q "$TARGET" -f /tmp/m2.sql >/dev/null 2>&1
check "re-run is a no-op"              "$(g 'SELECT count(*) FROM users;')" "$BEFORE"

say "refusal — half 1 against an already-migrated database must ERROR"
if q "$TARGET" -f /tmp/m1.sql >/dev/null 2>&1; then
  echo "  FAIL half 1 did not refuse"; fail=1
else
  echo "  ok   half 1 refused"
fi

say "refusal — the destructive step against a migrated database must ERROR"
# The one that matters most: run twice, or run against a box that is already on
# the new product, and this drops a live schema full of real resumes.
if q "$TARGET" -f /tmp/m3.sql >/dev/null 2>&1; then
  echo "  FAIL the drop did not refuse"; fail=1
else
  echo "  ok   the drop refused"
fi

say "refusal — the destructive step BEFORE the carry must ERROR"
q "$ADMIN" -c "DROP DATABASE IF EXISTS ${DB}_order;" >/dev/null
q "$ADMIN" -c "CREATE DATABASE ${DB}_order;" >/dev/null
q "postgresql://grindly:grindly_local@localhost:5432/${DB}_order"   -c "CREATE TABLE applications (id text PRIMARY KEY);" >/dev/null
if q "postgresql://grindly:grindly_local@localhost:5432/${DB}_order" -f /tmp/m3.sql >/dev/null 2>&1; then
  echo "  FAIL the drop ran without a carry"; fail=1
else
  echo "  ok   the drop refused without a carry"
fi
q "$ADMIN" -c "DROP DATABASE ${DB}_order;" >/dev/null 2>&1

q "$ADMIN" -c "DROP DATABASE ${DB};" >/dev/null 2>&1
say "$([ $fail -eq 0 ] && echo 'REHEARSAL PASSED' || echo 'REHEARSAL FAILED')"
exit $fail
