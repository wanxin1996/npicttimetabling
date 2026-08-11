// 这些上限同时适用于新增和编辑。明确的边界既能阻止意外超大请求进入数据库，
// 也让网页、测试脚本和未来的导入工具可以遵守同一套资料规则。
export const TEACHER_NAME_MAX_LENGTH = 128;
export const STUDENT_GROUP_CODE_MAX_LENGTH = 64;
export const STUDENT_GROUP_PROGRAM_MAX_LENGTH = 64;
export const ROOM_CODE_MAX_LENGTH = 64;
export const ROOM_CAPACITY_MAXIMUM = 999_999;
export const COURSE_CODE_MAX_LENGTH = 64;
export const COURSE_CATALOG_MAX_LENGTH = 256;
export const OPAQUE_RESOURCE_ID_MAX_LENGTH = 128;
export const MAX_STUDENT_GROUP_IDS_PER_ASSIGNMENT = 999;

export type ParsedInput<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export type ManualCourseInput = {
  code: string;
  catalog: string | null;
  sectionCount: number;
};

export type CourseSectionAssignmentInput = {
  teacherId: string | null;
  studentGroupIds: string[];
  revision: number;
};

export type ScheduledLessonPlacementInput = {
  sectionId: string;
  occurrence: number;
  dayOfWeek: number;
  startHour: number;
  roomId: string | null;
};

export type ScheduledLessonUpdateInput = {
  dayOfWeek: number;
  startHour: number;
  roomId: string | null;
  teacherId: string | null;
  studentGroupIds: string[];
  revision: number;
};

export type TeacherDetailsInput = { name: string; staffType: "FT" | "PT" };
export type TeacherPatchInput =
  | { kind: "details"; revision: number; details: TeacherDetailsInput }
  | { kind: "status"; revision: number; isActive: boolean };

export type StudentGroupDetailsInput = { code: string; year: 1 | 2 | 3; program: string };

export type RoomDetailsInput = {
  code: string;
  capacity: number;
  hasLab: boolean;
  hasMultiProjector: boolean;
  isSmartClassroom: boolean;
};
export type RoomPatchInput =
  | { kind: "details"; revision: number; details: RoomDetailsInput }
  | { kind: "status"; revision: number; isActive: boolean };

function hasOwnField(body: Record<string, unknown>, field: string) {
  // Object.hasOwn 只检查客户端真正提交的字段，不会把原型链上的名称误认成表单内容。
  return Object.prototype.hasOwnProperty.call(body, field);
}

