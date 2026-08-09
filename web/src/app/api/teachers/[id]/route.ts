import { setTeacherStatus } from "@/lib/database";

export const runtime = "nodejs";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  // Next.js provides dynamic route values asynchronously in this version.
  const { id } = await context.params;
  const body = await request.json();
  // Only allow a status change here; teacher details are edited in a later feature.
  if (typeof body.isActive !== "boolean") return Response.json({ error: "isActive must be a boolean." }, { status: 400 });
  if (!setTeacherStatus(id, body.isActive)) return Response.json({ error: "Teacher not found." }, { status: 404 });
  return Response.json({ ok: true });
}
