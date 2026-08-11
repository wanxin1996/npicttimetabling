// 五秒轮询与 Inspector 共用这一条小规则：远端记录仍是同一个 revision 时，
// 可以同步最新 warning；远端 revision 已变化或课程已经离开总表时，必须保留
// 老师当前的本地对象，让表单 key 和全部未保存输入保持不动，并明确标记过期。
export function reconcileLessonDraft(currentLesson, nextLessons) {
  if (!currentLesson) return { lesson: null, stale: false };

  const latestLesson = nextLessons.find((lesson) => lesson.id === currentLesson.id);
  if (!latestLesson || latestLesson.revision !== currentLesson.revision) {
    return { lesson: currentLesson, stale: true };
  }

  return { lesson: latestLesson, stale: false };
}
