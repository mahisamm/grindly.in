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
