import { NextResponse } from "next/server";

// Served as /sw.js (via rewrite in next.config.ts).
// Injecting NEXT_PUBLIC_BUILD_ID ensures the cache name changes on every deploy,
// forcing stale assets to be evicted without a manual version bump.
export async function GET() {
  const build = process.env.NEXT_PUBLIC_BUILD_ID || Date.now().toString();
  const cacheName = `grindly-${build}`;

  const body = `
const CACHE = ${JSON.stringify(cacheName)};
const OFFLINE_PAGE = "/offline";
const STATIC_ASSETS = ["/", "/login", "/offline", "/favicon.svg", "/manifest.json"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(STATIC_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (url.pathname.startsWith("/api/")) return;

  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() =>
        caches.match(e.request).then((cached) => cached ?? caches.match(OFFLINE_PAGE))
      )
  );
});
`.trim();

  return new NextResponse(body, {
    headers: {
      "Content-Type": "application/javascript",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Service-Worker-Allowed": "/",
    },
  });
}
