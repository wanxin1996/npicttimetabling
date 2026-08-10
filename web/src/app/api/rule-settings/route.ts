import { listRuleSettings, updateRuleSetting } from "@/lib/database";

// Policy switches are editable by schedulers; core conflict checks are deliberately
// not exposed here and therefore remain permanently active.
export const runtime = "nodejs";

export async function GET() {
  // Every signed-in scheduler receives the same enabled/disabled rule catalogue.
  return Response.json(listRuleSettings());
}

export async function PATCH(request: Request) {
  // Save one known rule toggle; changing its state immediately refreshes all saved
  // lesson warnings in the database layer.
  const body = await request.json();
  if (typeof body.key !== "string" || typeof body.enabled !== "boolean") return Response.json({ error: "Rule key and enabled state are invalid." }, { status: 400 });
  if (!updateRuleSetting(body.key, body.enabled)) return Response.json({ error: "Rule setting not found." }, { status: 404 });
  return Response.json({ ok: true });
}
