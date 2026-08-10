import { listCourseAllocationVariances } from "@/lib/database";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  // 教师分配复核与班次清单使用独立接口，使未来统计摘要可以单独刷新，
  // 不必改变已经稳定的班次 API 数据格式。
  const { id } = await context.params;
  return Response.json(listCourseAllocationVariances(id));
}
