import { deleteStudentGroup, MasterDataInputError, MasterDataRevisionConflictError, MasterDataUniqueConflictError, StudentGroupInUseError, updateStudentGroup } from "@/lib/database";
import { safeDatabaseFailureResponse } from "@/lib/database-response";
import { parsePositiveRevision, parseStudentGroupPatch } from "@/lib/master-data-input";
import { readJsonObject } from "@/lib/request-json";

export const runtime = "nodejs";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  // 使用与新增班级相同的规则读取并标准化每个可编辑字段，保持资料格式一致。
  const { id } = await context.params;
  const parsed = await readJsonObject(request, "Submit valid student-group data.");
  if (!parsed.ok) return parsed.response;
  const input = parseStudentGroupPatch(parsed.value);
  if (!input.ok) return Response.json({ error: input.error }, { status: 400 });

  try {
    // 原记录就地更新并保留稳定 ID；年级与编号组合只和同一年级记录比较唯一性。
    const saved = updateStudentGroup(id, { ...input.value.details, revision: input.value.revision });
    if (!saved) return Response.json({ error: "Student group not found." }, { status: 404 });
    return Response.json({ ok: true, revision: saved.revision, changed: saved.changed });
  } catch (error) {
    if (error instanceof MasterDataInputError) return Response.json({ error: error.message }, { status: 400 });
    if (error instanceof MasterDataRevisionConflictError) return Response.json({ code: "MASTER_DATA_CHANGED", error: error.message }, { status: 409 });
    if (error instanceof MasterDataUniqueConflictError) return Response.json({ error: error.message }, { status: 409 });
    // warning 重算或其他数据库故障只记录在服务器；前端不能把未知失败误报为编号重复。
    return safeDatabaseFailureResponse(error, "Student-group update failed", "The student group could not be updated. Try again.");
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  // 删除必须携带画面当前 revision；确认对话框打开后若另一位老师已修改资料，
  // 旧请求会得到409并刷新，而不是删除一条用户没有审阅过的新版记录。
  const { id } = await context.params;
  const parsed = await readJsonObject(request, "Submit a valid student-group revision.");
  if (!parsed.ok) return parsed.response;
  const revision = parsePositiveRevision(parsed.value.revision, "Student-group");
  if (!revision.ok) return Response.json({ error: revision.error }, { status: 400 });

  try {
    const removed = deleteStudentGroup(id, revision.value);
    if (removed === null) return Response.json({ error: "Student group not found." }, { status: 404 });
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof MasterDataInputError) return Response.json({ error: error.message }, { status: 400 });
    if (error instanceof MasterDataRevisionConflictError) {
      return Response.json({ code: "MASTER_DATA_CHANGED", error: error.message }, { status: 409 });
    }
    if (error instanceof StudentGroupInUseError) {
      return Response.json({ code: error.code, error: error.message }, { status: 409 });
    }
    return safeDatabaseFailureResponse(error, "Student-group deletion failed", "The student group could not be deleted. Try again.");
  }
}
