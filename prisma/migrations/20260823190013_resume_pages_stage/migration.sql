-- AlterTable
ALTER TABLE "resumes" ADD COLUMN     "career_signals" JSONB,
ADD COLUMN     "career_stage" TEXT,
ADD COLUMN     "pages" INTEGER,
ADD COLUMN     "target_pages" INTEGER;
