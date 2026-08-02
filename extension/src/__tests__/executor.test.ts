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
    // Either entry point counts — explainHumanGate is detectHumanGate plus the
    // evidence for its answer, and matching both keeps this asserting the safety
    // property rather than one function's current name.
    const checks = SRC.match(/(?:detect|explain)HumanGate\(/g) ?? [];
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
  it("is permitted to execute a leased job on an employer HTTPS domain", () => {
    // Web search intentionally finds employer-owned career pages, not only the
    // five original job boards. The per-task host lock in executor.js is the
    // security boundary; a static board-only manifest would strand every such
    // task before the executor could enforce that lock.
    const manifest = JSON.parse(fs.readFileSync(
      path.resolve(__dirname, "..", "..", "manifest.json"), "utf8",
    ));
    expect(manifest.host_permissions).toContain("https://*/*");
    expect(manifest.content_scripts[1].matches).toContain("https://*/*");
  });

  it("does not ship a package that disagrees with the source manifest", () => {
    // The test above proves the SOURCE manifest is right. It says nothing about
    // the artifact a user actually installs, and those drifted: widening
    // host_permissions to https://*/* never triggered a rebuild, so the built
    // package kept a five-board allowlist — and kept the SAME version string,
    // making a stale install indistinguishable from a current one. Tasks on an
    // employer-hosted page were claimed, the tab opened, and the executor was
    // never injected, so the lease just expired.
    //
    // dist/ is a build output and is not in git; when it is absent there is
    // nothing to contradict and nothing to check.
    const pkgManifest = path.resolve(__dirname, "..", "..", "dist", "pkg", "manifest.json");
    if (!fs.existsSync(pkgManifest)) return;
    const src = JSON.parse(fs.readFileSync(
      path.resolve(__dirname, "..", "..", "manifest.json"), "utf8",
    ));
    const built = JSON.parse(fs.readFileSync(pkgManifest, "utf8"));
    expect(built.version, "packaged build is stale — run `node extension/build.mjs`")
      .toBe(src.version);
    expect(built.host_permissions, "packaged host_permissions drifted from source")
      .toEqual(src.host_permissions);
    expect(
      built.content_scripts?.map((c: { matches: string[] }) => c.matches),
      "packaged content_script matches drifted from source",
    ).toEqual(src.content_scripts?.map((c: { matches: string[] }) => c.matches));
  });

  it("closes its own tab when a task ends, and only then", () => {
    // Autopilot opened the tab; autopilot cleans it up. A day at the cap used
    // to leave five submitted-application tabs (plus every human gate) crowding
    // the strip. awaiting_human must NOT close: that page is now the user's to
    // finish, and yanking it would take their CAPTCHA or question with it.
    const closer = BG.match(/if \(\s*\(msg\.event === "submitted" \|\| msg\.event === "failed"\)[\s\S]{0,600}?chrome\.tabs\.remove/);
    expect(closer, "terminal task events must close the task's own tab").toBeTruthy();
    expect(closer![0]).not.toMatch(/awaiting_human/);
    // Scoped to the reporting tab — never a lookup that could hit another tab.
    expect(closer![0]).toMatch(/sender\.tab/);
  });

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
    // trivially mistaken for a bot. A live task stops the next claim — only an
    // expired lease lets the loop move on, and by then the server has already
    // returned that task to its queue.
    const tick = BG.slice(BG.indexOf("async function tick"), BG.indexOf("chrome.alarms.onAlarm"));
    expect(tick).toMatch(/if \(!expired\) \{[\s\S]*?return;/);
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

  it("takes the next task as soon as one finishes", () => {
    // Idling until the next alarm meant five minutes between applications, so
    // autopilot appeared to work only when the user pressed the button.
    expect(BG).toMatch(/scheduleNextTick\(\)/);
    const report = BG.slice(BG.indexOf("async function reportTask"), BG.indexOf("const CHAIN_DELAY_MS"));
    expect(report).toMatch(/scheduleNextTick\(\)/);
  });

  it("does not chain instantly, so a queue of failures cannot spin", () => {
    expect(BG).toMatch(/CHAIN_DELAY_MS = \d{4}/);
  });

  it("clears a task whose lease died with the tab", () => {
    // A tab closed mid-application never reports, and that record would sit in
    // storage forever, silently blocking every future tick.
    expect(BG).toMatch(/leaseExpiresAt.*<.*new Date\(\)/);
    const tick = BG.slice(BG.indexOf("async function tick"), BG.indexOf("chrome.alarms.onAlarm"));
    expect(tick).toMatch(/storage\.local\.remove\(TASK_STATE_KEY\)/);
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

  it("opens the form before looking for the button that sends it", () => {
    // An Internshala listing has no form until "Apply now" is pressed. The
    // executor pressed that as if it were Submit, the modal opened, and it then
    // waited for a confirmation that could never come — on every single task.
    expect(SRC).toMatch(/waitForSender/);
    expect(SRC).toMatch(/isSender\(submit\)/);
    const openIdx = SRC.indexOf("opening the application form");
    const clickIdx = SRC.indexOf("submit.click()");
    expect(openIdx).toBeGreaterThan(-1);
    expect(openIdx).toBeLessThan(clickIdx);
  });

  it("fills again after the form appears", () => {
    // The fields arrive with the modal. Filling only before it opened meant
    // filling a page that had no form on it.
    //
    // Asserted on the CALL, not the exact expression. Filling is a round trip
    // to the server now — the modal is a different form with different
    // questions, so it gets its own plan rather than a replay of the one for
    // the page underneath — and the previous `filled += fillNow()` shape could
    // not survive that.
    const body = SRC.slice(SRC.indexOf("waitForSender()"), SRC.indexOf("unansweredRequiredFields"));
    expect(body).toMatch(/await fillNow\(\)/);
    expect(body).toMatch(/filled \+=/);
  });

  it("never presses an opener as though it were a send button", () => {
    // If the form never appeared, the honest report is that nothing was sent.
    expect(SRC).toMatch(/if \(!submit \|\| !window\.GrindlySubmit\.isSender\(submit\)\)/);
  });

  it("re-checks for a human gate on the form that just appeared", () => {
    // A CAPTCHA inside the modal did not exist when the first check ran.
    const body = SRC.slice(SRC.indexOf("waitForSender()"), SRC.indexOf("unansweredRequiredFields"));
    expect(body).toMatch(/(?:detect|explain)HumanGate\(document\)/);
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
