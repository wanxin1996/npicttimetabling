import { createTeacher, listTeachers, MasterDataUniqueConflictError } from "@/lib/database";
import { readJsonObject } from "@/lib/request-json";

// SQLite 使用原生 Node 模块，因此这些路由必须在 Node 运行环境中执行。
export const runtime = "nodejs";

export async function GET() {
  // 资料管理页面调用这个接口填充教师表格。
  return Response.json(listTeachers());
}

export async function POST(request: Request) {
  // 保存前统一姓名格式，避免“Wan Xin”和“WAN XIN”被当成两位不同教师。
  const parsed = await readJsonObject(request, "A teacher name and staff type are required.");
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;
  const name = String(body.name ?? "").trim().toUpperCase();
  const staffType = body.staffType === "PT" ? "PT" : body.staffType === "FT" ? "FT" : null;
  if (!name || !staffType) return Response.json({ error: "A teacher name and staff type are required." }, { status: 400 });

  try {
    // 由 SQLite 最终强制姓名唯一，并将其错误转换成清楚的 API 响应。
    return Response.json(createTeacher(name, staffType), { status: 201 });
  } catch (error) {
    if (error instanceof MasterDataUniqueConflictError) return Response.json({ error: error.message }, { status: 409 });
    console.error("Teacher creation failed", error);
    return Response.json({ error: "The teacher could not be created. Try again." }, { status: 500 });
  }
}
