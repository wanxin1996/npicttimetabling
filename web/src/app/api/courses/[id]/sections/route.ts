import { listCourseSections, resizeCourseSections } from "@/lib/database";

// This route reads generated sections for one selected course in the Node runtime.
export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  // Keeping the course id in the URL avoids returning hundreds of sections at once.
  const { id } = await context.params;
  return Response.json(listCourseSections(id));
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  // Staff can correct an incorrect Excel total without renaming or recreating the
  // lower-numbered sections that already contain useful assignments.
  const { id } = await context.params;
  const body = await request.json();
  const sectionCount = Number(body.sectionCount);
  if (!Number.isInteger(sectionCount) || sectionCount < 1 || sectionCount > 999) {
    return Response.json({ error: "Section count must be a whole number from 1 to 999." }, { status: 400 });
  }

  try {
    if (!resizeCourseSections(id, sectionCount)) return Response.json({ error: "Course not found." }, { status: 404 });
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Section count could not be changed." }, { status: 409 });
  }
}
