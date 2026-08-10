import { listCandidateSlots } from "@/lib/database";

// 候选建议按需实时计算，因为每次时间表编辑都可能改变哪些教师、班级、教室组合无冲突。
export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  // URL 路径指定生成的课程班次，查询参数则指出每周一次或两次课中的哪一次需要候选时段。
  const { id } = await context.params;
  const occurrence = Number(new URL(request.url).searchParams.get("occurrence") ?? 1);
  try {
    return Response.json(listCandidateSlots(id, occurrence));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Candidate slots could not be calculated." }, { status: 400 });
  }
}
