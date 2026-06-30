// Feature gates for staged rollout on the live site.
//
// Internshala credential login is automation against a third party we can't fully
// guarantee (selectors, captcha, account-ban risk). We expose it to a chosen set
// of accounts first — admins, plus any email in INTERNSHALA_BETA_EMAILS (comma or
// whitespace separated) — and keep everyone else on a "rolling out" message until
// it's proven. Set INTERNSHALA_BETA_OPEN=1 to open it to all users at once.

function betaEmails(): Set<string> {
  return new Set(
    (process.env.INTERNSHALA_BETA_EMAILS || "")
      .split(/[\s,]+/)
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function internshalaLoginEnabled(user: { email: string; role?: string | null }): boolean {
  if (process.env.INTERNSHALA_BETA_OPEN === "1") return true;
  if (user.role === "admin") return true;
  return betaEmails().has((user.email || "").toLowerCase());
}
