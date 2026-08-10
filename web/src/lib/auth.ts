import type { NextRequest, NextResponse } from "next/server";

export const SESSION_COOKIE = "timetable_session";

export function sessionToken(request: NextRequest) {
  // 所有 Cookie 读取集中在一个辅助函数中，避免路由和代理使用不同名称或认证行为。
  return request.cookies.get(SESSION_COOKIE)?.value ?? "";
}

export function attachSessionCookie(response: NextResponse, token: string, expiresAt: string) {
  // HttpOnly 阻止客户端脚本读取登录令牌；这个内部工具没有跨站登录流程，
  // 因此可安全使用严格的 SameSite 设置。
  response.cookies.set(SESSION_COOKIE, token, { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", priority: "high", path: "/", expires: new Date(expiresAt) });
}

export function clearSessionCookie(response: NextResponse) {
  // 清除 Cookie 时使用与设置时相同的安全属性和路径，确保所有受支持浏览器都删除正确凭证。
  response.cookies.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", priority: "high", path: "/", expires: new Date(0) });
}
