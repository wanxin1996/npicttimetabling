import { CourseSectionResizeConflictError, CourseSetupBusyError, CourseSetupInputError, CourseSetupRevisionConflictError, listCourseSections, resizeCourseSections } from "@/lib/database";
import { safeDatabaseFailureResponse } from "@/lib/database-response";
import { parsePositiveRevision } from "@/lib/master-data-input";
import { readJsonObject } from "@/lib/request-json";
import { isOpaqueResourceId } from "@/lib/schedule-input";

// 此路由在 Node 环境中读取某一门选定课程生成的全部班次。
export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  // 把课程 ID 放入 URL，只返回当前课程班次，避免一次发送数百条无关资料。
  const { id } = await context.params;
  try {
    return Response.json(listCourseSections(id));
  } catch (error) {
    return safeDatabaseFailureResponse(error, "Course-section list failed", "The course sections could not be loaded. Try again.");
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  // 老师可修正 Excel 中错误的班次总数，同时保留低编号班次的名称及已有教师、班级分配。
  const { id } = await context.params;
  if (!isOpaqueResourceId(id)) return Response.json({ error: "Course id is invalid." }, { status: 400 });
  const parsed = await readJsonObject(request, "Section count must be a whole number from 1 to 999.");
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;
  // 只接受 JSON 原生整数；字符串 "3" 或布尔值不能被 Number(...) 静默转换成有效数量。
  if (!Number.isSafeInteger(body.sectionCount) || Number(body.sectionCount) < 1 || Number(body.sectionCount) > 999) {
    return Response.json({ error: "Section count must be a whole number from 1 to 999." }, { status: 400 });
  }
  const sectionCount = body.sectionCount as number;
  const revision = parsePositiveRevision(body.revision, "Course");
  if (!revision.ok) return Response.json({ error: revision.error }, { status: 400 });

  try {
    const saved = resizeCourseSections(id, sectionCount, revision.value);
    if (!saved) return Response.json({ error: "Course not found." }, { status: 404 });
    return Response.json({ ok: true, revision: saved.revision, changed: saved.changed });
  } catch (error) {
    if (error instanceof CourseSetupInputError) return Response.json({ error: error.message }, { status: 400 });
    if (error instanceof CourseSetupRevisionConflictError) return Response.json({ code: "COURSE_SETUP_CHANGED", error: error.message }, { status: 409 });
    if (error instanceof CourseSectionResizeConflictError) return Response.json({ code: "COURSE_SECTION_IN_USE", error: error.message }, { status: 409 });
    if (error instanceof CourseSetupBusyError) return Response.json({ error: error.message }, { status: 503, headers: { "Retry-After": "1" } });
    return safeDatabaseFailureResponse(error, "Course-section resize failed", "Section count could not be changed. Try again.");
  }
}
