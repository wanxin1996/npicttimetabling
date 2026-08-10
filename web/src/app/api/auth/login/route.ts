import { NextResponse, type NextRequest } from "next/server";
import { attachSessionCookie } from "@/lib/auth";
import { loginUser } from "@/lib/database";
import { clearLoginFailures, loginRateLimitStatus, recordFailedLogin } from "@/lib/login-rate-limit";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  // 格式错误的公开登录请求应收到受控错误响应，不能返回可能泄露实现细节的框架错误页。
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Enter a username and password." }, { status: 400 });
  }
  const credentials = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const username = typeof credentials.username === "string" ? credentials.username.trim() : "";
  const password = typeof credentials.password === "string" ? credentials.password : "";

  // 密码哈希刻意消耗较多 CPU，因此先执行频率限制检查，避免攻击者滥用服务器资源。
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
