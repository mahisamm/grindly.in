import { describe, it, expect } from "vitest";
import { detectHumanGate, unansweredRequiredFields } from "../humanGate";

// The line between an assistant and a bot. Some controls on an application page
// exist SPECIFICALLY to confirm a person is present; Grindly's answer to every
// one of them is to stop and hand the page back — never to solve, outsource, or
// click past it. These tests are the enforcement of that promise.
//
// The document is a hand-rolled stub rather than jsdom: these functions already
// take `doc` as a parameter, so a fake keeps the suite dependency-free and makes
// each case state exactly which page condition it is describing.

type FakeEl = Record<string, unknown>;

function makeDoc(opts: {
  selectors?: Record<string, FakeEl | null>;
  text?: string;
  required?: FakeEl[];
}) {
  const selectors = opts.selectors ?? {};
  return {
    querySelector: (sel: string) => selectors[sel] ?? null,
    querySelectorAll: () => opts.required ?? [],
    body: { innerText: opts.text ?? "" },
  } as unknown as Document;
}

const visible = { offsetParent: {} };

describe("CAPTCHA and challenges", () => {
  it.each([
    ["reCAPTCHA iframe", "iframe[src*='recaptcha']"],
    ["hCaptcha widget", ".h-captcha"],
    ["Cloudflare challenge", "#cf-challenge-running"],
    ["a bare sitekey widget", "[data-sitekey]"],
  ])("stops at %s", (_label, selector) => {
    expect(detectHumanGate(makeDoc({ selectors: { [selector]: {} } }))).toBe("captcha");
  });
});

describe("other human gates", () => {
  it("stops at a visible password field even when no text says 'login'", () => {
    const doc = makeDoc({ selectors: { "input[type='password']": visible } });
    expect(detectHumanGate(doc)).toBe("login");
  });

  it("stops at a one-time code prompt", () => {
    expect(detectHumanGate(makeDoc({ text: "Enter the OTP sent to your phone" }))).toBe("otp");
  });

  it("stops at a payment demand rather than paying", () => {
    // A fee to apply is also the classic internship scam, so proceeding would be
    // wrong even if paying were technically possible.
    expect(
      detectHumanGate(makeDoc({ text: "A registration fee is required to apply" })),
    ).toBe("payment");
  });

  it("stops at a legal declaration the user must make personally", () => {
    expect(
      detectHumanGate(makeDoc({ text: "I certify that the above information is true" })),
    ).toBe("unknown_question");
  });

  it("stops at a login wall stated in words", () => {
    expect(detectHumanGate(makeDoc({ text: "Please sign in to continue" }))).toBe("login");
  });
});

describe("a normal application page", () => {
  it("is allowed to proceed", () => {
    const doc = makeDoc({
      text: "Apply for Software Development Intern. Tell us about yourself.",
    });
    expect(detectHumanGate(doc)).toBeNull();
  });

  it("is not tripped by a HIDDEN password field", () => {
    // Sites keep an offscreen password input for their own reasons; only a field
    // the user is actually being asked to fill is a login wall. Treating the
    // hidden one as a gate would strand every perfectly fillable application.
    const doc = makeDoc({ selectors: { "input[type='password']": { offsetParent: null } } });
    expect(detectHumanGate(doc)).toBeNull();
  });

  it("is not tripped by ordinary advice about passwords", () => {
    expect(
      detectHumanGate(makeDoc({ text: "Never share your password with recruiters." })),
    ).toBeNull();
  });
});

describe("unanswered required questions", () => {
  it("names the question that is blocking, not just that one exists", () => {
    const doc = makeDoc({
      required: [{ ...visible, type: "text", value: "", "aria-label": null,
                   getAttribute: () => "What is your CGPA?", id: "cgpa", name: "cgpa" }],
    });
    expect(unansweredRequiredFields(doc)).toEqual(["What is your CGPA?"]);
  });

  it("reports nothing when every required field is answered", () => {
    const doc = makeDoc({
      required: [{ ...visible, type: "text", value: "filled", getAttribute: () => null,
                   id: "a", name: "a" }],
    });
    expect(unansweredRequiredFields(doc)).toEqual([]);
  });

  it("counts a ticked checkbox as answered", () => {
    const doc = makeDoc({
      required: [{ ...visible, type: "checkbox", checked: true, getAttribute: () => null,
                   id: "c", name: "agree" }],
    });
    expect(unansweredRequiredFields(doc)).toEqual([]);
  });

  it("flags an unticked required checkbox", () => {
    const doc = makeDoc({
      required: [{ ...visible, type: "checkbox", checked: false,
                   getAttribute: () => "Accept terms", id: "c", name: "agree" }],
    });
    expect(unansweredRequiredFields(doc)).toEqual(["Accept terms"]);
  });

  it("ignores hidden fields, which the user cannot answer anyway", () => {
    const doc = makeDoc({
      required: [{ offsetParent: null, type: "hidden", value: "",
                   getAttribute: () => null, id: "h", name: "h" }],
    });
    expect(unansweredRequiredFields(doc)).toEqual([]);
  });
});
