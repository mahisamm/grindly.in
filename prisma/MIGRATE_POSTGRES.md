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
   DATABASE_URL="postgresql://nexpath:nexpath@localhost:5432/nexpath"
   ```
   `docker-compose.yml` already provisions this exact server.

3. **Create the schema**:
   ```
   npx prisma migrate dev --name init     # dev
   npx prisma migrate deploy              # prod / CI
   ```

4. **Python worker** reads the same DB. The current `agent/db.py` uses sqlite3
   directly; for Postgres swap it to `psycopg` (same SQL, parameter style `%s`).
   Until then, set `INTERNPILOT_DB` only for the SQLite path.

## Why
- SQLite single-writer lock → contention once web + 2+ workers write concurrently.
- Postgres gives real row-level locking, which the `agent_runs` queue
  (`claim_next` uses `BEGIN IMMEDIATE` today) maps onto `SELECT ... FOR UPDATE
  SKIP LOCKED` for true multi-worker draining.

## Data
No production data exists yet (prototype). If migrating real data later, export
with `sqlite3 dev.db .dump`, transform, and `\copy` into Postgres, or use a tool
like `pgloader`.
