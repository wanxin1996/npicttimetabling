import { setRoomStatus, updateRoom } from "@/lib/database";

export const runtime = "nodejs";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  // Read the room id from the URL and decide whether this is a status toggle or a
  // complete room-details edit from the data-management form.
  const { id } = await context.params;
  const body = await request.json();
  if (typeof body.isActive === "boolean" && body.code === undefined) {
    // Status toggles remain non-destructive, preserving any lessons using the room.
    if (!setRoomStatus(id, body.isActive)) return Response.json({ error: "Room not found." }, { status: 404 });
    return Response.json({ ok: true });
  }

  // Room addresses use Block-Level-Room so the first segment can drive travel warnings.
  const code = String(body.code ?? "").trim().toUpperCase();
  const capacity = Number(body.capacity);
  const addressParts = code.split("-");
  if (addressParts.length < 3 || addressParts.some((part) => !part) || !Number.isInteger(capacity) || capacity < 1) {
    return Response.json({ error: "Use a Block-Level-Room code and a positive whole-number capacity." }, { status: 400 });
  }

  try {
    const updated = updateRoom(id, { code, capacity, hasLab: Boolean(body.hasLab), hasMultiProjector: Boolean(body.hasMultiProjector), isSmartClassroom: Boolean(body.isSmartClassroom) });
    if (!updated) return Response.json({ error: "Room not found." }, { status: 404 });
    return Response.json({ ok: true });
  } catch {
    // The unique room-code constraint gives staff a clear correction instead of a
    // generic database error if another room already uses the new address.
    return Response.json({ error: "A room with this code already exists." }, { status: 409 });
  }
}
