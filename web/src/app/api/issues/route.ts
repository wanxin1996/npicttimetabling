import { listScheduleIssues } from "@/lib/database";

// The consolidated issue endpoint recalculates warnings before returning them, so
// the review page always represents the current timetable and restriction rules.
export const runtime = "nodejs";

export async function GET() {
  // A fresh calculation makes this read endpoint the authoritative list after any
  // timetable, rule, room or availability change.
  return Response.json(listScheduleIssues());
}
