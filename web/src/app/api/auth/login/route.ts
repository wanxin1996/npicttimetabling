import { NextResponse, type NextRequest } from "next/server";
import { attachSessionCookie } from "@/lib/auth";
import { loginUser } from "@/lib/database";
import { clearLoginFailures, loginRateLimitStatus, recordFailedLogin } from "@/lib/login-rate-limit";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  // Malformed public requests should receive a controlled response rather than a
  // framework error page that can expose unnecessary implementation details.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Enter a username and password." }, { status: 400 });
  }
  const credentials = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const username = typeof credentials.username === "string" ? credentials.username.trim() : "";
  const password = typeof credentials.password === "string" ? credentials.password : "";

  // Check before running password hashing, which is intentionally CPU intensive.
  const limit = loginRateLimitStatus(request, username);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Too many sign-in attempts. Wait 15 minutes and try again." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } },
    );
  }

  const result = username && password ? loginUser(username, password) : null;
  if (!result) {
    recordFailedLogin(request, username);
    return NextResponse.json({ error: "Username or password is incorrect." }, { status: 401 });
  }
  clearLoginFailures(request, username);
  const response = NextResponse.json({ user: result.user });
  attachSessionCookie(response, result.session.token, result.session.expiresAt);
  return response;
}
