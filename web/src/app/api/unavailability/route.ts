import {
  createUnavailableWindow,
  deleteUnavailableWindow,
  listUnavailableWindows,
  MasterDataInputError,
  UnavailableWindowConflictError,
} from "@/lib/database";
import { safeDatabaseFailureResponse } from "@/lib/database-response";
import { readJsonObject } from "@/lib/request-json";
import { isOpaqueResourceId, isUnavailableWindowKind, parseUnavailableWindowInput } from "@/lib/unavailability-input";

// 不可用规则保存在本地 SQLite 中，并在每次排课时参与警告计算。
export const runtime = "nodejs";

export function GET() {
  // 教师和年级禁排时段一起返回，供同一个规则管理页面展示。
  try {
    return Response.json(listUnavailableWindows());
  } catch (error) {
    return safeDatabaseFailureResponse(error, "Unavailable window list failed", "Unavailable windows could not be loaded. Try again.");
  }
}

export async function POST(request: Request) {
  // 两种规则共用星期和时间验证；ownerId 根据类型表示教师 ID 或年级字符串。
  const parsed = await readJsonObject(request, "Choose a valid owner, weekday and time range.");
  if (!parsed.ok) return parsed.response;
  // 路由和数据库函数共用同一个严格解析器；即使未来增加脚本调用，也不会形成
  // “HTTP 拒绝、直接调用却接受”两套不一致的时段边界。
  const input = parseUnavailableWindowInput(parsed.value);
  if (!input.ok) return Response.json({ error: input.error }, { status: 400 });
  try {
    return Response.json({ id: createUnavailableWindow(input.value) }, { status: 201 });
  } catch (error) {
    if (error instanceof MasterDataInputError) return Response.json({ error: error.message }, { status: 400 });
    if (error instanceof UnavailableWindowConflictError) {
      return Response.json({ code: "UNAVAILABLE_WINDOW_EXISTS", error: error.message }, { status: 409 });
    }
    return safeDatabaseFailureResponse(error, "Unavailable window creation failed", "The unavailable window could not be saved. Try again.");
  }
}

export async function DELETE(request: Request) {
  // 删除操作通过查询参数提供类型和 ID，使紧凑规则列表无需构造复杂请求体。
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  const kind = url.searchParams.get("kind");
  // 查询参数也遵守 opaque-ID 规范；控制字符、首尾空白及超长 ID 不应进入动态 DELETE。
  if (!isOpaqueResourceId(id) || !isUnavailableWindowKind(kind)) return Response.json({ error: "Rule id and kind are required." }, { status: 400 });
  try {
    if (!deleteUnavailableWindow(id, kind)) return Response.json({ error: "Unavailable window not found." }, { status: 404 });
    return Response.json({ ok: true });
  } catch (error) {
    return safeDatabaseFailureResponse(error, "Unavailable window deletion failed", "The unavailable window could not be removed. Try again.");
  }
}
