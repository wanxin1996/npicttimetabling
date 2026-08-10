import { NextResponse, type NextRequest } from "next/server";
import { clearSessionCookie, sessionToken } from "@/lib/auth";
import { logoutSession } from "@/lib/database";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  // Delete the current server-side session when present, then always expire the
  // browser cookie so logout remains safe and idempotent.
  const token = sessionToken(request);
  if (token) logoutSession(token);
  const response = NextResponse.json({ ok: true });
  clearSessionCookie(response);
  return response;
}
