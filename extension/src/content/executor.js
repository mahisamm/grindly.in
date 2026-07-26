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

  function findSubmit() {
    const candidates = document.querySelectorAll(
      "button[type='submit'], input[type='submit'], button",
    );
    for (const el of candidates) {
      if (el.offsetParent === null || el.disabled) continue;
      const label = (el.innerText || el.value || "").trim().toLowerCase();
      if (/^(submit|apply|send application|submit application)\b/.test(label)) return el;
    }
    return null;
  }

  async function run() {
    task = await send({ type: "grindly:activeTask" });
    if (!task || !task.url) return;
    if (!onTaskHost()) return; // not the page this task is for

    const gates = window.GrindlyGate;
    if (!gates) return; // humanGate.js not present — do nothing rather than guess

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
    const kit = task.profile || {};
    let filled = 0;
    try {
      const res = window.GrindlyFill.applyFills(document.body, kit, document);
      filled = res.filled;
    } catch {
      stopHeartbeat();
      await report("failed", { reason: "fill_error" });
      banner("Grindly could not fill this form. Left it untouched for you.", "gate");
      return;
    }

    // 3. Any required question we hold no approved answer for stops the run.
    //    Naming it is the difference between "needs your input" and something
    //    the user can actually act on.
    const unanswered = gates.unansweredRequiredFields(document);
    if (unanswered.length) {
      stopHeartbeat();
      banner(`Grindly filled ${filled} field(s) but needs you for: ${unanswered[0]}`, "gate");
      await report("awaiting_human", { reason: "unknown_question" });
      return;
    }

    // 4. Re-check immediately before submitting — a challenge can appear between
    //    the first check and now, and submitting into one is worse than stopping.
    gate = gates.detectHumanGate(document);
    if (gate) {
      stopHeartbeat();
      banner(`Grindly stopped before submitting: ${gate}.`, "gate");
      await report("awaiting_human", { reason: gate });
      return;
    }

    const submit = findSubmit();
    if (!submit) {
      stopHeartbeat();
      banner("Grindly filled the form but could not find Submit — please send it.", "gate");
      await report("awaiting_human", { reason: "unknown_question" });
      return;
    }

    submit.click();

    // 5. Only call it submitted once the page says so. Clicking is not proof,
    //    and a count the user cannot trust is worse than no count.
    await new Promise((r) => setTimeout(r, 2500));
    const confirmed = /thank you|application (received|submitted)|we(?:'| ha)ve received/i.test(
      document.body.innerText || "",
    );
    stopHeartbeat();
    if (confirmed) {
      banner("Grindly submitted this application.", "done");
      await report("submitted", { receipt: location.href.slice(0, 500) });
    } else {
      // Posted, but nothing confirmed it. Treated as needing a human look
      // rather than counted — see safety.classify_submit on the server.
      banner("Grindly sent this, but the site did not confirm. Please check it.", "gate");
      await report("awaiting_human", { reason: "changed_form" });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run, { once: true });
  } else {
    run();
  }
})();
