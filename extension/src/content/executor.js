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

  let task = null;
  let heartbeat = null;

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
    for (let waited = 0; waited < timeoutMs; waited += 300) {
      await new Promise((r) => setTimeout(r, 300));
      const found = findSubmit();
      if (found && window.GrindlySubmit.isSender(found)) return found;
    }
    return findSubmit();
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
    let gate = gates.detectHumanGate(document);
    if (gate) {
      stopHeartbeat();
      banner(`Grindly stopped: this page needs you (${gate}). Finish it and Grindly will carry on.`, "gate");
      await report("awaiting_human", { reason: gate });
      return;
    }

    // 2. Fill from approved facts only.
    // The kit shape fillEngine reads: { profile:{name,…}, answers, coverLetter }.
    // It used to be handed the claim endpoint's flat profile, which has no
    // `.profile` key at all — so every autopilot run filled exactly nothing and
    // then reported that the form asked something it could not answer.
    const kit = task.kit || {};
    let filled = 0;
    const fillNow = () => window.GrindlyFill.applyFills(document.body, kit, document).filled;
    try {
      filled = fillNow();
    } catch {
      stopHeartbeat();
      await report("failed", { reason: "fill_error" });
      banner("Grindly could not fill this form. Left it untouched for you.", "gate");
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
        gate = gates.detectHumanGate(document);
        if (gate) {
          stopHeartbeat();
          banner(`Grindly stopped: this page needs you (${gate}).`, "gate");
          await report("awaiting_human", { reason: gate });
          return;
        }
        try {
          filled += fillNow();
        } catch {
          stopHeartbeat();
          await report("failed", { reason: "fill_error" });
          banner("Grindly could not fill this form. Left it untouched for you.", "gate");
          return;
        }
      }
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
    gate = gates.detectHumanGate(document);
    if (gate) {
      stopHeartbeat();
      banner(`Grindly stopped before submitting: ${gate}.`, "gate");
      await report("awaiting_human", { reason: gate });
      return;
    }

    // Never press an opener as though it were a send button. If the form never
    // appeared, the honest report is that nobody submitted anything.
    if (!submit || !window.GrindlySubmit.isSender(submit)) {
      stopHeartbeat();
      banner("Grindly filled what it could but could not find Submit — please send it.", "gate");
      await report("awaiting_human", { reason: "unknown_question" });
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
    const CONFIRM_RE = /thank you|application (has been )?(received|submitted|sent)|successfully applied|we(?:'| ha)ve received|applied successfully/i;
    let confirmed = false;
    for (let waited = 0; waited < 12000; waited += 750) {
      await new Promise((r) => setTimeout(r, 750));
      if (CONFIRM_RE.test(document.body.innerText || "")) { confirmed = true; break; }
      // The form vanishing (or the button going away) is the site telling us it
      // took the application, in the only language it speaks.
      const gone = formEl && !document.body.contains(formEl);
      const buttonGone = !document.body.contains(submit) || submit.offsetParent === null;
      if (gone || buttonGone) { confirmed = true; break; }
    }
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
