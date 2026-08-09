import { setTeacherStatus, updateTeacher } from "@/lib/database";

export const runtime = "nodejs";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  // Next.js provides dynamic route values asynchronously in this version.
  const { id } = await context.params;
  const body = await request.json();
  // A status toggle is intentionally separate from a complete details edit so a
  // table action cannot accidentally overwrite the teacher's name or type.
  if (typeof body.isActive === "boolean" && body.name === undefined) {
    if (!setTeacherStatus(id, body.isActive)) return Response.json({ error: "Teacher not found." }, { status: 404 });
    return Response.json({ ok: true });
  }

  // Normalise edits exactly like new teachers, preventing case-only duplicates.
  const name = String(body.name ?? "").trim().toUpperCase();
  const staffType = body.staffType === "PT" ? "PT" : body.staffType === "FT" ? "FT" : null;
  if (!name || !staffType) return Response.json({ error: "A teacher name and staff type are required." }, { status: 400 });

  try {
    // Preserve the teacher id and translate the database uniqueness rule into a
    // message the scheduler can act on.
    if (!updateTeacher(id, { name, staffType })) return Response.json({ error: "Teacher not found." }, { status: 404 });
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "A teacher with this name already exists." }, { status: 409 });
  }
}
