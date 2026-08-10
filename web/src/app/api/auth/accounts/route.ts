import type { NextRequest } from "next/server";
import { sessionToken } from "@/lib/auth";
import { createAppUser, listAppUsers, resetAppUserPassword, setAppUserStatus, validateSession } from "@/lib/database";

export const runtime = "nodejs";

function administrator(request: NextRequest) {
  // 每次账号操作只解析一次登录会话，并额外检查管理员标记；
  // 普通排课账号不能读取或修改其他人的账号。
  const token = sessionToken(request);
  return token ? validateSession(token) : null;
}

export async function GET(request: NextRequest) {
  // 只有已经通过身份验证的管理员才能取得账号清单。
  const user = administrator(request);
  if (!user?.isAdmin) return Response.json({ error: "Only the administrator can manage accounts." }, { status: 403 });
  return Response.json(listAppUsers());
}

export async function POST(request: NextRequest) {
  // 创建排课账号前先验证用户名和初始密码，避免无效资料进入数据库。
  const user = administrator(request);
  if (!user?.isAdmin) return Response.json({ error: "Only the administrator can create accounts." }, { status: 403 });
  const body = await request.json();
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (username.length < 3 || password.length < 10) return Response.json({ error: "Username needs 3 characters and password needs 10 characters." }, { status: 400 });
  try { return Response.json(createAppUser(username, password), { status: 201 }); } catch { return Response.json({ error: "That username already exists." }, { status: 409 }); }
}

export async function PATCH(request: NextRequest) {
  // 请求中的 action 决定执行可恢复的启用/停用，还是管理员密码重置；
  // 两种操作都只允许管理员调用。
  const user = administrator(request);
  if (!user?.isAdmin) return Response.json({ error: "Only the administrator can manage accounts." }, { status: 403 });
  const body = await request.json();
  if (typeof body.userId !== "string") return Response.json({ error: "Choose an account." }, { status: 400 });
  if (body.action === "status" && typeof body.isActive === "boolean") {
    if (!setAppUserStatus(body.userId, body.isActive)) return Response.json({ error: "Only normal scheduler accounts can be changed." }, { status: 400 });
    return Response.json({ ok: true });
  }
  if (body.action === "resetPassword" && typeof body.password === "string" && body.password.length >= 10) {
    if (!resetAppUserPassword(body.userId, body.password)) return Response.json({ error: "Only normal scheduler accounts can be reset." }, { status: 400 });
    return Response.json({ ok: true });
  }
  return Response.json({ error: "Account action is invalid." }, { status: 400 });
}
