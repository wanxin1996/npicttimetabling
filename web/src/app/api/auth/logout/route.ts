import { NextResponse, type NextRequest } from "next/server";
import { clearSessionCookie, sessionToken } from "@/lib/auth";
import { logoutSession } from "@/lib/database";
import { safeDatabaseFailureResponse } from "@/lib/database-response";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  // 若当前服务器会话存在就将其删除，并始终让浏览器 Cookie 过期；
  // 因此重复退出也安全，不会产生额外副作用。
  try {
    const token = sessionToken(request);
    if (token) logoutSession(token);
    const response = NextResponse.json({ ok: true });
    clearSessionCookie(response);
    return response;
  } catch (error) {
    // 删除服务器会话失败时不要清掉浏览器 Cookie；否则用户失去重试撤销该令牌的机会，
    // 页面又会在刷新后因为服务端会话仍有效而重新登录。
    return safeDatabaseFailureResponse(error, "Logout failed", "Sign out could not be completed. Try again.");
  }
}
