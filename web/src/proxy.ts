import { NextResponse, type NextRequest } from "next/server";
import { sessionToken } from "@/lib/auth";
import { validateSession } from "@/lib/database";

// 所有业务 API 在这里统一进行身份保护。只有确实需要匿名调用的四个认证端点公开，
// 未来新增 `/api/auth/*` 路由不会因为路径前缀而意外绕过会话检查。
export function proxy(request: NextRequest) {
  // 托管平台需要一个明确且无需登录的健康接口，用来判断服务及持久化数据库是否就绪；
  // 除此之外的全部业务数据仍受登录保护。
  if (request.nextUrl.pathname === "/api/health") return NextResponse.next();
  const publicAuthenticationPaths = new Set([
    "/api/auth/status",
    "/api/auth/login",
    "/api/auth/setup",
    "/api/auth/logout",
  ]);
  if (publicAuthenticationPaths.has(request.nextUrl.pathname)) return NextResponse.next();
  const token = sessionToken(request);
  if (!token) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  try {
    if (!validateSession(token)) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    return NextResponse.next();
  } catch (error) {
    // SQLite 正在执行另一进程的短暂独占提交时，连会话读取也可能暂时 BUSY。
    // 对浏览器返回可重试 503，不能把底层锁消息或框架错误页暴露给用户。
    if (error instanceof Error && error.name === "DatabaseBusyError") {
      return NextResponse.json(
        { error: "Another scheduler is updating timetable data. Try again in a moment." },
        { status: 503, headers: { "Retry-After": "1" } },
      );
    }
    console.error("API session validation failed", error);
    return NextResponse.json({ error: "Authentication could not be checked. Try again." }, { status: 500 });
  }
}

export const config = { matcher: "/api/:path*" };
