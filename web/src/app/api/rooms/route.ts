import { createRoom, listRooms, MasterDataUniqueConflictError } from "@/lib/database";

export const runtime = "nodejs";

export async function GET() {
  // 教室清单包含容量和设施标记，后续排课要求检查会直接使用这些资料。
  return Response.json(listRooms());
}

export async function POST(request: Request) {
  // 调用 SQLite 前先检查教室基本字段，让用户能立即看到容易理解的输入错误。
  let parsedBody: unknown;
  try {
    parsedBody = await request.json();
  } catch {
    return Response.json({ error: "Use a Block-Level-Room code and a positive whole-number capacity." }, { status: 400 });
  }
  const body = parsedBody && typeof parsedBody === "object" && !Array.isArray(parsedBody)
    ? parsedBody as Record<string, unknown>
    : {};
  const code = String(body.code ?? "").trim().toUpperCase();
  const capacity = Number(body.capacity);
  const addressParts = code.split("-");
  const featureFieldsAreBoolean = [body.hasLab, body.hasMultiProjector, body.isSmartClassroom]
    .every((value) => value === undefined || typeof value === "boolean");
  if (addressParts.length < 3 || addressParts.some((part) => !part) || !Number.isInteger(capacity) || capacity < 1 || !featureFieldsAreBoolean) return Response.json({ error: "Use a Block-Level-Room code, a positive whole-number capacity and valid feature choices." }, { status: 400 });

  try {
    // 数据库唯一约束仍是防止重复教室编号的最后一道保障。
    return Response.json(createRoom({ code, capacity, hasLab: Boolean(body.hasLab), hasMultiProjector: Boolean(body.hasMultiProjector), isSmartClassroom: Boolean(body.isSmartClassroom) }), { status: 201 });
  } catch (error) {
    if (error instanceof MasterDataUniqueConflictError) return Response.json({ error: error.message }, { status: 409 });
    console.error("Room creation failed", error);
    return Response.json({ error: "The room could not be created. Try again." }, { status: 500 });
  }
}
