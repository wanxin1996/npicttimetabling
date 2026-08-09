import { listCandidateSlots } from "@/lib/database";

// Suggestions are calculated on demand because every timetable edit can change which
// teacher, student-group and room combinations are completely clear.
export const runtime = "nodejs";

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    return Response.json(listCandidateSlots(id));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Candidate slots could not be calculated." }, { status: 400 });
  }
}
