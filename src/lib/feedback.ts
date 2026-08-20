/**
 * Turning problem-report text into two columns an admin can actually read.
 *
 * There is no separate "feedback" form — see api/problems/route.ts. Every row
 * here started as a bug report typed into the widget in the corner of the
 * app, because that is the one place users already tell us something is
 * wrong (or, less often, that it isn't). This module is what puts a sentiment
 * and a one-line summary on top of that text; it never asks the reporter for
 * either.
 *
 * Classification is lazy, not on submit: the report endpoint is on the
 * critical path of a user's session and must not wait on a model call. It
 * runs here instead, from the admin feedback view, in a small capped batch so
 * one visit to the page cannot fire an unbounded number of subprocess calls.
 */
import { prisma } from "./prisma";
import { runAgent } from "./agent";

const BATCH_LIMIT = 12;

/**
 * Classify up to `limit` reports that have no sentiment yet, oldest first.
 *
 * Best-effort: a report whose classification fails (no provider answered,
 * the process timed out) is simply left unclassified and picked up on the
 * next visit — never surfaced as an error on a page an admin opens to read
 * complaints, not to debug the classifier.
 */
export async function classifyPending(limit = BATCH_LIMIT): Promise<number> {
  const pending = await prisma.problemReport.findMany({
    where: { sentiment: null },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { id: true, message: true },
  });
  if (pending.length === 0) return 0;

  const results = await Promise.all(
    pending.map((r) => runAgent<{ sentiment: "positive" | "negative"; summary: string }>(
      "classify_feedback",
      { message: r.message },
    )),
  );

  let classified = 0;
  await Promise.all(
    results.map(async (result, i) => {
      if (!result.ok) return;
      await prisma.problemReport
        .update({
          where: { id: pending[i].id },
          data: { sentiment: result.sentiment, summary: result.summary, classifiedAt: new Date() },
        })
        .then(() => {
          classified += 1;
        })
        .catch(() => {});
    }),
  );
  return classified;
}
