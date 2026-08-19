# The database

`prisma/schema.prisma` is the source of truth and carries the reasoning for
every non-obvious column. This file is the map: what the tables are for, how
they relate, and how a change to them reaches production.

The previous version of this document described `Profile`, `Application` →
`ResumeVersion`, `AgentRun`, `PlatformCredential` and a job queue drained by
`worker.py --serve`. None of those exist. They belonged to the auto-apply build
that the resume-readiness rewrite replaced, and a schema document describing a
database nobody has is worse than no document at all — it is a map of a city
that was demolished.

---

## Shape

```
User
 ├─→ Resume ──→ ScoreEvent      every score this document has ever been given
 │      ├─→ Variant             one measured rewrite, or the user's own edit
 │      ├─→ Target ──→ Variant  what a set of rewrites was aimed at
 │      ├─→ VariantRun          one rebuild batch, from button press to PDFs
 │      └─→ Application         where this resume was sent, typed by the user
 ├─→ Order                      a pass purchase
 ├─→ DailyUsage                 per-user daily ceilings
 ├─→ AuditLog
 ├─→ PasswordResetToken
 └─→ EmailVerificationToken

standalone:  RateLimitEntry · ErrorEvent · BackupHealth
```

A user has resumes; a resume has a measured report and some variants; a variant
may be aimed at a target. That is the whole product, and the schema is
deliberately about that size.

---

## What each table is for

| Table | Why it exists |
|---|---|
| `users` | Identity, plan, timezone. `plan` and `role` are enums — a typo used to read as an unknown plan, drop the user to the free tier, and log nothing. |
| `resumes` | The extracted text, the contact fields read locally, the last report, and `struct_json` — the editable fields the PDF is printed from. |
| `score_events` | Append-only. `resumes.score` is overwritten on every read, so without this the question "did my change help?" has no data behind it. |
| `variants` | One rendered rewrite with its own report and fidelity count. Superseded and deleted on the next run against the same target. |
| `targets` | A curated company pack, a pasted job description, or the user's own notes about an employer — `kind` keeps the last of those labelled as theirs. |
| `variant_runs` | A rebuild batch as a row rather than an open HTTP request, so the work survives a closed tab. |
| `applications` | Where a resume was sent. Typed by the user; Grindly submits nothing. Records WHICH VERSION went out, which is the join a spreadsheet cannot make. |
| `orders` | A pass purchase. The product bought is written at creation, never read from the client at confirmation. |
| `daily_usage` | Reserve-then-refund ceilings, counted in the user's own day. |
| `audit_logs` | Append-only trail. Pruned at 180 days by `lib/retention.ts`. |
| `error_events` | Deduplicated faults from the web app, the Python agent and the browser. Resolved ones pruned at 30 days. |
| `rate_limit_entries` | DB-backed limiter, swept opportunistically. |
| `password_reset_tokens` · `email_verification_tokens` | Hash only. A table of usable tokens hands out every account the moment a backup leaks. |
| `backup_health` | Written by `scripts/backup-drill.sh`, never by the app. Declared here so migrations leave it alone. |

---

## Changing it

`prisma migrate deploy` applies the SQL in `prisma/migrations` and nothing else.
**`prisma db push` is not used anywhere any more**, and the difference is the
point: `db push` compares a live database to the schema and invents a
reconciliation plan on the spot — a plan computed on a production box, at deploy
time, that nobody reads. That is how `backup_health` became a deletion candidate
and took a deploy down with it.

```bash
# 1. Edit prisma/schema.prisma, then generate the migration:
npx prisma migrate dev --name what_you_changed

# 2. READ THE GENERATED SQL. This is not a formality.
```

Prisma's draft is a description of the end state, not a plan for getting there
safely. Converting a `text` column holding JSON to `jsonb` generates
`DROP COLUMN` + `ADD COLUMN` — the right final schema and an empty product. The
migration that did that conversion here is hand-written for exactly that reason,
and `scripts/rehearse-schema-migration.sh` seeds a database the old way,
migrates it, and asserts the data is still there.

Two tests hold this together:

- `prisma/__tests__/migration-coverage.test.ts` — every model and column in the
  schema appears in a migration. A model added without one produces a client
  that queries a column the database does not have, and it fails on the first
  request in production rather than at deploy time.
- `scripts/__tests__/reset-db.regression-1.test.ts` — every model is cleared by
  `scripts/reset-db.mjs`.

---

## Migrating the production box

`docs/PIVOT-DEPLOY.md` is authoritative for the auto-apply → resume-readiness
cutover, which has not happened yet. `scripts/rehearse-migration.sh` rehearses
the whole thing against a throwaway database, including the refusals: the
destructive step will not run before the accounts are carried out of the way,
and will not run twice.
