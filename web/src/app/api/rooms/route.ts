import { createRoom, listRooms } from "@/lib/database";

export const runtime = "nodejs";

export async function GET() {
  return Response.json(listRooms());
}

export async function POST(request: Request) {
  const body = await request.json();
  const code = String(body.code ?? "").trim().toUpperCase();
  const capacity = Number(body.capacity);
  if (!code || !Number.isInteger(capacity) || capacity < 1) return Response.json({ error: "A room code and positive whole-number capacity are required." }, { status: 400 });

  try {
    return Response.json(createRoom({ code, capacity, hasLab: Boolean(body.hasLab), hasMultiProjector: Boolean(body.hasMultiProjector), isSmartClassroom: Boolean(body.isSmartClassroom) }), { status: 201 });
  } catch {
    return Response.json({ error: "A room with this code already exists." }, { status: 409 });
  }
}
