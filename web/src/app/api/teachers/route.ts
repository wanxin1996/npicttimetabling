import { createTeacher, listTeachers, MasterDataInputError, MasterDataUniqueConflictError } from "@/lib/database";
import { safeDatabaseFailureResponse } from "@/lib/database-response";
import { parseTeacherDetails } from "@/lib/master-data-input";
import { readJsonObject } from "@/lib/request-json";

// SQLite 使用原生 Node 模块，因此这些路由必须在 Node 运行环境中执行。
export const runtime = "nodejs";

export async function GET() {
  // 资料管理页面调用这个接口填充教师表格。
  try {
    return Response.json(listTeachers());
  } catch (error) {
    return safeDatabaseFailureResponse(error, "Teacher list failed", "The teachers could not be loaded. Try again.");
  }
}

export async function POST(request: Request) {
  // 保存前统一姓名格式，避免“Wan Xin”和“WAN XIN”被当成两位不同教师。
  const parsed = await readJsonObject(request, "Submit valid teacher data.");
  if (!parsed.ok) return parsed.response;
  const input = parseTeacherDetails(parsed.value);
  if (!input.ok) return Response.json({ error: input.error }, { status: 400 });

  try {
    // 由 SQLite 最终强制姓名唯一，并将其错误转换成清楚的 API 响应。
    return Response.json(createTeacher(input.value.name, input.value.staffType), { status: 201 });
  } catch (error) {
    if (error instanceof MasterDataInputError) return Response.json({ error: error.message }, { status: 400 });
    if (error instanceof MasterDataUniqueConflictError) return Response.json({ error: error.message }, { status: 409 });
    return safeDatabaseFailureResponse(error, "Teacher creation failed", "The teacher could not be created. Try again.");
  }
}
