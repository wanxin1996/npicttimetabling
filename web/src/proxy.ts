import { NextResponse, type NextRequest } from "next/server";
import { sessionToken } from "@/lib/auth";
import { validateSession } from "@/lib/database";

// 所有业务 API 在这里统一进行身份保护。认证接口保持公开，
// 使全新安装能够创建首位管理员，退出状态的用户也能正常登录。
export function proxy(request: NextRequest) {
  // 托管平台需要一个明确且无需登录的健康接口，用来判断服务及持久化数据库是否就绪；
  // 除此之外的全部业务数据仍受登录保护。
  if (request.nextUrl.pathname === "/api/health") return NextResponse.next();
  if (request.nextUrl.pathname.startsWith("/api/auth/")) return NextResponse.next();
  const token = sessionToken(request);
  if (!token || !validateSession(token)) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  return NextResponse.next();
}

export const config = { matcher: "/api/:path*" };
