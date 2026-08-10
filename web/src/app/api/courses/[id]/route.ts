import { updateCourseSetup } from "@/lib/database";

// 课程设置会写入本地 SQLite，因此必须在 Node 服务器运行环境中执行。
export const runtime = "nodejs";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  // 修改课程前先读取并验证全部设置，避免只保存一部分配置的课程进入后续排课页面。
  const { id } = await context.params;
  const body = await request.json();
  const durationHours = body.durationHours === null ? null : Number(body.durationHours);
  const sessionsPerWeek = Number(body.sessionsPerWeek);
  const primaryYear = body.primaryYear === null ? null : Number(body.primaryYear);
  const minimumRoomCapacity = body.minimumRoomCapacity === null ? null : Number(body.minimumRoomCapacity);
  const weekStart = body.weekStart === null ? null : Number(body.weekStart);
  const weekEnd = body.weekEnd === null ? null : Number(body.weekEnd);

  // 院系确认每节课只能持续 2、3 或 4 个整小时。
  // 即使自定义客户端绕过 HTML 表单，服务器仍会强制执行这个业务范围。
  if (durationHours === null || !Number.isInteger(durationHours) || durationHours < 2 || durationHours > 4 || !Number.isInteger(sessionsPerWeek) || sessionsPerWeek < 1 || sessionsPerWeek > 2 || (primaryYear !== null && ![1, 2, 3].includes(primaryYear)) || (minimumRoomCapacity !== null && (!Number.isInteger(minimumRoomCapacity) || minimumRoomCapacity < 1))) {
    return Response.json({ error: "Duration must be 2 to 4 whole hours; weekly sessions, year and room capacity must also use valid whole numbers." }, { status: 400 });
  }
  if (![body.requiresLab, body.requiresMultiProjector, body.requiresSmartClassroom, body.separateSectionsAcrossDays].every((value) => typeof value === "boolean")) {
    return Response.json({ error: "Room requirements must be true or false." }, { status: 400 });
  }
  // 普通全学期课程的开始周和结束周都留空；有限周次课程必须提供正整数，
  // 并且开始周不能晚于结束周。
  if ((weekStart === null) !== (weekEnd === null) || (weekStart !== null && weekEnd !== null && (!Number.isInteger(weekStart) || !Number.isInteger(weekEnd) || weekStart < 1 || weekEnd < weekStart))) {
    return Response.json({ error: "Leave both teaching weeks blank for all weeks, or enter a valid positive start and end range." }, { status: 400 });
  }

  try {
    const saved = updateCourseSetup(id, { durationHours, sessionsPerWeek, primaryYear, minimumRoomCapacity, requiresLab: body.requiresLab, requiresMultiProjector: body.requiresMultiProjector, requiresSmartClassroom: body.requiresSmartClassroom, separateSectionsAcrossDays: body.separateSectionsAcrossDays, weekStart, weekEnd });
    if (!saved) return Response.json({ error: "Course not found." }, { status: 404 });
    return Response.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Course setup could not be saved.";
    // 已有排课却清空主年级属于当前数据库状态与请求互相冲突，而不是字段格式错误；
    // 409 让前端和后续自动化测试能准确区分这种业务冲突。
    const status = message.includes("already has scheduled lessons") ? 409 : 400;
    return Response.json({ error: message }, { status });
  }
}
