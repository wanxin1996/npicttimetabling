import { NextResponse, type NextRequest } from "next/server";
import { attachSessionCookie } from "@/lib/auth";
import { createInitialAdmin, InitialAdministratorAlreadyExistsError } from "@/lib/database";
import { passwordHasValidLength, usernameHasValidLength, verifyAdministratorSetupToken } from "@/lib/auth-input";
import { readJsonObject } from "@/lib/request-json";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  // 首次初始化只接受一组管理员登录资料；一旦已有任何账号，数据库层就会拒绝再次初始化。
  const parsed = await readJsonObject(request, "Provide valid administrator setup details.");
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;

  // production 空库不能由最先访问公开网址的人抢注。部署者必须另外传递至少 32 bytes
  // 的随机一次性 token；错误、缺少和过长候选值都不会出现在响应或日志中。
  const tokenCheck = verifyAdministratorSetupToken(body.setupToken);
  if (tokenCheck === "unavailable") {
    return NextResponse.json({ error: "Administrator setup is unavailable. Contact the deployment administrator." }, { status: 503 });
  }
  if (tokenCheck === "invalid") {
    return NextResponse.json({ error: "Administrator setup is not authorized." }, { status: 403 });
  }
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!usernameHasValidLength(username) || !passwordHasValidLength(password)) {
    return NextResponse.json({ error: "Username must use 3 to 64 characters and password must use 10 to 256 characters." }, { status: 400 });
  }
  try {
    const result = createInitialAdmin(username, password);
    const response = NextResponse.json({ user: result.user }, { status: 201 });
    attachSessionCookie(response, result.session.token, result.session.expiresAt);
    return response;
  } catch (error) {
    if (error instanceof InitialAdministratorAlreadyExistsError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error("Initial administrator setup failed", error);
    return NextResponse.json({ error: "Administrator setup failed. Try again." }, { status: 500 });
  }
}
