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
  const weekStart = body.weekStart === null ? null : Number(body.weekStart);
  const weekEnd = body.weekEnd === null ? null : Number(body.weekEnd);

  // The department confirmed that every class lasts 2, 3 or 4 whole hours.
  // Enforce that business boundary on the server even if a custom client bypasses HTML.
  if (durationHours === null || !Number.isInteger(durationHours) || durationHours < 2 || durationHours > 4 || !Number.isInteger(sessionsPerWeek) || sessionsPerWeek < 1 || sessionsPerWeek > 2 || (primaryYear !== null && ![1, 2, 3].includes(primaryYear)) || (minimumRoomCapacity !== null && (!Number.isInteger(minimumRoomCapacity) || minimumRoomCapacity < 1))) {
    return Response.json({ error: "Duration must be 2 to 4 whole hours; weekly sessions, year and room capacity must also use valid whole numbers." }, { status: 400 });
  }
  if (![body.requiresLab, body.requiresMultiProjector, body.requiresSmartClassroom, body.separateSectionsAcrossDays].every((value) => typeof value === "boolean")) {
    return Response.json({ error: "Room requirements must be true or false." }, { status: 400 });
  }
  // Both teaching-week bounds are blank for a normal all-week course. Limited
  // courses need positive whole bounds with the start no later than the end.
  if ((weekStart === null) !== (weekEnd === null) || (weekStart !== null && weekEnd !== null && (!Number.isInteger(weekStart) || !Number.isInteger(weekEnd) || weekStart < 1 || weekEnd < weekStart))) {
    return Response.json({ error: "Leave both teaching weeks blank for all weeks, or enter a valid positive start and end range." }, { status: 400 });
  }

  try {
    const saved = updateCourseSetup(id, { durationHours, sessionsPerWeek, primaryYear, minimumRoomCapacity, requiresLab: body.requiresLab, requiresMultiProjector: body.requiresMultiProjector, requiresSmartClassroom: body.requiresSmartClassroom, separateSectionsAcrossDays: body.separateSectionsAcrossDays, weekStart, weekEnd });
    if (!saved) return Response.json({ error: "Course not found." }, { status: 404 });
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Course setup could not be saved." }, { status: 400 });
  }
}
