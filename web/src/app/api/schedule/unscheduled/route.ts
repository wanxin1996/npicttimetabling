import { listUnscheduledSections } from "@/lib/database";
import { safeDatabaseFailureResponse } from "@/lib/database-response";
import { parseTimetableYear } from "@/lib/schedule-input";

// 待排区需要读取本地 SQLite，因此在 Node 服务器端运行。
export const runtime = "nodejs";

export async function GET(request: Request) {
  // 每个年级拥有独立待排区，因为排课老师主要在各自负责的年级总表中工作。
  const year = parseTimetableYear(new URL(request.url).searchParams.get("year"));
  if (year === null) return Response.json({ error: "Year must be 1, 2 or 3." }, { status: 400 });
  try {
    return Response.json(listUnscheduledSections(year));
  } catch (error) {
    return safeDatabaseFailureResponse(error, "Unscheduled section list failed", "Unscheduled sections could not be loaded. Try again.");
  }
}
