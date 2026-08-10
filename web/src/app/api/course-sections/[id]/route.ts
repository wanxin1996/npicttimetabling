import { listCourseAllocationVariances, updateCourseSection } from "@/lib/database";

// 班次编辑会写入本地 SQLite，因此此路由必须使用 Node 服务器运行环境。
export const runtime = "nodejs";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  // 草拟排课时允许暂不选择教师，但学生班级字段必须始终是数组，避免后续关联处理出错。
  const { id } = await context.params;
  const body = await request.json();
  if (!(body.teacherId === null || typeof body.teacherId === "string") || !Array.isArray(body.studentGroupIds) || !body.studentGroupIds.every((groupId: unknown) => typeof groupId === "string")) {
    return Response.json({ error: "Teacher and student group selections are invalid." }, { status: 400 });
  }
  try {
    const courseId = updateCourseSection(id, body.teacherId, body.studentGroupIds);
    if (!courseId) return Response.json({ error: "Section not found." }, { status: 404 });
    // 保存后重新读取所属课程，使响应能够立即告诉老师当前任课教师是否偏离导入分配。
    return Response.json({ ok: true, allocationVariances: listCourseAllocationVariances(courseId) });
  } catch {
    return Response.json({ error: "Choose an active teacher and valid student groups." }, { status: 400 });
  }
}
