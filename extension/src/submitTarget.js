/*
 * Which button actually sends the application.
 *
 * This looks trivial and is not. A first-match scan of the document shipped, and
 * on a real Internshala apply modal it pressed the wrong button every time: the
 * listing page BEHIND the modal still has its own "Apply now", it is still
 * visible, and it sits earlier in the DOM. Clicking it merely re-opens the modal
 * that is already open, so the actual Submit was never pressed and the run ended
 * as "sent, but the site did not confirm" on a form that had not moved. Safe,
 * but wrong, and indistinguishable from a broken site.
 *
 * Two ideas fix it:
 *   1. Score labels. "Submit" sends something; "Apply now" usually OPENS a form.
 *   2. Require the button to be what a click would really hit. An element under
 *      a modal overlay is perfectly "visible" to offsetParent — the click lands
 *      on the overlay. elementFromPoint is the only honest test of that.
 *
 * Split out of executor.js so this decision can be unit-tested against a fake
 * document; executor.js runs on load and cannot be imported in Node.
 */
(function (root) {
  "use strict";

  // Ordered by how strongly the label implies "this sends the application".
  var RULES = [
    [/^submit( application)?\b/, 5],
    [/^send( my)? application\b/, 5],
    [/^finish( &| and)? submit\b/, 5],
    [/^apply( now)?\b/, 2],
  ];

  function score(label) {
    var L = (label || "").trim().toLowerCase().replace(/\s+/g, " ");
    if (!L || L.length > 40) return 0; // a paragraph is not a button label
    for (var i = 0; i < RULES.length; i++) {
      if (RULES[i][0].test(L)) return RULES[i][1];
    }
    return 0;
  }

  /**
   * Would a click on this element actually reach it? Deliberately conservative:
   * when the check itself cannot run (no elementFromPoint, exotic host) we say
   * yes rather than discard a genuine button over an inconclusive test.
   */
  function clickable(el, doc) {
    try {
      if (el.scrollIntoView) el.scrollIntoView({ block: "center", inline: "center" });
      var r = el.getBoundingClientRect();
      if (!r || !r.width || !r.height) return false; // not rendered
      var hit = doc.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (!hit) return false; // off-screen or covered by nothing we can name
      return hit === el || (el.contains ? el.contains(hit) : false);
    } catch {
      return true;
    }
  }

  /** The best real submit button on the page, or null. Never clicks anything. */
  function pick(doc) {
    var els = doc.querySelectorAll(
      "button, input[type='submit'], input[type='button'], [role='button']",
    );
    var best = null;
    var bestScore = 0;
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.disabled) continue;
      var s = score(el.innerText || el.value || "");
      if (s <= bestScore) continue; // cheap first: skip the costly hit test
      if (!clickable(el, doc)) continue;
      bestScore = s;
      best = el;
    }
    return best;
  }

  var api = { score: score, pick: pick, clickable: clickable };
  root.GrindlySubmit = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
