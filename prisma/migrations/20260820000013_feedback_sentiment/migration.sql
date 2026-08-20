-- Sentiment and a one-line summary on top of a problem report, so the admin
-- feedback view can sort into positive/negative without a second submission
-- form. Written once, lazily, by cmd_classify_feedback reading `message` —
-- see lib/feedback.ts. Null means "not classified yet", not "neutral".

ALTER TABLE "problem_reports"
  ADD COLUMN "sentiment" TEXT,
  ADD COLUMN "summary" TEXT,
  ADD COLUMN "classified_at" TIMESTAMP(3);

CREATE INDEX "problem_reports_sentiment_idx" ON "problem_reports"("sentiment");
