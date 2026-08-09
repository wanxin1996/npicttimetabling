import { createUnavailableWindow, deleteUnavailableWindow, listUnavailableWindows } from "@/lib/database";

// Unavailability rules are persisted in local SQLite and evaluated during placement.
export const runtime = "nodejs";

export function GET() {
  return Response.json(listUnavailableWindows());
}

export async function POST(request: Request) {
  // Both rule types share day and hour validation; ownerId is a teacher id or year string.
  const body = await request.json();
  if (!(["Teacher", "Year"] as const).includes(body.kind) || typeof body.ownerId !== "string" || !Number.isInteger(body.dayOfWeek) || body.dayOfWeek < 1 || body.dayOfWeek > 5 || !Number.isInteger(body.startHour) || !Number.isInteger(body.endHour) || body.startHour < 8 || body.endHour > 18 || body.endHour <= body.startHour || (body.kind === "Year" && !["1", "2", "3"].includes(body.ownerId))) return Response.json({ error: "Choose a valid owner, weekday and time range." }, { status: 400 });
  try { return Response.json({ id: createUnavailableWindow(body) }, { status: 201 }); } catch { return Response.json({ error: "The unavailable window could not be saved." }, { status: 400 }); }
}

export async function DELETE(request: Request) {
  // Query parameters keep deletion simple for the compact rules list.
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  const kind = url.searchParams.get("kind");
  if (!id || (kind !== "Teacher" && kind !== "Year")) return Response.json({ error: "Rule id and kind are required." }, { status: 400 });
  if (!deleteUnavailableWindow(id, kind)) return Response.json({ error: "Unavailable window not found." }, { status: 404 });
  return Response.json({ ok: true });
}
