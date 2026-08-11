import { MasterDataInputError, MasterDataRevisionConflictError, MasterDataUniqueConflictError, updateStudentGroup } from "@/lib/database";
import { safeDatabaseFailureResponse } from "@/lib/database-response";
import { parseStudentGroupPatch } from "@/lib/master-data-input";
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
    // 原记录就地更新并保留稳定 ID，因此所有现有课程班次关联继续有效。
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
