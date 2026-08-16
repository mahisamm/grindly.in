#!/usr/bin/env bash
# Rehearse the pivot migration end to end against a throwaway database.
# The two SQL files are already inside the container at /tmp/m1.sql, /tmp/m2.sql.
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
CREATE TABLE applications (
  id text PRIMARY KEY, user_id text REFERENCES users(id) ON DELETE CASCADE,
  company text, created_at timestamptz DEFAULT now());
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
INSERT INTO applications (id,user_id,company)
SELECT 'a'||g,'u'||((g % 5)+1),'Company '||g FROM generate_series(1,260) g;
INSERT INTO profiles (id,user_id) SELECT 'p'||id,id FROM users;
SQL

BEFORE=$(q "$TARGET" -tAc "SELECT count(*) FROM users;" | tr -d '[:space:]')
echo "  seeded: ${BEFORE} users, 260 applications"

say "half 1 — carry into the legacy schema"
q "$TARGET" -f /tmp/m1.sql || { echo "  half 1 FAILED"; exit 1; }

say "prisma db push — rebuilds public, drops the old tables"
( cd "$REPO" && DATABASE_URL="$HOSTURL" npx prisma db push --skip-generate --accept-data-loss 2>&1 | tail -2 )

say "half 2 — restore the accounts"
q "$TARGET" -f /tmp/m2.sql || { echo "  half 2 FAILED"; exit 1; }

say "ASSERTIONS"
g() { q "$TARGET" -tAc "$1" | tr -d '[:space:]'; }
# `prisma db push` ALTERS `users` in place rather than dropping it — the table
# exists in both schemas — so every row survives the rebuild and the restore's
# job is to normalise them, not to reinsert them.
check "users carried"                  "$(g 'SELECT count(*) FROM users;')" "$BEFORE"
check "emails normalised to lowercase" "$(g 'SELECT count(*) FROM users WHERE email <> lower(email);')" "0"
check "admin role preserved"           "$(g "SELECT count(*) FROM users WHERE role='admin';")" "1"
check "nobody silently granted a plan" "$(g "SELECT count(*) FROM users WHERE plan <> 'free';")" "0"
check "sessions invalidated"           "$(g 'SELECT count(*) FROM users WHERE token_version < 1000;')" "0"
check "google-only account kept"       "$(g 'SELECT count(*) FROM users WHERE password_hash IS NULL AND google_id IS NOT NULL;')" "1"
check "applications archived"          "$(g 'SELECT count(*) FROM legacy.applications_archive;')" "260"
check "every account present"           "$(g "SELECT count(*) FROM users WHERE email='f.student@gmail.com';")" "1"
check "new tables exist"               "$(g "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('resumes','variants','targets');")" "3"
check "old tables gone"                "$(g "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='applications';")" "0"

say "idempotency — half 2 twice must not duplicate"
q "$TARGET" -f /tmp/m2.sql >/dev/null 2>&1
check "re-run is a no-op"              "$(g 'SELECT count(*) FROM users;')" "$BEFORE"

say "refusal — half 1 against an already-migrated database must ERROR"
if q "$TARGET" -f /tmp/m1.sql >/dev/null 2>&1; then
  echo "  FAIL half 1 did not refuse"; fail=1
else
  echo "  ok   half 1 refused"
fi

q "$ADMIN" -c "DROP DATABASE ${DB};" >/dev/null 2>&1
say "$([ $fail -eq 0 ] && echo 'REHEARSAL PASSED' || echo 'REHEARSAL FAILED')"
exit $fail
