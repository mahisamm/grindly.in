import { NextRequest, NextResponse } from "next/server";

const SESSION_COOKIE = "ip_uid";

// Routes that require a valid session cookie to render at all.
// The actual user-existence check happens server-side in the page/API, but
// we block the request at the edge so the page HTML is never sent to an
// unauthenticated browser — eliminating the "Loading..." flash vulnerability.
const PROTECTED = [
  "/dashboard",
  "/applications",
  "/onboarding",
];

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  const isProtected = PROTECTED.some(
    (p) => pathname === p || pathname.startsWith(p + "/")
  );

  if (isProtected) {
    const session = req.cookies.get(SESSION_COOKIE);
    if (!session?.value) {
      const loginUrl = req.nextUrl.clone();
      loginUrl.pathname = "/login";
      loginUrl.search = "";
      return NextResponse.redirect(loginUrl, 307);
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*", "/applications/:path*", "/onboarding/:path*"],
};
