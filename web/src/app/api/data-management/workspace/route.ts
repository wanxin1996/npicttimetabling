import { listDataManagementWorkspace } from "@/lib/database";
import { safeDatabaseFailureResponse } from "@/lib/database-response";

// SQLite 使用原生 Node 模块；资料管理聚合读取不能被切换到 Edge runtime。
export const runtime = "nodejs";

export function GET() {
  // 四张清单由 database 层的同一个 DEFERRED 快照产生。API 只在全部读取成功后
  // 才序列化响应，因此浏览器不会收到半套可编辑资料。
  try {
    return Response.json(listDataManagementWorkspace());
  } catch (error) {
    return safeDatabaseFailureResponse(
      error,
      "Data-management workspace read failed",
      "The master-data workspace could not be loaded. Try again.",
    );
  }
}
