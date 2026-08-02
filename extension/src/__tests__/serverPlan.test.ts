/**
 * The browser reads the form; the server decides the answers.
 *
 * The extension's own logic is four regexes — phone, email, CGPA, name. It
 * could not read a `<select>` at all, so "Gender *" was invisible to it, and
 * that one required dropdown blocked every Keka application. Rather than port
 * forty-odd patterns into JavaScript and rediscover their bugs a second time,
 * the browser now sends a snapshot to the hardened Python engine and types back
 * what it is told.
 *
 * These tests cover the browser's half of that contract: read every control
 * including dropdowns, label each one with ITS OWN question, address them by an
 * index the plan can refer to, and apply the result — including selecting a
 * dropdown option, which assigning `.value` does not do.
 */
import { afterEach, describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const engine = require("../fillEngine.js");

function dom(html: string) {
  const d = new JSDOM(`<form id="f">${html}</form>`);
  const doc = d.window.document;
  // jsdom does not implement innerText — it is not in the DOM spec, only
  // textContent is. Real browsers have it and the reader uses it deliberately
  // (it respects visibility, textContent does not), so alias it here rather
  // than weakening the production code to suit the test harness.
  if (!("innerText" in d.window.HTMLElement.prototype)) {
    Object.defineProperty(d.window.HTMLElement.prototype, "innerText", {
      get() { return this.textContent; },
      configurable: true,
    });
  }
  // The reader asks the element whether it is drawn; jsdom lays nothing out, so
  // every control would be filtered as invisible without this.
  doc.querySelectorAll("input,select,textarea,[contenteditable]").forEach((el) => {
    // @ts-expect-error test stub
    el.getClientRects = () => [{ width: 120, height: 24 }];
  });
  // @ts-expect-error test stub
  d.window.getComputedStyle = () => ({ visibility: "visible", display: "block" });
  // The engine reaches for `window` in both halves — readFields asks whether a
  // control is drawn, and setValue needs the native value setter and Event
  // constructor. Install it for the whole test and tear it down after, rather
  // than only around the read: restoring it too early made every apply silently
  // do nothing, which looked exactly like a broken filler.
  // @ts-expect-error test stub
  globalThis.window = d.window;
  globalThis.Event = d.window.Event;
  const fields = engine.readFields(doc.getElementById("f"), doc);
  return { doc, fields, window: d.window };
}

afterEach(() => {
  // @ts-expect-error test stub
  delete globalThis.window;
  // @ts-expect-error test stub
  delete globalThis.Event;
});

describe("reading the form", () => {
  it("sees a dropdown at all", () => {
    // The measured failure: the reader queried textarea/input/contenteditable,
    // so every <select> on every form was invisible. Gender is a required
    // select on Keka and is the field that blocked those applications.
    const { fields } = dom(`
      <label for="gender">Gender *</label>
      <select id="gender" required>
        <option>Select an option</option><option>Male</option><option>Female</option>
      </select>`);
    const g = fields.find((f: any) => f.label.startsWith("Gender"));
    expect(g).toBeTruthy();
    expect(g.kind).toBe("select");
    expect(g.required).toBe(true);
    expect(g.options).toEqual(["Select an option", "Male", "Female"]);
  });

  it("does not mistake a dropdown's placeholder for an answer", () => {
    // "Select an option" is Keka's placeholder. Reading it as a value marks the
    // field answered and it is never filled — the form then rejects the submit.
    const { fields } = dom(`
      <label for="g">Gender *</label>
      <select id="g" required><option selected>Select an option</option><option>Male</option></select>`);
    expect(fields.find((f: any) => f.label.startsWith("Gender")).value).toBe("");
  });

  it("keeps a vendor's own default, which IS an answer", () => {
    // Keka presets the phone country code and the salary currency. Re-asking
    // those blocked submits, so a real chosen value must survive.
    const { fields } = dom(`
      <label for="cc">Country code</label>
      <select id="cc"><option>+91</option><option>+1</option></select>`);
    expect(fields.find((f: any) => f.label.startsWith("Country")).value).toBe("+91");
  });

  it("labels a field with its own question, not the whole section", () => {
    // Keka does not wire up label-for. Walking ancestors for the first text
    // over 8 characters returned the entire contact block, so the question came
    // back as "First Name * Last Name * Email *" and matched no stored answer.
    const { fields } = dom(`
      <div class="section">
        <div class="group"><label>First Name *</label><input id="fn"></div>
        <div class="group"><label>Gender *</label>
          <select id="gx"><option>Select an option</option><option>Male</option></select></div>
      </div>`);
    expect(fields.map((f: any) => f.label).sort()).toEqual(["First Name *", "Gender *"]);
  });

  it("still finds a label wired up the ordinary way", () => {
    const { fields } = dom(`<label for="e">Email *</label><input id="e" type="email">`);
    expect(fields[0].label).toBe("Email *");
  });
});

describe("the wire shape", () => {
  it("stamps each field with the index the plan will refer to", () => {
    const { fields } = dom(`
      <label for="a">First Name *</label><input id="a">
      <label for="b">Gender *</label><select id="b"><option>Male</option></select>`);
    const wire = engine.serializeFields(fields);
    expect(wire.map((w: any) => w.index)).toEqual([0, 1]);
    expect(wire[1].options).toEqual(["Male"]);
  });

  it("never sends the live element", () => {
    // The server answers from a snapshot and must never be handed a DOM node —
    // it would not survive JSON, and pretending otherwise hides the boundary.
    const { fields } = dom(`<label for="a">First Name *</label><input id="a">`);
    const wire = engine.serializeFields(fields);
    expect(JSON.stringify(wire)).toContain("First Name");
    expect(Object.keys(wire[0])).not.toContain("_el");
  });
});

describe("applying what the server decided", () => {
  it("types a text answer", () => {
    const { fields } = dom(`<label for="a">First Name *</label><input id="a">`);
    const out = engine.applyPlan(fields, {
      fills: [{ index: 0, value: "Mahendhar", kind: "text", label: "First Name *" }],
    });
    expect(out.filled).toBe(1);
    expect(fields[0]._el.value).toBe("Mahendhar");
  });

  it("actually selects a dropdown option", () => {
    // Assigning .value does not work here: the value attribute is rarely the
    // text the engine matched ("Male" may be value "2"), and frameworks ignore
    // a bare assignment.
    const { fields } = dom(`
      <label for="g">Gender *</label>
      <select id="g"><option value="0">Select an option</option>
      <option value="2">Male</option><option value="3">Female</option></select>`);
    const out = engine.applyPlan(fields, {
      fills: [{ index: 0, value: "Male", kind: "select", label: "Gender *" }],
    });
    expect(out.filled).toBe(1);
    expect(fields[0]._el.value).toBe("2");
  });

  it("leaves a dropdown EMPTY when the answer is not one of its options", () => {
    // A dropdown that looks answered but holds nothing is what gets a whole
    // application rejected at submit. Better to leave it and report it.
    const { fields } = dom(`
      <label for="g">Degree*</label>
      <select id="g"><option>Bachelor's Degree</option><option>Master's Degree</option></select>`);
    const out = engine.applyPlan(fields, {
      fills: [{ index: 0, value: "PhD in Astrophysics", kind: "select", label: "Degree*" }],
    });
    expect(out.filled).toBe(0);
    expect(out.missed).toEqual(["Degree*"]);
  });

  it("touches nothing the server left out of the plan", () => {
    // An omission means "we could not answer this honestly" — a decision, not
    // a gap for the browser to paper over with a guess.
    const { fields } = dom(`
      <label for="a">First Name *</label><input id="a">
      <label for="b">What is your CGPA?</label><input id="b">`);
    engine.applyPlan(fields, {
      fills: [{ index: 0, value: "Mahendhar", kind: "text", label: "First Name *" }],
    });
    expect(fields[1]._el.value).toBe("");
  });

  it("carries the server's refusals through to the caller", () => {
    const { fields } = dom(`<label for="a">What is your CGPA?</label><input id="a">`);
    const out = engine.applyPlan(fields, {
      fills: [],
      unanswered: [{ index: 0, label: "What is your CGPA?", required: true }],
    });
    expect(out.unanswered).toHaveLength(1);
    expect(out.filled).toBe(0);
  });

  it("survives a plan that refers to a field this page does not have", () => {
    // The page can re-render between the snapshot and the plan. That must cost
    // one field, not the whole application.
    const { fields } = dom(`<label for="a">First Name *</label><input id="a">`);
    const out = engine.applyPlan(fields, {
      fills: [
        { index: 0, value: "Mahendhar", kind: "text", label: "First Name *" },
        { index: 99, value: "ghost", kind: "text", label: "Gone" },
      ],
    });
    expect(out.filled).toBe(1);
    expect(out.missed).toEqual(["Gone"]);
  });

  it("survives an empty or malformed plan", () => {
    const { fields } = dom(`<label for="a">First Name *</label><input id="a">`);
    for (const plan of [null, undefined, {}, { fills: null }]) {
      expect(() => engine.applyPlan(fields, plan)).not.toThrow();
    }
  });
});

// ── the executor must ASK, not guess ─────────────────────────────────────

describe("the executor asks the server", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require("node:path");
  const EXEC = fs.readFileSync(
    path.join(__dirname, "..", "content", "executor.js"), "utf8");
  const BG = fs.readFileSync(
    path.join(__dirname, "..", "background.js"), "utf8");

  it("sends the form it read to the plan endpoint", () => {
    expect(EXEC).toMatch(/grindly:fillPlan/);
    expect(EXEC).toMatch(/serializeFields/);
    expect(BG).toMatch(/\/api\/extension\/plan/);
  });

  it("applies what came back rather than its own guess", () => {
    expect(EXEC).toMatch(/applyPlan/);
  });

  it("keeps a local fallback, because a bad API minute must not strand a student", () => {
    // The local engine is weaker but still refuses to invent anything, so
    // falling back is safe. Failing shut here would leave a half-read form in
    // somebody's tab with no explanation.
    expect(EXEC).toMatch(/applyFills/);
  });

  it("stops on a required question the server refused to answer", () => {
    // The refusal is the point of the whole system: the fact is not on file, and
    // sending anyway would put a guess in front of an employer under the user's
    // name. It must reach the user as something they can fix.
    expect(EXEC).toMatch(/serverRefusals/);
    expect(EXEC).toMatch(/missing_facts/);
  });

  it("never lets a job page see the API token", () => {
    // The content script runs on the employer's page. The token lives in the
    // background worker and the fetch happens there — a page that could ask for
    // a plan directly could ask for anything else too.
    expect(EXEC).not.toMatch(/Authorization/);
    expect(EXEC).not.toMatch(/Bearer/);
  });
});
