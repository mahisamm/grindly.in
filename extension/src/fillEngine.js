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
  // "Why should you be hired for this role?" is THE Internshala question — it
  // appears on nearly every listing that asks anything at all — and it was not
  // matched, so the one field a cover letter exists for was left blank and the
  // application stalled waiting for a human. These are all the same ask phrased
  // differently: tell us, in prose, why you.
  var RE_COVER = /cover.?letter|covering letter|message to (the )?(recruiter|employer|team|company)|note to (the )?(recruiter|employer)|why should (you|we) (be hired|hire you)|why are you (a good fit|interested)|tell us about yourself|why do you want (this|to)/i;
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
    // word overlap — require 3 shared meaningful (>3 char) words, not 2. A
    // 2-word overlap on a long label matched too easily on unrelated
    // screening questions, risking the wrong drafted answer landing somewhere
    // the user doesn't notice before submit.
    var lw = L.split(/\W+/).filter(Boolean);
    var best = null, bestScore = 0;
    for (var k = 0; k < answers.length; k++) {
      var qw = norm(answers[k].q).split(/\W+/).filter(Boolean);
      var overlap = lw.filter(function (w) { return w.length > 3 && qw.indexOf(w) !== -1; }).length;
      if (overlap > bestScore) { bestScore = overlap; best = answers[k].a; }
    }
    return bestScore >= 3 ? best : null;
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
      else {
        // An answer the user approved FOR THIS QUESTION always beats the
        // generic cover letter. Checking the letter first meant widening the
        // cover-letter pattern silently overrode specific approved answers —
        // the drafted reply the user actually reviewed would lose to boilerplate.
        var a = matchAnswer(label, answers);
        if (a) { val = a; source = "answer"; }
        else if (RE_COVER.test(label) && (tag === "textarea" || f.contentEditable)) {
          val = kit.coverLetter; source = "cover";
        }
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

      // The field's OWN <label>, when the form did not wire up `for`.
      //
      // Keka does not: its gender control is <select id="gender"> with a plain
      // sibling <label>Gender *</label> and no `for` attribute. Falling straight
      // through to the ancestor-text walk below returns the first ancestor whose
      // text passes a length check — the whole contact section — so the question
      // came back as "First Name * Middle Name Last Name * Mobile Phone * Email *"
      // and matched no stored answer. Measured on a live form; the same fix is in
      // agent/questions.py _LABEL_JS.
      //
      // Only when the ancestor holds exactly ONE label and ONE control: that is a
      // form-group wrapping a single question. Two of either means we have
      // climbed into a section and would be guessing which label is ours.
      var m = el.parentElement, mh = 0;
      while (m && mh < 4) {
        var labels = m.querySelectorAll("label");
        var controls = m.querySelectorAll("input,textarea,select,[contenteditable='true']");
        if (labels.length === 1 && controls.length === 1) {
          var own = clean(labels[0].innerText);
          if (own) return own;
        }
        m = m.parentElement; mh++;
      }

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

  // Not rendered / zero-size / display:none / visibility:hidden — the shape a
  // page uses for a honeypot field or an off-screen widget the user can't see.
  // Real forms don't hide the fields they want the user to fill, so this is a
  // safe filter, not a guess: it stops a same-page hidden newsletter/lead-
  // capture widget from silently soaking up PII meant for the job form (the
  // user reviews everything they can SEE before hitting Submit — an invisible
  // field bypasses that review entirely).
  function isFillable(el) {
    try {
      if (!el || (el.isConnected === false)) return false;
      var rects = el.getClientRects && el.getClientRects();
      if (!rects || rects.length === 0) return false;
      var style = window.getComputedStyle ? window.getComputedStyle(el) : null;
      if (style && (style.visibility === "hidden" || style.display === "none")) return false;
      return true;
    } catch {
      return true; // can't tell — don't silently drop a real field over it
    }
  }

  // What a dropdown says when nothing is chosen. Mirrors
  // agent/questions._PLACEHOLDER_LABEL — Keka's is "Select an option", and
  // reading that as a real value is what hid Gender on every Keka form.
  var RE_PLACEHOLDER = /^\s*(?:[-–—]{2,}\s*)?(?:please\s+)?(?:select|search|choose|pick)(?:\s+(?:an?|one|your|the)?\s*(?:option|item|value|choice|answer)?)?\s*[.…]{0,3}\s*(?:[-–—]{2,})?\s*$|^\s*[-–—]{2,}\s*$/i;

  function optionsOf(el) {
    var out = [];
    try {
      var opts = el.querySelectorAll("option");
      for (var i = 0; i < opts.length && i < 400; i++) {
        var t = (opts[i].textContent || "").trim().replace(/\s+/g, " ");
        if (t) out.push(t);
      }
    } catch { /* not a select */ }
    return out;
  }

  function readFields(root, doc) {
    // `select` is in this list now. It was not, so every dropdown on every form
    // was invisible to the extension — including "Gender *", which is required
    // on Keka and is the single field that blocked those applications.
    var els = root.querySelectorAll("textarea, input, select, [contenteditable='true']");
    var fields = [];
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (!isFillable(el)) continue;
      var tag = (el.tagName || "").toLowerCase();
      var editable = el.getAttribute && el.getAttribute("contenteditable") === "true";
      var isSelect = tag === "select";
      var type = editable ? "textarea"
        : isSelect ? "select"
        : ((el.getAttribute && el.getAttribute("type")) || "text").toLowerCase();

      var current;
      if (editable) current = el.textContent || "";
      else if (isSelect) {
        var chosen = el.selectedIndex >= 0 && el.options[el.selectedIndex]
          ? (el.options[el.selectedIndex].textContent || "") : "";
        // A vendor's own default IS an answer (Keka presets +91 and INR); its
        // placeholder is not.
        current = RE_PLACEHOLDER.test(chosen.trim()) ? "" : chosen;
      } else current = el.value || "";

      fields.push({
        _el: el,
        tag: editable ? "textarea" : tag,
        type: type,
        // The vocabulary agent/questions.py answers in. Sent to the server as
        // `kind`; the two must agree or the engine mis-shapes its answer.
        kind: editable ? "textarea" : isSelect ? "select" : type,
        name: (el.getAttribute && el.getAttribute("name")) || "",
        id: el.id || "",
        label: labelFor(el, doc),
        required: !!((el.hasAttribute && el.hasAttribute("required"))
          || (el.getAttribute && el.getAttribute("aria-required") === "true")),
        options: isSelect ? optionsOf(el) : [],
        value: current,
        contentEditable: editable,
        filled: current.trim() !== "",
      });
    }
    return fields;
  }

  /**
   * The wire shape for POST /api/extension/plan.
   *
   * Strips the live element — the server answers from a snapshot and never
   * touches a DOM — and stamps each field with the index the browser will use
   * to address it again. The plan comes back keyed on that index, so a mismatch
   * here types the right answer into the wrong box.
   */
  function serializeFields(fields) {
    var out = [];
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      out.push({
        index: i,
        label: f.label || f.name || f.id || "",
        kind: f.kind || f.type || "text",
        required: !!f.required,
        options: f.options || [],
        value: f.value || "",
      });
    }
    return out;
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

  /**
   * Choose an option in a real <select> by its visible text.
   *
   * Setting `.value` does not work here: the value attribute is rarely the text
   * the engine matched against ("Male" may be value "2"). So find the option
   * whose text matches, then set selectedIndex and fire change — React and
   * Angular both listen for that and ignore a bare assignment.
   */
  function selectOption(el, wanted) {
    try {
      var want = norm(wanted);
      var opts = el.options || [];
      var hit = -1;
      for (var i = 0; i < opts.length; i++) {
        if (norm(opts[i].textContent) === want) { hit = i; break; }
      }
      if (hit < 0) {
        for (var j = 0; j < opts.length; j++) {
          var t = norm(opts[j].textContent);
          if (t && (t.indexOf(want) === 0 || want.indexOf(t) === 0)) { hit = j; break; }
        }
      }
      // No match means leave it EMPTY. A dropdown that looks answered but holds
      // nothing is what gets a whole application rejected at submit.
      if (hit < 0) return false;
      el.selectedIndex = hit;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Apply a plan the SERVER decided, against fields this browser read.
   *
   * The division of labour: the browser can see the page and nothing else; the
   * server holds forty-odd patterns for gender, school, degree, years of
   * experience and the refusals that stop it inventing facts. So the browser
   * asks, and types back what it is told.
   *
   * `plan.fills` is keyed on the index from serializeFields. Anything the
   * server left out stays untouched — an omission there means "we could not
   * answer this honestly", which is a decision, not a gap to paper over.
   */
  function applyPlan(fields, plan) {
    var fills = (plan && plan.fills) || [];
    var filled = 0, missed = [];
    for (var i = 0; i < fills.length; i++) {
      var item = fills[i];
      var f = fields[item.index];
      if (!f || !f._el) { missed.push(item.label || item.index); continue; }
      var ok = (f.kind === "select")
        ? selectOption(f._el, item.value)
        : setValue(f._el, item.value, f.contentEditable);
      if (ok) filled++; else missed.push(item.label || item.index);
    }
    return {
      filled: filled,
      planned: fills.length,
      total: fields.length,
      missed: missed,
      // Required questions the server refused to answer. The caller shows these
      // to the user rather than submitting a form it knows is incomplete.
      unanswered: (plan && plan.unanswered) || [],
    };
  }

  /** Fill everything we can under `root`. Returns { filled, total }. Never submits. */
  function applyFills(root, kit, doc) {
    doc = doc || (root.ownerDocument) || document;
    var fields = readFields(root, doc);
    var plan = planFills(fields, kit);
    var filled = 0;
    for (var i = 0; i < plan.length; i++) {
      var f = fields[plan[i].i];
      if (f.kind === "select") { if (selectOption(f._el, plan[i].value)) filled++; }
      else if (setValue(f._el, plan[i].value, f.contentEditable)) filled++;
    }
    return { filled: filled, total: fields.length, planned: plan.length };
  }

  var api = {
    planFills: planFills, applyFills: applyFills, matchAnswer: matchAnswer,
    readFields: readFields, isFillable: isFillable,
    serializeFields: serializeFields, applyPlan: applyPlan,
    selectOption: selectOption,
  };
  root.GrindlyFill = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
