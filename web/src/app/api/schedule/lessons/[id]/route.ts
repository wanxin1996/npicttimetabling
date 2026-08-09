import { removeScheduledLesson, updateScheduledLesson } from "@/lib/database";

// Editing a placed lesson requires the complete saved timetable, so it runs on Node.
export const runtime = "nodejs";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  // Accept only whole-hour placements and known optional identifiers before checking conflicts.
  const { id } = await context.params;
  const body = await request.json();
  if (!Number.isInteger(body.dayOfWeek) || !Number.isInteger(body.startHour) || !(body.roomId === null || typeof body.roomId === "string") || !(body.teacherId === null || typeof body.teacherId === "string")) return Response.json({ error: "Day, start hour, teacher and room are invalid." }, { status: 400 });
  try { return Response.json(updateScheduledLesson(id, body)); } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Lesson could not be updated." }, { status: 400 }); }
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  // Unscheduling does not delete the section; it becomes available in the tray again.
  const { id } = await context.params;
  if (!removeScheduledLesson(id)) return Response.json({ error: "Scheduled lesson not found." }, { status: 404 });
  return Response.json({ ok: true });
}
