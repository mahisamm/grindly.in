/*
 * Filler content script — runs on the supported job platforms.
 *
 * It does NOT auto-fill on load. It asks the background whether the current job
 * page matches a due Grindly match; if so, it shows a small floating "Fill with
 * Grindly" button. The user clicks it, the kit is typed into the form, and the
 * user reviews and clicks the platform's own Submit — which this extension never
 * touches. Resume attach stays a manual click (browsers block scripted file
 * inputs by design). A human gesture starts the fill and a human click submits it.
 */
(function () {
  "use strict";

  var GF = globalThis.GrindlyFill;
  if (!GF) return; // fillEngine.js failed to load — do nothing rather than half-work

  var currentUrl = "";
  var lastKit = null;
  var dismissed = false; // user hid it on this page load — don't nag back
  var host = document.createElement("div");
  var shadow = host.attachShadow ? host.attachShadow({ mode: "open" }) : null;

  function mountUI() {
    if (!shadow) return;
    host.style.cssText = "position:fixed;z-index:2147483647;right:16px;bottom:16px;";
    shadow.innerHTML =
      '<style>' +
      '.row{display:flex;align-items:center;gap:6px}' +
      '.g{font:500 13px/1.4 system-ui,sans-serif;background:#e5533c;color:#fff;border:none;' +
      'border-radius:10px;padding:10px 14px;box-shadow:0 4px 16px rgba(0,0,0,.25);cursor:pointer;display:flex;gap:8px;align-items:center}' +
      '.g:hover{opacity:.92}.g[disabled]{opacity:.6;cursor:default}' +
      '.x{background:#111;color:#fff;border:none;border-radius:8px;width:26px;height:26px;cursor:pointer;font-size:15px;line-height:1;opacity:.7}' +
      '.x:hover{opacity:1}' +
      '.t{margin-top:8px;background:#111;color:#fff;font:400 12px/1.4 system-ui;padding:8px 12px;border-radius:8px;max-width:240px;display:none}' +
      '.dot{width:7px;height:7px;border-radius:50%;background:#fff}</style>' +
      '<div class="row">' +
      '<button class="g" id="btn" aria-label="Fill this application with Grindly"><span class="dot"></span><span id="lbl">Fill with Grindly</span></button>' +
      '<button class="x" id="dismiss" title="Hide" aria-label="Hide Grindly for this page">×</button>' +
      '</div>' +
      '<div class="t" id="toast" role="status" aria-live="polite"></div>';
    shadow.getElementById("btn").addEventListener("click", onFill);
    shadow.getElementById("dismiss").addEventListener("click", function () { dismissed = true; hide(); });
    if (!host.isConnected) document.body.appendChild(host);
  }

  function toast(text, ms) {
    if (!shadow) return;
    var t = shadow.getElementById("toast");
    t.textContent = text;
    t.style.display = "block";
    if (ms) setTimeout(function () { t.style.display = "none"; }, ms);
  }

  function setLabel(text, disabled) {
    if (!shadow) return;
    shadow.getElementById("lbl").textContent = text;
    shadow.getElementById("btn").disabled = !!disabled;
  }

  function hide() { if (host.isConnected) host.remove(); }

  function onFill() {
    if (!lastKit) return;
    // Not paired yet — send them to connect (checked BEFORE the matched guard,
    // since an unpaired kit is never "matched").
    if (lastKit.error === "not_connected") {
      window.open("https://grindly.in/extension/connect", "_blank");
      return;
    }
    if (!lastKit.matched) return;
    setLabel("Filling…", true);
    var res = GF.applyFills(document, lastKit, document);
    setLabel("Fill with Grindly", false);
    if (res.filled > 0) {
      toast("Filled " + res.filled + " field" + (res.filled === 1 ? "" : "s") +
        ". Review, attach your resume if asked, then click Submit yourself.", 8000);
    } else {
      toast("No fields to auto-fill on this step — the kit is in your Grindly dashboard to copy.", 8000);
    }
  }

  function refresh() {
    var url = location.href;
    if (url === currentUrl) return;
    currentUrl = url;
    dismissed = false; // a new page is a fresh chance to offer help
    chrome.runtime.sendMessage({ type: "grindly:getKit", url: url }, function (kit) {
      lastKit = kit || {};
      if (dismissed) return;
      if (kit && kit.error === "not_connected") {
        mountUI(); setLabel("Connect Grindly", false);
        return;
      }
      if (kit && kit.matched) {
        mountUI();
        setLabel("Fill with Grindly", false);
        toast(kit.jobTitle + " — kit ready", 4000);
      } else {
        hide(); // no match for this page — stay out of the way
      }
    });
  }

  // SPAs (LinkedIn, Naukri) change the URL without a reload — re-check on a light poll.
  refresh();
  setInterval(refresh, 1500);
})();
