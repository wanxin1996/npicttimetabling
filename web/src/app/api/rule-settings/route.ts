import { listRuleSettings, RuleSettingChangedError, updateRuleSetting } from "@/lib/database";
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
  // expectedEnabled 是客户端实际看见的版本。数据库会在同一个 IMMEDIATE 事务里
  // 比较、条件更新并刷新 warning，避免两个浏览器把彼此刚保存的选择静默覆盖。
  const parsed = await readJsonObject(request, "Rule key and enabled state are invalid.");
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;
  if (typeof body.key !== "string" || typeof body.expectedEnabled !== "boolean" || typeof body.enabled !== "boolean") {
    return Response.json({ error: "Rule key and enabled state are invalid." }, { status: 400 });
  }
  try {
    const result = updateRuleSetting(body.key, body.expectedEnabled, body.enabled);
    if (!result) return Response.json({ error: "Rule setting not found." }, { status: 404 });
    return Response.json({ ok: true, enabled: result.enabled, changed: result.changed });
  } catch (error) {
    if (error instanceof RuleSettingChangedError) {
      return Response.json({ code: "RULE_SETTING_CHANGED", error: error.message }, { status: 409 });
    }
    return safeDatabaseFailureResponse(error, "Rule setting update failed", "The rule setting could not be updated. Try again.");
  }
}
