import { listPersonalScheduledLessons } from "@/lib/database";

// Personal views are read-only projections of the same saved lessons used by the
// three year master tables, so they cannot drift into separate timetable copies.
export const runtime = "nodejs";

export async function GET(request: Request) {
  const parameters = new URL(request.url).searchParams;
  const kind = parameters.get("kind");
  const ownerId = parameters.get("ownerId") ?? "";
  if ((kind !== "Teacher" && kind !== "StudentGroup") || !ownerId) return Response.json({ error: "Choose a teacher or student group." }, { status: 400 });
  return Response.json(listPersonalScheduledLessons(kind, ownerId));
}
