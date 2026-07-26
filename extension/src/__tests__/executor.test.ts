import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// executor.js is the code that runs inside a user's own browser on a real
// employer's application form. It cannot be exercised end to end without a live
// page, so these tests pin the promises that must never quietly regress — each
// one is a rule about what the extension will NOT do.

const SRC = fs.readFileSync(
  path.resolve(__dirname, "..", "content", "executor.js"), "utf8",
);
const BG = fs.readFileSync(path.resolve(__dirname, "..", "background.js"), "utf8");

describe("the executor's safety rules", () => {
  it("checks for a human gate twice — before filling and before submitting", () => {
    // A challenge can appear between those two moments. Submitting into one
    // either fails or, worse, succeeds in a way the user never agreed to.
    const checks = SRC.match(/detectHumanGate\(/g) ?? [];
    expect(checks.length).toBeGreaterThanOrEqual(2);
  });

  it("refuses to act on a page outside the task's host", () => {
    // A leaked lease must not be usable to drive someone's browser elsewhere.
    expect(SRC).toMatch(/onTaskHost/);
    expect(SRC).toMatch(/if \(!onTaskHost\(\)\) return/);
  });

  it("stops rather than submitting when a required question is unanswered", () => {
    // Guessing would put an invented claim in front of an employer under the
    // user's name.
    const gateIdx = SRC.indexOf("unansweredRequiredFields");
    const submitIdx = SRC.indexOf("submit.click()");
    expect(gateIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeLessThan(submitIdx);
  });

  it("never wires up a captcha-solving service", () => {
    // Matches real bypass mechanisms, not the word "solve" in a comment — the
    // file's own doc block says it never solves one, and that sentence should
    // not be what makes this test pass or fail.
    expect(SRC).not.toMatch(
      /2captcha|anti-?captcha|capmonster|deathbycaptcha|solveRecaptcha|g-recaptcha-response\s*=/i,
    );
  });

  it("only reports 'submitted' after the page confirms it", () => {
    // Clicking is not proof. A count the user cannot trust is worse than none.
    const confirmIdx = SRC.indexOf("confirmed");
    const reportIdx = SRC.indexOf('report("submitted"');
    expect(confirmIdx).toBeGreaterThan(-1);
    expect(confirmIdx).toBeLessThan(reportIdx);
  });

  it("treats an unconfirmed submit as needing a human, not as success", () => {
    expect(SRC).toMatch(/did not confirm/i);
    expect(SRC).toMatch(/awaiting_human/);
  });

  it("shows the user a visible banner while acting in their browser", () => {
    // They must always be able to see what is happening in their own tab.
    expect(SRC).toMatch(/grindly-autopilot-banner/);
  });
});

describe("the background worker's boundaries", () => {
  it("keeps the extension token out of content scripts", () => {
    // A hostile page that compromised a content script still must not be able
    // to claim tasks or report submissions.
    expect(BG).toMatch(/sender\.tab \? \{ error: "forbidden" \}/);
  });

  it("refuses to let a page turn autopilot on", () => {
    expect(BG).toMatch(/case "grindly:autopilot":[\s\S]*?if \(sender\.tab\)/);
  });

  it("never sends a state, only an event", () => {
    // The server's transition table decides what an event means. A client that
    // could set "submitted" itself could inflate someone's application count.
    expect(BG).toMatch(/event,/);
    expect(BG).not.toMatch(/state:\s*["']submitted["']/);
  });

  it("claims one task at a time", () => {
    // A browser opening five application tabs at once is alarming to watch and
    // trivially mistaken for a bot.
    expect(BG).toMatch(/if \(active\) return/);
  });

  it("leaves an in-flight task alone when autopilot is switched off", () => {
    // Its lease expires on its own, and the server only requeues it after
    // confirming it never submitted.
    expect(BG).toMatch(/Leave any in-flight task alone/);
  });
});

describe("the popup exposes the engine it drives", () => {
  const HTML = fs.readFileSync(
    path.resolve(__dirname, "..", "popup", "popup.html"), "utf8",
  );
  const JS = fs.readFileSync(
    path.resolve(__dirname, "..", "popup", "popup.js"), "utf8",
  );

  it("has an Autopilot switch", () => {
    // The background worker, the task APIs and the executor all shipped while
    // the popup had no way to turn any of it on. A live test found the entire
    // feature unreachable: an engine with no ignition.
    expect(HTML).toMatch(/id="autoSw"/);
    expect(HTML).toMatch(/Autopilot/);
    expect(JS).toMatch(/grindly:autopilot/);
  });

  it("hides the switch until an account is connected", () => {
    // A toggle that can claim no tasks is worse than no toggle.
    expect(JS).toMatch(/autoBox"\)\.style\.display = connected/);
  });

  it("stops promising 'you always click Submit yourself' once autopilot is on", () => {
    // That sentence is simply false with autopilot running, and a promise the
    // product breaks is worse than one it never made.
    expect(JS).toMatch(/always click Submit yourself/);
    expect(JS).toMatch(/main\.textContent = on/);
  });

  it("says what autopilot will NOT do, next to the switch", () => {
    // Consequences described on another page are consequences nobody reads.
    expect(JS).toMatch(/stops and asks you at any CAPTCHA/i);
  });
});

describe("autopilot actually starts when you switch it on", () => {
  it("acts on the click instead of waiting for the first timer", () => {
    // periodInMinutes alone does not fire until a whole period has passed, so
    // turning Autopilot on did nothing for five minutes — indistinguishable
    // from broken, and read that way by a live test twice in a row.
    expect(BG).toMatch(/delayInMinutes: 0\.1/);
    // Assert the behaviour, not the byte layout: setAutopilot must kick a tick
    // itself. Pinning the exact gap between two lines breaks on a comment edit
    // and says nothing about whether autopilot actually starts.
    const body = BG.slice(
      BG.indexOf("async function setAutopilot"),
      BG.indexOf("async function tick"),
    );
    expect(body).toMatch(/\btick\(\);/);
  });

  it("re-arms after a browser restart", () => {
    // A service worker is evicted when idle. Without this, autopilot silently
    // stops after the first suspension and never tells anyone.
    expect(BG).toMatch(/onStartup/);
    expect(BG).toMatch(/onInstalled/);
  });

  it("records WHY it did nothing", () => {
    // "On" alone cannot distinguish idle from broken — the exact reason this
    // feature could not be diagnosed from outside the browser.
    expect(BG).toMatch(/setStatus/);
    expect(BG).toMatch(/no_work|not_ready|executor_disabled/);
  });

  it("offers a manual check so nobody waits on a timer to learn it works", () => {
    expect(BG).toMatch(/grindly:runNow/);
  });
});

describe("confirming a submission", () => {
  it("treats the form disappearing as the site's confirmation", () => {
    // On Internshala the modal closing IS the success signal — there is often
    // no "thank you" text anywhere. A live run clicked Submit, found no such
    // text within 2.5s, and reported "sent but not confirmed" for what had very
    // likely succeeded: safe, but it leaves the user checking by hand every
    // time and makes a working feature look broken.
    expect(SRC).toMatch(/document\.body\.contains\(formEl\)/);
    expect(SRC).toMatch(/buttonGone/);
  });

  it("picks the send button by score, not by whichever comes first", () => {
    // A first-match scan pressed the listing page's "Apply now" sitting behind
    // the apply modal, which just re-opened the modal. See submitTarget.js.
    expect(SRC).toMatch(/window\.GrindlySubmit/);
    expect(SRC).toMatch(/picker\.pick\(document\)/);
    expect(SRC).not.toMatch(/\^\(submit\|apply\|/);
  });

  it("reads the kit in the shape the fill engine actually parses", () => {
    // It was handed the claim endpoint's flat profile, which has no `.profile`
    // key at all, so every run filled nothing and then blamed the form.
    expect(SRC).toMatch(/task\.kit \|\| \{\}/);
    expect(SRC).not.toMatch(/task\.profile \|\| \{\}/);
  });

  it("says so when only half the extension has been reloaded", () => {
    // An old bundle claims tasks perfectly well and then behaves like the
    // version that pressed the wrong button — the one failure mode that looks
    // exactly like a broken website.
    expect(SRC).toMatch(/!window\.GrindlySubmit \|\| !window\.GrindlyFill/);
    expect(SRC).toMatch(/needs a reload/i);
  });

  it("names the button it pressed when the site says nothing", () => {
    // Without this the failure is undiagnosable from a screenshot — which is
    // exactly how the wrong-button bug survived a live run.
    expect(SRC).toMatch(/const pressed =/);
    expect(SRC).toMatch(/Grindly pressed/);
  });

  it("waits long enough for a real site to respond", () => {
    expect(SRC).toMatch(/waited < 12000/);
  });

  it("still refuses to claim success it cannot see", () => {
    // The whole point survives: no confirmation, no "submitted".
    expect(SRC).toMatch(/let confirmed = false/);
    expect(SRC).toMatch(/did not confirm/i);
  });
});
