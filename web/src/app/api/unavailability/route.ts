import { createUnavailableWindow, deleteUnavailableWindow, listUnavailableWindows } from "@/lib/database";

// 不可用规则保存在本地 SQLite 中，并在每次排课时参与警告计算。
export const runtime = "nodejs";

export function GET() {
  // 教师和年级禁排时段一起返回，供同一个规则管理页面展示。
  return Response.json(listUnavailableWindows());
}

export async function POST(request: Request) {
  // 两种规则共用星期和时间验证；ownerId 根据类型表示教师 ID 或年级字符串。
  const body = await request.json();
  if (!(["Teacher", "Year"] as const).includes(body.kind) || typeof body.ownerId !== "string" || !Number.isInteger(body.dayOfWeek) || body.dayOfWeek < 1 || body.dayOfWeek > 5 || !Number.isInteger(body.startHour) || !Number.isInteger(body.endHour) || body.startHour < 8 || body.endHour > 18 || body.endHour <= body.startHour || (body.kind === "Year" && !["1", "2", "3"].includes(body.ownerId))) return Response.json({ error: "Choose a valid owner, weekday and time range." }, { status: 400 });
  try { return Response.json({ id: createUnavailableWindow(body) }, { status: 201 }); } catch { return Response.json({ error: "The unavailable window could not be saved." }, { status: 400 }); }
}

export async function DELETE(request: Request) {
  // 删除操作通过查询参数提供类型和 ID，使紧凑规则列表无需构造复杂请求体。
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  const kind = url.searchParams.get("kind");
  if (!id || (kind !== "Teacher" && kind !== "Year")) return Response.json({ error: "Rule id and kind are required." }, { status: 400 });
  if (!deleteUnavailableWindow(id, kind)) return Response.json({ error: "Unavailable window not found." }, { status: 404 });
  return Response.json({ ok: true });
}
