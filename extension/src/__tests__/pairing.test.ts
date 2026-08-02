/**
 * Pairing, end to end — the one flow that had never once succeeded.
 *
 * Production had zero pairings. Not a few, none, across every user who ever
 * reached the page. Everything downstream of it — autopilot, the executor, the
 * server-side fill plan — was unreachable, and none of it could have been
 * noticed by testing those parts, because each works perfectly given a token.
 *
 * The cause was an ordering race with no second chance. The connect page pings
 * once from a React effect; bridge.js runs at document_idle. When hydration won,
 * the ping went out before any listener existed — window.postMessage is not
 * queued — and the attribute the page checks had not been set yet either. The
 * page concluded the extension was absent and rendered a "Coming soon" notice
 * with a link back to the dashboard. The paste-a-code fallback existed, but the
 * only way to reach it was the Connect button that branch did not draw.
 *
 * So these tests run the REAL bridge in both orderings, and assert the page can
 * always get to a pairing code regardless of what detection concluded.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..", "..");
const BRIDGE = fs.readFileSync(
  path.join(ROOT, "extension", "src", "content", "bridge.js"), "utf8");
const BACKGROUND = fs.readFileSync(
  path.join(ROOT, "extension", "src", "background.js"), "utf8");
const PAGE = fs.readFileSync(
  path.join(ROOT, "src", "app", "extension", "connect", "page.tsx"), "utf8");

const ORIGIN = "https://grindly.in";

type Msg = Record<string, unknown>;

/** A page: a window with real postMessage semantics and an <html> element. */
function makePage(pathname = "/extension/connect") {
  const listeners: ((e: { source: unknown; data: Msg; origin: string }) => void)[] = [];
  const attrs: Record<string, string> = {};
  const attrWatchers: (() => void)[] = [];
  const win = {
    location: { origin: ORIGIN, pathname },
    addEventListener: (t: string, fn: (e: never) => void) => {
      if (t === "message") listeners.push(fn as never);
    },
    removeEventListener: () => {},
    // The real thing: delivered to whoever is listening AT THIS MOMENT. A
    // listener registered afterwards never sees it. That is the whole bug.
    postMessage: (data: Msg) => {
      for (const fn of [...listeners]) fn({ source: win, data, origin: ORIGIN });
    },
  };
  const documentElement = {
    setAttribute: (k: string, v: string) => {
      attrs[k] = v;
      attrWatchers.forEach((f) => f());
    },
    getAttribute: (k: string) => attrs[k] ?? null,
  };
  return { win, documentElement, attrs, listeners, attrWatchers };
}

