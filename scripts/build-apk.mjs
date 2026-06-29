/**
 * Build the Grindly Android APK (TWA — Trusted Web Activity).
 *
 * Prerequisites:
 *   - Java 11+ installed (java -version)
 *   - npm install -g @bubblewrap/cli
 *
 * Steps:
 *   1. Update `twa-manifest.json` → set "host" to your production domain
 *   2. Run: node scripts/build-apk.mjs
 *   3. APK lands in android/app/build/outputs/apk/release/app-release-unsigned.apk
 *      (or app-release.apk if you set up a keystore)
 *   4. Copy APK to public/grindly.apk so users can download it from the site
 *
 * First run: Bubblewrap will download Android SDK + build tools (~1.5 GB).
 * This only happens once — subsequent builds are fast.
 */

import { execSync } from "child_process";
import { existsSync, copyFileSync } from "fs";
import { join } from "path";

const root = process.cwd();

console.log("=== Grindly Android APK Build ===\n");

// Step 1: Initialize if android/ folder doesn't exist
if (!existsSync(join(root, "android"))) {
  console.log("Initializing Bubblewrap project (downloads Android SDK on first run)...");
  execSync("bubblewrap init --manifest ./twa-manifest.json", {
    stdio: "inherit",
    cwd: root,
  });
}

// Step 2: Build
console.log("\nBuilding APK...");
execSync("bubblewrap build", {
  stdio: "inherit",
  cwd: root,
});

// Step 3: Copy to public/
const apkSrc = join(root, "app-release-signed.apk");
const apkFallback = join(root, "app-release.apk");
const apkDest = join(root, "public", "grindly.apk");

const src = existsSync(apkSrc) ? apkSrc : existsSync(apkFallback) ? apkFallback : null;
if (src) {
  copyFileSync(src, apkDest);
  console.log(`\nAPK copied to public/grindly.apk`);
  console.log("Users can now download it from: /grindly.apk");
} else {
  console.log("\nBuild complete. Find APK in android/app/build/outputs/apk/");
  console.log("Copy it to public/grindly.apk to make it downloadable.");
}

console.log("\nDone!");
