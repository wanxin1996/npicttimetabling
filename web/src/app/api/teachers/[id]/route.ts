import { MasterDataInputError, MasterDataRevisionConflictError, MasterDataUniqueConflictError, setTeacherStatus, updateTeacher } from "@/lib/database";
import { safeDatabaseFailureResponse } from "@/lib/database-response";
import { parseTeacherPatch } from "@/lib/master-data-input";
import { readJsonObject } from "@/lib/request-json";

export const runtime = "nodejs";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  // 当前 Next.js 版本以异步方式提供动态路由参数，因此这里需要等待解析。
  const { id } = await context.params;
  const parsed = await readJsonObject(request, "Submit valid teacher data.");
  if (!parsed.ok) return parsed.response;
  const input = parseTeacherPatch(parsed.value);
  if (!input.ok) return Response.json({ error: input.error }, { status: 400 });

  // 状态切换与完整资料编辑刻意分开，避免表格中的快捷操作意外覆盖教师姓名或类型。
  if (input.value.kind === "status") {
    try {
      // 状态与全部 warning 在数据库事务中一起提交；重算失败时接口返回通用错误，旧状态仍保持不变。
      const saved = setTeacherStatus(id, input.value.isActive, input.value.revision);
      if (!saved) return Response.json({ error: "Teacher not found." }, { status: 404 });
      return Response.json({ ok: true, revision: saved.revision, changed: saved.changed });
    } catch (error) {
      if (error instanceof MasterDataInputError) return Response.json({ error: error.message }, { status: 400 });
      if (error instanceof MasterDataRevisionConflictError) return Response.json({ code: "MASTER_DATA_CHANGED", error: error.message }, { status: 409 });
      return safeDatabaseFailureResponse(error, "Teacher status update failed", "Teacher status could not be updated. Try again.");
    }
  }

  try {
    // 保留教师稳定 ID，并把数据库唯一约束转换为排课老师可以理解和修正的提示。
    const saved = updateTeacher(id, { ...input.value.details, revision: input.value.revision });
    if (!saved) return Response.json({ error: "Teacher not found." }, { status: 404 });
    return Response.json({ ok: true, revision: saved.revision, changed: saved.changed });
  } catch (error) {
    if (error instanceof MasterDataInputError) return Response.json({ error: error.message }, { status: 400 });
    if (error instanceof MasterDataRevisionConflictError) return Response.json({ code: "MASTER_DATA_CHANGED", error: error.message }, { status: 409 });
    if (error instanceof MasterDataUniqueConflictError) return Response.json({ error: error.message }, { status: 409 });
    return safeDatabaseFailureResponse(error, "Teacher update failed", "The teacher could not be updated. Try again.");
  }
}
