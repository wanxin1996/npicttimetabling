import { listRuleSettings, updateRuleSetting } from "@/lib/database";

// 排课老师可以修改政策规则开关；核心资源冲突刻意不在此接口暴露，因此始终启用。
export const runtime = "nodejs";

export async function GET() {
  // 所有已登录排课老师查看并使用同一份规则启用/停用清单。
  return Response.json(listRuleSettings());
}

export async function PATCH(request: Request) {
  // 每次只保存一个已登记规则开关；状态改变后，数据库层立即刷新所有已排课程警告。
  const body = await request.json();
  if (typeof body.key !== "string" || typeof body.enabled !== "boolean") return Response.json({ error: "Rule key and enabled state are invalid." }, { status: 400 });
  if (!updateRuleSetting(body.key, body.enabled)) return Response.json({ error: "Rule setting not found." }, { status: 404 });
  return Response.json({ ok: true });
}
