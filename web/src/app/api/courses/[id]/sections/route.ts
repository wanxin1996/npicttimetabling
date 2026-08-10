import { listCourseSections, resizeCourseSections } from "@/lib/database";

// 此路由在 Node 环境中读取某一门选定课程生成的全部班次。
export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  // 把课程 ID 放入 URL，只返回当前课程班次，避免一次发送数百条无关资料。
  const { id } = await context.params;
  return Response.json(listCourseSections(id));
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  // 老师可修正 Excel 中错误的班次总数，同时保留低编号班次的名称及已有教师、班级分配。
  const { id } = await context.params;
  const body = await request.json();
  const sectionCount = Number(body.sectionCount);
  if (!Number.isInteger(sectionCount) || sectionCount < 1 || sectionCount > 999) {
    return Response.json({ error: "Section count must be a whole number from 1 to 999." }, { status: 400 });
  }

  try {
    if (!resizeCourseSections(id, sectionCount)) return Response.json({ error: "Course not found." }, { status: 404 });
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Section count could not be changed." }, { status: 409 });
  }
}
