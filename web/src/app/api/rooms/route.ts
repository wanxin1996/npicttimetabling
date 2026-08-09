import { createRoom, listRooms } from "@/lib/database";

export const runtime = "nodejs";

export async function GET() {
  // The room list includes capacity and facilities used by future placement checks.
  return Response.json(listRooms());
}

export async function POST(request: Request) {
  // Check the basic room fields before calling SQLite, so the user sees an immediate error.
  const body = await request.json();
  const code = String(body.code ?? "").trim().toUpperCase();
  const capacity = Number(body.capacity);
  const addressParts = code.split("-");
  if (addressParts.length < 3 || addressParts.some((part) => !part) || !Number.isInteger(capacity) || capacity < 1) return Response.json({ error: "Use a Block-Level-Room code and a positive whole-number capacity." }, { status: 400 });

  try {
    // The database remains the final safeguard against duplicate room codes.
    return Response.json(createRoom({ code, capacity, hasLab: Boolean(body.hasLab), hasMultiProjector: Boolean(body.hasMultiProjector), isSmartClassroom: Boolean(body.isSmartClassroom) }), { status: 201 });
  } catch {
    return Response.json({ error: "A room with this code already exists." }, { status: 409 });
  }
}
