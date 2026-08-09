import { listCourseSections } from "@/lib/database";

// This route reads generated sections for one selected course in the Node runtime.
export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  // Keeping the course id in the URL avoids returning hundreds of sections at once.
  const { id } = await context.params;
  return Response.json(listCourseSections(id));
}
