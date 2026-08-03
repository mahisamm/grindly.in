import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";

// Load the EXACT shipped content-script file, the same way fillEngine.test.ts
// does. humanGate.js cannot be an ES module: MV3 content_scripts do not load
// modules, and this file has to run on the job page itself.
let detectHumanGate: (doc: Document) => string | null;
let unansweredRequiredFields: (doc: Document) => string[];

beforeAll(() => {
  const code = fs.readFileSync(path.resolve(__dirname, "..", "humanGate.js"), "utf8");
  new Function(code)();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = (globalThis as any).GrindlyGate;
  detectHumanGate = g.detectHumanGate;
  unansweredRequiredFields = g.unansweredRequiredFields;
});

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
    // The old-fashioned kind: a distorted image and a box to type what it says.
    // Every marker above assumes a third-party widget, so none of them matched
    // Keka — which draws a plain <input id="captcha"> beside an image, and
    // which is 188 of our 256 employer listings. Measured on 22 of 22 tenants,
    // so this is the platform, not a few strict employers.
    //
    // Undetected, the page did not read as gated at all: the form filled, the
    // captcha box stayed empty because no honest answer exists for it, and we
    // either bounced off submit or clicked and reported "pressed but not
    // confirmed" — spending a daily slot on an application with no chance.
    ["a typed captcha box", "input#captcha"],
    ["a captcha box named anything", "input[name*='captcha' i]"],
    ["a captcha box with a vendor id", "input[id*='captcha' i]"],
    ["the captcha image itself", "img[src*='captcha' i]"],
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

  it.each([
    ["a registration fee asserted as required", "A registration fee is required to apply"],
    ["payment stated as mandatory", "Payment of ₹499 is required"],
    ["paying as the condition of applying", "Pay now to apply for this role"],
    ["card details demanded", "Card details are required to continue"],
    ["a paywall dressed as a subscription", "Subscribe to apply for unlimited internships"],
    // The negation guard must not swallow a real demand in a later sentence.
    ["a demand after an unrelated negation", "No experience required. Application fee required to apply."],
  ])("stops at %s rather than paying", (_label, text) => {
    // A fee to apply is also the classic internship scam, so proceeding would be
    // wrong even if paying were technically possible.
    expect(detectHumanGate(makeDoc({ text }))).toBe("payment");
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

describe("a page that mentions money but is not asking the applicant for any", () => {
  // Production evidence: real Internshala applications were abandoned with
  // reason "payment" on a board that charges nothing to apply. The old pattern
  // was `(payment|pay|fee|subscribe|card details)` within 40 characters of
  // `(required|to apply|continue)` across the WHOLE page, which ordinary board
  // furniture satisfies constantly. A false gate is not a safe failure: it
  // strands the application it exists to protect and tells the user the site
  // demanded money when it did not.
  it.each([
    ["a stipend beside a Continue button", "Stipend: ₹10,000 /month. Continue"],
    ["pay described as what the employer offers", "Pay: competitive. Continue to apply"],
    ["an unrelated course upsell", "Internshala Trainings — 40% off the certification fee. Subscribe"],
    ["a newsletter prompt", "Subscribe to our newsletter to continue reading"],
    ["a salary field label", "Expected pay required for this role"],
    ["reassurance that there is no fee", "There is no application fee to apply for this internship."],
  ])("does not call %s a payment gate", (_label, text) => {
    expect(detectHumanGate(makeDoc({ text }))).toBeNull();
  });
});

describe("gate evidence", () => {
  it("reports the text that triggered the gate, so a wrong gate can be found", () => {
    // A bare reason code was unfalsifiable from the server: "payment" arrived
    // with nothing saying which words on the page produced it.
    const g = (globalThis as { GrindlyGate?: { explainHumanGate: (d: Document) => { reason: string | null; evidence: string } } })
      .GrindlyGate!.explainHumanGate(
        makeDoc({ text: "A registration fee is required to apply" }),
      );
    expect(g.reason).toBe("payment");
    expect(g.evidence).toMatch(/registration fee/i);
  });

  it("carries no evidence when there is no gate", () => {
    const g = (globalThis as { GrindlyGate?: { explainHumanGate: (d: Document) => { reason: string | null; evidence: string } } })
      .GrindlyGate!.explainHumanGate(makeDoc({ text: "Tell us about yourself." }));
    expect(g).toEqual({ reason: null, evidence: "" });
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
