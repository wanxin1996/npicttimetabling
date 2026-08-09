import { listRuleSettings, updateRuleSetting } from "@/lib/database";

// Policy switches are editable by schedulers; core conflict checks are deliberately
// not exposed here and therefore remain permanently active.
export const runtime = "nodejs";

export async function GET() {
  return Response.json(listRuleSettings());
}

export async function PATCH(request: Request) {
  const body = await request.json();
  if (typeof body.key !== "string" || typeof body.enabled !== "boolean") return Response.json({ error: "Rule key and enabled state are invalid." }, { status: 400 });
  if (!updateRuleSetting(body.key, body.enabled)) return Response.json({ error: "Rule setting not found." }, { status: 404 });
  return Response.json({ ok: true });
}
