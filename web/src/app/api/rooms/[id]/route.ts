import { setRoomStatus } from "@/lib/database";

export const runtime = "nodejs";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = await request.json();
  if (typeof body.isActive !== "boolean") return Response.json({ error: "isActive must be a boolean." }, { status: 400 });
  if (!setRoomStatus(id, body.isActive)) return Response.json({ error: "Room not found." }, { status: 404 });
  return Response.json({ ok: true });
}