function positiveRevision(value: unknown): value is number {
  // revision 必须是 JSON number。字符串 "1"、true 和小数都不能被静默转换，
  // 否则自定义客户端可能在不知道当前版本的情况下绕过并发保护。
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

const forbiddenControlCharacter = /[\u0000-\u001f\u007f-\u009f]/u;

export function normalizeRequiredUppercaseText(value: unknown, maximumLength: number): string | null {
  // 所有资料字符串先去除首尾空白并统一大写；只接受原生字符串，避免数组等值
  // 通过 String(...) 变成看似有效、实际无法追踪来源的名称。控制字符会破坏日志、
  // 错误提示或内部组合键，所以连首尾制表符和换行也在 trim 前明确拒绝。
  if (typeof value !== "string" || forbiddenControlCharacter.test(value)) return null;
  const normalized = value.trim().toUpperCase();
  return normalized.length >= 1 && normalized.length <= maximumLength ? normalized : null;
}

export function normalizeOptionalText(value: unknown, maximumLength: number): ParsedInput<string | null> {
  // Excel 的 Catalog 可以为空；null、undefined 和空字符串都表示没有目录说明。
  // 只要单元格真的有内容，就必须遵守与必填文字相同的原生类型、控制字符和长度规则。
  if (value === null || value === undefined || value === "") return { ok: true, value: null };
  if (typeof value !== "string" || forbiddenControlCharacter.test(value)) {
    return { ok: false, error: "Optional text must be a plain string without control characters." };
  }
  // Catalog 是给老师阅读的说明文字，保留原有大小写；只有作为自然键的字段才统一大写。
  const normalized = value.trim();
  if (normalized === "") return { ok: true, value: null };
  if (normalized.length > maximumLength) return { ok: false, error: `Optional text must be ${maximumLength} characters or fewer.` };
  return { ok: true, value: normalized };
}

export function parseTeacherDetails(body: Record<string, unknown>): ParsedInput<TeacherDetailsInput> {
  const name = normalizeRequiredUppercaseText(body.name, TEACHER_NAME_MAX_LENGTH);
  const staffType = body.staffType === "FT" || body.staffType === "PT" ? body.staffType : null;
  if (!name || !staffType) {
    return { ok: false, error: `Teacher name must be 1 to ${TEACHER_NAME_MAX_LENGTH} characters and staff type must be FT or PT.` };
  }
  return { ok: true, value: { name, staffType } };
}

export function parseTeacherPatch(body: Record<string, unknown>): ParsedInput<TeacherPatchInput> {
  if (!positiveRevision(body.revision)) {
    return { ok: false, error: "Teacher revision must be a positive whole number." };
  }

  const isStatusRequest = hasOwnField(body, "isActive");
  const hasDetailField = hasOwnField(body, "name") || hasOwnField(body, "staffType");
  // 状态按钮和编辑表单修改不同的业务资料。混合两种形状会令人无法判断缺少的字段
  // 是故意省略还是旧客户端错误，因此明确拒绝，而不是猜测客户端意图。
  if (isStatusRequest && hasDetailField) {
    return { ok: false, error: "Update teacher status or teacher details in one request, not both." };
  }
  if (isStatusRequest) {
    if (typeof body.isActive !== "boolean") return { ok: false, error: "Teacher status must be true or false." };
    return { ok: true, value: { kind: "status", revision: body.revision, isActive: body.isActive } };
  }

  const details = parseTeacherDetails(body);
  if (!details.ok) return details;
  return { ok: true, value: { kind: "details", revision: body.revision, details: details.value } };
}

export function parseStudentGroupDetails(body: Record<string, unknown>): ParsedInput<StudentGroupDetailsInput> {
  const code = normalizeRequiredUppercaseText(body.code, STUDENT_GROUP_CODE_MAX_LENGTH);
  const program = normalizeRequiredUppercaseText(body.program, STUDENT_GROUP_PROGRAM_MAX_LENGTH);
  const year = Number.isSafeInteger(body.year) && [1, 2, 3].includes(Number(body.year))
    ? body.year as 1 | 2 | 3
    : null;
  if (!code || !program || year === null) {
    return {
      ok: false,
      error: `Group code and programme must be 1 to ${STUDENT_GROUP_CODE_MAX_LENGTH} characters, and year must be the number 1, 2 or 3.`,
    };
  }
  return { ok: true, value: { code, year, program } };
}

export function parseStudentGroupPatch(body: Record<string, unknown>): ParsedInput<{ revision: number; details: StudentGroupDetailsInput }> {
  if (!positiveRevision(body.revision)) {
    return { ok: false, error: "Student-group revision must be a positive whole number." };
  }
  const details = parseStudentGroupDetails(body);
  if (!details.ok) return details;
  return { ok: true, value: { revision: body.revision, details: details.value } };
}

export function parseRoomDetails(body: Record<string, unknown>): ParsedInput<RoomDetailsInput> {
  const code = normalizeRequiredUppercaseText(body.code, ROOM_CODE_MAX_LENGTH);
  const addressParts = code?.split("-") ?? [];
  const addressIsComplete = addressParts.length >= 3 && addressParts.every((part) => part.length > 0);
  const capacityIsValid = Number.isSafeInteger(body.capacity)
    && Number(body.capacity) >= 1
    && Number(body.capacity) <= ROOM_CAPACITY_MAXIMUM;
  const featuresAreBoolean = [body.hasLab, body.hasMultiProjector, body.isSmartClassroom]
    .every((value) => typeof value === "boolean");
  if (!code || !addressIsComplete || !capacityIsValid || !featuresAreBoolean) {
    return {
      ok: false,
      error: `Use a Block-Level-Room code up to ${ROOM_CODE_MAX_LENGTH} characters, capacity from 1 to ${ROOM_CAPACITY_MAXIMUM}, and true/false feature choices.`,
    };
  }
  return {
    ok: true,
    value: {
      code,
      capacity: body.capacity as number,
      hasLab: body.hasLab as boolean,
      hasMultiProjector: body.hasMultiProjector as boolean,
      isSmartClassroom: body.isSmartClassroom as boolean,
    },
  };
}

export function parseRoomPatch(body: Record<string, unknown>): ParsedInput<RoomPatchInput> {
  if (!positiveRevision(body.revision)) {
    return { ok: false, error: "Room revision must be a positive whole number." };
  }

  const isStatusRequest = hasOwnField(body, "isActive");
  const hasDetailField = ["code", "capacity", "hasLab", "hasMultiProjector", "isSmartClassroom"]
    .some((field) => hasOwnField(body, field));
  if (isStatusRequest && hasDetailField) {
    return { ok: false, error: "Update room status or room details in one request, not both." };
  }
  if (isStatusRequest) {
    if (typeof body.isActive !== "boolean") return { ok: false, error: "Room status must be true or false." };
    return { ok: true, value: { kind: "status", revision: body.revision, isActive: body.isActive } };
  }

  const details = parseRoomDetails(body);
  if (!details.ok) return details;
  return { ok: true, value: { kind: "details", revision: body.revision, details: details.value } };
}

export function parsePositiveRevision(value: unknown, label: string): ParsedInput<number> {
  // 课程班次数量调整与基础资料使用同一 revision 形状，保持 API 并发语义一致。
  if (!positiveRevision(value)) return { ok: false, error: `${label} revision must be a positive whole number.` };
  return { ok: true, value };
}

export function parseManualCourseInput(value: unknown): ParsedInput<ManualCourseInput> {
  // 手动课程也可能由维护脚本直接写入，因此这里接收 unknown 并执行与 API 相同的
  // 原生 JSON 类型、控制字符和长度检查。不要用 String/Number 自动转换客户端值。
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "Use a course code, optional catalog and a section count from 1 to 999." };
  }
  const body = value as Record<string, unknown>;
  const code = normalizeRequiredUppercaseText(body.code, COURSE_CODE_MAX_LENGTH);
  const catalog = normalizeOptionalText(body.catalog, COURSE_CATALOG_MAX_LENGTH);
  const sectionCount = Number.isSafeInteger(body.sectionCount)
    && Number(body.sectionCount) >= 1
    && Number(body.sectionCount) <= 999
    ? body.sectionCount as number
    : null;
  if (!code || !/^[A-Z0-9][A-Z0-9_-]*$/.test(code) || !catalog.ok || sectionCount === null) {
    return { ok: false, error: "Use a course code, optional catalog and a section count from 1 to 999." };
  }
  return { ok: true, value: { code, catalog: catalog.value, sectionCount } };
}