/** Run bridge.js against a page, with a stub extension runtime. */
function runBridge(page: ReturnType<typeof makePage>, connected = false) {
  const chrome = {
    runtime: {
      sendMessage: (msg: Msg, cb?: (r: Msg) => void) => {
        if (!cb) return;
        // Answered on a later turn, exactly like a real service-worker round
        // trip — a synchronous stub would hide any ordering problem here.
        queueMicrotask(() => {
          if (msg.type === "grindly:status") cb({ connected });
          else if (msg.type === "grindly:pair") cb({ ok: true });
          else cb({});
        });
      },
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  new Function("window", "document", "chrome", BRIDGE)(
    page.win, { documentElement: page.documentElement }, chrome);
}

/** What the page's effect does, in the order it does it. */
function mountPage(page: ReturnType<typeof makePage>) {
  const seen = { present: false, paired: null as boolean | null };
  page.win.addEventListener("message", (e: { source: unknown; data: Msg }) => {
    if (e.source !== page.win || !e.data) return;
    if (e.data.type === "grindly-ext:pong") seen.present = true;
    if (e.data.type === "grindly-ext:paired") seen.paired = !!e.data.ok;
  });
  const syncPresence = () => {
    if (page.documentElement.getAttribute("data-grindly-extension")) seen.present = true;
  };
  syncPresence();
  // Stands in for the MutationObserver on data-grindly-extension.
  page.attrWatchers.push(syncPresence);
  page.win.postMessage({ type: "grindly-ext:ping" });
  return seen;
}

const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => { vi.restoreAllMocks(); });

describe("the extension is found whichever loads first", () => {
  it("bridge first: the attribute is already waiting", async () => {
    const page = makePage();
    runBridge(page);
    const seen = mountPage(page);
    await settle();
    expect(seen.present).toBe(true);
  });

  it("page first: the bridge announces itself to a listener that exists", async () => {
    // THE BUG. The page's one ping is delivered to nobody, because the bridge
    // has not run yet. Before the announce, nothing ever corrected that.
    const page = makePage();
    const seen = mountPage(page);
    expect(seen.present).toBe(false); // ping lost, as it always was
    runBridge(page);
    await settle();
    expect(seen.present).toBe(true);
  });

  it("the attribute alone is enough, even if every message is lost", async () => {
    const page = makePage();
    const seen = mountPage(page);
    // Set by the bridge; the page watches for it.
    page.documentElement.setAttribute("data-grindly-extension", "0.7.0");
    expect(seen.present).toBe(true);
  });

  it("stays absent when there is genuinely no extension", async () => {
    const page = makePage();
    const seen = mountPage(page);
    await settle();
    expect(seen.present).toBe(false);
  });
});

describe("handing the token over", () => {
  it("relays a token posted by the connect page and reports back", async () => {
    const page = makePage();
    runBridge(page);
    const seen = mountPage(page);
    page.win.postMessage({ type: "grindly-ext:pair", token: "tok_abc" });
    await settle();
    expect(seen.paired).toBe(true);
  });

  it("refuses to pair from any other page on the origin", async () => {
    // The bridge runs on all of grindly.in — it has to, for the dashboard's
    // presence check. Without this, an XSS anywhere on the origin could
    // silently re-pair the extension to a token of the attacker's choosing.
    const page = makePage("/dashboard");
    runBridge(page);
    const seen = mountPage(page);
    page.win.postMessage({ type: "grindly-ext:pair", token: "tok_evil" });
    await settle();
    expect(seen.paired).toBe(null);
  });

  it("ignores a message that did not come from this window", async () => {
    const page = makePage();
    runBridge(page);
    let relayed = false;
    // A frame posting in pretends to be the page. e.source !== window rejects it.
    for (const fn of page.listeners) {
      fn({ source: {}, data: { type: "grindly-ext:pair", token: "tok_frame" }, origin: ORIGIN });
    }
    await settle();
    expect(relayed).toBe(false);
    relayed = false;
  });

  it("only the background ever holds the token", () => {
    // The bridge hands it straight on and keeps nothing. A content script's
    // storage is reachable from the page's own origin in ways the service
    // worker's is not.
    expect(BRIDGE).not.toMatch(/chrome\.storage/);
    expect(BACKGROUND).toMatch(/chrome\.storage\.local\.set\(\{ \[TOKEN_KEY\]/);
  });

  it("the background checks the origin by parsing it, not by prefix", () => {
    // "https://grindly.in.evil.com".startsWith("https://grindly.in") is true.
    expect(BACKGROUND).toMatch(/new URL\(sender\.url\)\.origin === API_BASE/);
  });
});

describe("the connect page can always reach a pairing code", () => {
  it("offers Connect without waiting to detect the extension", () => {
    // The dead end: `phase === "ready" && extPresent` drew the button, and the
    // else-branch drew "Coming soon" and a link away. Detection is a race, so
    // that branch was reachable with the extension installed and working — and
    // from it there was no route to pairing at all.
    expect(PAGE).not.toMatch(/phase === "ready" && extPresent/);
    expect(PAGE).not.toMatch(/phase === "ready" && !extPresent/);
    expect(PAGE).toMatch(/\{phase === "ready" && \(/);
    // Rendered output only. The JSX comment above that block explains the dead
    // end by quoting the copy it used to show, and a guard that trips on its
    // own explanation is one nobody can write the explanation for.
    const rendered = PAGE.replace(/\{?\/\*[\s\S]*?\*\/\}?/g, "");
    expect(rendered).not.toMatch(/Coming soon/);
  });

  it("mints the token before it needs the extension to answer", () => {
    // So a failed handshake still leaves something to paste, rather than
    // nothing.
    const connect = PAGE.slice(PAGE.indexOf("const connect"), PAGE.indexOf("<main"));
    expect(connect).toContain("setToken");
    expect(connect.indexOf("setToken")).toBeLessThan(connect.indexOf("grindly-ext:pair"));
    expect(connect).toMatch(/no_extension/);
  });

  it("keeps looking for the extension instead of deciding once", () => {
    expect(PAGE).toMatch(/MutationObserver/);
    expect(PAGE).toMatch(/setInterval/);
  });

  it("stops looking, so the page does not ping forever", () => {
    expect(PAGE).toMatch(/clearInterval\(retry\)/);
  });

  it("links to an extension the server can actually serve", () => {
    // dist/ is gitignored, so the built extension used to exist only on the
    // machine that packaged it — never committed, never deployed, and never
    // linked from anywhere. "Install the extension" is not an instruction
    // anyone can follow when there is nowhere to install it from.
    expect(PAGE).toMatch(/href="\/grindly-extension\.zip"/);
    const zip = path.join(ROOT, "public", "grindly-extension.zip");
    expect(fs.existsSync(zip), "run `node extension/build.mjs`").toBe(true);
    expect(fs.statSync(zip).size).toBeGreaterThan(10_000);
  });

  it("serves the same version the source manifest declares", () => {
    // A stale zip is worse than a missing one: someone installs it, pairs, and
    // meets bugs that were fixed weeks ago. Checked against the sidecar the
    // build writes, because the zip itself is deflated — the version string
    // does not survive verbatim inside it — and mtimes do not survive git.
    const published = JSON.parse(
      fs.readFileSync(path.join(ROOT, "public", "grindly-extension.json"), "utf8"));
    const source = JSON.parse(
      fs.readFileSync(path.join(ROOT, "extension", "manifest.json"), "utf8"));
    expect(published.version,
      "published zip is stale — run `node extension/build.mjs`").toBe(source.version);
  });
});
