import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * The bug this file exists for.
 *
 * A live autopilot run on Internshala filled the form, pressed a button, waited,
 * and reported "sent but the site did not confirm". The screenshot showed why:
 * the apply modal was still open, untouched, Submit unpressed. The listing page
 * BEHIND the modal has its own "Apply now" button — still visible, and earlier
 * in the DOM — and a first-match scan clicked that instead. It re-opened a modal
 * that was already open, so nothing was ever submitted.
 *
 * So the page shape is rebuilt here: background "Apply now" first, real "Submit"
 * second, an overlay covering the first.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let GS: any;

beforeAll(() => {
  const code = fs.readFileSync(
    path.resolve(__dirname, "..", "submitTarget.js"), "utf8",
  );
  new Function(code)();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  GS = (globalThis as any).GrindlySubmit;
});

type Btn = {
  innerText: string;
  disabled?: boolean;
  rect: { left: number; top: number; width: number; height: number };
  covered?: boolean;
};

/** A document whose elementFromPoint honours which elements sit under an overlay. */
function docOf(buttons: Btn[]): Document {
  const overlay = { tag: "overlay", contains: () => false };
  const els = buttons.map((b) => {
    const el = {
      innerText: b.innerText,
      disabled: !!b.disabled,
      getBoundingClientRect: () => b.rect,
      scrollIntoView: () => {},
      contains: (n: unknown) => n === el,
      _covered: !!b.covered,
    };
    return el;
  });
  return {
    querySelectorAll: () => els,
    elementFromPoint: (x: number, y: number) => {
      for (const el of els) {
        const r = el.getBoundingClientRect();
        if (x < r.left || x > r.left + r.width) continue;
        if (y < r.top || y > r.top + r.height) continue;
        return el._covered ? overlay : el;
      }
      return null;
    },
  } as unknown as Document;
}

const R = (top: number) => ({ left: 100, top, width: 120, height: 40 });

describe("picking the button that actually sends the application", () => {
  it("ignores the page's own 'Apply now' hiding under the modal", () => {
    const doc = docOf([
      { innerText: "Apply now", rect: R(400), covered: true }, // behind the modal
      { innerText: "Submit", rect: R(900) },                   // in the modal
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((GS.pick(doc) as any).innerText).toBe("Submit");
  });

  it("prefers Submit over Apply even when nothing is covered", () => {
    // DOM order must not decide this. "Apply" typically OPENS a form; "Submit"
    // sends one.
    const doc = docOf([
      { innerText: "Apply now", rect: R(400) },
      { innerText: "Submit", rect: R(900) },
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((GS.pick(doc) as any).innerText).toBe("Submit");
  });

  it("still uses Apply when that is genuinely the only send button", () => {
    const doc = docOf([{ innerText: "Apply now", rect: R(400) }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((GS.pick(doc) as any).innerText).toBe("Apply now");
  });

  it("returns nothing when every candidate is unreachable", () => {
    // Handing the page back to the user beats clicking a button they cannot see
    // being pressed.
    const doc = docOf([{ innerText: "Submit", rect: R(400), covered: true }]);
    expect(GS.pick(doc)).toBeNull();
  });

  it("skips a disabled Submit", () => {
    const doc = docOf([
      { innerText: "Submit", rect: R(400), disabled: true },
      { innerText: "Apply now", rect: R(900) },
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((GS.pick(doc) as any).innerText).toBe("Apply now");
  });

  it("skips a button that renders at zero size", () => {
    const doc = docOf([
      { innerText: "Submit", rect: { left: 0, top: 0, width: 0, height: 0 } },
    ]);
    expect(GS.pick(doc)).toBeNull();
  });
});

describe("what counts as a send button at all", () => {
  it.each([
    ["Submit", 5],
    ["Submit application", 5],
    ["Send application", 5],
    ["Apply now", 2],
    ["Apply", 2],
  ])("scores %s", (label, want) => {
    expect(GS.score(label)).toBe(want);
  });

  it.each(["Cancel", "Edit resume", "Save draft", "Back", "Login", ""])(
    "refuses to treat %s as a send button",
    (label) => {
      expect(GS.score(label)).toBe(0);
    },
  );

  it("ignores a whole paragraph that happens to start with 'apply'", () => {
    // Some pages put their terms text inside a clickable div with role=button.
    expect(
      GS.score("Apply to this internship and we will share your profile with"),
    ).toBe(0);
  });
});
