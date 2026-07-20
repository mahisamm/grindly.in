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
  document.documentElement.setAttribute("data-grindly-extension", "0.1.0");

  window.addEventListener("message", function (e) {
    if (e.source !== window || !e.data || typeof e.data !== "object") return;
    var d = e.data;

    if (d.type === "grindly-ext:pair" && typeof d.token === "string") {
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