export function isOpaqueResourceId(value: unknown): value is string {
  // UUID 是当前实现细节；公开接口只承诺一个紧凑、不含控制字符的 opaque ID。
  // 不 trim 后接受，避免看起来相同但数据库键不同的资源名称。
  return typeof value === "string"
    && value.length >= 1
    && value.length <= OPAQUE_RESOURCE_ID_MAX_LENGTH
    && value === value.trim()
    && !forbiddenControlCharacter.test(value);
}

export function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseOptionalResourceId(value: unknown): ParsedInput<string | null> {
  if (value === null) return { ok: true, value: null };
  return isOpaqueResourceId(value)
    ? { ok: true, value }
    : { ok: false, error: "Optional resource IDs must be valid opaque IDs or null." };
}

function parseStudentGroupIds(value: unknown): ParsedInput<string[]> {
  if (!Array.isArray(value) || value.length > MAX_STUDENT_GROUP_IDS_PER_ASSIGNMENT) {
    return { ok: false, error: `Choose no more than ${MAX_STUDENT_GROUP_IDS_PER_ASSIGNMENT} student groups.` };
  }
  if (!value.every(isOpaqueResourceId) || new Set(value).size !== value.length) {
    return { ok: false, error: "Student-group IDs must be valid and must not be repeated." };
  }
  return { ok: true, value: value as string[] };
}

