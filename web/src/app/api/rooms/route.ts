import { createRoom, listRooms, MasterDataInputError, MasterDataUniqueConflictError } from "@/lib/database";
import { safeDatabaseFailureResponse } from "@/lib/database-response";
import { parseRoomDetails } from "@/lib/master-data-input";
import { readJsonObject } from "@/lib/request-json";

export const runtime = "nodejs";

export async function GET() {
  // 教室清单包含容量和设施标记，后续排课要求检查会直接使用这些资料。
  try {
    return Response.json(listRooms());
  } catch (error) {
    return safeDatabaseFailureResponse(error, "Room list failed", "The rooms could not be loaded. Try again.");
  }
}

export async function POST(request: Request) {
  // 调用 SQLite 前先检查教室基本字段，让用户能立即看到容易理解的输入错误。
  const parsed = await readJsonObject(request, "Submit valid room data.");
  if (!parsed.ok) return parsed.response;
  const input = parseRoomDetails(parsed.value);
  if (!input.ok) return Response.json({ error: input.error }, { status: 400 });

  try {
    // 数据库唯一约束仍是防止重复教室编号的最后一道保障。
    return Response.json(createRoom(input.value), { status: 201 });
  } catch (error) {
    if (error instanceof MasterDataInputError) return Response.json({ error: error.message }, { status: 400 });
    if (error instanceof MasterDataUniqueConflictError) return Response.json({ error: error.message }, { status: 409 });
    return safeDatabaseFailureResponse(error, "Room creation failed", "The room could not be created. Try again.");
  }
}
