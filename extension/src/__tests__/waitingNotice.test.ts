/**
 * One knock, not five.
 *
 * A task that stops at a CAPTCHA keeps its tab — the page is the user's to
 * finish now. Autopilot does not wait for them: it releases the slot and takes
 * the next task. So a bad run leaves several background tabs, each with a
 * banner nobody has looked at, while the popup reports progress. The work is
 * genuinely blocked and the user is the last to know.
 *
 * These run background.js in a stub `chrome` and check the pooling behaviour,
 * because the failure mode is not "no notification" — it is five of them, or
 * one that fires before the run has finished stopping.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SRC = fs.readFileSync(
  path.resolve(__dirname, "..", "background.js"), "utf8");

type Listener = (...args: unknown[]) => unknown;

/** A chrome stub with just enough of the API surface background.js touches. */
function makeChrome(tabs: Record<number, { id: number; url: string; windowId: number }>) {
  const store: Record<string, unknown> = {};
  const alarms: Record<string, unknown> = {};
  const notifications: Record<string, unknown> = {};
  const listeners: Record<string, Listener[]> = {};
  const on = (name: string) => ({
    addListener: (fn: Listener) => { (listeners[name] ||= []).push(fn); },
  });
  return {
    listeners,
    alarms,
    notifications,
    store,
    api: {
      storage: {
        local: {
          get: async (k: string) => ({ [k]: store[k] }),
          set: async (o: Record<string, unknown>) => { Object.assign(store, o); },
          remove: async (k: string) => { delete store[k]; },
        },
      },
      alarms: {
        // Real behaviour: creating an alarm that already exists REPLACES the
        // pending one. The debounce depends on that and nothing else.
        create: (name: string, opts: unknown) => { alarms[name] = opts; },
        clear: async () => {},
        onAlarm: on("alarm"),
      },
      notifications: {
        create: (id: string, opts: unknown) => { notifications[id] = opts; },
        clear: (id: string) => { delete notifications[id]; },
        onClicked: on("notifyClick"),
      },
      tabs: {
        get: async (id: number) => {
          if (!tabs[id]) throw new Error("No tab with id");
          return tabs[id];
        },
        update: async () => {},
        create: () => {},
        // Takes the id so a case can swap in a recorder — see the skipped-tab
        // test, which needs to know WHICH tab got closed.
        remove: async (_id: number) => {},
        onRemoved: on("tabRemoved"),
      },
      windows: { update: async () => {} },
      runtime: {
        getURL: (p: string) => `chrome-extension://x/${p}`,
        onMessage: on("message"),
        onStartup: on("startup"),
        onInstalled: on("installed"),
      },
    },
  };
}

/** Load background.js against the stub and hand back its message listener. */
function load(tabs: Record<number, { id: number; url: string; windowId: number }>) {
  const c = makeChrome(tabs);
  // @ts-expect-error test stub
  globalThis.chrome = c.api;
  globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })) as never;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  new Function(SRC)();
  const send = (msg: Record<string, unknown>, sender: Record<string, unknown>) =>
    new Promise((resolve) => {
      c.listeners.message[0](msg, sender, resolve);
    });
  const fireAlarm = async (name: string) => {
    c.listeners.alarm.forEach((fn) => fn({ name }));
    // The real onAlarm listener is synchronous and kicks off an async flush
    // without returning it — Chrome does not await event handlers either. So
    // awaiting the listener proves nothing; wait for a macrotask instead, which
    // drains the whole microtask queue behind it.
    await new Promise((r) => setTimeout(r, 0));
  };
  return { c, send, fireAlarm };
}

const gate = (taskId: string, reason: string) => ({
  type: "grindly:taskEvent", taskId, leaseToken: "lt", event: "awaiting_human",
  extra: { reason },
});

const TABS = {
  11: { id: 11, url: "https://acme.keka.com/careers/job/1", windowId: 1 },
  12: { id: 12, url: "https://beta.keka.com/careers/job/2", windowId: 1 },
  13: { id: 13, url: "https://gamma.freshteam.com/jobs/3", windowId: 1 },
  14: { id: 14, url: "https://delta.keka.com/careers/job/4", windowId: 1 },
};

beforeEach(() => {
  // @ts-expect-error test stub
  delete globalThis.chrome;
});

