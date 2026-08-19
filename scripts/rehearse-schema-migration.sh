#!/usr/bin/env bash
# Prove that migrating an already-populated database keeps its data.
#
# The migration this exercises converts six text columns holding JSON into jsonb
# and four string columns into enums. Prisma's own generated draft did it by
# dropping and re-adding every column, which produces exactly the right schema
# and an empty product: no readiness reports, no parsed requirements, no
# fidelity counts, no skills. The hand-written version casts in place.
#
# "The schema matches" is checked by `migrate diff` and by
# prisma/__tests__/migration-coverage.test.ts. Neither of them can tell the
# difference between a column that was converted and a column that was emptied,
# which is the entire failure mode here. So this seeds real rows against the
# baseline schema, migrates, and reads them back.
set -uo pipefail

export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB=grindly_schema_rehearsal
PASS="${POSTGRES_PASSWORD:-grindly_local}"
ADMIN="postgresql://grindly:${PASS}@localhost:5432/postgres"
HOSTURL="postgresql://grindly:${PASS}@localhost:5433/${DB}"
TARGET="postgresql://grindly:${PASS}@localhost:5432/${DB}"

q() { docker exec -i grindly-postgres psql -v ON_ERROR_STOP=1 "$@"; }
say() { printf '\n=== %s ===\n' "$1"; }
fail=0
check() { if [ "$2" = "$3" ]; then echo "  ok   $1 = $2"; else echo "  FAIL $1: got '$2', want '$3'"; fail=1; fi; }
g() { q "$TARGET" -tAc "$1" | tr -d '[:space:]'; }

say "reset scratch database"
q "$ADMIN" -c "DROP DATABASE IF EXISTS ${DB};" >/dev/null
q "$ADMIN" -c "CREATE DATABASE ${DB};" >/dev/null

say "apply the baseline migration only"
( cd "$REPO" && DATABASE_URL="$HOSTURL" npx prisma migrate deploy \
    --schema prisma/schema.prisma 2>&1 | grep -Ei "applied|error" | tail -5 ) || true

# migrate deploy applies everything, so roll the second migration back off and
# reapply it below. Simpler and more honest than maintaining a half-migrated
# fixture: the point is what happens to rows that already exist.
say "rewind to the baseline, then seed rows the OLD way (text columns)"
q "$TARGET" >/dev/null <<'SQL'
-- Undo the parts of migration 2 that this rehearsal is about, so the seed below
-- writes into text columns exactly as the pre-migration application did.
ALTER TABLE resumes  ALTER COLUMN skills_json DROP DEFAULT;
ALTER TABLE resumes
  ALTER COLUMN contact_json TYPE text USING contact_json::text,
  ALTER COLUMN links_json   TYPE text USING links_json::text,
  ALTER COLUMN report_json  TYPE text USING report_json::text,
  ALTER COLUMN advice_json  TYPE text USING advice_json::text,
  ALTER COLUMN skills_json  TYPE text USING skills_json::text;
ALTER TABLE resumes ALTER COLUMN skills_json SET DEFAULT '[]';
ALTER TABLE resumes DROP COLUMN truncated;
ALTER TABLE targets  ALTER COLUMN spec_json TYPE text USING spec_json::text;
ALTER TABLE variants
  ALTER COLUMN changes_json  TYPE text USING changes_json::text,
  ALTER COLUMN report_json   TYPE text USING report_json::text,
  ALTER COLUMN fidelity_json TYPE text USING fidelity_json::text;
ALTER TABLE users ALTER COLUMN plan DROP DEFAULT;
ALTER TABLE users ALTER COLUMN plan TYPE text USING plan::text;
ALTER TABLE users ALTER COLUMN plan SET DEFAULT 'free';
ALTER TABLE users ALTER COLUMN role DROP DEFAULT;
ALTER TABLE users ALTER COLUMN role TYPE text USING role::text;
ALTER TABLE users ALTER COLUMN role SET DEFAULT 'user';
ALTER TABLE users DROP COLUMN timezone;
ALTER TABLE orders ALTER COLUMN sku TYPE text USING sku::text;
ALTER TABLE orders ALTER COLUMN status DROP DEFAULT;
ALTER TABLE orders ALTER COLUMN status TYPE text USING status::text;
ALTER TABLE orders ALTER COLUMN status SET DEFAULT 'created';
ALTER TABLE targets ALTER COLUMN kind TYPE text USING kind::text;
DROP TABLE score_events;
DROP INDEX audit_logs_created_at_idx;
DROP INDEX orders_status_idx;
DROP TYPE "Plan", "Role", "OrderStatus", "Sku", "TargetKind", "ScoreSource";
DELETE FROM _prisma_migrations WHERE migration_name LIKE '%closed_vocabularies%';

INSERT INTO users (id, email, plan, role, token_version, created_at)
VALUES ('u1','paid@example.com','pass','user',0,now());

INSERT INTO resumes (id, user_id, label, text, chars, skills_json, report_json,
                     contact_json, links_json, score, grade, created_at, updated_at)
VALUES ('r1','u1','Priya CV','experience with postgres',24,
        '["Postgres","Python"]',
        '{"score":74,"grade":"B","bands":{"readable":{"score":1,"weight":30,"points":30}},"findings":[],"facts":{},"targeted":false}',
        '{"email":"priya@example.com"}',
        '["https://github.com/priya-r"]',
        74,'B',now(),now());

