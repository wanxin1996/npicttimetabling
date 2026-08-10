import { removeScheduledLesson, updateScheduledLesson } from "@/lib/database";

// 编辑已排课程需要读取完整时间表，因此必须在 Node 服务器端运行。
export const runtime = "nodejs";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  // 冲突检查前只接受整点时间和格式正确的可选 ID，避免无效输入进入排课逻辑。
  const { id } = await context.params;
  const body = await request.json();
  if (!Number.isInteger(body.dayOfWeek) || !Number.isInteger(body.startHour) || !Number.isInteger(body.revision) || !(body.roomId === null || typeof body.roomId === "string") || !(body.teacherId === null || typeof body.teacherId === "string")) return Response.json({ error: "Day, start hour, teacher, room and revision are invalid." }, { status: 400 });
  try {
    return Response.json(updateScheduledLesson(id, body));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Lesson could not be updated.";
    return Response.json({ error: message }, { status: message.includes("another scheduler") ? 409 : 400 });
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  // 取消排课不会删除课程班次，只会让对应课次重新回到待排区。
  const { id } = await context.params;
  const revision = Number(new URL(request.url).searchParams.get("revision"));
  if (!Number.isInteger(revision)) return Response.json({ error: "Lesson revision is required." }, { status: 400 });
  if (!removeScheduledLesson(id, revision)) return Response.json({ error: "This lesson changed before it could be returned. Review the latest timetable." }, { status: 409 });
  return Response.json({ ok: true });
}