describe("pooling the interruptions", () => {
  it("does not knock at all until the quiet period is up", async () => {
    // Fire immediately and a run that stops on three forms interrupts three
    // times in twenty seconds, which is worse than not notifying.
    const { c, send } = load(TABS);
    await send(gate("t1", "captcha"), { tab: TABS[11] });
    expect(Object.keys(c.notifications)).toHaveLength(0);
    expect(c.alarms["grindly-waiting-notify"]).toBeTruthy();
  });

  it("sends ONE notification for three blocked applications", async () => {
    const { c, send, fireAlarm } = load(TABS);
    await send(gate("t1", "captcha"), { tab: TABS[11] });
    await send(gate("t2", "captcha"), { tab: TABS[12] });
    await send(gate("t3", "login"), { tab: TABS[13] });
    await fireAlarm("grindly-waiting-notify");
    const notes = Object.values(c.notifications) as { title: string; message: string }[];
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe("3 applications need you");
  });

  it("counts applications, not reports", async () => {
    // The executor checks for a gate more than once — before filling, on the
    // modal that just opened, and again before submitting. One stubborn form
    // must not read as a pile-up.
    const { c, send, fireAlarm } = load(TABS);
    await send(gate("t1", "captcha"), { tab: TABS[11] });
    await send(gate("t1", "captcha"), { tab: TABS[11] });
    await fireAlarm("grindly-waiting-notify");
    const notes = Object.values(c.notifications) as { title: string }[];
    expect(notes[0].title).toBe("One application needs you");
  });

  it("says what is being asked for and where", async () => {
    // "Something needs your attention" is the kind of notification people learn
    // to dismiss without reading.
    const { c, send, fireAlarm } = load(TABS);
    await send(gate("t1", "captcha"), { tab: TABS[11] });
    await fireAlarm("grindly-waiting-notify");
    const note = Object.values(c.notifications)[0] as { message: string };
    expect(note.message).toMatch(/CAPTCHA/);
    expect(note.message).toMatch(/acme\.keka\.com/);
  });

  it("forgets an application whose tab the user closed", async () => {
    // Closing the tab is how someone says they are done with it — including
    // "not this one". Nothing should nag about it again.
    const { c, send, fireAlarm } = load(TABS);
    await send(gate("t1", "captcha"), { tab: TABS[11] });
    await send(gate("t2", "captcha"), { tab: TABS[12] });
    await c.listeners.tabRemoved[0](11);
    await fireAlarm("grindly-waiting-notify");
    const note = Object.values(c.notifications)[0] as { title: string; message: string };
    expect(note.title).toBe("One application needs you");
    expect(note.message).toMatch(/beta\.keka\.com/);
  });

  it("stays silent when every tab is already gone", async () => {
    const { c, send, fireAlarm } = load(TABS);
    await send(gate("t1", "captcha"), { tab: TABS[11] });
    await c.listeners.tabRemoved[0](11);
    await fireAlarm("grindly-waiting-notify");
    expect(Object.keys(c.notifications)).toHaveLength(0);
  });

  it("does not pool a submission or a failure", async () => {
    // Those close their own tab. Only a gate leaves something for a person.
    const { c, send, fireAlarm } = load(TABS);
    await send(
      { type: "grindly:taskEvent", taskId: "t1", leaseToken: "lt", event: "submitted", extra: {} },
      { tab: TABS[11] },
    );
    await fireAlarm("grindly-waiting-notify");
    expect(Object.keys(c.notifications)).toHaveLength(0);
  });

  it("tells the popup too, because a toast can be missed", async () => {
    const { send } = load(TABS);
    await send(gate("t1", "captcha"), { tab: TABS[11] });
    const waiting = (await send({ type: "grindly:waiting" }, {})) as unknown[];
    expect(waiting).toHaveLength(1);
  });

  it("refuses to tell a job page what is waiting", async () => {
    // sender.tab is set for anything relayed from a page's content script.
    const { send } = load(TABS);
    await send(gate("t1", "captcha"), { tab: TABS[11] });
    expect(await send({ type: "grindly:waiting" }, { tab: TABS[11] }))
      .toEqual({ error: "forbidden" });
    expect(await send({ type: "grindly:focusWaiting" }, { tab: TABS[11] }))
      .toEqual({ error: "forbidden" });
  });
});

describe("the manifest allows it", () => {
  it("asks for the notifications permission", () => {
    // chrome.notifications throws without it, and the whole feature would be a
    // silent no-op that every test above still passes with a stub.
    const manifest = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, "..", "..", "manifest.json"), "utf8"));
    expect(manifest.permissions).toContain("notifications");
  });
});

describe("gates that are not worth interrupting anyone for", () => {
  const skip = (taskId: string, reason: string) => ({
    type: "grindly:taskEvent", taskId, leaseToken: "lt", event: "skipped",
    extra: { reason },
  });

  it("raises no notification for a skipped job", async () => {
    // The whole point: a job that asks for money, an OTP or an account is
    // declined on the user's behalf and they never hear about it.
    const { c, send, fireAlarm } = load(TABS);
    await send(skip("t1", "payment"), { tab: TABS[11] });
    await send(skip("t2", "otp"), { tab: TABS[12] });
    await fireAlarm("grindly-waiting-notify");
    expect(Object.keys(c.notifications)).toHaveLength(0);
  });

  it("still knocks for a CAPTCHA in the same run", async () => {
    // A CAPTCHA is one glance and a few keystrokes, and it is the reason this
    // runs in the user's own browser at all. It must not be swallowed by a run
    // that also skipped things.
    const { c, send, fireAlarm } = load(TABS);
    await send(skip("t1", "payment"), { tab: TABS[11] });
    await send(gate("t2", "captcha"), { tab: TABS[12] });
    await fireAlarm("grindly-waiting-notify");
    const note = Object.values(c.notifications)[0] as { title: string };
    expect(note.title).toBe("One application needs you");
  });

  it("closes the skipped tab but leaves a CAPTCHA tab open", async () => {
    // A skipped job leaves nothing to notice or tidy up. A CAPTCHA keeps its
    // tab, because that page is now the user's to finish.
    const { c, send } = load(TABS);
    const removed: number[] = [];
    c.api.tabs.remove = async (id: number) => { removed.push(id); };
    await send(skip("t9", "payment"), { tab: TABS[14] });
    await send(gate("t8", "captcha"), { tab: TABS[13] });
    await new Promise((r) => setTimeout(r, 4100));
    // Cases above leave 4s close timers pending, and those fire against
    // whichever `chrome` is global by then — this one. Look only at the tabs
    // this case owns.
    expect(removed.filter((id) => id === 13 || id === 14)).toEqual([14]);
  }, 10_000);
});
