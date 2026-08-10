import { createRoom, listRooms } from "@/lib/database";

export const runtime = "nodejs";

export async function GET() {
  // 教室清单包含容量和设施标记，后续排课要求检查会直接使用这些资料。
  return Response.json(listRooms());
}

export async function POST(request: Request) {
  // 调用 SQLite 前先检查教室基本字段，让用户能立即看到容易理解的输入错误。
  const body = await request.json();
  const code = String(body.code ?? "").trim().toUpperCase();
  const capacity = Number(body.capacity);
  const addressParts = code.split("-");
  if (addressParts.length < 3 || addressParts.some((part) => !part) || !Number.isInteger(capacity) || capacity < 1) return Response.json({ error: "Use a Block-Level-Room code and a positive whole-number capacity." }, { status: 400 });

  try {
    // 数据库唯一约束仍是防止重复教室编号的最后一道保障。
    return Response.json(createRoom({ code, capacity, hasLab: Boolean(body.hasLab), hasMultiProjector: Boolean(body.hasMultiProjector), isSmartClassroom: Boolean(body.isSmartClassroom) }), { status: 201 });
  } catch {
    return Response.json({ error: "A room with this code already exists." }, { status: 409 });
  }
}
