-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('running', 'done', 'empty', 'failed', 'cancelled');

-- CreateTable
CREATE TABLE "variant_runs" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "resume_id" TEXT NOT NULL,
    "target_id" TEXT,
    "target_name" TEXT NOT NULL DEFAULT '',
    "status" "RunStatus" NOT NULL DEFAULT 'running',
    "stage" TEXT NOT NULL DEFAULT 'Starting',
    "error" TEXT,
    "variants_made" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "variant_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "variant_runs_resume_id_started_at_idx" ON "variant_runs"("resume_id", "started_at");

-- CreateIndex
CREATE INDEX "variant_runs_status_idx" ON "variant_runs"("status");

-- AddForeignKey
ALTER TABLE "variant_runs" ADD CONSTRAINT "variant_runs_resume_id_fkey" FOREIGN KEY ("resume_id") REFERENCES "resumes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
