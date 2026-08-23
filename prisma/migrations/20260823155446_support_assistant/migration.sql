-- The support desk grows an assistant. Hand-written rather than Prisma's
-- draft: the draft DROPPED and re-added the two enum columns ("no cast
-- exists"), which loses every row. Role and MessageAuthor share the values
-- 'user' and 'admin', so a text cast carries existing rows across intact.

-- CreateEnum
CREATE TYPE "MessageAuthor" AS ENUM ('user', 'admin', 'assistant');

-- CreateEnum
CREATE TYPE "HandledBy" AS ENUM ('assistant', 'human');

-- ticket_messages.author_role: Role -> MessageAuthor, rows preserved
ALTER TABLE "ticket_messages"
  ALTER COLUMN "author_role" TYPE "MessageAuthor"
  USING ("author_role"::text::"MessageAuthor");

-- tickets.last_message_by: Role -> MessageAuthor, rows preserved
ALTER TABLE "tickets"
  ALTER COLUMN "last_message_by" DROP DEFAULT,
  ALTER COLUMN "last_message_by" TYPE "MessageAuthor"
    USING ("last_message_by"::text::"MessageAuthor"),
  ALTER COLUMN "last_message_by" SET DEFAULT 'user';

-- tickets: the assistant's summary, who is handling it, when it was handed over
ALTER TABLE "tickets"
  ADD COLUMN "summary" TEXT,
  ADD COLUMN "handled_by" "HandledBy" NOT NULL DEFAULT 'assistant',
  ADD COLUMN "escalated_at" TIMESTAMP(3),
  ALTER COLUMN "category" SET DEFAULT 'other';

-- CreateIndex
CREATE INDEX "tickets_handled_by_status_idx" ON "tickets"("handled_by", "status");
