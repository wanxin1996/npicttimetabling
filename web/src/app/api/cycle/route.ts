import { CycleActionBusyError, CycleActionConflictError, cycleStatus, restoreLastCycleBackup, startNewCycle } from "@/lib/database";

export const runtime = "nodejs";

export function GET() {
  // 周期页面只需要当前记录数量和最新紧急备份的基本资料，不读取完整快照。
  try {
    return Response.json(cycleStatus());
  } catch (error) {
    if (error instanceof CycleActionBusyError) return Response.json({ error: error.message }, { status: 503 });
    console.error("Cycle status load failed", error);
    return Response.json({ error: "Cycle status could not be loaded. Try again." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  // 同一接口处理“开始新周期”和“恢复周期”两项相关高风险操作；
  // action 名称及准确确认短语共同决定允许执行哪个数据库事务。
  let parsedBody: unknown;
  try {
    parsedBody = await request.json();
  } catch {
    return Response.json({ error: "Choose a valid cycle action." }, { status: 400 });
  }
  const body = parsedBody && typeof parsedBody === "object" && !Array.isArray(parsedBody)
    ? parsedBody as Record<string, unknown>
    : {};
  try {
    if (body.action === "start") {
      // 服务器要求完全匹配确认短语，防止有人绕过界面三次确认，
      // 用一个误发的普通请求直接调用受保护 API。
      if (body.confirmation !== "START NEW CYCLE") return Response.json({ error: "Type START NEW CYCLE exactly to continue." }, { status: 400 });
      if (typeof body.currentToken !== "string" || !/^[a-f0-9]{64}$/.test(body.currentToken)) return Response.json({ error: "Refresh the cycle page before starting a new cycle." }, { status: 400 });
      return Response.json(startNewCycle(body.currentToken));
    }
    if (body.action === "restore") {
      if (body.confirmation !== "RESTORE LAST BACKUP") return Response.json({ error: "Type RESTORE LAST BACKUP exactly to continue." }, { status: 400 });
      if (typeof body.backupId !== "string" || !body.backupId || typeof body.currentToken !== "string" || !/^[a-f0-9]{64}$/.test(body.currentToken)) return Response.json({ error: "Refresh the cycle page and review the backup before restoring." }, { status: 400 });
      return Response.json(restoreLastCycleBackup(body.backupId, body.currentToken));
    }
    return Response.json({ error: "Choose a valid cycle action." }, { status: 400 });
  } catch (error) {
    if (error instanceof CycleActionConflictError) return Response.json({ error: error.message }, { status: 409 });
    if (error instanceof CycleActionBusyError) return Response.json({ error: error.message }, { status: 503 });
    // 未知 SQLite、trigger 或文件故障只写服务器日志；不能把技术文字泄露给浏览器，
    // 也不能误报成老师可以靠重新确认解决的 409。
    console.error("Cycle action failed", error);
    return Response.json({ error: "The cycle action could not be completed. Try again." }, { status: 500 });
  }
}
