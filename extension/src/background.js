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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg && msg.type) {
      case "grindly:pair":
        // Relayed by the grindly.in bridge content script after the user paired
        // on the site. We trust it only because it came from a grindly.in tab.
        if (sender.url && sender.url.startsWith(API_BASE) && msg.token) {
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
      default:
        sendResponse({ error: "unknown" });
    }
  })();
  return true; // async sendResponse
});
