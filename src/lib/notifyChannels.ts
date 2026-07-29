/**
 * Which report channels this deploy can actually deliver on.
 *
 * The web side of agent/notify.py. The worker already knows the truth — it
 * checks EMAIL_SMTP_* and SLACK_BOT_TOKEN before every send and falls back to
 * the in-app bell when neither answers — but the setup screen did not, so it
 * offered "Daily reports go to your registered email automatically" on an
 * install with no mail server configured. The report was never lost (the bell
 * always works), but the user was told to watch an inbox that would stay empty,
 * which is indistinguishable from an agent that did nothing.
 *
 * Keep the environment variable names in step with agent/email_notify.py and
 * agent/notify.py — the two processes read the same container environment, so a
 * rename in one that misses the other silently re-opens exactly this gap.
 */

function set(name: string): boolean {
  return Boolean((process.env[name] || "").trim());
}

/** SMTP configured well enough for agent/email_notify.py to attempt a send. */
export function emailConfigured(): boolean {
  return set("EMAIL_SMTP_HOST") && set("EMAIL_SMTP_USER") && set("EMAIL_SMTP_PASS");
}

export function slackConfigured(): boolean {
  return set("SLACK_BOT_TOKEN");
}

export type NotifyChannels = {
  email: boolean;
  slack: boolean;
  /** Always true: the in-app bell needs no configuration and cannot be unreachable. */
  inApp: true;
};

export function notifyChannels(): NotifyChannels {
  return { email: emailConfigured(), slack: slackConfigured(), inApp: true };
}
