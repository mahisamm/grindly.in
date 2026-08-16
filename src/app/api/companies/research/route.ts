import { NextResponse } from "next/server";
import { requireUser, badRequest, serverError } from "@/lib/auth";
import { runAgent, type CompanyResearch } from "@/lib/agent";
import { isRateLimited } from "@/lib/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Two model calls behind this, and a cold Python start in front of them.
export const maxDuration = 120;

/**
 * Look up a company that has no curated pack.
 *
 * Returns one of three answers and the UI renders each differently — see
 * agent/company_research.py, where the interesting work is the decision to
 * decline:
 *
 *   curated       we have a hand-checked pack with citations
 *   generated     a model's summary, labelled as such, no citations
 *   not_required  we know nothing specific about how this employer screens,
 *                 which is the honest answer for most companies
 *
 * This is a LOOKUP, not a commit: nothing is written, no target slot is taken
 * and no quota is spent. The user sees what tailoring would mean before
 * deciding whether to spend a run on it — which also means "not_required" costs
 * them nothing at all, and it should not, because it is us telling them we
 * cannot help rather than them asking for something they did not get.
 */
export async function POST(req: Request) {
  const auth = await requireUser();
  if ("error" in auth) return auth.error;
  const { user } = auth;

  let body: { name?: string; role?: string } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return badRequest("Send a company name.");
  }

  const name = String(body.name ?? "").trim();
  if (name.length < 2) return badRequest("Type at least two characters.");
  if (name.length > 80) return badRequest("That does not look like a company name.");

  // Keyed to the ACCOUNT, not the IP. A lookup is only available to a signed-in
  // user, so the account is the identity that matters, and an IP bucket would
  // punish everyone behind one college NAT for each other's typing.
  if (await isRateLimited(`research:${user.id}`, 30, 60 * 60 * 1000)) {
    return NextResponse.json(
      { error: "That is a lot of company lookups in an hour. Try again later." },
      { status: 429 },
    );
  }

  const result = await runAgent<CompanyResearch>("research", {
    name,
    role: String(body.role ?? "").slice(0, 120),
  });
  if (!result.ok) return serverError(result.error);
  return NextResponse.json(result);
}
