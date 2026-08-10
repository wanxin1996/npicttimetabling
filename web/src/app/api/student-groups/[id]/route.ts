import { updateStudentGroup } from "@/lib/database";

export const runtime = "nodejs";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  // 使用与新增班级相同的规则读取并标准化每个可编辑字段，保持资料格式一致。
  const { id } = await context.params;
  const body = await request.json();
  const code = String(body.code ?? "").trim().toUpperCase();
  const program = String(body.program ?? "").trim().toUpperCase();
  const year = Number(body.year);
  if (!code || !program || ![1, 2, 3].includes(year)) {
    return Response.json({ error: "A code, programme and valid year are required." }, { status: 400 });
  }

  try {
    // 原记录就地更新并保留稳定 ID，因此所有现有课程班次关联继续有效。
    if (!updateStudentGroup(id, { code, year, program })) return Response.json({ error: "Student group not found." }, { status: 404 });
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "A student group with this code already exists." }, { status: 409 });
  }
}
