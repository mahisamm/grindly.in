/*
 * Grindly autopilot executor — runs an application in the user's OWN browser.
 *
 * This exists so a board application can be completed without our servers ever
 * holding the user's session. Everything here happens in their tab, signed in
 * as themselves. The server hands out a leased task; this script fills the form
 * from facts the user approved, and stops the moment the page asks for a human.
 *
 * Three rules it will not break:
 *   1. It never solves, outsources or clicks past a CAPTCHA / OTP / login /
 *      payment / legal declaration. Those exist to confirm a person is present.
 *      It hands the page back and says why.
 *   2. It never submits with a required question unanswered from approved
 *      facts. Guessing would put an invented claim in front of an employer
 *      under the user's name.
 *   3. It never navigates off the task's host. A leaked lease must not be able
 *      to drive someone's browser somewhere else.
 *
 * The gate check runs BEFORE filling and AGAIN immediately before submitting,
 * because a challenge can appear between those two moments.
 */
(function () {
  "use strict";

  const HEARTBEAT_MS = 30000;
  // Give a slow page time to settle before deciding it has no form.
  const SETTLE_MS = 1500;

  // Autopilot opens its tabs in the background, so NOBODY IS LOOKING AT THIS
  // PAGE. That is the normal case here, not the edge case, and Chrome treats a
  // hidden tab very differently: chained setTimeouts are clamped to one per
  // second, and once the tab has been hidden five minutes, to one per MINUTE.
  //
  // Every wait in here used to count the delay it ASKED for — `waited += 300`
  // — instead of the time that actually passed. Under that clamp each 300ms
  // step really takes 60s, so an "8 second" wait ran for twenty-seven minutes,
  // while the heartbeat below faithfully renewed the lease the whole time. The
  // task never finished, never failed, and never released the one task slot, so
  // autopilot stopped dead and the popup said "Working on an application…"
  // forever. It only ever appeared to work when someone had the tab in front of
  // them, which is exactly the condition that kept the timers running at speed.
  //
  // So: every deadline below is wall-clock, and waiting is driven by a
  // MutationObserver, which is NOT throttled. A submit button appearing or a
  // form vanishing is a DOM change, so we hear about it at once even when the
  // page's timers have been cut to one tick a minute.
  //
  // RUN_DEADLINE_MS is the backstop for everything else. It sits well inside
  // the server's ten-minute lease so that a run which somehow stalls anyway
  // gives the page back to the user instead of holding the slot until the
  // reaper takes it.
  const RUN_DEADLINE_MS = 4 * 60000;
  const runStartedAt = Date.now();
  const runLeftMs = () => RUN_DEADLINE_MS - (Date.now() - runStartedAt);
  /** Never wait longer than the run has left. */
  const budget = (want) => Math.max(0, Math.min(want, runLeftMs()));

  // Gates worth interrupting a person for, and gates that are simply not.
  //
  // A CAPTCHA is one glance and a few keystrokes, and it is the whole reason
  // this runs in the user's own browser rather than on a server: the check asks
  // whether a human is present, and one is. It stops and asks.
  //
  // These three never do. A job application that asks for money is a scam, not
  // an opportunity — agent/scam.py already screens for it and this is the last
  // line. An OTP or a login wall means the site wants an account before it will
  // take an application, which is a different decision than "apply to this
  // job", and not one to make on someone's behalf at 2am. Interrupting for any
  // of them spends the scarcest thing the product has — the user's willingness
  // to be interrupted — on an application that should not be sent anyway.
  //
  // Skipped tasks close their tab, raise no notification, and hand their
  // reserved daily slot back, so the run simply moves on to the next job.
  const SKIP_GATES = new Set(["payment", "otp", "login"]);

  let task = null;
  let heartbeat = null;

  /**
   * Wait until `test()` returns something truthy; resolve null at the deadline.
   *
   * The observer is the real signal and the interval is only a backstop — for a
   * change the observer cannot see (a value written by script, an element whose
   * visibility changed through a stylesheet) and for noticing the deadline on a
   * page that has gone completely still. The backstop being throttled is fine;
   * being throttled is precisely why it is not the primary path.
   */
  function waitFor(test, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        obs.disconnect();
        clearInterval(poll);
        resolve(v);
      };
      const check = () => {
        let v = null;
        try { v = test(); } catch { v = null; }
        if (v) return finish(v);
        if (Date.now() >= deadline) finish(null);
      };
      // Watches everything, and checks on every batch without coalescing. A
      // busy page can produce a lot of those, but the observer hands them over
      // in batches rather than one at a time, and this runs for seconds, not
      // for the life of the tab. Rate-limiting it would mean a change arriving
      // just after a check could be missed until the next tick — and on a page
      // that then goes still, in a tab whose timers are down to one a minute,
      // "the next tick" can fall past the deadline. Missing the send button is
      // the expensive failure here; a few hundred DOM queries is not.
      const obs = new MutationObserver(check);
      obs.observe(document.documentElement, {
        childList: true, subtree: true, attributes: true, characterData: true,
      });
      const poll = setInterval(check, 300);
      check();
    });
  }

  const send = (msg) =>
    new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));

  function report(event, extra) {
    if (!task) return Promise.resolve(null);
    return send({
      type: "grindly:taskEvent",
      taskId: task.id,
      leaseToken: task.leaseToken,
      event,
      extra,
    });
  }

  function stopHeartbeat() {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
  }

  /** A visible banner. The user must always be able to see what is happening in
   *  their own browser, and to stop it. */
  function banner(text, kind) {
    let el = document.getElementById("grindly-autopilot-banner");
    if (!el) {
      el = document.createElement("div");
      el.id = "grindly-autopilot-banner";
      el.style.cssText =
        "position:fixed;z-index:2147483647;top:12px;right:12px;max-width:340px;" +
        "padding:12px 14px;border-radius:12px;font:14px/1.45 system-ui,sans-serif;" +
        "box-shadow:0 8px 30px rgba(0,0,0,.18);color:#fff";
      document.documentElement.appendChild(el);
    }
    el.style.background =
      kind === "gate" ? "#b45309" : kind === "done" ? "#15803d" : "#4338ca";
    el.textContent = text;
    return el;
  }

  /** Everything the task must not do to a page it does not own. */
  function onTaskHost() {
    try {
      return location.hostname.endsWith(task.host);
    } catch {
      return false;
    }
  }

  // Choosing the send button is its own problem — see submitTarget.js. The first
  // visible label match is NOT good enough: the listing page behind an apply
  // modal has its own "Apply now", earlier in the DOM, and pressing it just
  // re-opens the modal.
  function findSubmit() {
    const picker = window.GrindlySubmit;
    if (!picker) return null;
    return picker.pick(document);
  }

  /**
   * Wait for a real send button to appear after opening the form.
   *
   * The modal is rendered asynchronously, so the button does not exist the
   * instant the opener is clicked. Returns whatever the page ends up offering —
   * including nothing, which the caller must treat as "no submission happened".
   */
  async function waitForSender(timeoutMs = 8000) {
    const found = await waitFor(() => {
      const el = findSubmit();
      return el && window.GrindlySubmit.isSender(el) ? el : null;
    }, budget(timeoutMs));
    // Whatever the page ended up offering, even if it never became a real
    // sender — the caller decides what that means.
    return found || findSubmit();
  }

  /**
   * Report a gate and end the run. Returns true if there was one.
   *
   * One place, because this decision is made at three separate moments — before
   * filling, on the modal that just opened, and again immediately before
   * submitting — and a policy that lives in three copies is a policy that ends
   * up meaning three different things.
   */
  async function stopAtGate(g, where) {
    if (!g.reason) return false;
    stopHeartbeat();
    if (SKIP_GATES.has(g.reason)) {
      banner(`Grindly skipped this one: it asks for ${g.reason}. Moving on.`, "gate");
      await report("skipped", { reason: g.reason, detail: g.evidence });
      return true;
    }
    banner(
      `Grindly stopped${where ? ` ${where}` : ""}: this page needs you (${g.reason}). ` +
      "Finish it and Grindly will carry on.",
      "gate",
    );
    await report("awaiting_human", { reason: g.reason, detail: g.evidence });
    return true;
  }

  async function run() {
    task = await send({ type: "grindly:activeTask" });
    if (!task || !task.url) return;
    if (!onTaskHost()) return; // not the page this task is for

    const gates = window.GrindlyGate;
    if (!gates) return; // humanGate.js not present — do nothing rather than guess

    // A half-loaded extension is the one failure that looks exactly like a
    // broken website: the old bundle claims tasks fine, then behaves like the
    // version that pressed the wrong button. Say which it is.
    if (!window.GrindlySubmit || !window.GrindlyFill) {
      banner("Grindly needs a reload — open chrome://extensions and reload it.", "gate");
      await report("failed", { reason: "fill_error" });
      return;
    }

    banner("Grindly is filling this application…", "work");
    heartbeat = setInterval(() => report("heartbeat"), HEARTBEAT_MS);
    await report("filling");

    await new Promise((r) => setTimeout(r, SETTLE_MS));

    // 1. Gate check before touching anything.
    //
    // `detail` carries the page text that triggered the gate. Without it a wrong
    // gate is unfalsifiable from the server side: production stopped real
    // applications with reason "payment" on a board that charges nothing to
    // apply, and nothing recorded which words said otherwise.
    // A gate found BEFORE anything is filled.
    //
    // Skip-gates stop right here and touch nothing. On a login wall the fields
    // in front of us ARE the login form, and typing application answers into
    // it would be both useless and alarming.
    //
    // A CAPTCHA is the opposite case, and getting this backwards made the
    // feature worthless on its first real run: nine tasks executed, every one
    // stopped at this line, and the server that decides the answers was never
    // called once. The user got eight open tabs containing EMPTY forms. They
    // still had to solve the CAPTCHA — and then fill the entire application by
    // hand, which is the whole product.
    //
    // Filling is not submitting. The rule is that we never SEND into a gate,
    // and that still holds: the pre-submit check below is what enforces it. So
    // note the CAPTCHA, fill everything we can answer honestly, and hand back a
    // form that needs one CAPTCHA and one click.
    let g = gates.explainHumanGate(document);
    if (g.reason && SKIP_GATES.has(g.reason)) {
      await stopAtGate(g);
      return;
    }
    let gateOnArrival = g.reason;

    // 2. Fill from approved facts only.
    // The kit shape fillEngine reads: { profile:{name,…}, answers, coverLetter }.
    // It used to be handed the claim endpoint's flat profile, which has no
    // `.profile` key at all — so every autopilot run filled exactly nothing and
    // then reported that the form asked something it could not answer.
    const kit = task.kit || {};
    let filled = 0;
    let serverRefusals = [];

    // Ask the SERVER what to type.
    //
    // The extension's own logic is four regexes — phone, email, CGPA, name —
    // and until today it could not read a <select> at all, so "Gender *" was
    // invisible to it and that one required dropdown blocked every Keka
    // application. The server holds the engine that knows gender, school,
    // degree, years of experience, notice period, option fitting, and the
    // refusals that stop it inventing a fact about the candidate. Reimplementing
    // that here would mean rediscovering every one of its bugs a second time.
    //
    // So: this reads the page, the server decides, this types the answer back.
    // Falls back to the local engine only when the server cannot be reached —
    // a student's application should not stall because our API had a bad
    // minute, and the local path still refuses to invent anything.
    const fillNow = () => {
      const fields = window.GrindlyFill.readFields(document.body, document);
      if (!fields.length) return { filled: 0, unanswered: [] };
      return send({
        type: "grindly:fillPlan",
        fields: window.GrindlyFill.serializeFields(fields),
        job: { title: task.jobTitle || "", company: task.company || "" },
        coverLetter: kit.coverLetter || "",
      }).then((plan) => {
        if (!plan || plan.error || !Array.isArray(plan.fills)) {
          const local = window.GrindlyFill.applyFills(document.body, kit, document);
          return { filled: local.filled, unanswered: [], local: true };
        }
        const out = window.GrindlyFill.applyPlan(fields, plan);
        return { filled: out.filled, unanswered: out.unanswered || [] };
      });
    };

    try {
      const result = await fillNow();
      filled = result.filled;
      serverRefusals = result.unanswered || [];
    } catch {
      stopHeartbeat();
      await report("failed", { reason: "fill_error" });
      banner("Grindly could not fill this form. Left it untouched for you.", "gate");
      return;
    }

    // A required question the server would not answer stops this here, before
    // any submit button is looked for. It refused because answering honestly
    // was impossible — the fact is not on file — and sending anyway would put a
    // guess in front of an employer under the user's name.
    if (serverRefusals.length) {
      const asked = serverRefusals.map((u) => u.label).filter(Boolean).slice(0, 3);
      stopHeartbeat();
      // `awaiting_human` / `unknown_question`, not an event of its own. This IS
      // the existing meaning — the form asks something we cannot answer
      // honestly, so a person has to finish it — and the server already knows
      // that one proves nothing was submitted, so it hands the reserved daily
      // slot back. A "blocked" event would have been rejected as unknown, which
      // is worse than useless: the task would sit in `filling` until its lease
      // expired and the reaper would hand the same unanswerable form straight
      // back to autopilot, forever.
      await report("awaiting_human", { reason: "unknown_question", detail: asked.join("; ") });
      banner(
        "Grindly filled what it could. This form asks for something it does not " +
        "have about you: " + (asked.join("; ") || "a required answer") +
        ". Add it in your profile and it will finish this itself.",
        "gate",
      );
      return;
    }

    // 3. Open the form, if the page is only offering to open one.
    //
    // An Internshala listing has NO application form until "Apply now" is
    // pressed — the form lives in a modal that does not exist yet. Treating that
    // button as the send button meant pressing it, watching the modal open, and
    // then waiting twelve seconds for a confirmation that could never arrive.
    // Every task did this, and every one of them reported "sent but not
    // confirmed" about an application that had not been started.
    let submit = findSubmit();
    if (submit && !window.GrindlySubmit.isSender(submit)) {
      banner("Grindly is opening the application form…", "work");
      // Named apart from the send click on purpose: opening a form and sending
      // one are different acts, and only the second is a submission.
      const opener = submit;
      opener.click();
      submit = await waitForSender();
      if (submit) {
        // The form that just appeared is a new form: re-check for a gate, and
        // fill the fields it brought with it.
        // Same rule as on arrival: a skip-gate stops untouched, a CAPTCHA gets
        // noted and the modal still gets filled. Stopping here would hand back
        // an empty modal — the exact form the user came to have filled.
        g = gates.explainHumanGate(document);
        if (g.reason && SKIP_GATES.has(g.reason)) {
          await stopAtGate(g);
          return;
        }
        if (g.reason) gateOnArrival = g.reason;
        try {
          // The modal that just opened is a different form with different
          // questions, so it gets its own trip to the server rather than a
          // replay of the plan for the page underneath it.
          const more = await fillNow();
          filled += more.filled;
          serverRefusals = more.unanswered || [];
        } catch {
          stopHeartbeat();
          await report("failed", { reason: "fill_error" });
          banner("Grindly could not fill this form. Left it untouched for you.", "gate");
          return;
        }
        if (serverRefusals.length) {
          const asked = serverRefusals.map((u) => u.label).filter(Boolean).slice(0, 3);
          stopHeartbeat();
          await report("awaiting_human", { reason: "unknown_question", detail: asked.join("; ") });
          banner(
            "Grindly filled what it could. This form asks for something it does " +
            "not have about you: " + (asked.join("; ") || "a required answer") +
            ". Add it in your profile and it will finish this itself.",
            "gate",
          );
          return;
        }
      }
    }

    // 3b. The CAPTCHA we deliberately filled past. Hand it over NOW, with the
    //     form completed, rather than looking for a submit button we are never
    //     going to be allowed to press. The difference the user sees is the
    //     difference between "solve this and press Submit" and "here is an
    //     empty form and a puzzle".
    if (gateOnArrival) {
      stopHeartbeat();
      banner(
        `Grindly filled ${filled} field(s) for you. This page needs you for a ` +
        `${gateOnArrival} — solve it and press Submit.`,
        "gate",
      );
      await report("awaiting_human", { reason: gateOnArrival, detail: g.evidence });
      return;
    }

    // 4. Any required question we hold no approved answer for stops the run.
    //    Naming it is the difference between "needs your input" and something
    //    the user can actually act on.
    const unanswered = gates.unansweredRequiredFields(document);
    if (unanswered.length) {
      stopHeartbeat();
      banner(`Grindly filled ${filled} field(s) but needs you for: ${unanswered[0]}`, "gate");
      await report("awaiting_human", { reason: "unknown_question" });
      return;
    }

    // 5. Re-check immediately before submitting — a challenge can appear between
    //    the first check and now, and submitting into one is worse than stopping.
    g = gates.explainHumanGate(document);
    if (await stopAtGate(g, "before submitting")) return;

    // Never press an opener as though it were a send button. If the form never
    // appeared, the honest report is that nobody submitted anything.
    if (!submit || !window.GrindlySubmit.isSender(submit)) {
      stopHeartbeat();
      banner("Grindly filled what it could but could not find Submit — please send it.", "gate");
      await report("awaiting_human", { reason: "unknown_question" });
      return;
    }

    // Out of time. Do NOT click — the run has taken so long that the page in
    // front of the button may no longer be the page we read, and a click on a
    // stale form is the one mistake that cannot be taken back.
    if (runLeftMs() <= 0) {
      stopHeartbeat();
      banner("Grindly ran out of time on this page and did not submit it. Open it to finish.", "gate");
      await report("awaiting_human", { reason: "unknown_question", detail: "timed out before submit" });
      return;
    }

    // Remember the form so its disappearance can be read as success: on
    // Internshala the modal closing IS the confirmation, and there is often no
    // "thank you" text anywhere on the page.
    const formEl = submit.closest("form") || submit.parentElement;
    const pressed = window.GrindlySubmit.labelOf(submit).slice(0, 30);
    banner("Grindly is submitting this application…", "work");
    submit.click();

    // 5. Only call it submitted once the page says so. Clicking is not proof,
    //    and a count the user cannot trust is worse than no count.
    //
    // Poll rather than sleeping once: 2.5s was shorter than Internshala takes
    // to respond, so a submission that very likely succeeded was reported as
    // unconfirmed — which is safe, but leaves the user to check by hand every
    // time and makes a working feature look broken.
    //
    // The confirmation is always a DOM change — text appearing, or the form
    // going away — so the observer sees it the moment it happens even in a tab
    // whose timers have been throttled to a tick a minute. Twelve seconds here
    // means twelve seconds of wall clock, not twelve seconds of timers that a
    // background tab is free to stretch into a quarter of an hour.
    const CONFIRM_RE = /thank you|application (has been )?(received|submitted|sent)|successfully applied|we(?:'| ha)ve received|applied successfully/i;
    const confirmed = await waitFor(() => {
      if (CONFIRM_RE.test(document.body.innerText || "")) return true;
      // The form vanishing (or the button going away) is the site telling us it
      // took the application, in the only language it speaks.
      const gone = formEl && !document.body.contains(formEl);
      const buttonGone = !document.body.contains(submit) || submit.offsetParent === null;
      return gone || buttonGone ? true : null;
      // Deliberately NOT capped by the run deadline. Everything above it can be
      // abandoned safely, but a click has already happened here — cutting this
      // short would report "we could not confirm it" about an application that
      // did land, and send the user to check by hand for no reason.
    }, 12000);
    stopHeartbeat();
    if (confirmed) {
      banner("Grindly submitted this application.", "done");
      await report("submitted", { receipt: location.href.slice(0, 500) });
    } else {
      // Posted, but nothing confirmed it. Treated as needing a human look
      // rather than counted — see safety.classify_submit on the server.
      // Name the button it pressed. When this banner appeared on a form that had
      // not moved, the one question nobody could answer from the screenshot was
      // "which button did it actually click?" — and that was the whole bug.
      banner(
        `Grindly pressed “${pressed}” but the site did not confirm. Please check it.`,
        "gate",
      );
      // Send the label too. Which button was pressed is the single fact that
      // separates "the site was slow" from "we clicked the wrong thing", and it
      // was unanswerable from outside the browser for two whole rounds.
      await report("awaiting_human", { reason: "changed_form", detail: pressed });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run, { once: true });
  } else {
    run();
  }
})();
