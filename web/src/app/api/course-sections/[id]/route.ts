import { updateCourseSection } from "@/lib/database";

// Section edits update local SQLite and therefore need the Node runtime.
export const runtime = "nodejs";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  // A teacher is optional while planning, but selected student groups must be an array.
  const { id } = await context.params;
  const body = await request.json();
  if (!(body.teacherId === null || typeof body.teacherId === "string") || !Array.isArray(body.studentGroupIds) || !body.studentGroupIds.every((groupId: unknown) => typeof groupId === "string")) {
    return Response.json({ error: "Teacher and student group selections are invalid." }, { status: 400 });
  }
  try {
    if (!updateCourseSection(id, body.teacherId, body.studentGroupIds)) return Response.json({ error: "Section not found." }, { status: 404 });
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "Choose an active teacher and valid student groups." }, { status: 400 });
  }
}
