import { listCourseAllocationVariances } from "@/lib/database";
import { safeDatabaseFailureResponse } from "@/lib/database-response";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  // 教师分配复核与班次清单使用独立接口，使未来统计摘要可以单独刷新，
  // 不必改变已经稳定的班次 API 数据格式。
  const { id } = await context.params;
  try {
    return Response.json(listCourseAllocationVariances(id));
  } catch (error) {
    // 方差统计仍依赖 SQLite；锁竞争返回可重试 503，其他故障保持固定 JSON 500。
    return safeDatabaseFailureResponse(error, "Course allocation variance load failed", "Allocation variances could not be loaded. Try again.");
  }
}
