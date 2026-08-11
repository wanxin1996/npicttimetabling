import {
  removeScheduledLesson,
  ScheduledLessonNotFoundError,
  ScheduledLessonRevisionConflictError,
  ScheduledLessonUpdateInputError,
  updateScheduledLesson,
} from "@/lib/database";
import { safeDatabaseFailureResponse } from "@/lib/database-response";
import { readJsonObject } from "@/lib/request-json";
import { isOpaqueResourceId, parseScheduledLessonUpdateInput } from "@/lib/schedule-input";

// 编辑已排课程需要读取完整时间表，因此必须在 Node 服务器端运行。
export const runtime = "nodejs";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  // 损坏 JSON 属于可修正的请求格式错误，不能让框架生成不明确的 500 页面。
  const { id } = await context.params;
  if (!isOpaqueResourceId(id)) return Response.json({ error: "Lesson id is invalid." }, { status: 400 });
  const parsed = await readJsonObject(request, "Day, start hour, teacher, room, student groups and revision are invalid.");
  if (!parsed.ok) return parsed.response;

  // 冲突检查前只接受安全整数、格式正确的可选 ID 和无重复的学生班级清单。
  const input = parseScheduledLessonUpdateInput(parsed.value);
  if (!input.ok) return Response.json({ error: input.error }, { status: 400 });
  try {
    return Response.json(updateScheduledLesson(id, input.value));
  } catch (error) {
    if (error instanceof ScheduledLessonNotFoundError) return Response.json({ error: error.message }, { status: 404 });
    if (error instanceof ScheduledLessonRevisionConflictError) {
      // 稳定 code 让浏览器只对“旧 Inspector”执行重新载入流程；未来若接口增加其他
      // 409，前端不会误把不同业务问题都说成另一位老师已经修改课程。
      return Response.json({ code: "SCHEDULED_LESSON_CHANGED", error: error.message }, { status: 409 });
    }
    if (error instanceof ScheduledLessonUpdateInputError) return Response.json({ error: error.message }, { status: 400 });
    // warning 重算或 SQLite 发生未知故障时只在服务器保留技术细节，浏览器收到通用 500。
    return safeDatabaseFailureResponse(error, "Scheduled lesson update failed", "The lesson could not be updated. Try again.");
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  // 取消排课不会删除课程班次，只会让对应课次重新回到待排区。
  const { id } = await context.params;
  if (!isOpaqueResourceId(id)) return Response.json({ error: "Lesson id is invalid." }, { status: 400 });
  const rawRevision = new URL(request.url).searchParams.get("revision");
  const revision = Number(rawRevision);
  if (!rawRevision || !/^\d+$/.test(rawRevision) || !Number.isSafeInteger(revision) || revision < 1) {
    return Response.json({ error: "Lesson revision is required." }, { status: 400 });
  }
  try {
    if (!removeScheduledLesson(id, revision)) {
      // Return to tray 与普通编辑使用同一并发 code，前端便能统一重载最新卡片，
      // 同时仍用不同文字说明这次操作原本要把课程退回待排区。
      return Response.json({ code: "SCHEDULED_LESSON_CHANGED", error: "This lesson changed before it could be returned. Review the latest timetable." }, { status: 409 });
    }
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof ScheduledLessonUpdateInputError) return Response.json({ error: error.message }, { status: 400 });
    // 删除和 warning 重算位于同一事务；任何未知失败都会回滚，并只返回安全通用信息。
    return safeDatabaseFailureResponse(error, "Scheduled lesson removal failed", "The lesson could not be returned to the tray. Try again.");
  }
}
