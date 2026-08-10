import { createStudentGroup, listStudentGroups, MasterDataUniqueConflictError } from "@/lib/database";

export const runtime = "nodejs";

export async function GET() {
  // 返回全部学生班级，因为历史冲突检查需要所有班级，而不只是当前启用项目。
  return Response.json(listStudentGroups());
}

export async function POST(request: Request) {
  // 按院系命名习惯把班级编号和专业缩写统一转换为大写。
  let parsedBody: unknown;
  try {
    parsedBody = await request.json();
  } catch {
    return Response.json({ error: "A code, programme and valid year are required." }, { status: 400 });
  }
  // JSON 的 null、数组或其他非对象值都没有表单字段，统一按可修正的 400 处理。
  const body = parsedBody && typeof parsedBody === "object" && !Array.isArray(parsedBody)
    ? parsedBody as Record<string, unknown>
    : {};
  const code = String(body.code ?? "").trim().toUpperCase();
  const program = String(body.program ?? "").trim().toUpperCase();
  const year = Number(body.year);
  if (!code || !program || ![1, 2, 3].includes(year)) return Response.json({ error: "A code, programme and valid year are required." }, { status: 400 });

  try {
    // SQLite 负责最终执行班级编号唯一规则；若重复，则向界面返回明确可处理的提示。
    return Response.json(createStudentGroup(code, year, program), { status: 201 });
  } catch (error) {
    if (error instanceof MasterDataUniqueConflictError) return Response.json({ error: error.message }, { status: 409 });
    console.error("Student group creation failed", error);
    return Response.json({ error: "The student group could not be created. Try again." }, { status: 500 });
  }
}
