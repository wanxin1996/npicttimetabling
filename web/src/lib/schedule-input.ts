export {
  isOpaqueResourceId,
  isPositiveSafeInteger,
  MAX_STUDENT_GROUP_IDS_PER_ASSIGNMENT,
  OPAQUE_RESOURCE_ID_MAX_LENGTH,
  parseCourseSectionAssignmentInput,
  parseScheduledLessonPlacementInput,
  parseScheduledLessonUpdateInput,
} from "./master-data-input";
export type {
  CourseSectionAssignmentInput,
  ScheduledLessonPlacementInput,
  ScheduledLessonUpdateInput,
} from "./master-data-input";

export type TimetableYear = 1 | 2 | 3;

export function parseTimetableYear(rawYear: string | null): TimetableYear | null {
  // 没有 year 参数时沿用第一年级，方便首页第一次打开；一旦客户端显式提交，
  // 就只接受单个字符 1、2 或 3。这样空白、+1、01 和科学记数法不会被
  // Number(...) 悄悄转换成看似有效但不符合公开 API 契约的年级。
  if (rawYear === null) return 1;
  if (!/^[123]$/.test(rawYear)) return null;
  return Number(rawYear) as TimetableYear;
}
