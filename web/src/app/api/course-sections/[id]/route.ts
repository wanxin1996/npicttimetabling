import {
  CourseSectionInputError,
  CourseSectionRevisionConflictError,
  listCourseAllocationVariances,
  updateCourseSection,
} from "@/lib/database";

// 班次编辑会写入本地 SQLite，因此此路由必须使用 Node 服务器运行环境。
export const runtime = "nodejs";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  // 损坏 JSON 属于可预期的客户端输入错误，必须返回受控 400，不能让框架生成 500 页面。
  const { id } = await context.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Teacher, student groups and revision are required." }, { status: 400 });
  }
  const input = body && typeof body === "object" ? body as Record<string, unknown> : {};

  // 草拟排课时允许暂不选择教师，但班级清单和 revision 必须完整，
  // 否则服务器无法判断这个表单是否已经被另一位老师更新。
  if (!(input.teacherId === null || typeof input.teacherId === "string") || !Array.isArray(input.studentGroupIds) || !input.studentGroupIds.every((groupId: unknown) => typeof groupId === "string") || !Number.isInteger(input.revision) || Number(input.revision) < 1) {
    return Response.json({ error: "Teacher, student groups and revision are invalid." }, { status: 400 });
  }
  try {
    const result = updateCourseSection(id, { teacherId: input.teacherId as string | null, studentGroupIds: input.studentGroupIds as string[], revision: Number(input.revision) });
    if (!result) return Response.json({ error: "Section not found." }, { status: 404 });
    // 保存后重新读取所属课程，使响应能够立即告诉老师当前任课教师是否偏离导入分配。
    return Response.json({ ok: true, revision: result.revision, allocationVariances: listCourseAllocationVariances(result.courseId) });
  } catch (error) {
    if (error instanceof CourseSectionRevisionConflictError) return Response.json({ error: error.message }, { status: 409 });
    if (error instanceof CourseSectionInputError) return Response.json({ error: error.message }, { status: 400 });
    console.error("Course section update failed", error);
    return Response.json({ error: "The section could not be saved. Try again." }, { status: 500 });
  }
}
