import { MasterDataInputError, MasterDataRevisionConflictError, MasterDataUniqueConflictError, setRoomStatus, updateRoom } from "@/lib/database";
import { safeDatabaseFailureResponse } from "@/lib/database-response";
import { parseRoomPatch } from "@/lib/master-data-input";
import { readJsonObject } from "@/lib/request-json";

export const runtime = "nodejs";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  // 从 URL 读取教室 ID，并判断请求是简单状态切换，还是资料管理表单提交的完整编辑。
  const { id } = await context.params;
  const parsed = await readJsonObject(request, "Submit valid room data.");
  if (!parsed.ok) return parsed.response;
  const input = parseRoomPatch(parsed.value);
  if (!input.ok) return Response.json({ error: input.error }, { status: 400 });

  if (input.value.kind === "status") {
    // 状态切换不删除资料，因此已经使用该教室的课程记录仍然完整保留。
    try {
      const saved = setRoomStatus(id, input.value.isActive, input.value.revision);
      if (!saved) return Response.json({ error: "Room not found." }, { status: 404 });
      return Response.json({ ok: true, revision: saved.revision, changed: saved.changed });
    } catch (error) {
      if (error instanceof MasterDataInputError) return Response.json({ error: error.message }, { status: 400 });
      if (error instanceof MasterDataRevisionConflictError) return Response.json({ code: "MASTER_DATA_CHANGED", error: error.message }, { status: 409 });
      return safeDatabaseFailureResponse(error, "Room status update failed", "The room status could not be updated. Try again.");
    }
  }

  try {
    const saved = updateRoom(id, { ...input.value.details, revision: input.value.revision });
    if (!saved) return Response.json({ error: "Room not found." }, { status: 404 });
    return Response.json({ ok: true, revision: saved.revision, changed: saved.changed });
  } catch (error) {
    // 若新地址已被其他教室使用，把数据库唯一约束转换成清楚的修正提示，
    // 而不是返回笼统数据库错误。
    if (error instanceof MasterDataInputError) return Response.json({ error: error.message }, { status: 400 });
    if (error instanceof MasterDataRevisionConflictError) return Response.json({ code: "MASTER_DATA_CHANGED", error: error.message }, { status: 409 });
    if (error instanceof MasterDataUniqueConflictError) return Response.json({ error: error.message }, { status: 409 });
    return safeDatabaseFailureResponse(error, "Room update failed", "The room could not be updated. Try again.");
  }
}
