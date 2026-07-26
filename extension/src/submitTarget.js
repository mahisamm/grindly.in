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
  //
  // The gap between 5 and 2 is the whole point. A 5 SENDS the application. A 2
  // usually just OPENS the form that has the 5 inside it — on Internshala the
  // listing page has no form at all until "Apply now" is pressed. Treating
  // those as the same kind of button meant pressing "Apply now", watching the
  // modal open, and then waiting for a confirmation that could never arrive.
  var SEND_SCORE = 5;
  var RULES = [
    [/^submit( application)?\b/, 5],
    [/^send( my)? application\b/, 5],
    [/^finish( &| and)? submit\b/, 5],
    [/^apply( now)?\b/, 2],
    [/^continue\b/, 2],
    [/^next\b/, 2],
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
      if (!r || !r.width || !r.height) return false;
      var hit = doc.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (!hit) return false; // off-screen or covered by nothing we can name
      return hit === el || (el.contains ? el.contains(hit) : false);
    } catch {
      return true;
    }
  }

  /**
   * Occupies space on the page at all.
   *
   * A hard filter, unlike clickable(): something with no width or height is not
   * a button anyone could press, so it is not a candidate. Being COVERED is
   * different — the button is real, something is simply on top of it — and that
   * only lowers its rank.
   */
  function rendered(el) {
    try {
      var r = el.getBoundingClientRect();
      return !!(r && r.width && r.height);
    } catch {
      return true; // can't tell — don't discard a real button over it
    }
  }

  function labelOf(el) {
    return ((el && (el.innerText || el.value)) || "").trim();
  }

  /** Does this button SEND the application, rather than open the form? */
  function isSender(el) {
    return score(labelOf(el)) >= SEND_SCORE;
  }

  /**
   * The best button on the page, or null. Never clicks anything.
   *
   * Ranked by label FIRST, with reachability only breaking ties. Reachability
   * was a filter at first, which meant a real "Submit" that failed the hit test
   * for any reason lost to a merely-visible "Apply now" — and clicking a
   * covered button does nothing anyway, while clicking the wrong one opens a
   * modal and looks like a submission that vanished.
   */
  function pick(doc) {
    var els = doc.querySelectorAll(
      "button, input[type='submit'], input[type='button'], [role='button'], a",
    );
    var best = null;
    var bestRank = 0;
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.disabled) continue;
      var s = score(labelOf(el));
      if (!s || !rendered(el)) continue;
      // Score dominates; a reachable button beats an unreachable one of the
      // same score.
      var rank = s * 2 + (clickable(el, doc) ? 1 : 0);
      if (rank > bestRank) { bestRank = rank; best = el; }
    }
    return best;
  }

  var api = {
    score: score, pick: pick, clickable: clickable,
    labelOf: labelOf, isSender: isSender, SEND_SCORE: SEND_SCORE,
  };
  root.GrindlySubmit = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
