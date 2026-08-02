/* Popup — shows connection state and a connect/disconnect control. */
function render(connected) {
  var dot = document.getElementById("dot");
  var txt = document.getElementById("stTxt");
  var connect = document.getElementById("connect");
  var disconnect = document.getElementById("disconnect");
  var pasteBox = document.getElementById("pasteBox");
  dot.className = "dot " + (connected ? "on" : "off");
  txt.textContent = connected ? "Connected to your Grindly account" : "Not connected";
  connect.style.display = connected ? "none" : "block";
  disconnect.style.display = connected ? "block" : "none";
  pasteBox.style.display = connected ? "none" : "block";
  // Autopilot cannot claim a task without an account, so the control only
  // appears once there is one — an inert switch is worse than no switch.
  document.getElementById("autoBox").style.display = connected ? "block" : "none";
  document.getElementById("runNow").style.display = connected ? "block" : "none";
  if (connected) refreshAutopilot();
}

function renderAutopilot(on) {
  var sw = document.getElementById("autoSw");
  var hint = document.getElementById("autoHint");
  sw.className = "sw" + (on ? " on" : "");
  sw.setAttribute("aria-checked", on ? "true" : "false");
  // Say exactly what it does and what it still will not do. The dashboard
  // promises an agent that works on its own; this is where a user finds out
  // that a CAPTCHA or a question it cannot answer honestly still comes to them.
  hint.textContent = on
    ? "On — Grindly opens and fills one application at a time in this browser. It stops and asks you at any CAPTCHA, login, or question it can't answer honestly."
    : "Off — Grindly only fills forms you open yourself.";

  // The main hint used to say "You always click Submit yourself" unconditionally.
  // With autopilot on that is simply false, and a promise the product breaks is
  // worse than one it never made.
  var main = document.getElementById("hint");
  main.textContent = on
    ? "Autopilot is on: Grindly opens matched applications here and submits the ones it can complete honestly. You can also open any job yourself and click “Fill with Grindly”."
    : "Open a job on Internshala, LinkedIn, Naukri, Unstop or Indeed and click “Fill with Grindly”. You always click Submit yourself.";
}

function refreshAutopilot() {
  chrome.runtime.sendMessage({ type: "grindly:autopilot" }, function (resp) {
    renderAutopilot(!!(resp && resp.on));
  });
  refreshStatus();
}

function refreshStatus() {
  chrome.runtime.sendMessage({ type: "grindly:autopilotStatus" }, function (st) {
    var el = document.getElementById("autoStatus");
    if (!st || !st.text || st.text === "off") { el.style.display = "none"; return; }
    var mins = Math.round((Date.now() - (st.at || Date.now())) / 60000);
    el.style.display = "block";
    el.textContent = st.text + (mins > 0 ? " (" + mins + "m ago)" : "");
  });
  refreshWaiting();
}

// Applications that stopped for a human. Autopilot does not wait for them, so
// the status line above can say "Opening an application…" while three others
// sit half-finished in background tabs the user never noticed opening.
function refreshWaiting() {
  chrome.runtime.sendMessage({ type: "grindly:waiting" }, function (list) {
    var el = document.getElementById("waiting");
    var n = Array.isArray(list) ? list.length : 0;
    if (!n) { el.style.display = "none"; return; }
    el.style.display = "block";
    el.textContent = n === 1
      ? "1 application needs you — open it"
      : n + " applications need you — open the first";
  });
}

chrome.runtime.sendMessage({ type: "grindly:status" }, function (resp) {
  render(!!(resp && resp.connected));
});

document.getElementById("disconnect").addEventListener("click", function () {
  chrome.runtime.sendMessage({ type: "grindly:disconnect" }, function () {
    render(false);
  });
});

// Fallback pairing path for when the connect page's automatic handshake
// doesn't land (service worker asleep, timing race, etc — see the connect
// page's "Almost there" state, which shows this same code to copy).
document.getElementById("pasteBtn").addEventListener("click", function () {
  var input = document.getElementById("pasteInput");
  var msg = document.getElementById("pasteMsg");
  var code = (input.value || "").trim();
  msg.textContent = "";
  msg.className = "msg";
  if (!code) return;
  chrome.runtime.sendMessage({ type: "grindly:pairManual", token: code }, function (resp) {
    if (resp && resp.ok) {
      msg.textContent = "Connected.";
      msg.className = "msg ok";
      input.value = "";
      render(true);
    } else {
      msg.textContent = "Couldn't connect with that code — check it and try again.";
      msg.className = "msg err";
    }
  });
});

document.getElementById("autoSw").addEventListener("click", function () {
  var turningOn = this.className.indexOf("on") === -1;
  chrome.runtime.sendMessage(
    { type: "grindly:autopilot", on: turningOn },
    function (resp) { renderAutopilot(!!(resp && resp.on)); },
  );
});

document.getElementById("waiting").addEventListener("click", function () {
  chrome.runtime.sendMessage({ type: "grindly:focusWaiting" }, function () {
    // The popup closes as soon as that tab takes focus, so there is nothing
    // useful to re-render here.
  });
});

// Manual kick. Waiting on a five-minute timer to discover whether autopilot
// works at all is not a debugging experience anyone should have.
document.getElementById("runNow").addEventListener("click", function (event) {
  var btn = event.currentTarget;
  btn.disabled = true;
  btn.textContent = "Checking…";
  chrome.runtime.sendMessage({ type: "grindly:runNow" }, function () {
    btn.disabled = false;
    btn.textContent = "Check for work now";
    refreshStatus();
  });
});
