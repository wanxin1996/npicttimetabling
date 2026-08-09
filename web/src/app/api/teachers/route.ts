import { createTeacher, listTeachers } from "@/lib/database";

export const runtime = "nodejs";

export async function GET() {
  return Response.json(listTeachers());
}

export async function POST(request: Request) {
  const body = await request.json();
  const name = String(body.name ?? "").trim().toUpperCase();
  const staffType = body.staffType === "PT" ? "PT" : body.staffType === "FT" ? "FT" : null;
  if (!name || !staffType) return Response.json({ error: "A teacher name and staff type are required." }, { status: 400 });

  try {
    return Response.json(createTeacher(name, staffType), { status: 201 });
  } catch {
    return Response.json({ error: "A teacher with this name already exists." }, { status: 409 });
  }
}
