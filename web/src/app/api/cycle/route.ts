import { cycleStatus, restoreLastCycleBackup, startNewCycle } from "@/lib/database";

export const runtime = "nodejs";

export function GET() {
  // 周期页面只需要当前记录数量和最新紧急备份的基本资料，不读取完整快照。
  return Response.json(cycleStatus());
}

export async function POST(request: Request) {
  // 同一接口处理“开始新周期”和“恢复周期”两项相关高风险操作；
  // action 名称及准确确认短语共同决定允许执行哪个数据库事务。
  const body = await request.json();
  try {
    if (body.action === "start") {
      // 服务器要求完全匹配确认短语，防止有人绕过界面三次确认，
      // 用一个误发的普通请求直接调用受保护 API。
      if (body.confirmation !== "START NEW CYCLE") return Response.json({ error: "Type START NEW CYCLE exactly to continue." }, { status: 400 });
      return Response.json(startNewCycle());
    }
    if (body.action === "restore") {
      if (body.confirmation !== "RESTORE LAST BACKUP") return Response.json({ error: "Type RESTORE LAST BACKUP exactly to continue." }, { status: 400 });
      return Response.json(restoreLastCycleBackup());
    }
    return Response.json({ error: "Choose a valid cycle action." }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "The cycle action could not be completed." }, { status: 409 });
  }
}
