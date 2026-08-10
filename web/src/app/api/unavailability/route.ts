import { createUnavailableWindow, deleteUnavailableWindow, listUnavailableWindows, MasterDataInputError } from "@/lib/database";

// 不可用规则保存在本地 SQLite 中，并在每次排课时参与警告计算。
export const runtime = "nodejs";

export function GET() {
  // 教师和年级禁排时段一起返回，供同一个规则管理页面展示。
  return Response.json(listUnavailableWindows());
}

export async function POST(request: Request) {
  // 两种规则共用星期和时间验证；ownerId 根据类型表示教师 ID 或年级字符串。
  let parsedBody: unknown;
  try {
    parsedBody = await request.json();
  } catch {
    return Response.json({ error: "Choose a valid owner, weekday and time range." }, { status: 400 });
  }
  const body = parsedBody && typeof parsedBody === "object" && !Array.isArray(parsedBody)
    ? parsedBody as Record<string, unknown>
    : {};
  // 先逐项缩窄 unknown 字段，再构造数据库输入；这样 TypeScript 与运行时都不会把字符串数字等错误格式悄悄转换成合法时段。
  const kind = body.kind;
  const ownerId = body.ownerId;
  const dayOfWeek = body.dayOfWeek;
  const startHour = body.startHour;
  const endHour = body.endHour;
  if ((kind !== "Teacher" && kind !== "Year")
    || typeof ownerId !== "string"
    || typeof dayOfWeek !== "number" || !Number.isInteger(dayOfWeek) || dayOfWeek < 1 || dayOfWeek > 5
    || typeof startHour !== "number" || !Number.isInteger(startHour)
    || typeof endHour !== "number" || !Number.isInteger(endHour)
    || startHour < 8 || endHour > 18 || endHour <= startHour
    || (kind === "Year" && !["1", "2", "3"].includes(ownerId))) {
    return Response.json({ error: "Choose a valid owner, weekday and time range." }, { status: 400 });
  }
  const input: { kind: "Teacher" | "Year"; ownerId: string; dayOfWeek: number; startHour: number; endHour: number } = {
    kind,
    ownerId,
    dayOfWeek,
    startHour,
    endHour,
  };
  try {
    return Response.json({ id: createUnavailableWindow(input) }, { status: 201 });
  } catch (error) {
    if (error instanceof MasterDataInputError) return Response.json({ error: error.message }, { status: 400 });
    console.error("Unavailable window creation failed", error);
    return Response.json({ error: "The unavailable window could not be saved. Try again." }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  // 删除操作通过查询参数提供类型和 ID，使紧凑规则列表无需构造复杂请求体。
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  const kind = url.searchParams.get("kind");
  if (!id || (kind !== "Teacher" && kind !== "Year")) return Response.json({ error: "Rule id and kind are required." }, { status: 400 });
  try {
    if (!deleteUnavailableWindow(id, kind)) return Response.json({ error: "Unavailable window not found." }, { status: 404 });
    return Response.json({ ok: true });
  } catch (error) {
    console.error("Unavailable window deletion failed", error);
    return Response.json({ error: "The unavailable window could not be removed. Try again." }, { status: 500 });
  }
}
