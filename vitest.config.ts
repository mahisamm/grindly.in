import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    // extension/dist/ is a staged copy of extension/src/, tests included. Left
    // in, vitest collected and ran that copy — so a stale build reported its
    // own old assertions as passing, right next to the real ones. A build
    // output must never be a test input.
    exclude: ["**/node_modules/**", "**/.git/**", "**/dist/**"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
