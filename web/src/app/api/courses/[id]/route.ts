import { updateCourseSetup } from "@/lib/database";

// Course setup writes to the local SQLite database, which needs the Node runtime.
export const runtime = "nodejs";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  // Read and validate every setting before changing the course, preventing a partially
  // configured course from reaching the later timetable-placement screen.
  const { id } = await context.params;
  const body = await request.json();
  const durationHours = body.durationHours === null ? null : Number(body.durationHours);
  const sessionsPerWeek = Number(body.sessionsPerWeek);
  const primaryYear = body.primaryYear === null ? null : Number(body.primaryYear);
  const minimumRoomCapacity = body.minimumRoomCapacity === null ? null : Number(body.minimumRoomCapacity);

  if (durationHours === null || !Number.isInteger(durationHours) || durationHours < 1 || !Number.isInteger(sessionsPerWeek) || sessionsPerWeek < 1 || (primaryYear !== null && ![1, 2, 3].includes(primaryYear)) || (minimumRoomCapacity !== null && (!Number.isInteger(minimumRoomCapacity) || minimumRoomCapacity < 1))) {
    return Response.json({ error: "Duration, weekly sessions, year and room capacity must use valid whole numbers." }, { status: 400 });
  }
  if (![body.requiresLab, body.requiresMultiProjector, body.requiresSmartClassroom].every((value) => typeof value === "boolean")) {
    return Response.json({ error: "Room requirements must be true or false." }, { status: 400 });
  }

  const saved = updateCourseSetup(id, { durationHours, sessionsPerWeek, primaryYear, minimumRoomCapacity, requiresLab: body.requiresLab, requiresMultiProjector: body.requiresMultiProjector, requiresSmartClassroom: body.requiresSmartClassroom });
  if (!saved) return Response.json({ error: "Course not found." }, { status: 404 });
  return Response.json({ ok: true });
}
