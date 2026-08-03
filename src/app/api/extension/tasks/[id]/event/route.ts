import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authenticateExtension } from "@/lib/extensionAuth";
import { ownsTask, LEASE_MS, releaseDailySlot } from "@/lib/browserTasks";

// POST /api/extension/tasks/:id/event — the extension's only way to report.
//
// One endpoint for heartbeat, progress, human-gate and completion, because they
// are all the same thing: a claim about what happened, which the server decides
// whether to believe. The client never writes a state directly — it names an
// event, and the transition table below decides the resulting state. A client
// that could set `submitted` itself could inflate a user's application count.
export const dynamic = "force-dynamic";

/** event -> resulting task state. Anything not listed is rejected. */
const TRANSITIONS: Record<string, string> = {
  heartbeat: "filling",
  filling: "filling",
  awaiting_human: "awaiting_human",
  // Deliberately passed over, not blocked on. The page asked for money, an OTP,
  // or an account, and none of those are worth interrupting someone for — see
  // SKIP_GATES in the executor. Distinct from `awaiting_human` because nobody
  // is going to come back to it, and distinct from `failed` because nothing
  // went wrong: this is the agent declining a job on the user's behalf, which
  // the timeline should say plainly.
  skipped: "skipped",
  submitted: "submitted",
  failed: "failed",
};

/** Gate reasons we accept, so page text can never land in the database. */
const GATES = new Set(["captcha", "otp", "login", "unknown_question", "payment", "changed_form"]);

/**
 * Gates that PROVE nothing was submitted, so the reserved daily slot goes back.
 *
 * `changed_form` is deliberately absent: it means the extension clicked and the
 * page never confirmed, which is exactly the case where an application may have
 * landed. Handing that slot back would let the day's sixth application out
 * under a limit of five — the same reason the server-side sender never refunds
 * a needs_review.
 */
const PROVES_NO_SUBMIT = new Set(["captcha", "otp", "login", "unknown_question", "payment"]);

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authenticateExtension(req);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const leaseToken = String(body.leaseToken ?? "");
  const event = String(body.event ?? "");

  const task = await ownsTask(auth.userId, id, leaseToken);
  // A lost lease is not an error the extension should retry into: the task may
  // already have been reclaimed and be running in another tab.
  if (!task) return NextResponse.json({ error: "lease_lost" }, { status: 409 });

  const nextState = TRANSITIONS[event];
  if (!nextState) return NextResponse.json({ error: "unknown_event" }, { status: 400 });

  // Terminal states are terminal. Re-reporting one must not resurrect a task
  // or double-count an application.
  if (["submitted", "failed", "cancelled"].includes(task.state)) {
    return NextResponse.json({ ok: true, state: task.state, note: "already final" });
  }

  const data: Record<string, unknown> = {
    state: nextState,
    heartbeatAt: new Date(),
  };

  if (event === "heartbeat" || event === "filling") {
    data.leaseExpiresAt = new Date(Date.now() + LEASE_MS);
  }

  // Unrecognised reasons collapse to a safe label rather than storing whatever
  // string a page produced. Normalised ONCE, here, and every decision below
  // uses the normalised value — the release check used to test the raw string,
  // so a reason not in GATES displayed as "unknown_question" (a releasable
  // gate) while the slot stayed spent.
  const gate = GATES.has(String(body.reason ?? "")) ? String(body.reason) : "unknown_question";

  // Slots reserved at claim time come back only on a definite non-send.
  //
  // `skipped` always qualifies: the gate was seen before any submit button was
  // pressed, so nothing went out. Without this the day's allowance would drain
  // on jobs the agent deliberately declined — five skipped scams and a user on
  // the free tier has no applications left, having sent none.
  const releasable =
    event === "failed" || event === "skipped" ||
    (event === "awaiting_human" && PROVES_NO_SUBMIT.has(gate));
  if (releasable && task.reservedDate) {
    await releaseDailySlot(auth.userId, task.reservedDate);
    data.reservedDate = null;
  }

  if (event === "skipped") {
    data.blockedReason = gate;
    // No lease: nobody is coming back to this one.
    data.leaseTokenHash = null;
    data.leaseExpiresAt = null;
  }

  if (event === "awaiting_human") {
    data.blockedReason = gate;
    // The lease is released: the person now owns this page, and holding a lease
    // would let it expire into a retry while they are mid-CAPTCHA.
    data.leaseTokenHash = null;
    data.leaseExpiresAt = null;
  }

  if (event === "submitted") {
    // Proof only — an id or confirmation URL. Never page HTML, which would drag
    // personal data into a table that admin views read.
    data.receipt = String(body.receipt ?? "").slice(0, 500);
    data.leaseTokenHash = null;
    data.leaseExpiresAt = null;
  }

  if (event === "failed") {
    data.leaseTokenHash = null;
    data.leaseExpiresAt = null;
  }

  await prisma.browserTask.update({ where: { id: task.id }, data });

  // Mirror onto the application the user actually sees, and onto its timeline.
  // Only a real submission touches the application's status — that is what the
  // dashboard counts, and it must mean an employer received something.
  if (event === "submitted") {
    await prisma.application
      .update({
        where: { id: task.applicationId },
        data: {
          status: "applied",
          appliedAt: new Date(),
          reason: "Submitted by the agent in your own browser",
        },
      })
      .catch(() => {});
  }
  await prisma.applicationEvent
    .create({
      data: {
        applicationId: task.applicationId,
        type: event,
        actor: "extension",
        meta: JSON.stringify({
          host: task.host,
          reason: data.blockedReason ?? null,
          // A button label, and only a button label: stripped to plain
          // characters and cut to 40, so no amount of page text can ride in
          // here. It exists because "which button did it press?" could not be
          // answered from outside the browser, and that was the whole bug.
          detail: String(body.detail ?? "").replace(/[^\w .,'&-]/g, "").slice(0, 40) || null,
        }),
      },
    })
    .catch(() => {});

  return NextResponse.json({ ok: true, state: nextState });
}
