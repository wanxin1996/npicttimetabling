import { listCourseSectionsWorkspace } from "@/lib/database";
import { safeDatabaseFailureResponse } from "@/lib/database-response";

// 班次详情同样依赖本地 SQLite 原生模块，必须在 Node runtime 执行。
export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    // currentCourse、sections 与 allocationVariances 已由一个 DEFERRED 事务读取。
    // 不存在的课程明确返回 404；空班次数组仍是合法课程，不可与 not found 混淆。
    const workspace = listCourseSectionsWorkspace(id);
    if (!workspace) return Response.json({ error: "Course not found." }, { status: 404 });
    return Response.json(workspace);
  } catch (error) {
    return safeDatabaseFailureResponse(
      error,
      "Course-sections workspace read failed",
      "The course sections workspace could not be loaded. Try again.",
    );
  }
}
