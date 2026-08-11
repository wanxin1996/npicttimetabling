import type { NextRequest } from "next/server";
import { sessionToken } from "@/lib/auth";
import { AppUserUniqueConflictError, createAppUser, listAppUsers, resetAppUserPassword, setAppUserStatus, validateSession } from "@/lib/database";
import { passwordHasValidLength, usernameHasValidLength } from "@/lib/auth-input";
import { safeDatabaseFailureResponse } from "@/lib/database-response";
import { readJsonObject } from "@/lib/request-json";

export const runtime = "nodejs";

function administrator(request: NextRequest) {
  // 每次账号操作只解析一次登录会话，并额外检查管理员标记；
  // 普通排课账号不能读取或修改其他人的账号。
  const token = sessionToken(request);
  return token ? validateSession(token) : null;
}

export async function GET(request: NextRequest) {
  // 只有已经通过身份验证的管理员才能取得账号清单。
  try {
    const user = administrator(request);
    if (!user?.isAdmin) return Response.json({ error: "Only the administrator can manage accounts." }, { status: 403 });
    return Response.json(listAppUsers());
  } catch (error) {
    return safeDatabaseFailureResponse(error, "Account list failed", "The accounts could not be loaded. Try again.");
  }
}

export async function POST(request: NextRequest) {
  // 创建排课账号前先验证用户名和初始密码，避免无效资料进入数据库。
  try {
    const user = administrator(request);
    if (!user?.isAdmin) return Response.json({ error: "Only the administrator can create accounts." }, { status: 403 });
    const parsed = await readJsonObject(request, "Provide valid account details.");
    if (!parsed.ok) return parsed.response;
    const body = parsed.value;
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!usernameHasValidLength(username) || !passwordHasValidLength(password)) {
      return Response.json({ error: "Username must use 3 to 64 characters and password must use 10 to 256 characters." }, { status: 400 });
    }
    return Response.json(createAppUser(username, password), { status: 201 });
  } catch (error) {
    if (error instanceof AppUserUniqueConflictError) return Response.json({ error: error.message }, { status: 409 });
    return safeDatabaseFailureResponse(error, "Account creation failed", "The account could not be created. Try again.");
  }
}

export async function PATCH(request: NextRequest) {
  // 请求中的 action 决定执行可恢复的启用/停用，还是管理员密码重置；
  // 两种操作都只允许管理员调用。
  try {
    const user = administrator(request);
    if (!user?.isAdmin) return Response.json({ error: "Only the administrator can manage accounts." }, { status: 403 });
    const parsed = await readJsonObject(request, "Account action is invalid.");
    if (!parsed.ok) return parsed.response;
    const body = parsed.value;
    if (typeof body.userId !== "string") return Response.json({ error: "Choose an account." }, { status: 400 });
    if (body.action === "status" && typeof body.isActive === "boolean") {
      if (!setAppUserStatus(body.userId, body.isActive)) return Response.json({ error: "Only normal scheduler accounts can be changed." }, { status: 400 });
      return Response.json({ ok: true });
    }
    if (body.action === "resetPassword" && typeof body.password === "string" && passwordHasValidLength(body.password)) {
      if (!resetAppUserPassword(body.userId, body.password)) return Response.json({ error: "Only normal scheduler accounts can be reset." }, { status: 400 });
      return Response.json({ ok: true });
    }
    return Response.json({ error: "Account action is invalid." }, { status: 400 });
  } catch (error) {
    return safeDatabaseFailureResponse(error, "Account update failed", "The account could not be updated. Try again.");
  }
}
