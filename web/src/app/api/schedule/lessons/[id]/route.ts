import { removeScheduledLesson, updateScheduledLesson } from "@/lib/database";

// Editing a placed lesson requires the complete saved timetable, so it runs on Node.
export const runtime = "nodejs";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  // Accept only whole-hour placements and known optional identifiers before checking conflicts.
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
  // Unscheduling does not delete the section; it becomes available in the tray again.
  const { id } = await context.params;
  const revision = Number(new URL(request.url).searchParams.get("revision"));
  if (!Number.isInteger(revision)) return Response.json({ error: "Lesson revision is required." }, { status: 400 });
  if (!removeScheduledLesson(id, revision)) return Response.json({ error: "This lesson changed before it could be returned. Review the latest timetable." }, { status: 409 });
  return Response.json({ ok: true });
}
