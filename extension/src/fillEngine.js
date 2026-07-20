/*
 * Grindly fill engine — the code that types the Apply Kit into a real application
 * form, inside the user's own browser. Shipped as a classic content script (no
 * ES imports — MV3 content scripts don't support them), so it attaches to
 * globalThis and guards a CommonJS export tail purely so the Node test suite can
 * load THIS EXACT FILE and unit-test the decision logic.
 *
 * The one rule this file exists to keep: it NEVER interacts with a submit button.
 * There is no .click() anywhere in here and no code path that submits a form —
 * the human always performs that final action. A source-level test asserts it.
 *
 * Design: the risky part (deciding what to type where) is a PURE function,
 * planFills(fields, kit) -> decisions, with no DOM — so it's fully testable in
 * Node. applyFills() is thin DOM glue that reads fields, calls planFills, writes.
 */
(function (root) {
  "use strict";

  // Mirrors agent/questions.py's classifiers so the extension and the server-side
  // draft agree on what a field means. Order matters: checkable facts first.
  // Narrow on purpose: only the dedicated cover-letter box. Screening questions
  // like "Why should we hire you?" are answered from the drafted answers, not by
  // dropping the whole cover letter into them.
  var RE_COVER = /cover.?letter|covering letter|message to (the )?(recruiter|employer|team|company)|note to (the )?(recruiter|employer)/i;
  var RE_PHONE = /\b(phone|mobile|contact number|whatsapp)\b/i;
  var RE_EMAIL = /\be-?mail\b/i;
  var RE_CGPA = /\b(cgpa|gpa|grade point|percentage|marks|aggregate)\b/i;
  var RE_NAME = /\b(your name|full name|first name|candidate name)\b/i;
  // Fields we must never write into — the platform's plumbing, or the user's call.
  var SKIP_TYPE = { hidden: 1, file: 1, submit: 1, button: 1, image: 1, reset: 1, password: 1, checkbox: 1, radio: 1 };
  var SKIP_NAME = /csrf|token|captcha|_method|utf8/i;

  function norm(s) {
    return (s || "").toString().trim().toLowerCase();
  }

  // Best fuzzy match of a field label against a drafted question. Exact-ish first,
  // then containment, then a loose word-overlap score — the server drafted answers
  // from harvested labels, but a live form may word its label slightly differently.
  function matchAnswer(label, answers) {
    if (!answers || !answers.length) return null;
    var L = norm(label);
    if (!L) return null;
    for (var i = 0; i < answers.length; i++) {
      if (norm(answers[i].q) === L) return answers[i].a;
    }
    for (var j = 0; j < answers.length; j++) {
      var Q = norm(answers[j].q);
      if (Q && (L.indexOf(Q) !== -1 || Q.indexOf(L) !== -1)) return answers[j].a;
    }
    // word overlap
    var lw = L.split(/\W+/).filter(Boolean);
    var best = null, bestScore = 0;
    for (var k = 0; k < answers.length; k++) {
      var qw = norm(answers[k].q).split(/\W+/).filter(Boolean);
      var overlap = lw.filter(function (w) { return w.length > 3 && qw.indexOf(w) !== -1; }).length;
      if (overlap > bestScore) { bestScore = overlap; best = answers[k].a; }
    }
    return bestScore >= 2 ? best : null;
  }

  /**
   * PURE. Given field descriptors and the kit, decide what to type where.
   * fields: [{ tag, type, name, id, label, required, filled }]
   * kit:    { coverLetter, answers:[{q,a}], profile:{name,email,phone,gpa} }
   * returns: [{ i, value, source }]  — i indexes into `fields`; source is why.
   * Never returns a decision for a skipped field, an already-filled field, or an
   * empty value. Never references a submit/button.
   */
  function planFills(fields, kit) {
    var out = [];
    var profile = (kit && kit.profile) || {};
    var answers = (kit && kit.answers) || [];
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i] || {};
      var type = norm(f.type) || "text";
      var tag = norm(f.tag);
      if (tag !== "textarea" && SKIP_TYPE[type]) continue;
      if (SKIP_NAME.test(f.name || "")) continue;
      if (f.filled) continue; // never clobber something the user or the page already set

      var label = f.label || f.name || f.id || "";
      var val = null, source = null;

      if (RE_PHONE.test(label) || type === "tel") { val = profile.phone; source = "profile"; }
      else if (RE_EMAIL.test(label) || type === "email") { val = profile.email; source = "profile"; }
      else if (RE_CGPA.test(label)) { val = profile.gpa != null ? String(profile.gpa) : null; source = "profile"; }
      else if (RE_NAME.test(label)) { val = profile.name; source = "profile"; }
      else if (RE_COVER.test(label) && (tag === "textarea" || f.contentEditable)) { val = kit.coverLetter; source = "cover"; }
      else {
        var a = matchAnswer(label, answers);
        if (a) { val = a; source = "answer"; }
      }

      if (val != null && String(val).trim() !== "") {
        out.push({ i: i, value: String(val), source: source });
      }
    }
    return out;
  }

  // --- DOM glue (not unit-tested; exercised live in the browser) ----------------

  // Reads the human-readable question next to a field. JS port of the ancestor
  // walk in agent/questions.py (_LABEL_JS): explicit label[for], wrapping label,
  // aria-label, then nearest text-bearing ancestor.
  function labelFor(el, doc) {
    var clean = function (s) { return (s || "").trim().replace(/\s+/g, " "); };
    try {
      if (el.id) {
        var l = doc.querySelector('label[for="' + (window.CSS ? CSS.escape(el.id) : el.id) + '"]');
        if (l && clean(l.innerText)) return clean(l.innerText);
      }
      var wrap = el.closest && el.closest("label");
      if (wrap && clean(wrap.innerText)) return clean(wrap.innerText);
      var aria = el.getAttribute && el.getAttribute("aria-label");
      if (aria) return clean(aria);
      var n = el.parentElement, hops = 0;
      while (n && hops < 4) {
        var c = n.cloneNode(true);
        var kids = c.querySelectorAll("input,textarea,select,button,script,style");
        for (var i = 0; i < kids.length; i++) kids[i].remove();
        var t = clean(c.innerText);
        if (t.length > 8) return t;
        n = n.parentElement; hops++;
      }
    } catch { /* fall through */ }
    return clean((el.getAttribute && (el.getAttribute("placeholder") || el.getAttribute("name"))) || "");
  }

  function readFields(root, doc) {
    var els = root.querySelectorAll("textarea, input, [contenteditable='true']");
    var fields = [];
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var tag = (el.tagName || "").toLowerCase();
      var editable = el.getAttribute && el.getAttribute("contenteditable") === "true";
      var type = editable ? "textarea" : ((el.getAttribute && el.getAttribute("type")) || "text").toLowerCase();
      var current = editable ? (el.textContent || "") : (el.value || "");
      fields.push({
        _el: el,
        tag: editable ? "textarea" : tag,
        type: type,
        name: (el.getAttribute && el.getAttribute("name")) || "",
        id: el.id || "",
        label: labelFor(el, doc),
        required: !!(el.hasAttribute && el.hasAttribute("required")),
        contentEditable: editable,
        filled: current.trim() !== "",
      });
    }
    return fields;
  }

  // Type a value the way a real edit fires events, so frameworks (React etc.)
  // register the change. Standard autofill technique — a password manager does
  // the same. NOTHING here clicks or submits.
  function setValue(el, value, contentEditable) {
    try {
      if (el.focus) el.focus();
      if (contentEditable) {
        el.textContent = value;
      } else {
        var proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement : window.HTMLInputElement;
        var setter = proto && Object.getOwnPropertyDescriptor(proto.prototype, "value");
        if (setter && setter.set) setter.set.call(el, value); else el.value = value;
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      if (el.blur) el.blur();
      return true;
    } catch {
      return false;
    }
  }

  /** Fill everything we can under `root`. Returns { filled, total }. Never submits. */
  function applyFills(root, kit, doc) {
    doc = doc || (root.ownerDocument) || document;
    var fields = readFields(root, doc);
    var plan = planFills(fields, kit);
    var filled = 0;
    for (var i = 0; i < plan.length; i++) {
      var f = fields[plan[i].i];
      if (setValue(f._el, plan[i].value, f.contentEditable)) filled++;
    }
    return { filled: filled, total: fields.length, planned: plan.length };
  }

  var api = { planFills: planFills, applyFills: applyFills, matchAnswer: matchAnswer, readFields: readFields };
  root.GrindlyFill = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
