import { NextResponse, type NextRequest } from "next/server";
import { clearSessionCookie, sessionToken } from "@/lib/auth";
import { logoutSession } from "@/lib/database";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  // 若当前服务器会话存在就将其删除，并始终让浏览器 Cookie 过期；
  // 因此重复退出也安全，不会产生额外副作用。
  const token = sessionToken(request);
  if (token) logoutSession(token);
  const response = NextResponse.json({ ok: true });
  clearSessionCookie(response);
  return response;
}
