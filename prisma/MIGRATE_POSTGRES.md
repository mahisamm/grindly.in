# Moving from SQLite (prototype) to Postgres (production)

The prototype runs on a single SQLite file. Postgres is required before scaling
(concurrent web + multiple workers writing at once). The code is already
config-driven — only the datasource provider + URL change.

## Steps

1. **Switch the provider** in `prisma/schema.prisma`:
   ```prisma
   datasource db {
     provider = "postgresql"
     url      = env("DATABASE_URL")
   }
   ```

2. **Point `DATABASE_URL` at Postgres** (in `.env` / deployment env):
   ```
   DATABASE_URL="postgresql://grindly:grindly@localhost:5432/grindly"
   ```
   `docker-compose.yml` already provisions this exact server.

3. **Create the schema**:
   ```
   npx prisma migrate dev --name init     # dev
   npx prisma migrate deploy              # prod / CI
   ```

4. **Python worker** reads the same DB. `agent/db.py` now auto-detects the
   backend from `DATABASE_URL` (Postgres when it starts with `postgres://`,
   else SQLite) — no manual `?`→`%s` edits needed. It uses `psycopg2`
   (`psycopg2-binary`, in `agent/requirements.txt`) and `SELECT ... FOR UPDATE
   SKIP LOCKED` for true multi-worker draining. Leave `INTERNPILOT_DB` unset in
   prod so the Postgres path is selected; set it to a file path to force SQLite.

## Why
- SQLite single-writer lock → contention once web + 2+ workers write concurrently.
- Postgres gives real row-level locking, which the `agent_runs` queue
  (`claim_next` uses `BEGIN IMMEDIATE` today) maps onto `SELECT ... FOR UPDATE
  SKIP LOCKED` for true multi-worker draining.

## Data
No production data exists yet (prototype). If migrating real data later, export
with `sqlite3 dev.db .dump`, transform, and `\copy` into Postgres, or use a tool
like `pgloader`.
