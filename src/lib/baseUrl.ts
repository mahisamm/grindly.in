// Single source of truth for the app's public base URL. Historically some
// routes read NEXT_PUBLIC_APP_URL and others NEXT_PUBLIC_BASE_URL; if only one
// was set in prod the other path silently fell back to localhost (broken reset
// links / OAuth redirects). Accept either, prefer APP_URL, then the request
// origin, then localhost.
export function baseUrl(fallbackOrigin?: string): string {
  return (
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_BASE_URL ||
    fallbackOrigin ||
    "http://localhost:3000"
  );
}
