import { NextResponse, type NextRequest } from "next/server";
import { attachSessionCookie } from "@/lib/auth";
import { loginUser } from "@/lib/database";
import { safeDatabaseFailureResponse } from "@/lib/database-response";
import { clearLoginFailures, loginRateLimitStatus, recordFailedLogin } from "@/lib/login-rate-limit";
import { PASSWORD_MAX_LENGTH, USERNAME_MAX_LENGTH } from "@/lib/auth-input";
import { readJsonObject } from "@/lib/request-json";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  // 格式错误的公开登录请求应收到受控错误响应，不能返回可能泄露实现细节的框架错误页。
  const parsed = await readJsonObject(request, "Enter a username and password.");
  if (!parsed.ok) return parsed.response;
  const credentials = parsed.value;
  const username = typeof credentials.username === "string" ? credentials.username.trim() : "";
  const password = typeof credentials.password === "string" ? credentials.password : "";

  // 长度检查必须先于限流 Map 和 Scrypt。超长公开输入属于格式错误，不应占用失败桶，
  // 更不能进入同步密码哈希后阻塞同一进程中的排课请求。
  if (username.length > USERNAME_MAX_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    return NextResponse.json({ error: "Username or password is too long." }, { status: 400 });
  }

  // 密码哈希刻意消耗较多 CPU，因此先执行频率限制检查，避免攻击者滥用服务器资源。
  const limit = loginRateLimitStatus(request, username);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Too many sign-in attempts. Wait 15 minutes and try again." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } },
    );
  }

  let result: ReturnType<typeof loginUser>;
  try {
    result = username && password ? loginUser(username, password) : null;
  } catch (error) {
    // 登录不经过认证 proxy，因此这里必须自己处理真实 SQLite 锁和未知故障，
    // 保证公开接口始终返回固定 JSON，绝不暴露 SQL、文件路径或框架 HTML 错误页。
    return safeDatabaseFailureResponse(error, "Login failed", "Sign in could not be completed. Try again.");
  }
  if (!result) {
    recordFailedLogin(request, username);
    return NextResponse.json({ error: "Username or password is incorrect." }, { status: 401 });
  }
  clearLoginFailures(request, username);
  const response = NextResponse.json({ user: result.user });
  attachSessionCookie(response, result.session.token, result.session.expiresAt);
  return response;
}
