import { listScheduleIssues } from "@/lib/database";

// 综合问题接口返回前会重新计算警告，确保复核页面始终反映当前时间表和限制规则。
export const runtime = "nodejs";

export async function GET() {
  // 每次读取都重新计算，使时间表、规则、教室或不可用时段变化后，
  // 这个接口仍是最新问题清单的唯一权威来源。
  return Response.json(listScheduleIssues());
}
