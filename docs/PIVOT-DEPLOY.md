# Deploying the pivot over a populated box

The runbook for replacing the auto-apply build with the resume-readiness one on
a server that already has real users on it. Written for grindly.in, which had 6
accounts, 260 applications and 200 resume versions when this was drafted.

Read it start to finish before running anything. The ordering is the whole
point: two steps in this sequence are irreversible and one of them is easy to
trigger by accident.

---

## The trap

`docker compose up -d` starts a one-shot `migrate` service. It runs
`npx prisma migrate deploy`, which applies the SQL in `prisma/migrations` and
nothing else — so on a box carrying the old product's 27 tables it will create
the new schema *alongside* them and fail on the first name that collides.

That failure is loud and harmless, and it is not the trap. The trap is that
`migrate` is one-shot and `web` used to depend on it: `up -d` stops the running
container before it evaluates dependencies, so a failed migration left nothing
serving. `migrate` is now a separate step you run first, and only a successful
one lets you take the next.

So: **empty `public` by hand, first.** `scripts/reset-public-schema.sql` does
it, refuses unless the accounts are already carried into `legacy`, and refuses
outright on a database that is not the pre-pivot one. After it runs, `migrate
deploy` builds the new schema on clean ground, from files that were reviewed in
a diff rather than from a plan computed on the box.

The old version of this runbook used `prisma db push --accept-data-loss` here.
Never add that flag to anything: it asks Prisma to invent a reconciliation plan
against a live database and promises in advance not to object to it. That is how
`backup_health` — a table created by the backup script, outside Prisma's
knowledge — became a candidate for deletion and took a deploy down with it.

---

## Order of operations

Nothing below is safe to reorder.

### 0. Before you start

- [ ] A full `pg_dump` exists, has been **restored into a scratch database** and
      the row counts matched. A dump nobody has restored is a hypothesis.
- [ ] That dump is **off the box**, checksum verified. A backup that only exists
      on the machine it protects is not a backup.
- [ ] `applications` and `users` exported to CSV, also off the box.
- [ ] Users have been told, if you are going to tell them. See the bottom.

### 1. Rollback tags — free, and the only way back

```bash
docker tag grindly-web:latest    grindly-web:pre-pivot-$(git rev-parse --short HEAD)
docker tag grindly-worker:latest grindly-worker:pre-pivot-$(git rev-parse --short HEAD)
docker image ls | grep pre-pivot
```

Both images. `worker` is separate and the old compose file references it. This
costs no disk — same layers, new names.

### 2. Get the code

```bash
cd /opt/grindly
git fetch origin
git checkout resume-pivot
git pull origin resume-pivot
```

Then **verify you have the right code**, because a branch name is not evidence:

```bash
grep -c "model Resume"      prisma/schema.prisma   # >= 1
grep -c "model Variant"     prisma/schema.prisma   # >= 1
grep -c "model Application" prisma/schema.prisma   # 0
ls agent/readiness.py agent/render_pdf.py
ls scripts/migrate-from-autoapply*.sql scripts/reset-public-schema.sql
ls prisma/migrations/*/migration.sql                # the schema, as reviewable SQL
```

Any failure: stop.

### 3. Get the image

Built off-box by CI and pulled here — see `.github/workflows/build-image.yml`.
Building on the box competes for RAM with the running stack, and `next build` on
a 1.2 GB image with a few hundred MB of headroom is an OOM kill waiting for a
busy moment.

```bash
docker pull ghcr.io/mahisamm/grindly-web:resume-pivot
docker tag  ghcr.io/mahisamm/grindly-web:resume-pivot grindly-web:latest
```

If you must build locally instead, stop `connect` and `worker` first to free
their memory, and watch it: `docker compose build web 2>&1 | tail -40`.

### 4. Carry the accounts out of the way

```bash
docker compose exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U grindly -d grindly \
  < scripts/migrate-from-autoapply.sql
```

Copies accounts into a `legacy` schema, which Prisma does not manage and step 5a
therefore leaves alone. Archives `applications` and `profiles` alongside them,
freezing their enum columns as text first — the types themselves go with
`public`. Refuses if it has already run.

Expected output: a row reading `users | applications_archived | profiles_archived`.

### 5. Change the schema — the irreversible step

Two commands, and the split is the point: one destroys, one builds, and only the
first is irreversible.

```bash
# 5a. Empty public. Refuses unless step 4 has already carried the accounts.
docker compose exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U grindly -d grindly \
  < scripts/reset-public-schema.sql

# 5b. Build the new schema from prisma/migrations.
docker compose run --rm --no-deps \
  -e DATABASE_URL="postgresql://grindly:${POSTGRES_PASSWORD}@postgres:5432/grindly" \
  migrate sh -c "npx prisma migrate deploy"
```

`--no-deps` so this does not start `web`.

5a prints the carried-account count and the number of tables it is about to
destroy before it does anything. Read both. If the carried count is not 6, stop
— step 4 did not do what you think it did, and 5a is the last moment that is
recoverable without the dump.

5b is deterministic: it applies `00000000000000_baseline_pivot_schema` and
records it in `_prisma_migrations`. Every deploy after this one applies only
what is new, so this is the last time the schema step is anything but boring.

The whole sequence — 4, 5a, 5b, 6 — is rehearsed by
`scripts/rehearse-migration.sh` against a throwaway database seeded with a
replica of the old schema. Run it before you run any of this. It asserts the
refusals as well as the successes: that 5a will not run before 4, and will not
run twice.

### 6. Put the accounts back

```bash
docker compose exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U grindly -d grindly \
  < scripts/migrate-from-autoapply-restore.sql
```

Prints the restored count, anyone who had paid under the old product, and any
account that failed to come back (should be empty). Safe to re-run.

### 7. Retire the auto-apply services

Explicitly, not as compose orphans. This is the moment the daily agent stops.

```bash
docker compose stop worker planner sweep connect searxng redis
docker compose rm -f worker planner sweep connect searxng redis
```

### 8. Start the new stack

```bash
docker compose up -d
docker compose ps
docker compose logs --tail=40 migrate   # "No pending migrations" — 5b already applied it
docker compose logs --tail=40 web
```

### 9. Verify

```bash
curl -s http://localhost:3000/api/health
curl -s 'http://localhost:3000/api/health?deep=1'   # "renderer": true is required
```

`renderer: false` means Chromium is not in the image. Roll back; do not patch a
running container.

Then in a browser: landing page over HTTPS, sign in as an existing user
(**their password still works — sessions were invalidated, credentials were
not**), upload a resume, confirm a score comes back.

### 10. Afterwards

```sql
-- Once you are satisfied, and not before:
DROP SCHEMA legacy CASCADE;
```

Keep the rollback tags for a week.

---

## Rolling back

Before step 5, rollback is `git checkout master && docker compose up -d`.

**After step 5a there is no rollback without the dump.** The old tables are gone.
5b is not the dangerous half — if it fails, `public` is empty and re-running it
is free.
Restoring means: stop the stack, drop the database, restore
`grindly-FULL-*.sql.gz`, retag `grindly-web:pre-pivot-*` back to `latest`, and
bring up the old compose file from `master`.

This is why step 0 is not optional.

---

## The part that is not technical

Six people signed up for a product that applies to internships on their behalf,
and it has been doing that — 192 applications in the fortnight before the
cutover. After step 7 it stops, and after step 6 their application history is no
longer in the app.

Send them something before the cutover, not after, and attach each person their
own rows from `applications-*.csv`. It costs an hour and it is the difference
between a migration and a deletion with a changelog.
