import { listYearTimetableWorkspace } from "@/lib/database";

// 年级排课工作区读取本地 SQLite，并且必须让总表与待排区来自同一数据库快照。
export const runtime = "nodejs";

export async function GET(request: Request) {
  // 三个年级各有独立总表；拒绝其他数字，避免错误参数悄悄返回空画面。
  const year = Number(new URL(request.url).searchParams.get("year") ?? 1);
  if (![1, 2, 3].includes(year)) {
    return Response.json({ error: "Year must be 1, 2 or 3." }, { status: 400 });
  }

  // database 层用一个 DEFERRED 事务读取五份资料。这里一次返回完整 payload，浏览器
  // 不再自行拼接不同时间点的 lessons 与 unscheduled sessions。
  return Response.json(listYearTimetableWorkspace(year));
}
