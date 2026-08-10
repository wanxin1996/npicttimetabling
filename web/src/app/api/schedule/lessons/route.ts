import {
  listScheduledLessons,
  placeScheduledLesson,
  ScheduledLessonPlacementConflictError,
  ScheduledLessonPlacementInputError,
} from "@/lib/database";

// 排课操作在服务器端执行，因为冲突检查必须看到数据库中所有已保存课程。
export const runtime = "nodejs";

export async function GET(request: Request) {
  // 年级总表读取只返回所选主要年级，但冲突计算仍会考虑其他所有年级的课程。
  const year = Number(new URL(request.url).searchParams.get("year") ?? 1);
  if (![1, 2, 3].includes(year)) return Response.json({ error: "Year must be 1, 2 or 3." }, { status: 400 });
  return Response.json(listScheduledLessons(year));
}

export async function POST(request: Request) {
  // 保存成功时同时返回警告；产品要求允许老师保留困难排法，
  // 但必须立即清楚显示其中的问题。
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Section, weekly session, day and start hour are required." }, { status: 400 });
  }
  const input = body && typeof body === "object" ? body as Record<string, unknown> : {};
  if (typeof input.sectionId !== "string" || !Number.isInteger(input.occurrence) || !Number.isInteger(input.dayOfWeek) || !Number.isInteger(input.startHour) || !(input.roomId === null || typeof input.roomId === "string")) {
    return Response.json({ error: "Section, weekly session, day, start hour and room are invalid." }, { status: 400 });
  }

  try {
    return Response.json(placeScheduledLesson({
      sectionId: input.sectionId,
      occurrence: Number(input.occurrence),
      dayOfWeek: Number(input.dayOfWeek),
      startHour: Number(input.startHour),
      roomId: input.roomId as string | null,
    }), { status: 201 });
  } catch (error) {
    // 409 明确表示同一课次已被其他账号先保存；前端收到后会刷新总表，而不是显示 SQLite 内部错误。
    if (error instanceof ScheduledLessonPlacementConflictError) return Response.json({ code: "LESSON_ALREADY_SCHEDULED", error: error.message }, { status: 409 });
    if (error instanceof ScheduledLessonPlacementInputError) return Response.json({ error: error.message }, { status: 400 });
    console.error("Scheduled lesson placement failed", error);
    return Response.json({ error: "The lesson could not be placed. Try again." }, { status: 500 });
  }
}
