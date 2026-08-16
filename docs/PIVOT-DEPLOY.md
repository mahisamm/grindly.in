# Deploying the pivot over a populated box

The runbook for replacing the auto-apply build with the resume-readiness one on
a server that already has real users on it. Written for grindly.in, which had 6
accounts, 260 applications and 200 resume versions when this was drafted.

Read it start to finish before running anything. The ordering is the whole
point: two steps in this sequence are irreversible and one of them is easy to
trigger by accident.

---

## The trap

`docker compose up -d` starts a one-shot `migrate` service that runs
`npx prisma db push`. The new schema shares almost nothing with the old one, so
that push is a destructive change — it drops 27 tables.

Two independent things stop it being a disaster, and you need to understand both
or you will disable one while working around the other:

1. **`migrate` has no `--accept-data-loss`.** Prisma refuses destructive changes
   without it, and there is no TTY in the container to prompt on, so it errors
   and `web` never starts. Failing safe.
2. **But it fails at the worst possible moment** — after the pre-migration SQL
   has already moved your accounts into the `legacy` schema, so you are
   half-migrated with a stack that will not come up.

So: **do the schema change by hand, first.** After that, `migrate` finds the
schema already in sync, exits 0, and the stack starts normally.

Do not add `--accept-data-loss` to the compose file. That converts every future
deploy into one that will silently drop whatever it finds inconvenient.

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
ls scripts/migrate-from-autoapply*.sql
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

Copies accounts into a `legacy` schema, which `prisma db push` does not manage
and therefore will not touch. Archives `applications` and `profiles` alongside
them. Refuses if it has already run.

Expected output: a row reading `users | applications_archived | profiles_archived`.

### 5. Change the schema — the irreversible step

```bash
docker compose run --rm --no-deps \
  -e DATABASE_URL="postgresql://grindly:${POSTGRES_PASSWORD}@postgres:5432/grindly" \
  migrate sh -c "npx prisma db push --skip-generate --accept-data-loss"
```

`--no-deps` so this does not start `web`. This is the one place the flag is
used, typed by a human who has read step 0.

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
docker compose logs --tail=40 migrate   # should be a no-op: schema already in sync
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

**After step 5 there is no rollback without the dump.** The old tables are gone.
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
