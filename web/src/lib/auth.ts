import type { NextRequest, NextResponse } from "next/server";

export const SESSION_COOKIE = "timetable_session";

export function sessionToken(request: NextRequest) {
  // Keeping cookie access in one helper prevents route and proxy code from using
  // different names or authentication behaviour.
  return request.cookies.get(SESSION_COOKIE)?.value ?? "";
}

export function attachSessionCookie(response: NextResponse, token: string, expiresAt: string) {
  // HttpOnly blocks client-side scripts from reading the bearer token; SameSite
  // Strict is safe because this internal tool has no cross-site sign-in flow.
  response.cookies.set(SESSION_COOKIE, token, { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", priority: "high", path: "/", expires: new Date(expiresAt) });
}

export function clearSessionCookie(response: NextResponse) {
  // Clear with the same security attributes and path used when the cookie was set,
  // ensuring every supported browser removes the correct credential.
  response.cookies.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", priority: "high", path: "/", expires: new Date(0) });
}
