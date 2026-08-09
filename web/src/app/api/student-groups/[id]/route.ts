import { updateStudentGroup } from "@/lib/database";

export const runtime = "nodejs";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  // Read and normalise every editable field using the same rules as group creation.
  const { id } = await context.params;
  const body = await request.json();
  const code = String(body.code ?? "").trim().toUpperCase();
  const program = String(body.program ?? "").trim().toUpperCase();
  const year = Number(body.year);
  if (!code || !program || ![1, 2, 3].includes(year)) {
    return Response.json({ error: "A code, programme and valid year are required." }, { status: 400 });
  }

  try {
    // Updating in place keeps all existing section-to-student-group assignments.
    if (!updateStudentGroup(id, { code, year, program })) return Response.json({ error: "Student group not found." }, { status: 404 });
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "A student group with this code already exists." }, { status: 409 });
  }
}
