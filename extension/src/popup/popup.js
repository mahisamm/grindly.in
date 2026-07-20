/* Popup — shows connection state and a connect/disconnect control. */
function render(connected) {
  var dot = document.getElementById("dot");
  var txt = document.getElementById("stTxt");
  var connect = document.getElementById("connect");
  var disconnect = document.getElementById("disconnect");
  dot.className = "dot " + (connected ? "on" : "off");
  txt.textContent = connected ? "Connected to your Grindly account" : "Not connected";
  connect.style.display = connected ? "none" : "block";
  disconnect.style.display = connected ? "block" : "none";
}

chrome.runtime.sendMessage({ type: "grindly:status" }, function (resp) {
  render(!!(resp && resp.connected));
});

document.getElementById("disconnect").addEventListener("click", function () {
  chrome.runtime.sendMessage({ type: "grindly:disconnect" }, function () {
    render(false);
  });
});
