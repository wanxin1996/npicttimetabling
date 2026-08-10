import {
  CourseSetupBusyError,
  CourseSetupInputError,
  CourseSetupRevisionConflictError,
  CourseSetupStateConflictError,
  updateCourseSetup,
} from "@/lib/database";

// 课程设置会写入本地 SQLite，因此必须在 Node 服务器运行环境中执行。
export const runtime = "nodejs";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  // JSON 可能来自旧浏览器、自定义客户端或损坏请求。先把未知内容安全缩窄成普通对象，
  // 避免 null、数组或破损 JSON 变成未控制的 HTML 500 页面。
  const { id } = await context.params;
  let parsedBody: unknown;
  try {
    parsedBody = await request.json();
  } catch {
    return Response.json({ error: "Course setup must be sent as valid JSON." }, { status: 400 });
  }
  if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) {
    return Response.json({ error: "Course setup must be a JSON object." }, { status: 400 });
  }
  const body = parsedBody as Record<string, unknown>;

  // 数字必须在 JSON 中真实使用 number；不把 true、[3] 或字符串悄悄转换成有效配置。
  // revision 来自打开表单时读到的课程版本，用于检测另一位老师已经先保存的情况。
  if (!Number.isSafeInteger(body.revision) || Number(body.revision) < 1
    || !Number.isInteger(body.durationHours) || Number(body.durationHours) < 2 || Number(body.durationHours) > 4
    || !Number.isInteger(body.sessionsPerWeek) || ![1, 2].includes(Number(body.sessionsPerWeek))
    || !(body.primaryYear === null || (Number.isInteger(body.primaryYear) && [1, 2, 3].includes(Number(body.primaryYear))))
    || !(body.minimumRoomCapacity === null || (Number.isSafeInteger(body.minimumRoomCapacity) && Number(body.minimumRoomCapacity) >= 1))) {
    return Response.json({ error: "Revision, duration, weekly sessions, year and room capacity must use valid whole numbers." }, { status: 400 });
  }
  if (![body.requiresLab, body.requiresMultiProjector, body.requiresSmartClassroom, body.separateSectionsAcrossDays].every((value) => typeof value === "boolean")) {
    return Response.json({ error: "Course requirement switches must be true or false." }, { status: 400 });
  }

  // 普通全学期课程的开始周和结束周都为 null；有限周次课程必须同时提供正整数，
  // 并且开始周不能晚于结束周。
  const weeksAreBlank = body.weekStart === null && body.weekEnd === null;
  const weeksAreValid = Number.isSafeInteger(body.weekStart) && Number.isSafeInteger(body.weekEnd)
    && Number(body.weekStart) >= 1 && Number(body.weekEnd) >= Number(body.weekStart);
  if (!weeksAreBlank && !weeksAreValid) {
    return Response.json({ error: "Leave both teaching weeks blank for all weeks, or enter a valid positive start and end range." }, { status: 400 });
  }

  try {
    const saved = updateCourseSetup(id, {
      revision: Number(body.revision),
      durationHours: Number(body.durationHours),
      sessionsPerWeek: Number(body.sessionsPerWeek),
      primaryYear: body.primaryYear as number | null,
      minimumRoomCapacity: body.minimumRoomCapacity as number | null,
      requiresLab: body.requiresLab as boolean,
      requiresMultiProjector: body.requiresMultiProjector as boolean,
      requiresSmartClassroom: body.requiresSmartClassroom as boolean,
      separateSectionsAcrossDays: body.separateSectionsAcrossDays as boolean,
      weekStart: body.weekStart as number | null,
      weekEnd: body.weekEnd as number | null,
    });
    if (!saved) return Response.json({ error: "Course not found." }, { status: 404 });
    return Response.json({ ok: true, revision: saved.revision, changed: saved.changed });
  } catch (error) {
    if (error instanceof CourseSetupInputError) return Response.json({ error: error.message }, { status: 400 });
    if (error instanceof CourseSetupRevisionConflictError) return Response.json({ code: "COURSE_SETUP_CHANGED", error: error.message }, { status: 409 });
    if (error instanceof CourseSetupStateConflictError) return Response.json({ error: error.message }, { status: 409 });
    if (error instanceof CourseSetupBusyError) return Response.json({ error: error.message }, { status: 503, headers: { "Retry-After": "1" } });
    // trigger、约束、磁盘等未知错误只写入服务器日志；浏览器始终收到固定安全文案。
    console.error("Course setup update failed", error);
    return Response.json({ error: "The course setup could not be saved. Try again." }, { status: 500 });
  }
}
