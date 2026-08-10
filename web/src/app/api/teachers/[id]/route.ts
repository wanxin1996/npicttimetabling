import { setTeacherStatus, updateTeacher } from "@/lib/database";

export const runtime = "nodejs";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  // 当前 Next.js 版本以异步方式提供动态路由参数，因此这里需要等待解析。
  const { id } = await context.params;
  const body = await request.json();
  // 状态切换与完整资料编辑刻意分开，避免表格中的快捷操作意外覆盖教师姓名或类型。
  if (typeof body.isActive === "boolean" && body.name === undefined) {
    if (!setTeacherStatus(id, body.isActive)) return Response.json({ error: "Teacher not found." }, { status: 404 });
    return Response.json({ ok: true });
  }

  // 编辑资料时使用与新增教师完全相同的标准化规则，防止只因大小写不同而重复。
  const name = String(body.name ?? "").trim().toUpperCase();
  const staffType = body.staffType === "PT" ? "PT" : body.staffType === "FT" ? "FT" : null;
  if (!name || !staffType) return Response.json({ error: "A teacher name and staff type are required." }, { status: 400 });

  try {
    // 保留教师稳定 ID，并把数据库唯一约束转换为排课老师可以理解和修正的提示。
    if (!updateTeacher(id, { name, staffType })) return Response.json({ error: "Teacher not found." }, { status: 404 });
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "A teacher with this name already exists." }, { status: 409 });
  }
}
