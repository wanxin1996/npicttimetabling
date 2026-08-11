export type JsonObject = Record<string, unknown>;

export type JsonObjectResult =
  | { ok: true; value: JsonObject }
  | { ok: false; response: Response };

export const MAX_JSON_REQUEST_BYTES = 64 * 1024;

export async function readJsonObject(request: Request, invalidMessage: string): Promise<JsonObjectResult> {
  // 公开 login／setup 也使用这个解析器，所以不能先让 request.json() 无上限缓冲整段请求。
  // 64 KiB 足够容纳本系统最复杂的 JSON 表单；更大的 body 在解析、限流或 Scrypt 前
  // 就会停止读取并返回 413，避免攻击者用巨型字符串占用进程内存和事件循环。
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_REQUEST_BYTES) {
    await request.body?.cancel().catch(() => undefined);
    return { ok: false, response: Response.json({ error: "JSON request is too large." }, { status: 413 }) };
  }

  if (!request.body) {
    return { ok: false, response: Response.json({ error: invalidMessage }, { status: 400 }) };
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let receivedBytes = 0;
  let rawJson = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      receivedBytes += chunk.value.byteLength;
      if (receivedBytes > MAX_JSON_REQUEST_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, response: Response.json({ error: "JSON request is too large." }, { status: 413 }) };
      }
      rawJson += decoder.decode(chunk.value, { stream: true });
    }
    rawJson += decoder.decode();
  } catch {
    return { ok: false, response: Response.json({ error: invalidMessage }, { status: 400 }) };
  } finally {
    reader.releaseLock();
  }

  // 所有 JSON 写入接口都必须同时处理三类无效请求：JSON 语法损坏、null，以及数组等
  // 非对象值。集中在这里解析可保证它们一律返回 JSON 400，不会落入 Next.js 的 HTML
  // 错误页，也不会让每条路由因为遗漏 Array.isArray 判断而接受错误形状。
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return { ok: false, response: Response.json({ error: invalidMessage }, { status: 400 }) };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, response: Response.json({ error: invalidMessage }, { status: 400 }) };
  }
  return { ok: true, value: parsed as JsonObject };
}
