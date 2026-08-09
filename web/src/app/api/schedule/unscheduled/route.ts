import { listUnscheduledSections } from "@/lib/database";

// The unscheduled tray reads local SQLite and therefore runs on the Node server.
export const runtime = "nodejs";

export async function GET(request: Request) {
  // Each year has its own tray because schedulers work primarily within one master table.
  const year = Number(new URL(request.url).searchParams.get("year") ?? 1);
  if (![1, 2, 3].includes(year)) return Response.json({ error: "Year must be 1, 2 or 3." }, { status: 400 });
  return Response.json(listUnscheduledSections(year));
}
