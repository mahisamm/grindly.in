#!/usr/bin/env bash
# One-shot production remediation — 2026-07-27.
#
# Why this exists: the agent was fully idle in production. Three independent
# causes, each invisible from the dashboard:
#   1. The owner account was status='paused' (sweep only enqueues 'active').
#   2. GRINDLY_TIER_B_APPLY=0 — hosted Internshala submit off fleet-wide, so a
#      connected account got banked matches and queued browser tasks, never a
#      hosted send.
#   3. Six ATS applications failed on the pre-695e151 asyncio bug and their
#      submission-ledger claims were never released, so they could never retry.
#
# Run ON THE VPS:  cd /opt/grindly && git pull --ff-only && bash scripts/beta-remediate-2026-07-27.sh
set -euo pipefail
cd /opt/grindly

echo "== 1/5 Tier B hosted submit on =="
if grep -q '^GRINDLY_TIER_B_APPLY=' .env; then
  sed -i 's/^GRINDLY_TIER_B_APPLY=.*$/GRINDLY_TIER_B_APPLY=1/' .env
else
  echo 'GRINDLY_TIER_B_APPLY=1' >> .env
fi
grep '^GRINDLY_TIER_B_APPLY=' .env

echo "== 2/5 DB: unstick claims, re-open failed ATS rows, reactivate owner =="
docker compose exec -T postgres psql -U grindly -d grindly <<'SQL'
-- The six pre-fix exception claims: the sender crashed BEFORE the browser
-- started, so nothing reached an employer — releasing them is safe and is the
-- only way those listings can ever be retried.
DELETE FROM submission_receipts WHERE status = 'exception';
-- 'skipped' (unlike 'failed') is re-scorable: discovery will re-find these,
-- re-score them, and send them through the fixed ATS sender.
UPDATE applications
   SET status = 'skipped',
       reason = 'reset 2026-07-27: failed on a worker bug (since fixed) — will be re-scored and retried'
 WHERE status = 'failed' AND apply_channel = 'ats';
-- The daily sweep only runs status='active' users.
UPDATE users SET status = 'active' WHERE role = 'admin' AND status = 'paused';
SELECT status, count(*) FROM users GROUP BY 1;
SQL

echo "== 3/5 rebuild with today's fixes =="
docker compose build web worker
docker compose up -d

echo "== 4/5 enqueue a verification run now (instead of waiting for tomorrow's sweep) =="
sleep 10
docker compose run --rm -T --no-deps -w /app/agent worker python -c "
import db, run_queue
for uid in db.active_users():
    run_queue.enqueue(uid, 'live')
    print('enqueued live run for', uid)
"

echo "== 5/5 done — watch it apply =="
echo "docker compose logs -f worker      # discovery -> match -> dispatch"
echo "Then check https://grindly.in dashboard: 'Sent today' should move."
