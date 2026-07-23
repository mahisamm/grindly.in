// Server-side mirror of agent/safety.py's apply policy.
//
// The agent decides what it is allowed to submit; this file exists so the web
// app can say the same thing to the user. When those two disagree the product
// lies — either it promises a submission that never happens, or it tells someone
// to go finish an application the agent already sent. Both are worse than the
// old behaviour of promising nothing.
//
// Keep the env var names and the tier semantics in lockstep with
// agent/safety.py (auto_apply_mode / tier_b_enabled / destination_policy) and
// agent/resolver.py (channels and tiers).

export const AUTO_APPLY_OFF = "off";
export const AUTO_APPLY_SHADOW = "shadow";
export const AUTO_APPLY_LIVE = "live";

export type AutoApplyMode =
  | typeof AUTO_APPLY_OFF
  | typeof AUTO_APPLY_SHADOW
  | typeof AUTO_APPLY_LIVE;

/** Channels the agent can actually DELIVER — i.e. an employer's own intake, where
 *  the candidate holds no account, AND a sender exists for it.
 *
 *  "ats" is deliberately absent. Greenhouse/Lever/Ashby pages resolve to Tier A
 *  correctly (no candidate account is involved, so submitting is safe), but no
 *  ATS sender is built yet. Listing it here would make the dashboard tell a user
 *  "the agent will submit this" about an application nothing can submit — which
 *  is the precise failure this whole file exists to prevent. Add "ats" the same
 *  day agent/worker.py gains an ATS module in _CHANNEL_MODULES, not before. */
export const EMPLOYER_CHANNELS = ["google_form", "email"] as const;

/** Fleet-wide auto-apply switch. Fails closed: anything unrecognised reads as
 *  shadow, never as live, so a typo in the environment cannot start sending
 *  applications under someone's name. */
export function autoApplyMode(): AutoApplyMode {
  const raw = (process.env.GRINDLY_AUTO_APPLY_MODE ?? AUTO_APPLY_SHADOW).trim().toLowerCase();
  if (raw === AUTO_APPLY_OFF || raw === AUTO_APPLY_LIVE) return raw;
  return AUTO_APPLY_SHADOW;
}

/** Tier B (hosted submit on a board the user gave credentials to) needs its own
 *  switch on top of live mode — turning Tier A on must never silently turn on
 *  the one path that can cost a user their account. */
export function tierBEnabled(): boolean {
  return process.env.GRINDLY_TIER_B_APPLY === "1";
}

type Routed = {
  applyChannel?: string | null;
  applyTier?: string | null;
  applyTarget?: string | null;
};

/** Is this application routed to an employer's own intake? */
export function isEmployerChannel(app: Routed): boolean {
  const channel = app.applyChannel ?? "";
  return (
    (EMPLOYER_CHANNELS as readonly string[]).includes(channel) &&
    !!(app.applyTarget ?? "")
  );
}

/** Will the agent actually send this one, with no further action from the user?
 *
 *  True only when the destination is an employer channel at Tier A *and* the
 *  fleet is in live mode. In shadow mode this is false for everything, which is
 *  why the default copy still says "you finish it" — because that is still what
 *  happens. */
export function agentWillSend(app: Routed): boolean {
  if (autoApplyMode() !== AUTO_APPLY_LIVE) return false;
  if (isEmployerChannel(app) && app.applyTier === "A") return true;
  if (app.applyTier === "B") return tierBEnabled();
  return false;
}

/** One sentence for the user about what happens after they approve. Written for
 *  a person mid-job-search, so it says who acts next and where. */
export function approvalOutcomeMessage(app: Routed): string {
  if (!agentWillSend(app)) {
    return "ready for your final browser submission";
  }
  if (app.applyChannel === "email") {
    return `the agent will email this application to ${app.applyTarget} from your Gmail`;
  }
  return "the agent will submit this to the company's own application form";
}
