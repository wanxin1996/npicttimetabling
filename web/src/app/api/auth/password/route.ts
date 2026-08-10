import { NextResponse, type NextRequest } from "next/server";
import { clearSessionCookie, sessionToken } from "@/lib/auth";
import { changeOwnPassword, validateSession } from "@/lib/database";

export const runtime = "nodejs";

export async function PATCH(request: NextRequest) {
  // Users may change only their own password and must present a valid current
  // session plus the existing password before all sessions are revoked.
  const token = sessionToken(request);
  const user = token ? validateSession(token) : null;
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const body = await request.json();
  if (typeof body.currentPassword !== "string" || typeof body.newPassword !== "string" || body.newPassword.length < 10) return NextResponse.json({ error: "New password needs at least 10 characters." }, { status: 400 });
  if (!changeOwnPassword(user.id, body.currentPassword, body.newPassword)) return NextResponse.json({ error: "Current password is incorrect." }, { status: 400 });
  const response = NextResponse.json({ ok: true });
  clearSessionCookie(response);
  return response;
}
