import { authenticationStatus } from "@/lib/database";
import { sessionToken } from "@/lib/auth";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  // 这个公开接口只告诉客户端应显示首次设置、登录页还是已登录工作区，
  // 不会暴露密码或会话数据。
  return Response.json(authenticationStatus(sessionToken(request)));
}
