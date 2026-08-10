import { listCandidateSlots } from "@/lib/database";

// Suggestions are calculated on demand because every timetable edit can change which
// teacher, student-group and room combinations are completely clear.
export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  // The path identifies the generated section and the query selects which of its
  // one or two weekly occurrences needs clear room-and-time options.
  const { id } = await context.params;
  const occurrence = Number(new URL(request.url).searchParams.get("occurrence") ?? 1);
  try {
    return Response.json(listCandidateSlots(id, occurrence));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Candidate slots could not be calculated." }, { status: 400 });
  }
}
