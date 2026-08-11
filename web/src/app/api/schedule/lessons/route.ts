import {
  listScheduledLessons,
  placeScheduledLesson,
  ScheduledLessonPlacementConflictError,
  ScheduledLessonPlacementInputError,
} from "@/lib/database";
import { safeDatabaseFailureResponse } from "@/lib/database-response";
import { parseScheduledLessonPlacementInput, parseTimetableYear } from "@/lib/schedule-input";
import { readJsonObject } from "@/lib/request-json";

// 排课操作在服务器端执行，因为冲突检查必须看到数据库中所有已保存课程。
export const runtime = "nodejs";

export async function GET(request: Request) {
  // 年级总表读取只返回所选主要年级，但冲突计算仍会考虑其他所有年级的课程。
  const year = parseTimetableYear(new URL(request.url).searchParams.get("year"));
  if (year === null) return Response.json({ error: "Year must be 1, 2 or 3." }, { status: 400 });
  try {
    return Response.json(listScheduledLessons(year));
  } catch (error) {
    // 总表读取同样可能在数据库初始化或另一实例提交时失败；始终返回受控 JSON。
    return safeDatabaseFailureResponse(error, "Scheduled lesson list failed", "The timetable could not be loaded. Try again.");
  }
}

export async function POST(request: Request) {
  // 保存成功时同时返回警告；产品要求允许老师保留困难排法，
  // 但必须立即清楚显示其中的问题。
  const parsed = await readJsonObject(request, "Section, weekly session, day and start hour are required.");
  if (!parsed.ok) return parsed.response;
  const input = parseScheduledLessonPlacementInput(parsed.value);
  if (!input.ok) return Response.json({ error: input.error }, { status: 400 });

  try {
    return Response.json(placeScheduledLesson(input.value), { status: 201 });
  } catch (error) {
    // 409 明确表示同一课次已被其他账号先保存；前端收到后会刷新总表，而不是显示 SQLite 内部错误。
    if (error instanceof ScheduledLessonPlacementConflictError) return Response.json({ code: "LESSON_ALREADY_SCHEDULED", error: error.message }, { status: 409 });
    if (error instanceof ScheduledLessonPlacementInputError) return Response.json({ error: error.message }, { status: 400 });
    return safeDatabaseFailureResponse(error, "Scheduled lesson placement failed", "The lesson could not be placed. Try again.");
  }
}
