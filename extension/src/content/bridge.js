/*
 * Bridge content script — runs ONLY on grindly.in.
 *
 * Two jobs:
 *  1. Pairing handoff. The "Connect extension" page posts a window message with
 *     a freshly minted token; we forward it to the background (the only place it's
 *     stored). window.postMessage is same-origin here, and we ignore anything not
 *     from this exact page, so a third-party frame can't inject a token.
 *  2. Presence marker. We set a data attribute + answer a ping so the dashboard
 *     can show "extension installed" and switch to the auto-fill hint. This tells
 *     the page nothing sensitive — only that the extension exists.
 */
(function () {
  "use strict";

  // 1. Presence marker — the dashboard checks for this to know the extension is here.
  // Read from the manifest rather than hardcoded: this string was stuck at
  // "0.1.0" for several releases, and a presence marker that lies about its
  // version is worse than one that says nothing.
  document.documentElement.setAttribute(
    "data-grindly-extension",
    (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || "unknown",
  );

  // ...and announce it, rather than only answering when asked.
  //
  // The connect page pings once, from a React effect, and window.postMessage is
  // NOT queued for listeners that do not exist yet. This script runs at
  // document_idle; hydration often beats that. When it does, the page's single
  // ping goes out to nobody, the attribute above has not been set yet either,
  // and the page concludes the extension is absent — permanently, because there
  // was never a second attempt. Zero pairings had ever happened in production,
  // and this was the reason.
  //
  // So both orderings are covered now: run first and the attribute is waiting
  // for the page, run second and this message finds a listener already there.
  chrome.runtime.sendMessage({ type: "grindly:status" }, function (resp) {
    window.postMessage(
      { type: "grindly-ext:pong", installed: true, connected: !!(resp && resp.connected) },
      window.location.origin,
    );
  });

  window.addEventListener("message", function (e) {
    if (e.source !== window || !e.data || typeof e.data !== "object") return;
    var d = e.data;

    // Pairing is restricted to the one page meant to issue it. This script
    // itself runs on all of grindly.in/* (needed for the presence ping below,
    // which the dashboard also uses) — without this check, any future XSS
    // anywhere on the origin could silently re-pair the extension to an
    // attacker-chosen token just by posting this message.
    if (d.type === "grindly-ext:pair" && typeof d.token === "string" &&
        window.location.pathname === "/extension/connect") {
      chrome.runtime.sendMessage({ type: "grindly:pair", token: d.token }, function (resp) {
        window.postMessage({ type: "grindly-ext:paired", ok: !!(resp && resp.ok) }, window.location.origin);
      });
    }

    if (d.type === "grindly-ext:ping") {
      chrome.runtime.sendMessage({ type: "grindly:status" }, function (resp) {
        window.postMessage(
          { type: "grindly-ext:pong", installed: true, connected: !!(resp && resp.connected) },
          window.location.origin
        );
      });
    }
  });
})();
