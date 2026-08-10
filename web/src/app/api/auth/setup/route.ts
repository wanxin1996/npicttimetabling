import { NextResponse, type NextRequest } from "next/server";
import { attachSessionCookie } from "@/lib/auth";
import { createInitialAdmin } from "@/lib/database";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  // 首次初始化只接受一组管理员登录资料；一旦已有任何账号，数据库层就会拒绝再次初始化。
  const body = await request.json();
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (username.length < 3 || password.length < 10) return NextResponse.json({ error: "Username needs 3 characters and password needs 10 characters." }, { status: 400 });
  try {
    const result = createInitialAdmin(username, password);
    const response = NextResponse.json({ user: result.user }, { status: 201 });
    attachSessionCookie(response, result.session.token, result.session.expiresAt);
    return response;
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Administrator setup failed." }, { status: 409 });
  }
}
