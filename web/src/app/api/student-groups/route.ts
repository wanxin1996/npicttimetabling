import { createStudentGroup, listStudentGroups, MasterDataInputError, MasterDataUniqueConflictError } from "@/lib/database";
import { safeDatabaseFailureResponse } from "@/lib/database-response";
import { parseStudentGroupDetails } from "@/lib/master-data-input";
import { readJsonObject } from "@/lib/request-json";

export const runtime = "nodejs";

export async function GET() {
  // 返回全部学生班级，因为历史冲突检查需要所有班级，而不只是当前启用项目。
  try {
    return Response.json(listStudentGroups());
  } catch (error) {
    return safeDatabaseFailureResponse(error, "Student-group list failed", "The student groups could not be loaded. Try again.");
  }
}

export async function POST(request: Request) {
  // 按院系命名习惯把班级编号和专业缩写统一转换为大写。
  const parsed = await readJsonObject(request, "Submit valid student-group data.");
  if (!parsed.ok) return parsed.response;
  const input = parseStudentGroupDetails(parsed.value);
  if (!input.ok) return Response.json({ error: input.error }, { status: 400 });

  try {
    // SQLite 负责最终执行班级编号唯一规则；若重复，则向界面返回明确可处理的提示。
    return Response.json(createStudentGroup(input.value.code, input.value.year, input.value.program), { status: 201 });
  } catch (error) {
    if (error instanceof MasterDataInputError) return Response.json({ error: error.message }, { status: 400 });
    if (error instanceof MasterDataUniqueConflictError) return Response.json({ error: error.message }, { status: 409 });
    return safeDatabaseFailureResponse(error, "Student-group creation failed", "The student group could not be created. Try again.");
  }
}
