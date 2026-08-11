import { DatabaseBusyError, listRulesWorkspace } from "@/lib/database";
import { safeDatabaseFailureResponse } from "@/lib/database-response";

// 规则工作区依赖本机 SQLite，不能被切换到不支持原生数据库模块的 Edge runtime。
export const runtime = "nodejs";

export function GET() {
  // 四组资料必须来自 database 层的同一个 DEFERRED 快照。只在全部读取成功后
  // 序列化响应，避免页面把新规则状态与旧 warnings、教师或不可用时段拼在一起。
  try {
    return Response.json(listRulesWorkspace());
  } catch (error) {
    if (error instanceof DatabaseBusyError) {
      return Response.json(
        { error: error.message },
        { status: 503, headers: { "Retry-After": "1" } },
      );
    }
    return safeDatabaseFailureResponse(
      error,
      "Rules workspace read failed",
      "The rules workspace could not be loaded. Try again.",
    );
  }
}
