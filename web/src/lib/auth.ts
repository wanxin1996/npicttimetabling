import type { NextRequest, NextResponse } from "next/server";

export const SESSION_COOKIE = "timetable_session";

export function sessionToken(request: NextRequest) {
  // Keeping cookie access in one helper prevents route and proxy code from using
  // different names or authentication behaviour.
  return request.cookies.get(SESSION_COOKIE)?.value ?? "";
}

export function attachSessionCookie(response: NextResponse, token: string, expiresAt: string) {
  // HttpOnly blocks client-side scripts from reading the bearer token; SameSite
  // protects normal local use against cross-site form submissions.
  response.cookies.set(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", expires: new Date(expiresAt) });
}

export function clearSessionCookie(response: NextResponse) {
  response.cookies.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", expires: new Date(0) });
}
