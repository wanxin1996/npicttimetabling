// 泛型保留调用方的完整课程类型；这个工具只要求稳定 ID 与整数 revision，
// 不复制 ScheduledLesson 的几十个业务字段定义。
export function reconcileLessonDraft<T extends { id: string; revision: number }>(
  currentLesson: T | null,
  nextLessons: T[],
): { lesson: T | null; stale: boolean };
