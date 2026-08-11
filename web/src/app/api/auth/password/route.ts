import { NextResponse, type NextRequest } from "next/server";
import { clearSessionCookie, sessionToken } from "@/lib/auth";
import { changeOwnPassword, validateSession } from "@/lib/database";
import { passwordHasValidLength, PASSWORD_MAX_LENGTH } from "@/lib/auth-input";
import { safeDatabaseFailureResponse } from "@/lib/database-response";
import { readJsonObject } from "@/lib/request-json";

export const runtime = "nodejs";

export async function PATCH(request: NextRequest) {
  // 用户只能修改自己的密码，并且必须提供有效会话和正确旧密码；
  // 修改成功后，该账号的所有现有会话都会撤销。
  try {
    const token = sessionToken(request);
    const user = token ? validateSession(token) : null;
    if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    const parsed = await readJsonObject(request, "Provide the current password and a valid new password.");
    if (!parsed.ok) return parsed.response;
    const body = parsed.value;
    if (typeof body.currentPassword !== "string" || body.currentPassword.length > PASSWORD_MAX_LENGTH
      || typeof body.newPassword !== "string" || !passwordHasValidLength(body.newPassword)) {
      return NextResponse.json({ error: "Password must use 10 to 256 characters." }, { status: 400 });
    }
    if (!changeOwnPassword(user.id, body.currentPassword, body.newPassword)) return NextResponse.json({ error: "Current password is incorrect." }, { status: 400 });
    const response = NextResponse.json({ ok: true });
    clearSessionCookie(response);
    return response;
  } catch (error) {
    return safeDatabaseFailureResponse(error, "Own password change failed", "The password could not be changed. Try again.");
  }
}
