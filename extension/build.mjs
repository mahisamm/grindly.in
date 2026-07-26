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
// Check every file the manifest actually references, rather than a list kept by
// hand here. The hand-kept version drifted the moment a new content script was
// added: the packaged extension would still load and still fill forms while
// silently never running a task or never stopping at a CAPTCHA — a build that
// looks fine and is not.
const referenced = [
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  ...(manifest.content_scripts ?? []).flatMap((cs) => [...(cs.js ?? []), ...(cs.css ?? [])]),
  ...Object.values(manifest.icons ?? {}),
].filter(Boolean);
for (const f of [...new Set(referenced), "src/popup/popup.js"]) {
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
