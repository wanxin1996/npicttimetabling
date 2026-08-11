import { DatabaseBusyError, listYearTimetableWorkspace } from "@/lib/database";
import { safeDatabaseFailureResponse } from "@/lib/database-response";
import { parseTimetableYear } from "@/lib/schedule-input";

// 年级排课工作区读取本地 SQLite，并且必须让总表与待排区来自同一数据库快照。
export const runtime = "nodejs";

export async function GET(request: Request) {
  // 三个年级各有独立总表；拒绝其他数字，避免错误参数悄悄返回空画面。
  const year = parseTimetableYear(new URL(request.url).searchParams.get("year"));
  if (year === null) {
    return Response.json({ error: "Year must be 1, 2 or 3." }, { status: 400 });
  }

  // database 层用一个 DEFERRED 事务读取五份资料。这里一次返回完整 payload，浏览器
  // 不再自行拼接不同时间点的 lessons 与 unscheduled sessions。
  try {
    return Response.json(listYearTimetableWorkspace(year));
  } catch (error) {
    // 五秒轮询遇到短暂数据库锁时明确告诉浏览器稍后重试；固定响应不会泄漏 SQL、
    // SQLite 错误代码或本机数据库路径，Retry-After 也让调用方避免立即反复请求。
    if (error instanceof DatabaseBusyError) {
      return Response.json({ error: error.message }, { status: 503, headers: { "Retry-After": "1" } });
    }
    // 原始 SQLite BUSY（例如初始化尚未转换的错误）也应成为同样可重试的 503；
    // 其他异常只在服务器日志保留技术细节。
    return safeDatabaseFailureResponse(error, "Year timetable workspace read failed", "The timetable workspace could not be loaded. Try again.");
  }
}
