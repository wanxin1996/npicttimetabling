import { listRuleSettings, updateRuleSetting } from "@/lib/database";
import { safeDatabaseFailureResponse } from "@/lib/database-response";
import { readJsonObject } from "@/lib/request-json";

// 排课老师可以修改政策规则开关；核心资源冲突刻意不在此接口暴露，因此始终启用。
export const runtime = "nodejs";

export async function GET() {
  // 所有已登录排课老师查看并使用同一份规则启用/停用清单。
  try {
    return Response.json(listRuleSettings());
  } catch (error) {
    return safeDatabaseFailureResponse(error, "Rule setting list failed", "Rule settings could not be loaded. Try again.");
  }
}

export async function PATCH(request: Request) {
  // 每次只保存一个已登记规则开关；状态改变后，数据库层立即刷新所有已排课程警告。
  const parsed = await readJsonObject(request, "Rule key and enabled state are invalid.");
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;
  if (typeof body.key !== "string" || typeof body.enabled !== "boolean") return Response.json({ error: "Rule key and enabled state are invalid." }, { status: 400 });
  try {
    if (!updateRuleSetting(body.key, body.enabled)) return Response.json({ error: "Rule setting not found." }, { status: 404 });
    return Response.json({ ok: true });
  } catch (error) {
    return safeDatabaseFailureResponse(error, "Rule setting update failed", "The rule setting could not be updated. Try again.");
  }
}
