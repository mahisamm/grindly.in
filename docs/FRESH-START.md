# Wiping grindly.in back to an empty site

Written 19 Aug 2026, for the decision to remove every account and start clean.

This is **not** the pivot cutover — that already happened. The box is on
`resume-pivot`, serving the resume-readiness product, with the new schema in
`public` and the old auto-apply archive parked in `legacy`.

## What is on the box right now

| | |
|---|---|
| Users | 7 |
| Resumes | 2 |
| Variants | 9 |
| Targets | 3 |
| **Paid orders** | **0** — nobody is owed anything |
| `legacy` schema | `applications_archive`, `profiles`, `profiles_archive` |

## The backup, already taken

```
/root/backups/grindly-PREWIPE-20260819-143011.sql.gz          on the box
%USERPROFILE%\grindly-backups\grindly-PREWIPE-20260819-143011.sql.gz   off it
sha256 1b5f67809671db12460236c151ceaecb3a40e5ebf04b9310eb7f4839106caa83
```

Both copies verified identical. It is a `--clean --if-exists` dump, so restoring
it puts the seven accounts and their documents back exactly as they were. Keep
it until you are sure.

## Why the schema is rebuilt rather than migrated

There is no `_prisma_migrations` table on the box: the live schema was created
by `prisma db push`, before migrations existed. Two ways forward, and only one
of them is honest:

- `migrate resolve --applied <baseline>` tells Prisma the pushed schema already
  matches the baseline SQL. Probably true. Nobody has checked, and if it is
  wrong the next migration runs against a schema it does not describe.
- Drop `public` and let `migrate deploy` build it. Deterministic, identical to
  what CI and every developer machine build, and — since everything in it is
  being deleted anyway — free.

The second one. Wiping removes the only reason to prefer the first.

## The sequence

Every step is a separate command on purpose. Read the output of each before
running the next.

```bash
ssh -i "$env:USERPROFILE\.ssh\grindly_deploy" root@187.127.151.176
cd /opt/grindly
```

### 1. Get the new code and image

```bash
git fetch origin && git checkout resume-pivot && git pull origin resume-pivot
git log --oneline -1          # expect the "Merge hardening" commit

docker pull ghcr.io/mahisamm/grindly-web:resume-pivot
docker tag  ghcr.io/mahisamm/grindly-web:resume-pivot grindly-web:latest
```

If the pull 404s, CI has not finished publishing — check the Actions tab. Do not
build on the box; it has ~230 MB free while the stack runs and `next build`
plus Chromium will be OOM-killed.

### 2. Keep a rollback image

```bash
docker tag grindly-web:latest grindly-web:pre-wipe-$(git rev-parse --short HEAD)
```

Costs no disk — same layers, another name.

### 3. Stop serving

```bash
docker compose stop web
```

Caddy stays up and will return 502 for a minute or two. That is the correct
face for "we are working on it".

### 4. Empty the database

```bash
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U grindly -d grindly <<'SQL'
DROP SCHEMA IF EXISTS legacy CASCADE;
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;
GRANT ALL ON SCHEMA public TO CURRENT_USER;
GRANT ALL ON SCHEMA public TO public;
COMMENT ON SCHEMA public IS 'standard public schema';
SQL
```

`legacy` goes too — it is the archive of the auto-apply product's applications
and profiles, which is user data, and the instruction was to keep none.

**This is the irreversible step.** After it, the dump in step 0 is the only copy.

### 5. Build the schema from the migrations

```bash
docker compose --profile migrate run --rm --no-deps \
  -e DATABASE_URL="postgresql://grindly:${POSTGRES_PASSWORD_URLENCODED}@postgres:5432/grindly" \
  migrate
```

That runs `prisma migrate deploy` and then `seed-admin.mjs`. Expect five
migrations applied, ending with `20260819000005_share_and_applications`.

### 6. Delete the uploaded files

The database no longer references them, so they are orphaned bytes containing
other people's resumes.

```bash
docker run --rm -v grindly_appdata:/data alpine sh -c 'rm -rf /data/resumes/* /data/variants/* /data/llm-cache/*'
docker run --rm -v grindly_appdata:/data alpine sh -c 'ls -la /data'
```

### 7. Start, and check

```bash
docker compose up -d
docker compose ps
curl -s localhost:3000/api/health | head -c 400
curl -s 'localhost:3000/api/health?deep=1' | head -c 600     # "renderer": true is required
```

`renderer: false` means Chromium is missing from the image — roll back to the
`pre-wipe` tag rather than patching a running container.

### 8. Take the first account

The database is empty, and `signup` makes the **first account an admin**. Sign
up at https://grindly.in/signup with the address you want to monitor from,
before anyone else does.

Then confirm, signed in:

- `/app` — no resumes, no leftovers
- upload a resume, get a score
- `/app/<id>/edit` — the editor reads it into fields
- `/admin` — users: 1, and the error table is reachable

### 9. Afterwards

Keep `grindly-web:pre-wipe-*` and the dump for a week. After that:

```bash
docker image rm grindly-web:pre-wipe-<sha>
```

## What this does not do

It does not tell the seven people their accounts are gone. None of them paid,
and the product they used is already not the product that was there — but if
any of them uploaded a resume in the last week, their score history and rebuilt
PDFs disappear without warning. The addresses are in the dump if you want to
send anything.
