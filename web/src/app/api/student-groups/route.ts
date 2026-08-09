import { createStudentGroup, listStudentGroups } from "@/lib/database";

export const runtime = "nodejs";

export async function GET() {
  // Return all student classes because conflict checks need every class, not only active ones.
  return Response.json(listStudentGroups());
}

export async function POST(request: Request) {
  // Match the department's convention: codes and programme abbreviations are uppercase.
  const body = await request.json();
  const code = String(body.code ?? "").trim().toUpperCase();
  const program = String(body.program ?? "").trim().toUpperCase();
  const year = Number(body.year);
  if (!code || !program || ![1, 2, 3].includes(year)) return Response.json({ error: "A code, programme and valid year are required." }, { status: 400 });

  try {
    // SQLite handles the unique code rule; return a useful conflict message to the UI.
    return Response.json(createStudentGroup(code, year, program), { status: 201 });
  } catch {
    return Response.json({ error: "A student group with this code already exists." }, { status: 409 });
  }
}
