// Human-gate detection: the difference between an assistant and a bot.
//
// Some things on an application page exist SPECIFICALLY to confirm a person is
// present — a CAPTCHA, a one-time code, a login wall, a payment step, a legal
// declaration. Grindly's answer to all of them is the same: stop, hand the page
// back to the user, and say why. Never solve one, never outsource one, never
// click past one.
//
// The other gate is honesty rather than policy: a required question we hold no
// approved answer for. Guessing there would put an invented fact in front of an
// employer under the user's name, so it stops too.

(function (root) {
  "use strict";

const CAPTCHA_MARKERS = [
  "iframe[src*='recaptcha']",
  "iframe[src*='hcaptcha']",
  "iframe[title*='challenge']",
  ".g-recaptcha",
  ".h-captcha",
  "#cf-challenge-running",
  "[data-sitekey]",
];

// Payment demands, stated the way a page that actually wants money states them.
//
// The previous single pattern was `(payment|pay|fee|subscribe|card details)`
// within 40 characters of `(required|to apply|continue)`, tested against the
// whole rendered page. On a real board that is almost a tautology: a stipend
// line ("Pay: ₹10,000/month") near a Continue button, or a course upsell
// mentioning a fee, matched it — and Internshala, which charges nothing to
// apply, had valid applications abandoned with reason "payment". A false gate is
// not a safe failure: it silently strands the application it was meant to
// protect, and the user is told the site asked for money when it did not.
//
// So each pattern now needs the DEMAND, not merely the vocabulary: a named fee
// asserted as required, or paying as the condition of applying. The fee-to-apply
// scam is still caught here (see the test), and it is caught twice more besides —
// agent/scam.py screens the listing before it is ever queued, and the executor
// cannot enter card details anyway, since it fills only from approved facts and
// stops on any required field it has no answer for.
const PAYMENT_PATTERNS = [
  /\b(?:application|registration|processing|admission|enrol?ment|training)\s+fees?\b[^.!?]{0,60}?\b(?:required|payable|mandatory|to\s+apply|before\s+(?:you\s+)?apply)\b/i,
  /\b(?:fee|payment|amount)\b[^.!?]{0,30}?\b(?:is\s+)?(?:required|mandatory|payable)\b[^.!?]{0,30}?\bto\s+(?:apply|continue|submit|proceed)\b/i,
  // "payment required", never bare "pay required" — the latter is how a form
  // asks what salary you want ("Expected pay required for this role").
  /\bpayment\s+(?:of\s+\S{1,12}\s+)?(?:is\s+)?(?:required|mandatory)\b/i,
  /\bpay\s+(?:now\s+)?to\s+(?:apply|continue|submit|proceed)\b/i,
  /\bcard\s+details?\b[^.!?]{0,40}?\b(?:required|to\s+(?:apply|continue|proceed))\b/i,
  /\bsubscribe\s+to\s+(?:apply|continue|proceed)\b/i,
];

// "There is no application fee to apply" says the opposite of what it matches.
// Only a negation in the SAME clause counts — bounded to a couple of words and
// stopped by any sentence break, so "No experience required. Application fee
// required to apply." is still correctly read as a demand.
const PAYMENT_NEGATION = /\b(?:no|not|never|without|zero|nil|free\s+of)\s+(?:\w+\s+){0,2}$/i;

function isNegatedPayment(text, index) {
  const before = text.slice(Math.max(0, index - 24), index);
  if (/[.!?]/.test(before)) return false;
  return PAYMENT_NEGATION.test(before);
}

const TEXT_GATES = [
  { re: /\b(one[- ]time (password|code)|otp|verification code)\b/i, reason: "otp" },
  { re: /\b(sign in|log in|login) to (continue|apply)\b/i, reason: "login" },
  ...PAYMENT_PATTERNS.map(function (re) { return { re: re, reason: "payment" }; }),
  { re: /\bi (certify|declare|affirm)\b/i, reason: "unknown_question" },
];

/** A visible login form is a login wall even when no text says so. */
function hasLoginForm(doc) {
  const pw = doc.querySelector("input[type='password']");
  return !!pw && pw.offsetParent !== null;
}

/**
 * Inspect a page. Returns a gate reason, or null when the extension may proceed.
 *
 * Runs BEFORE filling and again immediately before submitting: a challenge can
 * appear between those two moments, and submitting into one either fails or —
 * worse — succeeds in a way the user never agreed to.
 */
function detectHumanGate(doc = document) {
  return explainHumanGate(doc).reason;
}

/**
 * The same decision, plus the evidence for it: {reason, evidence}.
 *
 * A bare reason code turned out to be undebuggable in the field. Production
 * showed applications stopping with reason "payment" on a site that charges
 * nothing to apply, and nothing anywhere recorded WHICH text on the page said
 * so — the reason was unfalsifiable from the outside. `evidence` is the matched
 * fragment (site boilerplate, trimmed and stripped by the caller before it is
 * reported) so a wrong gate can be seen and fixed instead of guessed at.
 */
function explainHumanGate(doc = document) {
  for (const sel of CAPTCHA_MARKERS) {
    const el = doc.querySelector(sel);
    if (el) return { reason: "captcha", evidence: sel };
  }
  if (hasLoginForm(doc)) return { reason: "login", evidence: "visible password field" };

  // Only look at rendered text; a hidden template or a script tag mentioning
  // "OTP" is not a gate the user is actually facing.
  const text = (doc.body?.innerText || "").slice(0, 20000);
  for (const { re, reason } of TEXT_GATES) {
    const m = re.exec(text);
    if (!m) continue;
    if (reason === "payment" && isNegatedPayment(text, m.index)) continue;
    return { reason: reason, evidence: String(m[0]).slice(0, 120) };
  }
  return { reason: null, evidence: "" };
}

/**
 * Required fields that no approved fact answers.
 *
 * Returns their labels so the user is told WHICH question stopped the
 * application, rather than a vague "needs your input". An empty list means
 * every mandatory field was filled from something the user actually approved.
 */
function unansweredRequiredFields(doc = document) {
  const out = [];
  const fields = doc.querySelectorAll(
    "input[required], select[required], textarea[required], [aria-required='true']",
  );
  for (const el of fields) {
    if (el.type === "hidden" || el.offsetParent === null) continue;
    const filled =
      el.type === "checkbox" || el.type === "radio"
        ? el.checked
        : String(el.value ?? "").trim().length > 0;
    if (filled) continue;
    const label =
      el.getAttribute("aria-label") ||
      doc.querySelector(`label[for='${el.id}']`)?.innerText ||
      el.name ||
      el.placeholder ||
      "a required question";
    out.push(String(label).trim().slice(0, 80));
  }
  return out;
}

  root.GrindlyGate = {
    detectHumanGate: detectHumanGate,
    explainHumanGate: explainHumanGate,
    unansweredRequiredFields: unansweredRequiredFields,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
