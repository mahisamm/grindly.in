-- CreateEnum
CREATE TYPE "ApplicationStatus" AS ENUM ('sent', 'screening', 'interview', 'offer', 'rejected', 'withdrawn');

-- AlterTable
ALTER TABLE "resumes" ADD COLUMN     "share_token" TEXT;

-- CreateTable
CREATE TABLE "applications" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "resume_id" TEXT NOT NULL,
    "variant_label" TEXT,
    "company" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT '',
    "status" "ApplicationStatus" NOT NULL DEFAULT 'sent',
    "notes" TEXT,
    "applied_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "applications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "applications_user_id_applied_at_idx" ON "applications"("user_id", "applied_at");

-- CreateIndex
CREATE INDEX "applications_resume_id_idx" ON "applications"("resume_id");

-- CreateIndex
CREATE UNIQUE INDEX "resumes_share_token_key" ON "resumes"("share_token");

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_resume_id_fkey" FOREIGN KEY ("resume_id") REFERENCES "resumes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

