import {
  CourseSectionInputError,
  CourseSectionRevisionConflictError,
  updateCourseSection,
} from "@/lib/database";
import { safeDatabaseFailureResponse } from "@/lib/database-response";
import { readJsonObject } from "@/lib/request-json";
import { isOpaqueResourceId, parseCourseSectionAssignmentInput } from "@/lib/schedule-input";

// 班次编辑会写入本地 SQLite，因此此路由必须使用 Node 服务器运行环境。
export const runtime = "nodejs";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  // 损坏或超大 JSON 属于可预期的客户端输入错误，必须返回受控响应。
  const { id } = await context.params;
  if (!isOpaqueResourceId(id)) return Response.json({ error: "Section id is invalid." }, { status: 400 });
  const parsed = await readJsonObject(request, "Teacher, student groups and revision are invalid.");
  if (!parsed.ok) return parsed.response;
  const input = parseCourseSectionAssignmentInput(parsed.value);

  // 草拟排课时允许暂不选择教师，但班级清单和 revision 必须完整，
  // 否则服务器无法判断这个表单是否已经被另一位老师更新。
  if (!input.ok) return Response.json({ error: input.error }, { status: 400 });
  try {
    const result = updateCourseSection(id, input.value);
    if (!result) return Response.json({ error: "Section not found." }, { status: 404 });
    // revision 和 allocation variance 都由同一个数据库事务返回；接口不会在成功提交后
    // 再执行一个可能失败的读取，从而避免“资料已保存但响应说失败”。
    return Response.json({ ok: true, revision: result.revision, allocationVariances: result.allocationVariances });
  } catch (error) {
    if (error instanceof CourseSectionRevisionConflictError) return Response.json({ error: error.message }, { status: 409 });
    if (error instanceof CourseSectionInputError) return Response.json({ error: error.message }, { status: 400 });
    // 只有上面的业务错误可以原样返回；初始化、SQLite 锁和未知异常都交给统一安全边界。
    return safeDatabaseFailureResponse(error, "Course section update failed", "The section could not be saved. Try again.");
  }
}
