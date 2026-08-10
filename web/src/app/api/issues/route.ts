import { listScheduleIssues } from "@/lib/database";

// 综合问题接口只读取写事务已经保存的警告，避免轮询请求与排课保存互相争抢 SQLite 写锁。
export const runtime = "nodejs";

export async function GET() {
  // 所有影响 warning 的课程、主资料、规则和不可用时段写入都会在自己的原子事务中
  // 主动重算；这里保持纯读取，绝不能用事务外读到的旧课时覆盖刚保存的新 warning。
  return Response.json(listScheduleIssues());
}
