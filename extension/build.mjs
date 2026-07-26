#!/usr/bin/env node
/*
 * Package the extension into dist/grindly-extension-<version>.zip for the Chrome
 * Web Store. No third-party deps: uses the OS zip tool (`zip` on macOS/Linux,
 * PowerShell Compress-Archive on Windows). Validates the manifest first.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, "dist");

const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const version = manifest.version;

// --- validate ---------------------------------------------------------------
const problems = [];
for (const f of ["src/background.js", "src/fillEngine.js", "src/content/filler.js",
  "src/content/bridge.js", "src/popup/popup.html", "src/popup/popup.js",
  // The autopilot executor and its gate detection. Without these the packaged
  // extension still loads and still fills forms, but silently never runs a
  // task and never stops at a CAPTCHA — a build that looks fine and is not.
  "src/humanGate.js", "src/content/executor.js"]) {
  if (!fs.existsSync(path.join(root, f))) problems.push(`missing ${f}`);
}
if (!manifest.icons) {
  console.warn("⚠  No icons in manifest — add icons/ (see icons/README.md) before store submission.");
}
if (JSON.stringify(manifest.host_permissions).includes("<all_urls>")) {
  problems.push("host_permissions must not include <all_urls>");
}
if (problems.length) {
  console.error("Build blocked:\n  - " + problems.join("\n  - "));
  process.exit(1);
}

// --- stage ------------------------------------------------------------------
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });
const staging = path.join(dist, "pkg");
fs.mkdirSync(staging);
for (const entry of ["manifest.json", "src", "icons"]) {
  const from = path.join(root, entry);
  if (fs.existsSync(from)) fs.cpSync(from, path.join(staging, entry), { recursive: true });
}

// --- zip --------------------------------------------------------------------
const zipName = `grindly-extension-${version}.zip`;
const zipPath = path.join(dist, zipName);
try {
  if (process.platform === "win32") {
    execFileSync("powershell", [
      "-NoProfile", "-Command",
      `Compress-Archive -Path '${staging}\\*' -DestinationPath '${zipPath}' -Force`,
    ], { stdio: "inherit" });
  } else {
    execFileSync("zip", ["-r", "-q", zipPath, "."], { cwd: staging, stdio: "inherit" });
  }
  console.log(`✔ Built ${path.relative(process.cwd(), zipPath)} (v${version})`);
} catch (e) {
  console.error("Could not run the OS zip tool. Zip the contents of dist/pkg/ manually.");
  console.error(String(e.message || e));
  process.exit(1);
}
