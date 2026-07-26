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

const TEXT_GATES = [
  { re: /\b(one[- ]time (password|code)|otp|verification code)\b/i, reason: "otp" },
  { re: /\b(sign in|log in|login) to (continue|apply)\b/i, reason: "login" },
  { re: /\b(payment|pay|fee|subscribe|card details)\b.{0,40}\b(required|to apply|continue)\b/i, reason: "payment" },
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
  for (const sel of CAPTCHA_MARKERS) {
    const el = doc.querySelector(sel);
    if (el) return "captcha";
  }
  if (hasLoginForm(doc)) return "login";

  // Only look at rendered text; a hidden template or a script tag mentioning
  // "OTP" is not a gate the user is actually facing.
  const text = (doc.body?.innerText || "").slice(0, 20000);
  for (const { re, reason } of TEXT_GATES) {
    if (re.test(text)) return reason;
  }
  return null;
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
    unansweredRequiredFields: unansweredRequiredFields,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
