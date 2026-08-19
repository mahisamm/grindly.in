-- Closed vocabularies, real JSON columns, score history, two missing indexes.
--
-- HAND-WRITTEN, and the reason is the first thing to know about this file.
--
-- `prisma migrate diff` generates this change as, for every affected column:
--
--     ALTER TABLE "resumes" DROP COLUMN "report_json",
--     ADD COLUMN "report_json" JSONB;
--
-- which is a correct description of the end state and silently deletes every
-- readiness report, every set of parsed requirements, every fidelity count and
-- every user's extracted skills. Prisma cannot know that `text` holding JSON is
-- convertible to `jsonb`; it only knows the types differ. A generated migration
-- is a draft, and this is the class of thing that makes reading the draft
-- non-optional.
--
-- Everything below alters in place with an explicit USING, so the data survives
-- and the indexes on those columns are not dropped and rebuilt.

-- ---------------------------------------------------------------------------
-- Guards. Run before anything is altered.
--
-- A value outside the new enum has no correct automatic answer: mapping an
-- unrecognised `sku` onto one of the two real products invents a purchase, and
-- defaulting an unrecognised `plan` to free silently downgrades someone who
-- paid. So the migration stops and names what it found, and a human decides.
-- On a fresh database these are no-ops; on a populated one they are the
-- difference between a refused deploy and a quiet corruption.
-- ---------------------------------------------------------------------------
DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(DISTINCT plan, ', ') INTO bad
    FROM users WHERE plan NOT IN ('free', 'pack', 'pass');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'users.plan holds values outside the Plan enum: %. Resolve these rows first.', bad;
  END IF;

  SELECT string_agg(DISTINCT role, ', ') INTO bad
    FROM users WHERE role NOT IN ('user', 'admin');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'users.role holds values outside the Role enum: %. Resolve these rows first.', bad;
  END IF;

  SELECT string_agg(DISTINCT sku, ', ') INTO bad
    FROM orders WHERE sku NOT IN ('pass90', 'pack1');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'orders.sku holds values outside the Sku enum: %. Resolve these rows first.', bad;
  END IF;

  SELECT string_agg(DISTINCT status, ', ') INTO bad
    FROM orders WHERE status NOT IN ('created', 'paid', 'failed', 'refunded');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'orders.status holds values outside the OrderStatus enum: %. Resolve these rows first.', bad;
  END IF;

  SELECT string_agg(DISTINCT kind, ', ') INTO bad
    FROM targets WHERE kind NOT IN ('company', 'jd', 'notes');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'targets.kind holds values outside the TargetKind enum: %. Resolve these rows first.', bad;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- CreateEnum
-- ---------------------------------------------------------------------------
CREATE TYPE "Plan" AS ENUM ('free', 'pack', 'pass');
CREATE TYPE "Role" AS ENUM ('user', 'admin');
CREATE TYPE "OrderStatus" AS ENUM ('created', 'paid', 'failed', 'refunded');
CREATE TYPE "Sku" AS ENUM ('pass90', 'pack1');
CREATE TYPE "TargetKind" AS ENUM ('company', 'jd', 'notes');
CREATE TYPE "ScoreSource" AS ENUM ('upload', 'rescore', 'variant', 'edit');

-- ---------------------------------------------------------------------------
-- users: plan and role become enums, timezone appears
--
-- The default has to come off before the type changes and go back on after:
-- Postgres will not cast an existing text default to the new type on its own.
-- ---------------------------------------------------------------------------
ALTER TABLE "users" ALTER COLUMN "plan" DROP DEFAULT;
ALTER TABLE "users" ALTER COLUMN "plan" TYPE "Plan" USING "plan"::"Plan";
ALTER TABLE "users" ALTER COLUMN "plan" SET DEFAULT 'free';

ALTER TABLE "users" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "users" ALTER COLUMN "role" TYPE "Role" USING "role"::"Role";
ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'user';

ALTER TABLE "users" ADD COLUMN "timezone" TEXT;

-- ---------------------------------------------------------------------------
-- orders
-- ---------------------------------------------------------------------------
ALTER TABLE "orders" ALTER COLUMN "sku" TYPE "Sku" USING "sku"::"Sku";

ALTER TABLE "orders" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "orders" ALTER COLUMN "status" TYPE "OrderStatus" USING "status"::"OrderStatus";
ALTER TABLE "orders" ALTER COLUMN "status" SET DEFAULT 'created';

-- ---------------------------------------------------------------------------
-- targets
-- ---------------------------------------------------------------------------
ALTER TABLE "targets" ALTER COLUMN "kind" TYPE "TargetKind" USING "kind"::"TargetKind";

-- ---------------------------------------------------------------------------
-- text holding JSON becomes jsonb
--
-- NULLIF guards the one value that is not convertible: an empty string. It is
-- not supposed to be there — every writer goes through JSON.stringify — but a
-- cast that fails takes the whole deploy with it, and an empty string and a
-- NULL mean the same thing to every reader in the application.
-- ---------------------------------------------------------------------------
ALTER TABLE "resumes"
  ALTER COLUMN "contact_json" TYPE JSONB USING NULLIF("contact_json", '')::jsonb,
  ALTER COLUMN "links_json"   TYPE JSONB USING NULLIF("links_json", '')::jsonb,
  ALTER COLUMN "report_json"  TYPE JSONB USING NULLIF("report_json", '')::jsonb,
  ALTER COLUMN "advice_json"  TYPE JSONB USING NULLIF("advice_json", '')::jsonb;

-- skills_json is NOT NULL with a default, so it needs the default dropped, a
-- COALESCE in the cast to keep the not-null promise, and the default put back
-- as jsonb rather than text.
ALTER TABLE "resumes" ALTER COLUMN "skills_json" DROP DEFAULT;
ALTER TABLE "resumes" ALTER COLUMN "skills_json" TYPE JSONB
  USING COALESCE(NULLIF("skills_json", ''), '[]')::jsonb;
ALTER TABLE "resumes" ALTER COLUMN "skills_json" SET DEFAULT '[]';

ALTER TABLE "resumes" ADD COLUMN "truncated" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "targets"
  ALTER COLUMN "spec_json" TYPE JSONB USING NULLIF("spec_json", '')::jsonb;

ALTER TABLE "variants"
  ALTER COLUMN "changes_json"  TYPE JSONB USING NULLIF("changes_json", '')::jsonb,
  ALTER COLUMN "report_json"   TYPE JSONB USING NULLIF("report_json", '')::jsonb,
  ALTER COLUMN "fidelity_json" TYPE JSONB USING NULLIF("fidelity_json", '')::jsonb;

-- ---------------------------------------------------------------------------
-- CreateTable
-- ---------------------------------------------------------------------------
CREATE TABLE "score_events" (
    "id" TEXT NOT NULL,
    "resume_id" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "grade" TEXT NOT NULL,
    "source" "ScoreSource" NOT NULL,
    "variant_label" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "score_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "score_events_resume_id_created_at_idx" ON "score_events"("resume_id", "created_at");

ALTER TABLE "score_events" ADD CONSTRAINT "score_events_resume_id_fkey"
  FOREIGN KEY ("resume_id") REFERENCES "resumes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- CreateIndex
--
-- `users_plan_idx` is NOT recreated here. Altering a column in place keeps its
-- indexes; the generated draft only listed it because dropping and re-adding
-- the column had destroyed it.
-- ---------------------------------------------------------------------------
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");
CREATE INDEX "orders_status_idx" ON "orders"("status");
