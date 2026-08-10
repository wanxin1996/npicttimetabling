import {
  CandidateSlotsBusyError,
  CandidateSlotsInputError,
  CandidateSlotsNotFoundError,
  CandidateSlotsStateConflictError,
  listCandidateSlots,
} from "@/lib/database";

// 候选建议按需实时计算，因为每次时间表编辑都可能改变哪些教师、班级、教室组合无冲突。
export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  // URL 路径指定生成的课程班次，查询参数则指出每周一次或两次课中的哪一次需要候选时段。
  const { id } = await context.params;
  const occurrenceText = new URL(request.url).searchParams.get("occurrence");
  // 缺省值保持每周第一次课；显式参数只接受 1 或 2，不能把空白、科学记数法或 +1 宽松转换成有效输入。
  if (occurrenceText !== null && !/^[12]$/.test(occurrenceText)) {
    return Response.json({ error: "Choose weekly session 1 or 2." }, { status: 400 });
  }
  const occurrence = occurrenceText === null ? 1 : Number(occurrenceText);
  try {
    return Response.json(listCandidateSlots(id, occurrence));
  } catch (error) {
    // 只有明确的业务错误可以把说明原样发给老师；SQLite、程序异常或表结构文字只能写服务器日志。
    if (error instanceof CandidateSlotsInputError) return Response.json({ error: error.message }, { status: 400 });
    if (error instanceof CandidateSlotsNotFoundError) return Response.json({ error: error.message }, { status: 404 });
    if (error instanceof CandidateSlotsStateConflictError) return Response.json({ code: "CANDIDATE_REQUEST_STALE", error: error.message }, { status: 409 });
    if (error instanceof CandidateSlotsBusyError) return Response.json({ error: error.message }, { status: 503, headers: { "Retry-After": "1" } });
    console.error("Candidate slot calculation failed", error);
    return Response.json({ error: "Candidate slots could not be calculated. Try again." }, { status: 500 });
  }
}
