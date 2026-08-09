import { listCourseAllocationVariances } from "@/lib/database";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  // Keep allocation review separate from the section list so future summaries can
  // refresh independently without changing the established sections API contract.
  const { id } = await context.params;
  return Response.json(listCourseAllocationVariances(id));
}
