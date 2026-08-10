import { MasterDataUniqueConflictError, setRoomStatus, updateRoom } from "@/lib/database";

export const runtime = "nodejs";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  // 从 URL 读取教室 ID，并判断请求是简单状态切换，还是资料管理表单提交的完整编辑。
  const { id } = await context.params;
  let parsedBody: unknown;
  try {
    parsedBody = await request.json();
  } catch {
    return Response.json({ error: "Room details are invalid." }, { status: 400 });
  }
  const body = parsedBody && typeof parsedBody === "object" && !Array.isArray(parsedBody)
    ? parsedBody as Record<string, unknown>
    : {};
  if (typeof body.isActive === "boolean" && body.code === undefined) {
    // 状态切换不删除资料，因此已经使用该教室的课程记录仍然完整保留。
    try {
      if (!setRoomStatus(id, body.isActive)) return Response.json({ error: "Room not found." }, { status: 404 });
      return Response.json({ ok: true });
    } catch (error) {
      console.error("Room status update failed", error);
      return Response.json({ error: "The room status could not be updated. Try again." }, { status: 500 });
    }
  }

  // 教室地址采用 Block-Level-Room 格式，第一段楼栋编号用于连续课程跨楼提醒。
  const code = String(body.code ?? "").trim().toUpperCase();
  const capacity = Number(body.capacity);
  const addressParts = code.split("-");
  const featureFieldsAreBoolean = [body.hasLab, body.hasMultiProjector, body.isSmartClassroom]
    .every((value) => value === undefined || typeof value === "boolean");
  if (addressParts.length < 3 || addressParts.some((part) => !part) || !Number.isInteger(capacity) || capacity < 1 || !featureFieldsAreBoolean) {
    return Response.json({ error: "Use a Block-Level-Room code, a positive whole-number capacity and valid feature choices." }, { status: 400 });
  }

  try {
    const updated = updateRoom(id, { code, capacity, hasLab: Boolean(body.hasLab), hasMultiProjector: Boolean(body.hasMultiProjector), isSmartClassroom: Boolean(body.isSmartClassroom) });
    if (!updated) return Response.json({ error: "Room not found." }, { status: 404 });
    return Response.json({ ok: true });
  } catch (error) {
    // 若新地址已被其他教室使用，把数据库唯一约束转换成清楚的修正提示，
    // 而不是返回笼统数据库错误。
    if (error instanceof MasterDataUniqueConflictError) return Response.json({ error: error.message }, { status: 409 });
    console.error("Room update failed", error);
    return Response.json({ error: "The room could not be updated. Try again." }, { status: 500 });
  }
}
