import type { NextRequest } from "next/server";
import { sessionToken } from "@/lib/auth";
import { systemBackupStatus, validateSession } from "@/lib/database";
import { safeDatabaseFailureResponse } from "@/lib/database-response";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    // Proxy 之外再做一次管理员校验；会话读取和状态快照共用错误边界，SQLite 锁始终
    // 返回可重试 JSON 503，而不会泄漏框架 HTML 或内部 SQL。
    const token = sessionToken(request);
    const user = token ? validateSession(token) : null;
    if (!user?.isAdmin) {
      return Response.json({ error: "Only the administrator can review full system restore status." }, { status: 403 });
    }

    return Response.json(systemBackupStatus(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return safeDatabaseFailureResponse(
      error,
      "System backup status failed",
      "The current system data could not be checked. Retry before restoring a backup.",
    );
  }
}
