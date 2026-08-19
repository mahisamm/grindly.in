-- CreateTable
CREATE TABLE "problem_reports" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "message" TEXT NOT NULL,
    "path" TEXT,
    "user_agent" TEXT,
    "resume_id" TEXT,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "problem_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "problem_reports_resolved_at_created_at_idx" ON "problem_reports"("resolved_at", "created_at");

-- CreateIndex
CREATE INDEX "problem_reports_user_id_idx" ON "problem_reports"("user_id");

-- AddForeignKey
ALTER TABLE "problem_reports" ADD CONSTRAINT "problem_reports_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

