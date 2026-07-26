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
  }
  return out;
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
      case "grindly:taskEvent":
        sendResponse(await reportTask(msg.taskId, msg.leaseToken, msg.event, msg.extra));
        break;
      case "grindly:autopilot":
        // Popup only (sender.tab is unset there) — a job page must never be
        // able to switch autopilot on for the user.
        if (sender.tab) { sendResponse({ error: "forbidden" }); break; }
        if (typeof msg.on === "boolean") await setAutopilot(msg.on);
        sendResponse({ on: await autopilotOn() });
        break;
      case "grindly:activeTask":
        sendResponse((await chrome.storage.local.get(TASK_STATE_KEY))[TASK_STATE_KEY] || null);
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

async function autopilotOn() {
  return !!(await chrome.storage.local.get(AUTOPILOT_KEY))[AUTOPILOT_KEY];
}

async function setAutopilot(on) {
  await chrome.storage.local.set({ [AUTOPILOT_KEY]: !!on });
  if (on) {
    chrome.alarms.create(ALARM, { periodInMinutes: 5 });
  } else {
    await chrome.alarms.clear(ALARM);
    // Leave any in-flight task alone: its lease expires on its own, and the
    // server will only requeue it after confirming it never submitted.
  }
}

async function tick() {
  if (!(await autopilotOn())) return;
  // Never stack tasks: if one is still leased, that tab is mid-application.
  const active = (await chrome.storage.local.get(TASK_STATE_KEY))[TASK_STATE_KEY];
  if (active) return;

  const out = await claimTask();
  if (!out || !out.task) return;
  // Hand the task's profile to the executor through the same stored record, so
  // the content script never has to hold the extension token to get it.
  await chrome.storage.local.set({
    [TASK_STATE_KEY]: { ...out.task, profile: out.profile },
  });
  chrome.tabs.create({ url: out.task.url, active: false });
}

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) tick();
});
