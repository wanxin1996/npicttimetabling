import { NextResponse, type NextRequest } from "next/server";
import { clearSessionCookie, sessionToken } from "@/lib/auth";
import { changeOwnPassword, validateSession } from "@/lib/database";

export const runtime = "nodejs";

export async function PATCH(request: NextRequest) {
  // 用户只能修改自己的密码，并且必须提供有效会话和正确旧密码；
  // 修改成功后，该账号的所有现有会话都会撤销。
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
