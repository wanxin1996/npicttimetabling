import { isOpaqueResourceId } from "./master-data-input";

export { isOpaqueResourceId };

export type UnavailableWindowKind = "Teacher" | "Year";

export type UnavailableWindowInput = {
  kind: UnavailableWindowKind;
  ownerId: string;
  dayOfWeek: number;
  startHour: number;
  endHour: number;
};

export type ParsedUnavailableWindowInput =
  | { ok: true; value: UnavailableWindowInput }
  | { ok: false; error: string };

const invalidUnavailableWindowMessage = "Choose a valid owner, weekday and time range.";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isUnavailableWindowKind(value: unknown): value is UnavailableWindowKind {
  return value === "Teacher" || value === "Year";
}

export function parseUnavailableWindowInput(value: unknown): ParsedUnavailableWindowInput {
  if (!isPlainObject(value)) return { ok: false, error: invalidUnavailableWindowMessage };

  const { kind, ownerId, dayOfWeek, startHour, endHour } = value;
  if (!isUnavailableWindowKind(kind)) return { ok: false, error: invalidUnavailableWindowMessage };

  // 年级是封闭业务键，不能按一般 opaque ID 接受诸如 "01" 或带空格的值；
  // 教师 ID 则遵守全站统一的 opaque-ID 合约（原样、无控制字符、最多 128 字符）。
  const parsedOwnerId = kind === "Teacher"
    ? (isOpaqueResourceId(ownerId) ? ownerId : null)
    : (ownerId === "1" || ownerId === "2" || ownerId === "3" ? ownerId : null);

  // 这里和数据库写入边界共用同一解析器。只接受原生、安全整数，避免路由拒绝了
  // 字符串数字或小数，但未来的脚本调用却把它们直接写进 SQLite。
  const windowIsValid = typeof dayOfWeek === "number"
    && Number.isSafeInteger(dayOfWeek)
    && dayOfWeek >= 1
    && dayOfWeek <= 5
    && typeof startHour === "number"
    && Number.isSafeInteger(startHour)
    && startHour >= 8
    && startHour <= 17
    && typeof endHour === "number"
    && Number.isSafeInteger(endHour)
    && endHour >= 9
    && endHour <= 18
    && endHour > startHour;

  if (parsedOwnerId === null || !windowIsValid) return { ok: false, error: invalidUnavailableWindowMessage };

  return {
    ok: true,
    value: { kind, ownerId: parsedOwnerId, dayOfWeek, startHour, endHour },
  };
}
