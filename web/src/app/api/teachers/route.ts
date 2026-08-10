import { createTeacher, listTeachers } from "@/lib/database";

// SQLite 使用原生 Node 模块，因此这些路由必须在 Node 运行环境中执行。
export const runtime = "nodejs";

export async function GET() {
  // 资料管理页面调用这个接口填充教师表格。
  return Response.json(listTeachers());
}

export async function POST(request: Request) {
  // 保存前统一姓名格式，避免“Wan Xin”和“WAN XIN”被当成两位不同教师。
  const body = await request.json();
  const name = String(body.name ?? "").trim().toUpperCase();
  const staffType = body.staffType === "PT" ? "PT" : body.staffType === "FT" ? "FT" : null;
  if (!name || !staffType) return Response.json({ error: "A teacher name and staff type are required." }, { status: 400 });

  try {
    // 由 SQLite 最终强制姓名唯一，并将其错误转换成清楚的 API 响应。
    return Response.json(createTeacher(name, staffType), { status: 201 });
  } catch {
    return Response.json({ error: "A teacher with this name already exists." }, { status: 409 });
  }
}