export function parseCourseSectionAssignmentInput(value: unknown): ParsedInput<CourseSectionAssignmentInput> {
  if (!isPlainObject(value)) {
    return { ok: false, error: "Teacher, student groups and revision are invalid." };
  }
  const teacherId = parseOptionalResourceId(value.teacherId);
  const studentGroupIds = parseStudentGroupIds(value.studentGroupIds);
  if (!teacherId.ok || !studentGroupIds.ok || !isPositiveSafeInteger(value.revision)) {
    return { ok: false, error: "Teacher, student groups and revision are invalid." };
  }
  return { ok: true, value: { teacherId: teacherId.value, studentGroupIds: studentGroupIds.value, revision: value.revision } };
}

export function parseScheduledLessonPlacementInput(value: unknown): ParsedInput<ScheduledLessonPlacementInput> {
  if (!isPlainObject(value)) {
    return { ok: false, error: "Section, weekly session, day, start hour and room are invalid." };
  }
  const roomId = parseOptionalResourceId(value.roomId);
  if (!isOpaqueResourceId(value.sectionId)
    || !Number.isSafeInteger(value.occurrence) || Number(value.occurrence) < 1 || Number(value.occurrence) > 2
    || !Number.isSafeInteger(value.dayOfWeek) || Number(value.dayOfWeek) < 1 || Number(value.dayOfWeek) > 5
    || !Number.isSafeInteger(value.startHour) || Number(value.startHour) < 8 || Number(value.startHour) > 17
    || !roomId.ok) {
    return { ok: false, error: "Section, weekly session, day, start hour and room are invalid." };
  }
  return {
    ok: true,
    value: {
      sectionId: value.sectionId,
      occurrence: value.occurrence as number,
      dayOfWeek: value.dayOfWeek as number,
      startHour: value.startHour as number,
      roomId: roomId.value,
    },
  };
}

export function parseScheduledLessonUpdateInput(value: unknown): ParsedInput<ScheduledLessonUpdateInput> {
  if (!isPlainObject(value)) {
    return { ok: false, error: "Day, start hour, teacher, room, student groups and revision are invalid." };
  }
  const roomId = parseOptionalResourceId(value.roomId);
  const teacherId = parseOptionalResourceId(value.teacherId);
  const studentGroupIds = parseStudentGroupIds(value.studentGroupIds);
  if (!Number.isSafeInteger(value.dayOfWeek) || Number(value.dayOfWeek) < 1 || Number(value.dayOfWeek) > 5
    || !Number.isSafeInteger(value.startHour) || Number(value.startHour) < 8 || Number(value.startHour) > 17
    || !isPositiveSafeInteger(value.revision)
    || !roomId.ok || !teacherId.ok || !studentGroupIds.ok) {
    return { ok: false, error: "Day, start hour, teacher, room, student groups and revision are invalid." };
  }
  return {
    ok: true,
    value: {
      dayOfWeek: value.dayOfWeek as number,
      startHour: value.startHour as number,
      roomId: roomId.value,
      teacherId: teacherId.value,
      studentGroupIds: studentGroupIds.value,
      revision: value.revision,
    },
  };
}
