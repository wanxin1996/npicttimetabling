import { createTeacher, listTeachers } from "@/lib/database";

// SQLite uses native Node modules, so these routes must run in the Node runtime.
export const runtime = "nodejs";

export async function GET() {
  // The data-management screen calls this to populate its teachers table.
  return Response.json(listTeachers());
}

export async function POST(request: Request) {
  // Normalise names before saving so "Wan Xin" and "WAN XIN" are not duplicates.
  const body = await request.json();
  const name = String(body.name ?? "").trim().toUpperCase();
  const staffType = body.staffType === "PT" ? "PT" : body.staffType === "FT" ? "FT" : null;
  if (!name || !staffType) return Response.json({ error: "A teacher name and staff type are required." }, { status: 400 });

  try {
    // Let SQLite enforce unique names and turn its error into a clear API response.
    return Response.json(createTeacher(name, staffType), { status: 201 });
  } catch {
    return Response.json({ error: "A teacher with this name already exists." }, { status: 409 });
  }
}
