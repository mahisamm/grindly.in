/*
 * Grindly extension — background service worker.
 *
 * This is the ONLY place the extension token lives. Content scripts running on
 * job-platform pages (linkedin.com etc.) never see it: they ask the background
 * for a kit, the background does the authenticated fetch to grindly.in and
 * returns just the kit data. So a hostile page can't read the token even if it
 * compromised a content script.
 */

const API_BASE = "https://grindly.in";
const TOKEN_KEY = "grindly_token";

async function getToken() {
  const o = await chrome.storage.local.get(TOKEN_KEY);
  return o[TOKEN_KEY] || null;
}

async function setToken(token) {
  await chrome.storage.local.set({ [TOKEN_KEY]: token });
}

async function clearToken() {
  await chrome.storage.local.remove(TOKEN_KEY);
}

// Fetch the kit for a given job URL. Returns { matched, ... } or { error }.
async function fetchKit(jobUrl) {
  const token = await getToken();
  if (!token) return { error: "not_connected" };
  try {
    const res = await fetch(`${API_BASE}/api/extension/kit?url=${encodeURIComponent(jobUrl)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401) {
      await clearToken();
      return { error: "not_connected" };
    }
    if (!res.ok) return { error: "server_error" };
    return await res.json();
  } catch {
    return { error: "network" };
  }
}

// ---- Autopilot: leased browser tasks ---------------------------------------
//
// The server hands out one task at a time under a short lease. The token stays
// here, in the service worker, exactly like the kit token — a content script on
// a job page never sees it, so a hostile page cannot claim tasks or report
// submissions even if it fully compromised that script.
//
// The lease is the safety property: if this browser closes mid-fill the lease
// expires and the task returns to the queue, but only from states that prove
// nothing was submitted. That is what stops a closed tab becoming a duplicate
// application.

const TASK_STATE_KEY = "grindly_task";

async function authedFetch(path, init) {
  const token = await getToken();
  if (!token) return { error: "not_connected" };
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        ...(init && init.headers),
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });
    if (res.status === 401) {
      await clearToken();
      return { error: "not_connected" };
    }
    if (!res.ok) return { error: `http_${res.status}` };
    return await res.json();
  } catch {
    return { error: "network" };
  }
}

/** Ask for work. Returns { task, profile } or { task: null, reason }. */
async function claimTask() {
  const out = await authedFetch("/api/extension/tasks/claim", { method: "POST" });
  if (out && out.task) {
    // Remember the lease so a service-worker restart can still report on it.
    await chrome.storage.local.set({ [TASK_STATE_KEY]: out.task });
  }
  return out;
}

/**
 * Report progress. The client never names a STATE, only an event — the server's
 * transition table decides what that means. A client that could set "submitted"
 * itself could inflate someone's application count.
 */
async function reportTask(taskId, leaseToken, event, extra) {
  const body = JSON.stringify({ leaseToken, event, ...(extra || {}) });
  const out = await authedFetch(`/api/extension/tasks/${taskId}/event`, {
    method: "POST", body,
  });
  if (event === "submitted" || event === "failed" || event === "awaiting_human") {
    await chrome.storage.local.remove(TASK_STATE_KEY);
    // This task is done, so take the next one now rather than idling until the
    // alarm comes round. Waiting five minutes between applications made
    // autopilot look like it only worked when the user pressed the button —
    // which, from the outside, is exactly what it looked like.
    scheduleNextTick();
  }
  return out;
}

// A short pause before the next task: enough that a queue of instant failures
// cannot become a hot loop, short enough that the browser keeps working.
const CHAIN_DELAY_MS = 5000;
let chainTimer = null;

function scheduleNextTick() {
  if (chainTimer) clearTimeout(chainTimer);
  chainTimer = setTimeout(() => { chainTimer = null; tick(); }, CHAIN_DELAY_MS);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg && msg.type) {
      case "grindly:pair": {
        // Relayed by the grindly.in bridge content script after the user paired
        // on the site. We trust it only because it came from a grindly.in tab —
        // checked by parsed origin, not a string prefix (a prefix match would
        // also accept "https://grindly.in.evil.com" if the manifest's match
        // pattern is ever loosened).
        let originOk = false;
        try {
          originOk = !!sender.url && new URL(sender.url).origin === API_BASE;
        } catch { /* malformed sender.url — treat as untrusted */ }
        if (originOk && msg.token) {
          await setToken(msg.token);
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false });
        }
        break;
      }
      case "grindly:pairManual":
        // Manual "paste code" fallback in the popup, for when the automatic
        // handshake above doesn't land. Trusted because it can only come from
        // our own popup page, never a content script on a web page: sender.tab
        // is only set for messages relayed from a tab's content script.
        if (!sender.tab && msg.token) {
          await setToken(msg.token);
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false });
        }
        break;
      case "grindly:status": {
        const token = await getToken();
        sendResponse({ connected: !!token });
        break;
      }
      case "grindly:disconnect":
        await clearToken();
        sendResponse({ ok: true });
        break;
      case "grindly:getKit":
        sendResponse(await fetchKit(msg.url));
        break;
      case "grindly:claimTask":
        // Only from our own popup/offscreen context, never a page's content
        // script: a job page must not be able to pull the next task.
        sendResponse(sender.tab ? { error: "forbidden" } : await claimTask());
        break;
      case "grindly:fillPlan": {
        // What to type, decided SERVER-SIDE.
        //
        // The extension is the hands: it runs in the student's own browser,
        // where a CAPTCHA has a person to answer it and the IP is residential.
        // The brain stays on the server, where forty-odd patterns for gender,
        // school, degree, years of experience and the refusals that stop it
        // inventing facts already live and are already tested. This message is
        // the wire between them.
        //
        // The content script cannot make this call itself: the token is held
        // here, and a job page must never see it.
        sendResponse(
          await authedFetch("/api/extension/plan", {
            method: "POST",
            body: JSON.stringify({
              fields: msg.fields || [],
              job: msg.job || {},
              coverLetter: msg.coverLetter || "",
            }),
          }),
        );
        break;
      }
      case "grindly:taskEvent": {
        const out = await reportTask(msg.taskId, msg.leaseToken, msg.event, msg.extra);
        // Autopilot opened this tab; autopilot cleans it up. Terminal states
        // only — a task at a human gate keeps its tab, because the page is now
        // the user's to finish. Without this, every completed application left
        // a background tab behind, and a day at the cap left five of them
        // (plus every gate) crowding the tab strip.
        //
        // sender.tab is the executor's OWN tab — the one the event is about —
        // and closing is gated on it matching the task we opened, so a report
        // relayed oddly can never close an unrelated tab.
        if (
          (msg.event === "submitted" || msg.event === "failed") &&
          sender.tab && typeof sender.tab.id === "number"
        ) {
          const tabId = sender.tab.id;
          // A beat first, so someone watching sees the confirmation banner
          // rather than a tab that blinks out mid-submit.
          setTimeout(() => { chrome.tabs.remove(tabId).catch?.(() => {}); }, 4000);
        }
        // A gate keeps its tab, so pool the interruption instead — see
        // "One knock, not five" below.
        if (msg.event === "awaiting_human" && sender.tab && typeof sender.tab.id === "number") {
          let host = "";
          try { host = new URL(sender.tab.url || "").hostname.replace(/^www\./, ""); } catch { /* keep "" */ }
          await noteWaiting({
            taskId: msg.taskId,
            tabId: sender.tab.id,
            host,
            reason: (msg.extra && msg.extra.reason) || "unknown_question",
            at: Date.now(),
          });
        }
        sendResponse(out);
        break;
      }
      case "grindly:autopilot":
        // Popup only (sender.tab is unset there) — a job page must never be
        // able to switch autopilot on for the user.
        if (sender.tab) { sendResponse({ error: "forbidden" }); break; }
        if (typeof msg.on === "boolean") await setAutopilot(msg.on);
        sendResponse({ on: await autopilotOn() });
        break;
      case "grindly:autopilotStatus":
        sendResponse((await chrome.storage.local.get(STATUS_KEY))[STATUS_KEY] || null);
        break;
      case "grindly:runNow":
        // Manual kick, so a user never has to wait on a timer to find out
        // whether this works.
        if (sender.tab) { sendResponse({ error: "forbidden" }); break; }
        await tick();
        sendResponse((await chrome.storage.local.get(STATUS_KEY))[STATUS_KEY] || null);
        break;
      case "grindly:activeTask":
        sendResponse((await chrome.storage.local.get(TASK_STATE_KEY))[TASK_STATE_KEY] || null);
        break;
      case "grindly:waiting":
        // For the popup. A notification can be missed or dismissed; opening the
        // extension must still show that three applications are sitting there
        // half-finished, or the count is only as reliable as the OS toast.
        if (sender.tab) { sendResponse({ error: "forbidden" }); break; }
        sendResponse(await pruneWaiting());
        break;
      case "grindly:focusWaiting":
        if (sender.tab) { sendResponse({ error: "forbidden" }); break; }
        await focusFirstWaiting();
        sendResponse({ ok: true });
        break;
      default:
        sendResponse({ error: "unknown" });
    }
  })();
  return true; // async sendResponse
});

// ---- Autopilot poll loop ----------------------------------------------------
//
// Opt-in per browser. While it is on, the worker asks for one task at a time and
// opens it in a tab; executor.js takes over there. One at a time on purpose —
// the daily cap is enforced server-side, and a browser that opened five
// application tabs at once would be both alarming to watch and easy to mistake
// for a bot.

const AUTOPILOT_KEY = "grindly_autopilot";
const ALARM = "grindly-autopilot-tick";
const STATUS_KEY = "grindly_autopilot_status";

/** Last thing autopilot did or decided, for the popup to show. */
async function setStatus(text) {
  await chrome.storage.local.set({
    [STATUS_KEY]: { text: String(text), at: Date.now() },
  });
}

async function autopilotOn() {
  return !!(await chrome.storage.local.get(AUTOPILOT_KEY))[AUTOPILOT_KEY];
}

async function setAutopilot(on) {
  await chrome.storage.local.set({ [AUTOPILOT_KEY]: !!on });
  if (on) {
    // delayInMinutes matters: with periodInMinutes alone the FIRST alarm does
    // not fire until a full period has passed. Turning Autopilot on and having
    // nothing happen for five minutes is indistinguishable from it being
    // broken — which is exactly how a live test read it, twice.
    chrome.alarms.create(ALARM, { delayInMinutes: 0.1, periodInMinutes: 5 });
    // And do not even wait for that: act on the click that asked for it.
    tick();
  } else {
    await chrome.alarms.clear(ALARM);
    // Leave any in-flight task alone: its lease expires on its own, and the
    // server will only requeue it after confirming it never submitted.
  }
}

async function tick() {
  if (!(await autopilotOn())) {
    await setStatus("off");
    return;
  }
  // Never stack tasks: if one is still leased, that tab is mid-application.
  const active = (await chrome.storage.local.get(TASK_STATE_KEY))[TASK_STATE_KEY];
  if (active) {
    // ...unless its lease has run out. A tab closed mid-application never
    // reports anything, and this record would otherwise sit here forever,
    // silently blocking every future tick. The server has already returned the
    // task to its queue by now, and only from states that prove nothing was
    // submitted.
    const expired = active.leaseExpiresAt && new Date(active.leaseExpiresAt) < new Date();
    if (!expired) {
      await setStatus("Working on an application…");
      return;
    }
    await chrome.storage.local.remove(TASK_STATE_KEY);
  }

  const out = await claimTask();
  if (!out || !out.task) {
    // Say WHY there is nothing to do. Without this the popup can only show
    // "on", and "on but idle" looks identical to "on but broken" — the single
    // thing that made this feature impossible to diagnose from the outside.
    await setStatus(
      out && out.reason
        ? { no_work: "No applications waiting right now.",
            not_ready: "Finish your Grindly setup before autopilot can run.",
            daily_cap: "That's your daily limit — Grindly will carry on tomorrow.",
            executor_disabled: "Autopilot is switched off on the Grindly server.",
            not_connected: "Reconnect this browser to your Grindly account." }[out.reason]
          || out.reason
        : "Could not reach Grindly.",
    );
    return;
  }
  await setStatus("Opening an application…");
  // Hand the task's kit to the executor through the same stored record, so the
  // content script never has to hold the extension token to get it.
  await chrome.storage.local.set({
    [TASK_STATE_KEY]: { ...out.task, kit: out.kit },
  });
  chrome.tabs.create({ url: out.task.url, active: false });
}

// ---- One knock, not five ----------------------------------------------------
//
// A task that hits a CAPTCHA, a login or a question we cannot answer honestly
// keeps its tab: the page is now the user's to finish. Autopilot does not wait
// for them — it releases the slot and takes the next task — so on a bad run
// five background tabs accumulate, each with a banner nobody has looked at,
// while the popup cheerfully reports progress. The work is genuinely blocked
// and the user is the last to know.
//
// So the tabs stay where they are, and the interruption is pooled: one
// notification for however many are waiting, after a short quiet period, so a
// run that stops on three forms knocks once instead of three times.

const WAITING_KEY = "grindly_waiting";
const NOTIFY_ALARM = "grindly-waiting-notify";
const NOTIFY_ID = "grindly-waiting";
// Creating an alarm that already exists replaces the pending one, so each new
// blocked task pushes the knock back — the debounce falls out of that. Half a
// minute is also the floor Chrome clamps alarms to in a packed extension;
// asking for less would quietly become this anyway.
const NOTIFY_DEBOUNCE_MIN = 0.5;

/** What the person is actually being asked for, in their words. */
const GATE_WORDS = {
  captcha: "a CAPTCHA",
  otp: "a code from your email or phone",
  login: "a sign-in",
  payment: "a payment step",
  unknown_question: "a question only you can answer",
  changed_form: "a check that it went through",
};

async function readWaiting() {
  const v = (await chrome.storage.local.get(WAITING_KEY))[WAITING_KEY];
  return Array.isArray(v) ? v : [];
}

async function noteWaiting(entry) {
  const list = await readWaiting();
  // A task can report a gate more than once (the modal check and the
  // pre-submit check are separate moments). Count the application, not the
  // reports, or one stubborn form reads as a pile-up.
  if (list.some((w) => w.taskId === entry.taskId)) return;
  list.push(entry);
  await chrome.storage.local.set({ [WAITING_KEY]: list });
  chrome.alarms.create(NOTIFY_ALARM, { delayInMinutes: NOTIFY_DEBOUNCE_MIN });
}

/** Forget anything whose tab is gone — closing it IS the user dealing with it. */
async function pruneWaiting() {
  const list = await readWaiting();
  const open = [];
  for (const w of list) {
    // eslint-disable-next-line no-await-in-loop
    const alive = await chrome.tabs.get(w.tabId).then(() => true, () => false);
    if (alive) open.push(w);
  }
  if (open.length !== list.length) {
    await chrome.storage.local.set({ [WAITING_KEY]: open });
  }
  return open;
}

async function flushWaiting() {
  const open = await pruneWaiting();
  if (!open.length) {
    chrome.notifications.clear(NOTIFY_ID);
    return;
  }
  const asks = [...new Set(open.map((w) => GATE_WORDS[w.reason] || "your input"))];
  const where = [...new Set(open.map((w) => w.host).filter(Boolean))];
  chrome.notifications.create(NOTIFY_ID, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title: open.length === 1
      ? "One application needs you"
      : `${open.length} applications need you`,
    // Name what is being asked and where. "Something needs your attention" is
    // the kind of notification people learn to dismiss without reading.
    message:
      `Grindly filled ${open.length === 1 ? "it" : "them"} and stopped for ` +
      `${asks.slice(0, 2).join(" and ")}. ` +
      `${where.slice(0, 2).join(", ")}${where.length > 2 ? ` and ${where.length - 2} more` : ""}. ` +
      `${open.length === 1 ? "The tab is" : "The tabs are"} open and waiting.`,
    priority: 1,
  });
}

/** Bring the oldest waiting tab to the front. */
async function focusFirstWaiting() {
  const open = await pruneWaiting();
  if (!open.length) return;
  const tab = await chrome.tabs.get(open[0].tabId).catch(() => null);
  if (!tab) return;
  await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
  if (typeof tab.windowId === "number") {
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  }
}

chrome.notifications.onClicked.addListener((id) => {
  if (id !== NOTIFY_ID) return;
  chrome.notifications.clear(NOTIFY_ID);
  focusFirstWaiting();
});

// Closing the tab is how someone says they are done with it — including
// "I don't want this one". Nothing here should nag about it again.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const list = await readWaiting();
  const next = list.filter((w) => w.tabId !== tabId);
  if (next.length === list.length) return;
  await chrome.storage.local.set({ [WAITING_KEY]: next });
  if (!next.length) chrome.notifications.clear(NOTIFY_ID);
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) tick();
  if (a.name === NOTIFY_ALARM) flushWaiting();
});

// A service worker is evicted when idle and a browser gets restarted. Without
// re-arming, autopilot silently stops after the first suspension and the user
// is never told — it just quietly never applies again.
chrome.runtime.onStartup.addListener(async () => {
  if (await autopilotOn()) {
    chrome.alarms.create(ALARM, { delayInMinutes: 0.1, periodInMinutes: 5 });
  }
});
chrome.runtime.onInstalled.addListener(async () => {
  if (await autopilotOn()) {
    chrome.alarms.create(ALARM, { delayInMinutes: 0.1, periodInMinutes: 5 });
  }
});