INSERT INTO targets (id, user_id, resume_id, kind, name, spec_json, created_at)
VALUES ('t1','u1','r1','company','Amazon','{"skills":["Java","AWS"]}',now());

INSERT INTO variants (id, resume_id, target_id, label, score, grade, baseline_score,
                      beats_baseline, changes_json, report_json, fidelity_json,
                      file, bytes, created_at)
VALUES ('v1','r1','t1','Impact-focused',81,'A',74,true,
        '["Rewrote three bullets to lead with an action"]',
        '{"score":81,"grade":"A","bands":{},"findings":[],"facts":{},"targeted":true}',
        '{"total":51,"recovered":47,"lost":["Kafka"],"pct":92}',
        'run/variant-1.pdf',180000,now());

INSERT INTO orders (id, user_id, sku, amount, currency, status, created_at)
VALUES ('o1','u1','pass90',39900,'INR','paid',now());
SQL
check "seeded before migrating" "$(g "SELECT count(*) FROM resumes;")" "1"

say "apply the migration under test"
( cd "$REPO" && DATABASE_URL="$HOSTURL" npx prisma migrate deploy 2>&1 | grep -Ei "applied|error" | tail -3 )

say "ASSERTIONS — the data is still there, and it is jsonb"
check "resume report survived"    "$(g "SELECT report_json->>'score' FROM resumes WHERE id='r1';")" "74"
check "skills survived"           "$(g "SELECT jsonb_array_length(skills_json) FROM resumes WHERE id='r1';")" "2"
check "contact survived"          "$(g "SELECT contact_json->>'email' FROM resumes WHERE id='r1';")" "priya@example.com"
check "links survived"            "$(g "SELECT links_json->>0 FROM resumes WHERE id='r1';")" "https://github.com/priya-r"
check "target spec survived"      "$(g "SELECT spec_json->'skills'->>0 FROM targets WHERE id='t1';")" "Java"
check "variant changes survived"  "$(g "SELECT jsonb_array_length(changes_json) FROM variants WHERE id='v1';")" "1"
check "fidelity survived"         "$(g "SELECT fidelity_json->>'recovered' FROM variants WHERE id='v1';")" "47"
check "columns are jsonb"         "$(g "SELECT count(*) FROM information_schema.columns WHERE table_name='resumes' AND column_name IN ('report_json','skills_json','contact_json','links_json','advice_json') AND data_type='jsonb';")" "5"

say "ASSERTIONS — enums took the existing values rather than resetting them"
check "paid plan kept"            "$(g "SELECT plan FROM users WHERE id='u1';")" "pass"
check "order sku kept"            "$(g "SELECT sku FROM orders WHERE id='o1';")" "pass90"
check "order status kept"         "$(g "SELECT status FROM orders WHERE id='o1';")" "paid"
check "target kind kept"          "$(g "SELECT kind FROM targets WHERE id='t1';")" "company"
check "plan is an enum now"       "$(g "SELECT count(*) FROM information_schema.columns WHERE table_name='users' AND column_name='plan' AND udt_name='Plan';")" "1"
check "the plan index survived"   "$(g "SELECT count(*) FROM pg_indexes WHERE tablename='users' AND indexname='users_plan_idx';")" "1"
check "new columns exist"         "$(g "SELECT count(*) FROM information_schema.columns WHERE (table_name='users' AND column_name='timezone') OR (table_name='resumes' AND column_name='truncated');")" "2"
check "score history table exists" "$(g "SELECT count(*) FROM information_schema.tables WHERE table_name='score_events';")" "1"

say "REFUSAL — a value outside an enum must stop the migration, not be guessed"
q "$ADMIN" -c "DROP DATABASE IF EXISTS ${DB}_bad;" >/dev/null
q "$ADMIN" -c "CREATE DATABASE ${DB}_bad;" >/dev/null
( cd "$REPO" && DATABASE_URL="postgresql://grindly:${PASS}@localhost:5433/${DB}_bad" \
    npx prisma migrate deploy >/dev/null 2>&1 )
# Put the column back to text, plant a plan from the discontinued product, and
# re-run the migration. It must refuse rather than silently downgrade them.
q "postgresql://grindly:${PASS}@localhost:5432/${DB}_bad" >/dev/null 2>&1 <<'SQL'
ALTER TABLE users ALTER COLUMN plan DROP DEFAULT;
ALTER TABLE users ALTER COLUMN plan TYPE text USING plan::text;
DROP TABLE score_events;
DROP TYPE "Plan", "Role", "OrderStatus", "Sku", "TargetKind", "ScoreSource" CASCADE;
DELETE FROM _prisma_migrations WHERE migration_name LIKE '%closed_vocabularies%';
INSERT INTO users (id, email, plan, role, token_version, created_at)
VALUES ('u9','legacy@example.com','plus','user',0,now());
SQL
if ( cd "$REPO" && DATABASE_URL="postgresql://grindly:${PASS}@localhost:5433/${DB}_bad" \
       npx prisma migrate deploy >/dev/null 2>&1 ); then
  echo "  FAIL migration accepted a plan outside the enum"; fail=1
else
  echo "  ok   migration refused an unknown plan"
fi
q "$ADMIN" -c "DROP DATABASE ${DB}_bad;" >/dev/null 2>&1

q "$ADMIN" -c "DROP DATABASE ${DB};" >/dev/null 2>&1
say "$([ $fail -eq 0 ] && echo 'SCHEMA REHEARSAL PASSED' || echo 'SCHEMA REHEARSAL FAILED')"
exit $fail
