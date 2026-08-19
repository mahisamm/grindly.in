-- CreateEnum
CREATE TYPE "LinkStyle" AS ENUM ('url', 'label');

-- AlterTable
ALTER TABLE "resumes" ADD COLUMN     "link_style" "LinkStyle" NOT NULL DEFAULT 'url';

