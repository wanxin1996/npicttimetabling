"use client";

import { DragEvent, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { candidateSlotRequestMatches, type CandidateSlotRequestIdentity } from "@/lib/candidate-slot-request.mjs";
import { reconcileLessonDraft } from "@/lib/lesson-draft-reconciliation.mjs";
import {
  COURSE_CATALOG_MAX_LENGTH,
  COURSE_CODE_MAX_LENGTH,
  ROOM_CAPACITY_MAXIMUM,
  ROOM_CODE_MAX_LENGTH,
  STUDENT_GROUP_CODE_MAX_LENGTH,
  STUDENT_GROUP_PROGRAM_MAX_LENGTH,
  TEACHER_NAME_MAX_LENGTH,
} from "@/lib/master-data-input";

// 所有功能页面共用同一个外层布局；View 只决定中间区域显示哪一种排课资料，避免为每张资料表重复维护导航和登录逻辑。
type View = "Year timetables" | "Personal timetables" | "Rules & issues" | "Cycle" | "Accounts" | "Profile" | "Teachers" | "Student groups" | "Rooms" | "Courses";
type AppUser = { id: string; username: string; isAdmin: boolean; isActive: boolean; revision: number };

type Teacher = {
  id: string;
  revision: number;
  name: string;
  staffType: "FT" | "PT";
  status: "Active" | "Inactive";
  sections: number;
};

type StudentGroup = {
  id: string;
  revision: number;
  code: string;
  year: number;
  program: string;
};

type Room = {
  id: string;
  revision: number;
  code: string;
  capacity: number;
  features: string[];
  status: "Active" | "Inactive";
};

type Course = {
  id: string;
  code: string;
  catalog: string | null;
  revision: number;
  durationHours: number | null;
  sessionsPerWeek: number;
  primaryYear: number | null;
  minimumRoomCapacity: number | null;
  requiresLab: boolean;
  requiresMultiProjector: boolean;
  requiresSmartClassroom: boolean;
  separateSectionsAcrossDays: boolean;
  weekPattern: "ALL" | "W1_4" | "W5_8";
  weekStart: number | null;
  weekEnd: number | null;
  allocatedSections: number;
  configuredSections: number;
  scheduledLessons: number;
  allocationVarianceCount: number;
};

type CourseSection = {
  id: string;
  label: string;
  teacherId: string | null;
  teacherName: string | null;
  studentGroupIds: string[];
  studentGroupCodes: string[];
  revision: number;
};
type AllocationVariance = { teacherId: string; teacherName: string; expectedSections: number; actualSections: number };
type DataManagementWorkspace = { teachers: Teacher[]; groups: StudentGroup[]; rooms: Room[]; courses: Course[] };
type CourseSectionsWorkspace = { currentCourse: Course; sections: CourseSection[]; allocationVariances: AllocationVariance[] };
type ScheduledLesson = { id: string; sectionId: string; sectionLabel: string; courseCode: string; teacherId: string | null; teacherName: string | null; dayOfWeek: number; startHour: number; durationHours: number; roomId: string | null; roomCode: string | null; studentGroupIds: string[]; studentGroups: string[]; occurrence: number; sessionsPerWeek: number; revision: number; warnings: string[]; warningSeverity: "High" | "Warning" | "Advisory" | null };
type TimetableLoadResult = { loaded: boolean; reopenedLesson: ScheduledLesson | null; unscheduledSections: UnscheduledSection[] };
type UnscheduledSection = { id: string; sectionId: string; label: string; teacherName: string | null; teacherIsActive: boolean | null; staffType: "FT" | "PT" | null; durationHours: number; studentGroupIds: string[]; studentGroups: string[]; occurrence: number; sessionsPerWeek: number };
type UnavailableWindow = { id: string; kind: "Teacher" | "Year"; ownerId: string; ownerLabel: string; dayOfWeek: number; startHour: number; endHour: number };
type ScheduleIssue = { id: string; lessonId: string; sectionId: string; occurrence: number; sectionLabel: string; primaryYear: number; dayOfWeek: number; startHour: number; endHour: number; teacherName: string | null; roomCode: string | null; studentGroups: string[]; category: "Assignment" | "Availability" | "Conflict" | "Course rule" | "Preference" | "Room" | "Travel" | "Workload"; severity: "High" | "Warning" | "Advisory"; message: string };
type YearTimetableWorkspace = { lessons: ScheduledLesson[]; unscheduledSections: UnscheduledSection[]; issues: ScheduleIssue[]; teachers: Teacher[]; rooms: Room[] };
type CandidateSlot = { dayOfWeek: number; startHour: number; endHour: number; roomId: string; roomCode: string; roomCapacity: number; roomFeatures: string[] };
type RuleSetting = { key: string; label: string; description: string; enabled: boolean };
type RulesWorkspace = { unavailableWindows: UnavailableWindow[]; issues: ScheduleIssue[]; ruleSettings: RuleSetting[]; teachers: Teacher[] };
type CycleStatus = { courses: number; sections: number; lessons: number; currentToken: string; backup: null | { id: string; createdAt: string; courses: number; sections: number; lessons: number } };
type PositionedLesson = { lesson: ScheduledLesson; lane: number; laneCount: number };
type TimetableDropTarget = { dayOfWeek: number; startHour: number };
type NoticeTone = "info" | "success" | "warning" | "error";

class RulesWorkspaceRequestError extends Error {
  constructor(readonly status: number) {
    super("Rules workspace request failed.");
    this.name = "RulesWorkspaceRequestError";
  }
}

class ProtectedSessionExpiredError extends Error {
  constructor() {
    super("The protected browser session expired.");
    this.name = "ProtectedSessionExpiredError";
  }
}

function requireArrayPayload<T>(value: unknown, message: string): T[] {
  // 服务器聚合响应必须整批到达。只靠 TypeScript 的 `as` 不会检查真实 JSON；若代理
  // 意外返回 HTML、null 或缺少数组，这里会在任何 React state 写入前拒绝整批资料。
  if (!Array.isArray(value)) throw new Error(message);
  return value as T[];
}

function isAppUserPayload(value: unknown): value is AppUser {
  // 账号资料会决定管理员专属界面和启停按钮；不能只用 TypeScript `as` 信任网络
  // JSON。这里逐字段确认最小公开形状，额外字段仍可由后端以后向兼容地加入。
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === "string"
    && candidate.id.length > 0
    && typeof candidate.username === "string"
    && candidate.username.length > 0
    && typeof candidate.isAdmin === "boolean"
    && typeof candidate.isActive === "boolean"
    && Number.isSafeInteger(candidate.revision)
    && Number(candidate.revision) >= 1;
}

function parseAccountsPayload(value: unknown): AppUser[] {
  const accounts = requireArrayPayload<unknown>(value, "The accounts response was invalid.");
  if (!accounts.every(isAppUserPayload)) throw new Error("The accounts response contained an invalid account.");
  return accounts;
}

function parseYearTimetableWorkspace(payload: unknown): YearTimetableWorkspace {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("The year timetable workspace response was invalid.");
  }
  const candidate = payload as Record<string, unknown>;
  return {
    lessons: requireArrayPayload<ScheduledLesson>(candidate.lessons, "The year timetable lessons were missing."),
    unscheduledSections: requireArrayPayload<UnscheduledSection>(candidate.unscheduledSections, "The unscheduled sessions were missing."),
    issues: requireArrayPayload<ScheduleIssue>(candidate.issues, "The year timetable issues were missing."),
    teachers: requireArrayPayload<Teacher>(candidate.teachers, "The year timetable teachers were missing."),
    rooms: requireArrayPayload<Room>(candidate.rooms, "The year timetable rooms were missing."),
  };
}

const timetableDays = ["Mon", "Tue", "Wed", "Thu", "Fri"];
const timetableHours = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17];

function Pill({ children, tone = "slate" }: { children: React.ReactNode; tone?: "slate" | "blue" | "amber" | "green" | "red" }) {
  // 这个共用状态标签集中管理颜色和文字样式，确保不同页面对成功、警告和错误使用一致且容易辨认的视觉表达。
  const tones = {
    slate: "bg-slate-100 text-slate-700",
    blue: "bg-blue-50 text-blue-700 ring-1 ring-inset ring-blue-200",
    amber: "bg-amber-50 text-amber-800 ring-1 ring-inset ring-amber-200",
    green: "bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200",
    red: "bg-red-50 text-red-700 ring-1 ring-inset ring-red-200",
  };

  return <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${tones[tone]}`}>{children}</span>;
}

function WorkspaceMenuButton({ active, disabled = false, icon, label, onClick }: { active: boolean; disabled?: boolean; icon: string; label: string; onClick: () => void }) {
  // 顶部 Workspace 的所有入口共用这一种按钮，避免不同页面各自复制颜色、间距和无障碍属性后逐渐出现差异。
  // aria-current 会让屏幕阅读器说明当前所在页面；按钮保持 shrink-0，窗口不足时由外层菜单横向滚动，而不是压扁文字。
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-2 text-xs transition disabled:cursor-wait disabled:opacity-50 ${active ? "bg-blue-50 font-black text-blue-800 ring-1 ring-inset ring-blue-100" : "font-semibold text-slate-600 hover:bg-slate-50 hover:text-slate-950"}`}
      type="button"
      aria-current={active ? "page" : undefined}
    >
      <span className="text-sm" aria-hidden="true">{icon}</span>
      <span>{label}</span>
    </button>
  );
}

function StudentGroupSelector({ groups, selectedIds, disabled = false }: { groups: StudentGroup[]; selectedIds: string[]; disabled?: boolean }) {
  // Inspector 需要同时选择一个或多个学生班级；复选框比单选下拉更适合跨年级课程，也能让老师一眼看清当前全部关联。
  // 这里使用 defaultChecked，让原生 FormData 在提交时收集所有勾选值；调用位置以课程编号和修订号作为 key，切换课程时会重新建立正确默认状态。
  const selectedIdSet = new Set(selectedIds);

  return (
    <fieldset disabled={disabled} className="rounded-xl border border-slate-200 p-2.5 disabled:cursor-wait disabled:opacity-60">
      <legend className="px-1 text-xs font-semibold text-slate-700">Student groups</legend>
      <p className="mb-2 text-[11px] leading-4 text-slate-500">Changes apply to every weekly occurrence of this section.</p>
      <div className="max-h-40 space-y-1 overflow-y-auto pr-1">
        {groups.length === 0 ? (
          <p className="rounded-lg bg-slate-50 p-2 text-xs text-slate-500">Create student groups before assigning them here.</p>
        ) : groups.map((group) => (
          <label key={group.id} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-slate-700 hover:bg-blue-50">
            <input
              form="lesson-editor"
              name="studentGroupIds"
              value={group.id}
              defaultChecked={selectedIdSet.has(group.id)}
              className="h-4 w-4 rounded border-slate-300 text-blue-700"
              type="checkbox"
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-bold text-slate-900">{group.code}</span>
              <span className="block truncate text-[10px] text-slate-500">Year {group.year} · {group.program}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function TeacherSelect({ teachers, selectedTeacherId, selectedTeacherName, ariaLabel, disabled = false }: { teachers: Teacher[]; selectedTeacherId: string | null; selectedTeacherName: string | null; ariaLabel: string; disabled?: boolean }) {
  // Active 教师是唯一允许建立“新分配”的选项；如果旧班次当前引用的教师已经停用，
  // 仍额外渲染这一项，避免浏览器因为找不到 defaultValue 而自动退回 Teacher pending。
  const [draftTeacherId, setDraftTeacherId] = useState(selectedTeacherId ?? "");
  const selectedTeacher = selectedTeacherId ? teachers.find((teacher) => teacher.id === selectedTeacherId) : undefined;
  const draftTeacher = draftTeacherId ? teachers.find((teacher) => teacher.id === draftTeacherId) : undefined;
  const currentTeacherIsUnavailable = Boolean(selectedTeacherId) && selectedTeacher?.status !== "Active";
  const newDraftTeacherIsUnavailable = Boolean(draftTeacherId) && draftTeacherId !== selectedTeacherId && draftTeacher?.status !== "Active";
  const currentTeacherLabel = selectedTeacher?.status === "Active"
    ? `${selectedTeacher.name} (${selectedTeacher.staffType})`
    : `${selectedTeacherName ?? selectedTeacher?.name ?? "Current teacher"} (Inactive — current assignment)`;

  return (
    <div className="grid gap-1">
      <select
        name="teacherId"
        value={draftTeacherId}
        onChange={(event) => setDraftTeacherId(event.target.value)}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-invalid={newDraftTeacherIsUnavailable || undefined}
        className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm disabled:cursor-wait disabled:bg-slate-100"
      >
        <option value="">Teacher pending</option>
        {/* 当前教师无论 Active／Inactive 都保留同一个 key 和 value；跨账号状态刷新只改标签，不会让原生 select 跳回首项。 */}
        {selectedTeacherId && (
          <option key={`current-${selectedTeacherId}`} value={selectedTeacherId}>{currentTeacherLabel}</option>
        )}
        {/* 未保存的新选择可能被另一账号停用；保留原草稿值并显示失效原因，不能让原生 select 静默跳回空值或原教师。 */}
        {newDraftTeacherIsUnavailable && (
          <option key={`unavailable-draft-${draftTeacherId}`} value={draftTeacherId}>
            {draftTeacher?.name ?? "Selected teacher"} (Inactive — choose another teacher)
          </option>
        )}
        {teachers.filter((teacher) => teacher.status === "Active" && teacher.id !== selectedTeacherId).map((teacher) => (
          <option key={teacher.id} value={teacher.id}>{teacher.name} ({teacher.staffType})</option>
        ))}
      </select>
      {currentTeacherIsUnavailable && (
        <p className="text-[10px] leading-4 text-red-700">This teacher is inactive. Keep the current assignment temporarily, or choose an active teacher.</p>
      )}
      {newDraftTeacherIsUnavailable && (
        <p className="text-[10px] font-semibold leading-4 text-red-700">Your unsaved teacher selection became inactive. Choose an active teacher before saving.</p>
      )}
    </div>
  );
}

function RoomSelect({ rooms, selectedRoomId, selectedRoomCode, ariaLabel, disabled = false }: { rooms: Room[]; selectedRoomId: string | null; selectedRoomCode: string | null; ariaLabel: string; disabled?: boolean }) {
  // 教室状态与教师状态采用相同原则：Inactive 教室不能成为新的选择，但旧课程当前
  // 使用的教室必须继续显示。否则原生 select 找不到当前 value，会静默跳到 Room pending。
  const [draftRoomId, setDraftRoomId] = useState(selectedRoomId ?? "");
  const selectedRoom = selectedRoomId ? rooms.find((room) => room.id === selectedRoomId) : undefined;
  const draftRoom = draftRoomId ? rooms.find((room) => room.id === draftRoomId) : undefined;
  const currentRoomIsUnavailable = Boolean(selectedRoomId) && selectedRoom?.status !== "Active";
  const newDraftRoomIsUnavailable = Boolean(draftRoomId) && draftRoomId !== selectedRoomId && draftRoom?.status !== "Active";
  const currentRoomLabel = selectedRoom?.status === "Active"
    ? `${selectedRoom.code} · ${selectedRoom.capacity} seats`
    : `${selectedRoomCode ?? selectedRoom?.code ?? "Current room"} (Inactive — current assignment)`;

  return (
    <div className="grid gap-1">
      <select
        name="roomId"
        value={draftRoomId}
        onChange={(event) => setDraftRoomId(event.target.value)}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-invalid={newDraftRoomIsUnavailable || undefined}
        className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm disabled:cursor-wait disabled:bg-slate-100"
      >
        <option value="">Room pending</option>
        {/* 当前教室保留稳定的 key/value；后台状态刷新只改变文字，不会把已保存的 roomId 清空。 */}
        {selectedRoomId && (
          <option key={`current-${selectedRoomId}`} value={selectedRoomId}>{currentRoomLabel}</option>
        )}
        {/* 未保存的新教室若被另一账号停用，继续显示该草稿并要求重选，避免浏览器自行换成空值。 */}
        {newDraftRoomIsUnavailable && (
          <option key={`unavailable-draft-${draftRoomId}`} value={draftRoomId}>
            {draftRoom?.code ?? "Selected room"} (Inactive — choose another room)
          </option>
        )}
        {rooms.filter((room) => room.status === "Active" && room.id !== selectedRoomId).map((room) => (
          <option key={room.id} value={room.id}>{room.code} · {room.capacity} seats</option>
        ))}
      </select>
      {currentRoomIsUnavailable && (
        <p className="text-[10px] leading-4 text-red-700">This room is inactive. Keep the current assignment temporarily, or choose an active room.</p>
      )}
      {newDraftRoomIsUnavailable && (
        <p className="text-[10px] font-semibold leading-4 text-red-700">Your unsaved room selection became inactive. Choose an active room before saving.</p>
      )}
    </div>
  );
}

function lessonIssueClasses(severity: ScheduledLesson["warningSeverity"]) {
  // 按需求约定统一课程卡颜色：红色代表严重冲突，黄色代表每日时数等软性上限，蓝色代表建议事项或尚未完成的教师／教室分配。
  if (severity === "High") {
    return {
      card: "bg-red-50 text-red-950 ring-red-300",
      message: "text-red-700",
      panel: "border-red-200 bg-red-50 text-red-800",
    };
  }
  if (severity === "Warning") {
    return {
      card: "bg-amber-50 text-amber-950 ring-amber-300",
      message: "text-amber-700",
      panel: "border-amber-200 bg-amber-50 text-amber-900",
    };
  }
  return {
    card: "bg-blue-50 text-blue-900 ring-blue-300",
    message: "text-blue-700",
    panel: "border-blue-200 bg-blue-50 text-blue-900",
  };
}

function noticeToneClasses(tone: NoticeTone) {
  // 提示颜色由发起操作的业务区块明确指定，不再猜测英文句子里是否包含某个单词。
  // 这样同一句资料说明即使未来改写，也不会意外从成功变成警告或从错误变成中性状态。
  if (tone === "error") return "border-red-200 bg-red-50 text-red-900";
  if (tone === "warning") return "border-amber-200 bg-amber-50 text-amber-950";
  if (tone === "success") return "border-emerald-200 bg-emerald-50 text-emerald-950";
  return "border-slate-200 bg-white text-slate-800";
}

function preferredScrollBehavior(): ScrollBehavior {
  // 尊重操作系统的“减少动态效果”设置；键盘定位和左右浏览仍然发生，只取消可能引起不适的平滑移动。
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}

function setCompactDragPreview(event: DragEvent<HTMLElement>, label: string) {
  // 浏览器默认会把整张课程卡当作拖动影子，容易遮住鼠标下方的小时格；这里临时生成只含课程编号的小标签，让老师始终看得见目标时间。
  const preview = document.createElement("div");
  preview.textContent = label;
  preview.className = "fixed -left-[9999px] top-0 rounded-md bg-slate-900 px-2 py-1 text-xs font-bold text-white shadow-lg";
  document.body.appendChild(preview);
  event.dataTransfer.setDragImage(preview, 12, 12);
  requestAnimationFrame(() => preview.remove());
}

function positionTimetableLessons(lessons: ScheduledLesson[]): PositionedLesson[] {
  // 把数据库保存的星期和时间转换为可视化横向通道；即使老师允许多门课重叠保存，课程卡也会并排显示，而不是互相覆盖。
  const positioned: PositionedLesson[] = [];

  for (let dayOfWeek = 1; dayOfWeek <= timetableDays.length; dayOfWeek += 1) {
    // 每次只处理一天并按开始时间排序；相同开始时间时先放长课，使长课通道保持稳定，较短的冲突课程再排列到旁边。
    const dayLessons = lessons
      .filter((lesson) => lesson.dayOfWeek === dayOfWeek)
      .sort((left, right) => left.startHour - right.startHour || right.durationHours - left.durationHours || left.id.localeCompare(right.id));
    let component: ScheduledLesson[] = [];
    let componentEnd = 0;

    const placeComponent = () => {
      if (component.length === 0) return;
      // 每门重叠课程使用第一个已经空出的横向通道；同一组相连的重叠课程共用最终通道总数，保证所有已保存冲突都能完整并排显示。
      const laneEnds: number[] = [];
      const assignments = component.map((lesson) => {
        let lane = laneEnds.findIndex((endHour) => endHour <= lesson.startHour);
        if (lane === -1) lane = laneEnds.length;
        laneEnds[lane] = lesson.startHour + lesson.durationHours;
        return { lesson, lane };
      });
      const laneCount = Math.max(1, laneEnds.length);
      positioned.push(...assignments.map((assignment) => ({ ...assignment, laneCount })));
    };

    for (const lesson of dayLessons) {
      // 如果下一门课刚好在当前课程组结束时开始，两者没有时间重叠；结束当前组后，下一门课可以重新使用整列宽度。
      if (component.length > 0 && lesson.startHour >= componentEnd) {
        placeComponent();
        component = [];
        componentEnd = 0;
      }
      component.push(lesson);
      componentEnd = Math.max(componentEnd, lesson.startHour + lesson.durationHours);
    }
    placeComponent();
  }

  return positioned;
}

function WeeklyTimetableGrid({ lessons, renderLesson, onCellDrop, focusLesson }: {
  lessons: ScheduledLesson[];
  renderLesson: (lesson: ScheduledLesson, isDense: boolean) => React.ReactNode;
  onCellDrop?: (event: DragEvent<HTMLDivElement>, dayOfWeek: number, startHour: number) => void;
  focusLesson?: { id: string; requestNumber: number } | null;
}) {
  // 这张共用周表同时服务可编辑的年级总表和只读的个人课表；只有传入拖放回调时才开放拖动，避免个人课表意外修改资料。
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [dropTarget, setDropTarget] = useState<TimetableDropTarget | null>(null);
  const positionedLessons = useMemo(() => positionTimetableLessons(lessons), [lessons]);
  // 先统计每天最多有多少门课同时上课，再按每条并排课程至少 112px 扩展当天宽度。
  // 总表可能同时展示十多班课程；若继续把一天封顶在 288px，每张卡最终只剩十几像素，课程编号也无法辨认。
  // 因此普通日期仍可同时看到至少三个工作日，极繁忙日期则宁可让内部总表横向滚动，也不再牺牲卡片可读性。
  const laneCountsByDay = timetableDays.map((_, dayIndex) => Math.max(1, ...positionedLessons.filter((item) => item.lesson.dayOfWeek === dayIndex + 1).map((item) => item.laneCount)));
  const dayWidthWeights = laneCountsByDay.map((laneCount) => laneCount <= 2 ? 1 : Math.min(2.4, 1 + ((laneCount - 2) * 0.28)));
  const dayMinimumWidths = laneCountsByDay.map((laneCount) => Math.max(152, laneCount * 112));
  const minimumGridWidth = 48 + dayMinimumWidths.reduce((total, width) => total + width, 0) + (timetableDays.length * 4);
  const timetableColumns = `48px ${dayMinimumWidths.map((width, index) => `minmax(${width}px, ${dayWidthWeights[index]}fr)`).join(" ")}`;

  useEffect(() => {
    // 无论拖动在表内完成还是在表外取消，都清除绿色目标行，避免页面残留一个实际上不会接收课程的错误时间提示。
    if (!onCellDrop) return;
    const clearDropTarget = () => setDropTarget(null);
    window.addEventListener("dragend", clearDropTarget);
    window.addEventListener("drop", clearDropTarget);
    return () => {
      window.removeEventListener("dragend", clearDropTarget);
      window.removeEventListener("drop", clearDropTarget);
    };
  }, [onCellDrop]);

  function allowCellDrop(event: DragEvent<HTMLDivElement>, dayOfWeek: number, startHour: number) {
    // 鼠标经过每个小时格时立即记录确切星期和开始时间，并先显示绿色目标行，让老师在松开鼠标前确认落点。
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDropTarget((current) => current?.dayOfWeek === dayOfWeek && current.startHour === startHour ? current : { dayOfWeek, startHour });
  }

  function hourInsideLesson(event: DragEvent<HTMLDivElement>, lesson: ScheduledLesson) {
    // 已有的多小时课程卡会遮住多个背景格；这里按课程时长把卡片高度平均分成小时段，拖到第二或第三段仍能准确得到对应开始时间。
    const bounds = event.currentTarget.getBoundingClientRect();
    const hourHeight = bounds.height / lesson.durationHours;
    const offset = Math.min(lesson.durationHours - 1, Math.max(0, Math.floor((event.clientY - bounds.top) / hourHeight)));
    return lesson.startHour + offset;
  }

  function finishCellDrop(event: DragEvent<HTMLDivElement>, dayOfWeek: number, startHour: number) {
    // 松开鼠标后先清除视觉提示，再把准确星期和小时交给原有保存流程；保存接口仍会执行全部冲突与规则检查。
    event.preventDefault();
    event.stopPropagation();
    setDropTarget(null);
    onCellDrop?.(event, dayOfWeek, startHour);
  }

  useEffect(() => {
    // 保存成功后直接在已渲染元素中寻找相同数据库编号，不把编号拼进 CSS；找到后跨越内外滚动区把课程卡平滑移动到可见位置。
    if (!focusLesson) return;
    const scrollContainer = scrollContainerRef.current;
    const savedLesson = Array.from(scrollContainer?.querySelectorAll<HTMLElement>("[data-lesson-id]") ?? []).find((element) => element.dataset.lessonId === focusLesson.id);
    savedLesson?.scrollIntoView({ behavior: preferredScrollBehavior(), block: "center", inline: "center" });
  }, [focusLesson, positionedLessons]);

  const scrollTimetable = (direction: -1 | 1) => {
    // 横向按钮每次移动约四分之三可见宽度，保留一小段原画面作为位置参照，避免老师滚动后不知道刚才离开了哪一天。
    const container = scrollContainerRef.current;
    if (!container) return;
    container.scrollBy({ left: direction * Math.max(320, container.clientWidth * 0.75), behavior: preferredScrollBehavior() });
  };

  return (
    <div>
      {/* 普通密度下至少三个连续工作日同屏；极繁忙日期按卡片数量继续扩宽，其余内容通过明确的左右按钮查看。 */}
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
        <span>{onCellDrop ? "Cards stay readable. Busy days expand horizontally; use the arrows for the rest." : "Cards stay readable; use the arrows to review the rest."}</span>
        <div className="flex gap-1">
          <button onClick={() => scrollTimetable(-1)} className="rounded-md border border-slate-200 bg-white px-2.5 py-1 font-bold text-slate-700 hover:border-blue-400 hover:text-blue-700" type="button" aria-label="Scroll timetable left">← Left</button>
          <button onClick={() => scrollTimetable(1)} className="rounded-md border border-slate-200 bg-white px-2.5 py-1 font-bold text-slate-700 hover:border-blue-400 hover:text-blue-700" type="button" aria-label="Scroll timetable right">Right →</button>
        </div>
      </div>
      <div ref={scrollContainerRef} data-timetable-scroll className="overflow-x-auto pb-1">
        {/* 每小时压缩为 36px，使 08:00–18:00 和页面工具栏更容易同时留在大屏内；课程卡仍严格按照 durationHours 跨越对应小时数。 */}
        <div className="grid gap-x-1 text-[10px]" style={{ gridTemplateColumns: timetableColumns, gridTemplateRows: "28px repeat(10, minmax(36px, 1fr))", minHeight: 388, minWidth: minimumGridWidth }}>
        <div className="sticky left-0 z-20 bg-white pt-2 text-slate-400" style={{ gridColumn: 1, gridRow: 1 }}>Time</div>
        {timetableDays.map((day, index) => <div key={day} className="rounded-md bg-slate-50 p-1.5 text-center font-bold text-slate-500" style={{ gridColumn: index + 2, gridRow: 1 }}>{day}</div>)}

        {timetableHours.map((hour, hourIndex) => (
          <div key={`time-${hour}`} className="sticky left-0 z-20 border-t border-slate-100 bg-white py-2 font-semibold text-slate-400" style={{ gridColumn: 1, gridRow: hourIndex + 2 }}>
            {String(hour).padStart(2, "0")}:00
          </div>
        ))}

        {/* 背景小时格始终是真正的拖放目标；课程覆盖层本身不接收鼠标，只有课程卡例外，因此所有空白小时仍可正常放入课程。 */}
        {timetableHours.flatMap((hour, hourIndex) => timetableDays.map((_, dayIndex) => (
          <div
            key={`cell-${dayIndex + 1}-${hour}`}
            onDragOver={onCellDrop ? (event) => allowCellDrop(event, dayIndex + 1, hour) : undefined}
            onDrop={onCellDrop ? (event) => finishCellDrop(event, dayIndex + 1, hour) : undefined}
            className={onCellDrop ? `m-px rounded-md border border-dashed transition ${dropTarget?.dayOfWeek === dayIndex + 1 && dropTarget.startHour === hour ? "border-emerald-500 bg-emerald-100" : "border-slate-200 hover:border-blue-400 hover:bg-blue-50/40"}` : "m-px rounded-md border border-slate-100 bg-slate-50/50"}
            style={{ gridColumn: dayIndex + 2, gridRow: hourIndex + 2 }}
          />
        )))}

        {timetableDays.map((_, dayIndex) => (
          <div key={`overlay-${dayIndex + 1}`} className="pointer-events-none relative z-10" style={{ gridColumn: dayIndex + 2, gridRow: "2 / span 10" }}>
            {/* 绿色目标行显示在已有课程卡上方但不截获鼠标事件，因此老师能看见确切落点，同时拖放仍由下方课程或小时格处理。 */}
            {dropTarget?.dayOfWeek === dayIndex + 1 && <div className="pointer-events-none absolute z-30 flex items-start rounded border-2 border-emerald-500 bg-emerald-200/70 px-1 py-0.5 font-black text-emerald-950 shadow-sm" style={{ top: `${((dropTarget.startHour - timetableHours[0]) / timetableHours.length) * 100}%`, height: `${100 / timetableHours.length}%`, left: 1, right: 1 }}><span className="rounded bg-white/90 px-1">Drop {String(dropTarget.startHour).padStart(2, "0")}:00</span></div>}
            {positionedLessons.filter((item) => item.lesson.dayOfWeek === dayIndex + 1).map(({ lesson, lane, laneCount }) => {
              const laneWidth = 100 / laneCount;
              // 三条以上并排时把卡片之间的空隙从 4px 缩到 2px，把宝贵宽度留给课程编号和教师姓名；普通密度仍保留较清楚的分隔。
              const laneGap = laneCount > 2 ? 1 : 2;
              const top = ((lesson.startHour - timetableHours[0]) / timetableHours.length) * 100;
              const height = (lesson.durationHours / timetableHours.length) * 100;
              return (
                <div
                  key={lesson.id}
                  data-lesson-id={lesson.id}
                  data-day-of-week={lesson.dayOfWeek}
                  data-start-hour={lesson.startHour}
                  data-duration-hours={lesson.durationHours}
                  aria-label={`${lesson.sectionLabel}, ${lesson.durationHours} hours`}
                  onDragOver={onCellDrop ? (event) => allowCellDrop(event, lesson.dayOfWeek, hourInsideLesson(event, lesson)) : undefined}
                  onDrop={onCellDrop ? (event) => finishCellDrop(event, lesson.dayOfWeek, hourInsideLesson(event, lesson)) : undefined}
                  className={`pointer-events-auto absolute transition ${focusLesson?.id === lesson.id ? "z-20 rounded-md ring-4 ring-emerald-400 ring-offset-2" : ""}`}
                  style={{ top: `calc(${top}% + 2px)`, height: `calc(${height}% - 4px)`, left: `calc(${lane * laneWidth}% + ${laneGap}px)`, width: `calc(${laneWidth}% - ${laneGap * 2}px)` }}
                >
                  {renderLesson(lesson, laneCount > 2)}
                </div>
              );
            })}
          </div>
        ))}
        </div>
      </div>
    </div>
  );
}

export default function Home() {
  // 这一组状态记录老师当前看到的页面、表单和业务资料；所有切换都在客户端完成，避免每次点击都重新载入整页。
  const [view, setView] = useState<View>("Year timetables");
  const [query, setQuery] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [teachers, setTeachers] = useState<Teacher[]>([]);
  const [groups, setGroups] = useState<StudentGroup[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [editingTeacher, setEditingTeacher] = useState<Teacher | null>(null);
  const [editingGroup, setEditingGroup] = useState<StudentGroup | null>(null);
  const [editingRoom, setEditingRoom] = useState<Room | null>(null);
  // 教师、班级和教室的编辑／状态／删除按钮按“资料页 + 稳定 ID + 动作”保存引用。
  // 保存或多人冲突刷新后，画面可精确回到老师刚才使用的入口，而不是把键盘焦点丢到页面开头。
  const masterRecordButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const masterDataSearchInputRef = useRef<HTMLInputElement>(null);
  const dataManagementFormToggleButtonRef = useRef<HTMLButtonElement>(null);
  const dataManagementFormFirstInputRef = useRef<HTMLInputElement>(null);
  // 资料刷新会重建表格行，而 finally 才解除按钮的 disabled。一次性目标等两者都
  // 完成后才恢复焦点；新增资料回到 Add，编辑／启停则按稳定 ID 回到原动作。
  const pendingMasterRecordFocusRef = useRef<
    | { kind: "form-toggle" }
    | { kind: "record"; recordView: "Teachers" | "Student groups" | "Rooms"; recordId: string; action: "edit" | "status" | "delete" }
    | null
  >(null);
  const loadErrorRefreshButtonRef = useRef<HTMLButtonElement>(null);
  const [courses, setCourses] = useState<Course[]>([]);
  const [editingCourse, setEditingCourse] = useState<Course | null>(null);
  // 每门课程的 Configure 按钮按稳定课程 ID 保存引用。旧设置表单因 409 被关闭后，
  // 键盘焦点会回到同一门课的按钮，而不是掉到页面 body 让老师重新 Tab 很久。
  const courseConfigureButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const courseDeleteButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  // 删除成功后课程行已经不存在，焦点回到搜索；并发冲突刷新后则按稳定 ID 回到
  // 最新 Delete 按钮。管理写锁释放前不消费目标，避免聚焦仍 disabled 的旧节点。
  const pendingCourseDeleteFocusRef = useRef<{ kind: "delete"; courseId: string } | { kind: "search" } | null>(null);
  const courseSearchInputRef = useRef<HTMLInputElement>(null);
  const courseDurationInputRef = useRef<HTMLInputElement>(null);
  const savingCourseSetupIdRef = useRef<string | null>(null);
  const [savingCourseSetupId, setSavingCourseSetupId] = useState<string | null>(null);
  const [selectedCourse, setSelectedCourse] = useState<Course | null>(null);
  const sectionCountInputRef = useRef<HTMLInputElement>(null);
  // 班次表单以 revision 为 key 重建。按稳定 section ID 保存可聚焦标题，保存或409重载后
  // 才能回到同一行；若目标班次已被另一账号移除，则退到本面板 Close，而不是误入邻行。
  const sectionAssignmentFocusRefs = useRef(new Map<string, HTMLParagraphElement>());
  const sectionsCloseButtonRef = useRef<HTMLButtonElement>(null);
  const [sections, setSections] = useState<CourseSection[]>([]);
  const [allocationVariances, setAllocationVariances] = useState<AllocationVariance[]>([]);
  // ref 会在第一次点击时立即锁住班次，state 则负责把当前按钮显示为 Saving 并暂时停用其余 Save；
  // 两者配合可阻止快速双击或连续点击两个班次时发出相互覆盖的请求。
  const savingSectionIdRef = useRef<string | null>(null);
  const [savingSectionId, setSavingSectionId] = useState<string | null>(null);
  const [timetableYear, setTimetableYear] = useState(1);
  const [lessons, setLessons] = useState<ScheduledLesson[]>([]);
  const [unscheduledSections, setUnscheduledSections] = useState<UnscheduledSection[]>([]);
  const [unscheduledQuery, setUnscheduledQuery] = useState("");
  const [unscheduledStaffType, setUnscheduledStaffType] = useState<"All" | "FT" | "PT">("All");
  const [unscheduledGroupId, setUnscheduledGroupId] = useState("");
  const [unscheduledProgram, setUnscheduledProgram] = useState("");
  const [editingLesson, setEditingLesson] = useState<ScheduledLesson | null>(null);
  // Inspector 的课程对象同时保存老师打开表单时看到的 revision。后台轮询发现新版时
  // 只标记过期，不替换这个对象，避免未保存的星期、时间、教师、教室或班级静默消失。
  const editingLessonRef = useRef<ScheduledLesson | null>(null);
  const [lessonDraftIsStale, setLessonDraftIsStale] = useState(false);
  const lessonEditorDaySelectRef = useRef<HTMLSelectElement>(null);
  const draggingScheduledLessonRef = useRef<ScheduledLesson | null>(null);
  const lessonMutationIdRef = useRef<string | null>(null);
  const [lessonMutation, setLessonMutation] = useState<{ id: string; action: "save" | "return" | "move" } | null>(null);
  // 老师进入年级总表后的主要动作是从待排清单开始放课，因此左侧待排区默认打开；仍可用顶部开关关闭并恢复全宽总表。
  const [showUnscheduledDrawer, setShowUnscheduledDrawer] = useState(true);
  const [showTimetableInspector, setShowTimetableInspector] = useState(false);
  // 开关和关闭按钮的引用用于管理键盘焦点：打开面板后进入面板，关闭后回到原来的工具栏按钮。
  const unscheduledToggleButtonRef = useRef<HTMLButtonElement>(null);
  const unscheduledCloseButtonRef = useRef<HTMLButtonElement>(null);
  // 记录上一次待排区状态，用来区分“页面载入时本来就打开”和“老师刚刚按开关打开”这两种情况。
  const previousUnscheduledDrawerState = useRef(showUnscheduledDrawer);
  const inspectorToggleButtonRef = useRef<HTMLButtonElement>(null);
  const inspectorCloseButtonRef = useRef<HTMLButtonElement>(null);
  // Inspector 从关闭状态重新打开时，普通入口应先聚焦 Close；多人冲突重新载入课程时
  // 则应直接聚焦 Day。这个一次性目标由唯一的打开 Effect 消费，避免两个 rAF 互相抢焦点。
  const pendingInspectorFocusRef = useRef<"close" | "lesson-day" | null>(null);
  const [unavailableWindows, setUnavailableWindows] = useState<UnavailableWindow[]>([]);
  const [scheduleIssues, setScheduleIssues] = useState<ScheduleIssue[]>([]);
  const [placingSection, setPlacingSection] = useState<UnscheduledSection | null>(null);
  // 首次排课的三个入口共用同一把即时锁：ref 在第一次操作同步生效，state 则负责显示 Placing 和停用按钮。
  // 这样快速双击候选位置或重复提交 Inspector 时，只会真正建立一条课次记录。
  const placingSessionKeyRef = useRef<string | null>(null);
  const [placingSessionKey, setPlacingSessionKey] = useState<string | null>(null);
  const [candidateSection, setCandidateSection] = useState<UnscheduledSection | null>(null);
  const [candidateSlots, setCandidateSlots] = useState<CandidateSlot[]>([]);
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  // 候选请求可与关闭／切换班次交错返回。递增序号负责淘汰旧请求，显式班次身份
  // 再防止 A 班次的迟到响应写进 B 班次面板或成为可点击的候选项。
  const candidateSlotRequestNumber = useRef(0);
  const candidateSectionIdentityRef = useRef<CandidateSlotRequestIdentity | null>(null);
  const [recentlySavedLesson, setRecentlySavedLesson] = useState<{ id: string; requestNumber: number } | null>(null);
  const savedLessonRequestNumber = useRef(0);
  const [personalKind, setPersonalKind] = useState<"Teacher" | "StudentGroup" | "Room">("Teacher");
  const [personalOwnerId, setPersonalOwnerId] = useState("");
  const [personalLessons, setPersonalLessons] = useState<ScheduledLesson[]>([]);
  const [ruleSettings, setRuleSettings] = useState<RuleSetting[]>([]);
  const [currentCycle, setCurrentCycle] = useState<CycleStatus | null>(null);
  const [authScreen, setAuthScreen] = useState<"checking" | "setup" | "login" | "ready" | "load-error">("checking");
  // load-error 会卸载整套可编辑资料，因此必须在专用状态中保存冻结原因；普通 toast
  // 会在八秒后隐藏，而且错误画面过去只显示固定文案，无法说明写入结果未知或已提交但重载失败。
  const [workspaceLoadErrorDetail, setWorkspaceLoadErrorDetail] = useState<string | null>(null);
  const [currentUser, setCurrentUser] = useState<AppUser | null>(null);
  // 这个 generation 只在身份边界改变时提高，不受普通课表轮询影响。受保护请求在
  // await 前保存号码；登出／会话撤销后迟到的旧响应不得下载资料、复活缓存或改提示。
  const authenticatedSessionGeneration = useRef(0);
  const sessionExpiryNoticeActive = useRef(false);
  // ref 会在同一个事件循环内立即挡住重复 Enter／双击，state 则把按钮显示为进行中。
  // 首次 setup 若发出两次请求，第二个 409 不应盖掉第一笔已经成功的登录结果。
  const authenticationRequestInFlight = useRef(false);
  const [authenticationSubmitting, setAuthenticationSubmitting] = useState(false);
  const [accounts, setAccounts] = useState<AppUser[]>([]);
  // 启停按钮以稳定账号 ID 保存引用。多人冲突或成功刷新会重建这一行，下一帧仍要
  // 把键盘焦点送回同一账号的最新按钮，不能让使用者从页面 body 重新寻找入口。
  const accountStatusButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const pendingAccountStatusFocusRef = useRef<string | null>(null);
  // 完整恢复会覆盖管理员打开页面后发生的任何业务修改，因此页面先保存服务端给出的
  // 当前资料指纹，提交时再由数据库在写锁内核对。这个值只作并发确认，不显示给用户。
  const [systemRestoreCurrentToken, setSystemRestoreCurrentToken] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);
  const [importing, setImporting] = useState(false);
  const [downloadingBackup, setDownloadingBackup] = useState(false);
  const [restoringBackup, setRestoringBackup] = useState(false);
  // 资料维护动作共用一把即时锁。ref 在第一次点击的同一事件循环内生效，state
  // 负责停用画面按钮和导航；只用 state 会让快速双击有机会送出两笔写入请求。
  const managementMutationKeyRef = useRef<string | null>(null);
  const [managementMutationKey, setManagementMutationKey] = useState<string | null>(null);
  const [notice, setNoticeMessage] = useState("Loading the local scheduling database...");
  const [noticeTone, setNoticeTone] = useState<NoticeTone>("info");
  // 序号与文案分开保存；即使老师连续两次遇到完全相同的错误，每次调用仍会增加序号、重新显示提示并重启八秒计时器。
  const [noticeRequestNumber, setNoticeRequestNumber] = useState(0);
  const [showNoticeToast, setShowNoticeToast] = useState(true);
  const [isLoading, setIsLoading] = useState(true);
  // 显式保存后的刷新必须让更早发出的五秒轮询失效，否则慢响应可能把旧列表
  // 写回刚保存的新画面。每一批请求领取递增号码，只有最新批次可以应用 state。
  const visibleWorkspaceRefreshNumber = useRef(0);
  // 老师主动换年级、保存后重载或处理409时，显式刷新拥有更高优先级。轮询在这段
  // 时间内不领取新号码，避免“较晚启动的后台 tick”取消老师正在等待的操作。
  const activeManualTimetableRefreshNumber = useRef<number | null>(null);

  function setNotice(message: string, tone: NoticeTone = "info") {
    // 保留既有 setNotice("文字") 调用的低风险写法，同时允许关键成功、警告和错误路径显式指定颜色。
    // 显示开关在调用当下打开，序号则保证相同文案也会重新触发计时与辅助技术播报。
    if (sessionExpiryNoticeActive.current) return;
    setNoticeMessage(message);
    setNoticeTone(tone);
    setShowNoticeToast(true);
    setNoticeRequestNumber((current) => current + 1);
  }

  const clearCandidateSlotWorkspace = useCallback(() => {
    candidateSlotRequestNumber.current += 1;
    candidateSectionIdentityRef.current = null;
    setCandidateSection(null);
    setCandidateSlots([]);
    setCandidatesLoading(false);
  }, []);

  function candidateSlotRequestIsCurrent(requestNumber: number, sectionId: string, occurrence: number) {
    return requestNumber === candidateSlotRequestNumber.current
      && candidateSlotRequestMatches(candidateSectionIdentityRef.current, { requestNumber, sectionId, occurrence });
  }

  function beginManagementMutation(key: string) {
    // 不同资料页也共享同一个数据库；上一笔写入尚未确认时，不允许导航或另一笔
    // 写入并行开始，否则后完成的旧刷新可能覆盖较新的画面和提示。
    if (managementMutationKeyRef.current || lessonMutationIdRef.current || placingSessionKeyRef.current || savingCourseSetupIdRef.current || savingSectionIdRef.current) {
      setNotice("Another change is still being saved. Wait for it to finish before trying again.", "warning");
      return false;
    }
    // 让已经发出的五秒轮询立即过期，并阻止当前恢复确认继续使用旧资料指纹。
    // 即使写入最终被服务端拒绝，重新审阅一次也比误覆盖他人资料更安全。
    visibleWorkspaceRefreshNumber.current += 1;
    activeManualTimetableRefreshNumber.current = null;
    setSystemRestoreCurrentToken(null);
    managementMutationKeyRef.current = key;
    setManagementMutationKey(key);
    return true;
  }

  function finishManagementMutation(key: string, sessionRequestGeneration: number) {
    // finally 可能在页面状态已经变化后运行；只有仍持有同一把锁的请求可以释放它，
    // 避免迟到的旧请求意外解锁一笔较新的操作。generation 是必填参数，让之后新增
    // mutation 若忘记绑定身份边界，会直接在 TypeScript 检查时报错，而不是留下竞态。
    if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
    if (managementMutationKeyRef.current !== key) return;
    managementMutationKeyRef.current = null;
    setManagementMutationKey(null);
  }

  function freezeManagementWorkspace(message: string, tone: NoticeTone = "warning") {
    // 写请求已提交后若聚合重载失败，或网络中断令提交结果未知，当前 revision 和关联
    // 清单都不再可信。统一卸载可编辑工作区，只保留 Refresh 入口；绝不能让老师
    // 在旧画面继续保存第二笔资料，或因重复点击把已成功的第一笔误报成冲突。
    if (sessionExpiryNoticeActive.current || authenticationRequestInFlight.current) return;
    setWorkspaceLoadErrorDetail(message);
    setAuthScreen("load-error");
    setNotice(message, tone);
  }

  function restoreSectionAssignmentFocus(sectionId: string) {
    // openSections 的三份 state 会在本轮事件结束统一提交；下一帧才查询 ref，确保取得
    // 新 revision 对应的 DOM。绝不按数组位置回退，以免焦点落到另一班次的保存表单。
    window.requestAnimationFrame(() => {
      const sectionTarget = sectionAssignmentFocusRefs.current.get(sectionId);
      if (sectionTarget?.isConnected) sectionTarget.focus();
      else sectionsCloseButtonRef.current?.focus();
    });
  }

  useEffect(() => {
    // refreshAccounts 会替换整行按钮，而 mutation 的 finally 才解除 disabled。等两项
    // state 都提交后再消费一次性目标，成功与409冲突都会回到同一账号的最新动作。
    if (managementMutationKey !== null) return;
    const accountId = pendingAccountStatusFocusRef.current;
    if (!accountId) return;
    pendingAccountStatusFocusRef.current = null;
    const animationFrame = window.requestAnimationFrame(() => accountStatusButtonRefs.current.get(accountId)?.focus());
    return () => window.cancelAnimationFrame(animationFrame);
  }, [accounts, managementMutationKey]);

  useEffect(() => {
    // 新增／编辑表单位于汇总卡和搜索框之后；如果焦点留在页首的 Add／Close 按钮，
    // 键盘继续 Tab 会绕过整张表单。DOM 挂载后的下一帧直接进入第一个实际输入。
    if (!showForm || (view === "Courses" && editingCourse)) return;
    const animationFrame = window.requestAnimationFrame(() => dataManagementFormFirstInputRef.current?.focus());
    return () => window.cancelAnimationFrame(animationFrame);
  }, [editingCourse, editingGroup, editingRoom, editingTeacher, showForm, view]);

  useEffect(() => {
    // React 会在聚合刷新时替换资料对象，管理锁也要到 finally 才解除；因此不能在
    // fetch 回调里立即 focus 一个仍 disabled 或尚未挂载的按钮。
    if (managementMutationKey !== null) return;
    const target = pendingMasterRecordFocusRef.current;
    if (!target) return;
    pendingMasterRecordFocusRef.current = null;
    const animationFrame = window.requestAnimationFrame(() => {
      if (target.kind === "form-toggle") {
        dataManagementFormToggleButtonRef.current?.focus();
        return;
      }
      // 键格式与 masterRecordButtonKey 相同；在 Effect 内直接组合可保持依赖稳定，
      // 避免每次 render 因本地函数身份改变而重复消费一次性焦点目标。
      const originalButton = masterRecordButtonRefs.current.get(
        `${target.recordView}:${target.recordId}:${target.action}`,
      );
      if (originalButton?.isConnected) originalButton.focus();
      else masterDataSearchInputRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(animationFrame);
  }, [courses, groups, managementMutationKey, rooms, teachers]);

  useEffect(() => {
    if (managementMutationKey !== null) return;
    const target = pendingCourseDeleteFocusRef.current;
    if (!target) return;
    pendingCourseDeleteFocusRef.current = null;
    const animationFrame = window.requestAnimationFrame(() => {
      if (target.kind === "search") {
        courseSearchInputRef.current?.focus();
        return;
      }
      const deleteButton = courseDeleteButtonRefs.current.get(target.courseId);
      if (deleteButton?.isConnected) deleteButton.focus();
      else courseSearchInputRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(animationFrame);
  }, [courses, managementMutationKey]);

  useEffect(() => {
    // 轮询回调每五秒才执行一次，不能依赖建立 interval 时捕获的旧 editingLesson。
    // ref 始终指向画面当前编辑对象，让后台同步可以判断服务器 revision 是否已经变化。
    editingLessonRef.current = editingLesson;
  }, [editingLesson]);

  useEffect(() => {
    // Configure 表单插在课程表格之前；若焦点仍停在行尾按钮，键盘继续 Tab 会跳到
    // 下一行而不是新表单。表单完成挂载后的下一帧直接进入第一个课时字段。
    if (view !== "Courses" || !showForm || !editingCourse) return;
    const animationFrame = window.requestAnimationFrame(() => courseDurationInputRef.current?.focus());
    return () => window.cancelAnimationFrame(animationFrame);
  }, [editingCourse, showForm, view]);

  useEffect(() => {
    // 资料冲突后的强制重载若也失败，应用会切到完全不可编辑的错误画面。
    // 等 React 卸载旧工作区后再聚焦唯一恢复入口，键盘用户可以直接重新载入，而不会停在已消失的旧按钮上。
    if (authScreen !== "load-error") return;
    const animationFrame = window.requestAnimationFrame(() => loadErrorRefreshButtonRef.current?.focus());
    return () => window.cancelAnimationFrame(animationFrame);
  }, [authScreen]);

  useEffect(() => {
    // 每次产生新的操作结果时重新开始八秒计时；依赖请求序号而不是文案，才能可靠处理连续两次相同结果。
    // 因此其他页面底部的 System status 仍可保留完整结果，同时排课页不会长期被提示框遮挡。
    if (!notice) return;
    const hideTimeout = window.setTimeout(() => setShowNoticeToast(false), 8000);
    return () => {
      window.clearTimeout(hideTimeout);
    };
  }, [notice, noticeRequestNumber]);

  useEffect(() => {
    // 保存后的绿色外框保留六秒，让老师能把右上角操作提示和总表课程对应起来；随后自动消失，避免被误认为永久冲突标记。
    if (!recentlySavedLesson) return;
    const timeout = window.setTimeout(() => setRecentlySavedLesson(null), 6000);
    return () => window.clearTimeout(timeout);
  }, [recentlySavedLesson]);

  useEffect(() => {
    // 先保存本轮状态，只有从关闭变成打开时才把键盘焦点移到关闭按钮；页面首次载入虽然默认打开，但不会突然抢走登录后原有焦点。
    const wasOpen = previousUnscheduledDrawerState.current;
    previousUnscheduledDrawerState.current = showUnscheduledDrawer;
    if (!showUnscheduledDrawer || wasOpen) return;
    const frame = window.requestAnimationFrame(() => unscheduledCloseButtonRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [showUnscheduledDrawer]);

  useEffect(() => {
    // Inspector 可能由工具栏、课程卡片或多人冲突重载打开。普通入口先落到 Close；
    // 冲突重载则把老师送到 Day 字段继续检查最新版。只能由这一处决定新面板焦点，
    // 否则两个 requestAnimationFrame 会先后聚焦 Day 与 Close，最终位置不稳定。
    if (!showTimetableInspector) return;
    const requestedFocus = pendingInspectorFocusRef.current ?? "close";
    pendingInspectorFocusRef.current = null;
    const frame = window.requestAnimationFrame(() => {
      if (requestedFocus === "lesson-day") lessonEditorDaySelectRef.current?.focus();
      else inspectorCloseButtonRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [showTimetableInspector]);

  function closeUnscheduledDrawerAndRestoreFocus() {
    // 先请求关闭面板，再把焦点交回仍然存在的工具栏开关，方便键盘用户继续浏览总表。
    setShowUnscheduledDrawer(false);
    window.requestAnimationFrame(() => unscheduledToggleButtonRef.current?.focus());
  }

  function closeInspectorAndRestoreFocus() {
    // Inspector 的关闭按钮是老师明确放弃当前编辑／排课草稿的出口。同步清除这些
    // 对象后，Workspace 与年级导航才重新启用；不能只隐藏面板却把页面永久锁住。
    editingLessonRef.current = null;
    setEditingLesson(null);
    setLessonDraftIsStale(false);
    setPlacingSection(null);
    clearCandidateSlotWorkspace();
    pendingInspectorFocusRef.current = null;
    setShowTimetableInspector(false);
    window.requestAnimationFrame(() => inspectorToggleButtonRef.current?.focus());
  }

  function revealSavedLesson(id: string) {
    // 每次保存都创建新的请求编号，即使课程编号没有改变也一样；这样快速连续编辑同一门课时，滚动定位和六秒高亮都会重新触发。
    savedLessonRequestNumber.current += 1;
    setRecentlySavedLesson({ id, requestNumber: savedLessonRequestNumber.current });
  }

  // 教师、班级、教室和课程搜索都在浏览器内过滤已加载资料，输入时立即响应，也不会反复查询 SQLite。
  const filteredTeachers = useMemo(
    () => teachers.filter((teacher) => `${teacher.name} ${teacher.staffType}`.toLowerCase().includes(query.toLowerCase())),
    [query, teachers],
  );
  const filteredGroups = useMemo(
    () => groups.filter((group) => `${group.code} ${group.program} ${group.year}`.toLowerCase().includes(query.toLowerCase())),
    [query, groups],
  );
  const filteredRooms = useMemo(
    () => rooms.filter((room) => `${room.code} ${room.features.join(" ")}`.toLowerCase().includes(query.toLowerCase())),
    [query, rooms],
  );
  const filteredCourses = useMemo(
    () => courses.filter((course) => `${course.code} ${course.catalog ?? ""}`.toLowerCase().includes(query.toLowerCase())),
    [courses, query],
  );
  const unscheduledPrograms = useMemo(() => [...new Set(groups.map((group) => group.program))].sort(), [groups]);
  const filteredUnscheduledSections = useMemo(() => {
    // 待排搜索同时检查课程、教师、学生班级和专业；下拉菜单提供精确筛选，覆盖分配工作中最常见的查找方式。
    const normalizedQuery = unscheduledQuery.trim().toLowerCase();
    return unscheduledSections.filter((section) => {
      // 同一个 AAA_01 可以分别属于 Year 1、2、3，筛选必须使用稳定 ID；若按 code
      // 反查，会把另一个年级的同名班级及其 programme 错误混入当前待排卡片。
      const sectionGroups = groups.filter((group) => section.studentGroupIds.includes(group.id));
      const searchableText = [section.label, section.teacherName ?? "", section.staffType ?? "", ...section.studentGroups, ...sectionGroups.flatMap((group) => [group.program, `Year ${group.year}`])].join(" ").toLowerCase();
      return (!normalizedQuery || searchableText.includes(normalizedQuery))
        && (unscheduledStaffType === "All" || section.staffType === unscheduledStaffType)
        && (!unscheduledGroupId || section.studentGroupIds.includes(unscheduledGroupId))
        && (!unscheduledProgram || sectionGroups.some((group) => group.program === unscheduledProgram));
    });
  }, [groups, unscheduledGroupId, unscheduledProgram, unscheduledQuery, unscheduledSections, unscheduledStaffType]);
  const visibleYearIssues = useMemo(() => {
    const severityRank = { High: 0, Warning: 1, Advisory: 2 } as const;
    return scheduleIssues
      .filter((issue) => issue.primaryYear === timetableYear)
      .sort((left, right) => severityRank[left.severity] - severityRank[right.severity] || left.dayOfWeek - right.dayOfWeek || left.startHour - right.startHour);
  }, [scheduleIssues, timetableYear]);
  // Inspector 只要仍有一张编辑表单，就要求老师先明确 Close／Save／Return，再离开
  // 年级或打开另一张课；这既保护已标记 stale 的草稿，也避免普通未保存选择被拖动
  // 或导航静默清除。真正保存期间还会冻结所有相关入口直到请求完成。
  const workspaceNavigationLocked = editingLesson !== null
    || placingSection !== null
    || candidateSection !== null
    || candidatesLoading
    || lessonMutation !== null
    || placingSessionKey !== null
    || savingCourseSetupId !== null
    || managementMutationKey !== null;

  function setActiveView(nextView: View) {
    // 恢复指纹只对管理员实际审阅的 Accounts 页面有效。任何导航离开都会同步
    // 清除它；重新进入时必须向服务端取得新指纹，不能跨页面长期保留旧确认。
    if (nextView !== "Accounts") setSystemRestoreCurrentToken(null);
    setView(nextView);
  }

  const clearSessionBoundWorkspace = useCallback(() => {
    // React 在登录画面出现时不会卸载这个组件。退出、会话过期或完整恢复后必须显式
    // 清除管理员账号清单、恢复指纹和上一个账号读取的业务资料；否则下一位普通排课
    // 账号登录后会先看到旧 Accounts 页面或旧课表，直到后台刷新才被替换。
    authenticatedSessionGeneration.current += 1;
    visibleWorkspaceRefreshNumber.current += 1;
    activeManualTimetableRefreshNumber.current = null;
    setWorkspaceLoadErrorDetail(null);
    setCurrentUser(null);
    setAccounts([]);
    accountStatusButtonRefs.current.clear();
    pendingAccountStatusFocusRef.current = null;
    masterRecordButtonRefs.current.clear();
    pendingMasterRecordFocusRef.current = null;
    courseConfigureButtonRefs.current.clear();
    courseDeleteButtonRefs.current.clear();
    pendingCourseDeleteFocusRef.current = null;
    setSystemRestoreCurrentToken(null);
    setTeachers([]);
    setGroups([]);
    setRooms([]);
    setCourses([]);
    setEditingTeacher(null);
    setEditingGroup(null);
    setEditingRoom(null);
    setEditingCourse(null);
    setSelectedCourse(null);
    setSections([]);
    setAllocationVariances([]);
    setLessons([]);
    setUnscheduledSections([]);
    editingLessonRef.current = null;
    setEditingLesson(null);
    setLessonDraftIsStale(false);
    setPlacingSection(null);
    // 身份边界切换时同步释放上一账号的所有即时锁。旧请求的 finally 还会核对
    // 原 session generation 和操作 identity，因此不会误清新账号后来建立的同名锁。
    placingSessionKeyRef.current = null;
    setPlacingSessionKey(null);
    lessonMutationIdRef.current = null;
    setLessonMutation(null);
    managementMutationKeyRef.current = null;
    setManagementMutationKey(null);
    savingCourseSetupIdRef.current = null;
    setSavingCourseSetupId(null);
    savingSectionIdRef.current = null;
    setSavingSectionId(null);
    clearCandidateSlotWorkspace();
    setPersonalOwnerId("");
    setPersonalLessons([]);
    setLastSyncedAt(null);
    setUnavailableWindows([]);
    setScheduleIssues([]);
    setRuleSettings([]);
    setCurrentCycle(null);
    setDownloadingBackup(false);
    setRestoringBackup(false);
    setImporting(false);
    setShowForm(false);
    setShowTimetableInspector(false);
    setShowUnscheduledDrawer(true);
    setView("Year timetables");
  }, [clearCandidateSlotWorkspace]);

  const expireSessionAndReturnToLogin = useCallback((message: string) => {
    // 会话失效属于身份边界变化，不是普通资料读取失败。先废弃所有请求 generation
    // 并清空上一账号缓存，再显示登录页；直接更新 notice state 可让这个 callback
    // 保持稳定，供全页面状态轮询使用而不会每次 render 重建 interval。
    sessionExpiryNoticeActive.current = true;
    clearSessionBoundWorkspace();
    setAuthScreen("login");
    setNoticeMessage(message);
    setNoticeTone("error");
    setShowNoticeToast(true);
    setNoticeRequestNumber((current) => current + 1);
  }, [clearSessionBoundWorkspace]);

  function protectedResponseEndedSession(response: Response, message: string, requestGeneration?: number) {
    // 受保护接口已经明确返回401时，不必等下一次五秒状态轮询。调用方必须在解析
    // 业务正文或写任何 workspace state 前检查本 helper，并立即结束当前流程。
    if (requestGeneration !== undefined && !sessionRequestIsCurrent(requestGeneration)) return true;
    if (response.status !== 401) return false;
    expireSessionAndReturnToLogin(message);
    return true;
  }

  function sessionRequestIsCurrent(requestGeneration: number) {
    // 收到 Response 只证明 fetch 的第一阶段结束；解析正文、冲突重载和 catch 都可能
    // 在老师登出并重新登录后才继续。每个异步 continuation 都用同一号码复核，确保
    // 上一账号的迟到请求不能冻结、改提示或写入新账号刚加载的 workspace。
    return requestGeneration === authenticatedSessionGeneration.current;
  }

  function openView(nextView: View) {
    // 切换资料页面时清除上一页专用的编辑对象、筛选和课程详情，防止旧状态被错误带到新的表格。
    if (editingLessonRef.current || placingSection || candidateSection || candidatesLoading
      || lessonMutationIdRef.current || placingSessionKeyRef.current
      || savingCourseSetupIdRef.current || managementMutationKeyRef.current) {
      setNotice(editingLessonRef.current
        ? "Close or save the open Inspector lesson before leaving this workspace."
        : placingSection || candidateSection || candidatesLoading
          ? "Close the open placement or candidate panel before leaving this workspace."
          : "A save is still in progress. Wait for it to finish before leaving this workspace.", "warning");
      return;
    }
    // 同步导航也要废弃此前已发出的 Rules／Cycle／Accounts／Personal 读取；否则它们
    // 迟到后会把用户拉回旧页面并应用旧资料。
    visibleWorkspaceRefreshNumber.current += 1;
    activeManualTimetableRefreshNumber.current = null;
    setActiveView(nextView);
    setQuery("");
    setShowForm(false);
    setEditingTeacher(null);
    setEditingGroup(null);
    setEditingRoom(null);
    setEditingCourse(null);
    setSelectedCourse(null);
    setSections([]);
    setAllocationVariances([]);
    setEditingLesson(null);
    setPlacingSection(null);
    clearCandidateSlotWorkspace();
  }

  async function openTimetable(
    year: number,
    signal?: AbortSignal,
    lessonToReopen?: Pick<ScheduledLesson, "id" | "sectionId" | "occurrence">,
  ): Promise<TimetableLoadResult> {
    // 系里分别维护三个年级总表，因此这里只加载一个年级的完整排课工作区。
    // 返回 loaded 与实际重开的课程，让多人冲突处理能够区分“最新版已打开”、
    // “已被退回待排区”和“网络失败”，不能给老师错误的成功保证。
    // 可选 signal 只由首次排课链传入，使 POST 成功后的工作区刷新也受同一个30秒总时限保护。
    const requestNumber = ++visibleWorkspaceRefreshNumber.current;
    activeManualTimetableRefreshNumber.current = requestNumber;
    const sessionRequestGeneration = authenticatedSessionGeneration.current;
    try {
      const workspaceResponse = await fetch(`/api/schedule/workspace?year=${year}`, { signal });
      if (protectedResponseEndedSession(workspaceResponse, "Your session expired. Sign in again before opening a timetable.", sessionRequestGeneration)) {
        return { loaded: false, reopenedLesson: null, unscheduledSections: [] };
      }
      if (!workspaceResponse.ok) {
        // 已有更新的显式请求取代本次请求时，旧失败也不能覆盖新请求的提示。
        if (requestNumber === visibleWorkspaceRefreshNumber.current) setNotice("The year timetable could not be loaded.", "error");
        return { loaded: false, reopenedLesson: null, unscheduledSections: [] };
      }
      // 服务端已在一个 DEFERRED 事务内读取全部资料；解析成功前不修改任何 state，
      // 因此 Return／重新排课夹在请求中间时也不会拼出“不可能存在”的总表和待排组合。
      // 保留清楚的聚合响应类型，再立即执行运行时数组验证；`as` 只帮助 TypeScript，
      // 下一行才负责拒绝 200 HTML、null 或缺字段 JSON，且发生在任何 state 写入之前。
      const workspace = await workspaceResponse.json() as YearTimetableWorkspace;
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return { loaded: false, reopenedLesson: null, unscheduledSections: [] };
      parseYearTimetableWorkspace(workspace);
      const nextLessons = workspace.lessons;
      const nextUnscheduledSections = workspace.unscheduledSections;
      // 请求开始后若已有更新批次完成或开始，这一批就是旧响应，不能覆盖较新的画面。
      if (requestNumber !== visibleWorkspaceRefreshNumber.current) return { loaded: false, reopenedLesson: null, unscheduledSections: [] };
      // Return 后若另一位老师立刻把同一个 weekly occurrence 重新排入总表，新记录会有
      // 新 lesson ID。优先找旧 ID，找不到时再按 section + occurrence 识别同一逻辑课次，
      // 不能误报它已经离开当前年级。
      const reopenedLesson = lessonToReopen
        ? nextLessons.find((lesson) => lesson.id === lessonToReopen.id)
          ?? nextLessons.find((lesson) => lesson.sectionId === lessonToReopen.sectionId && lesson.occurrence === lessonToReopen.occurrence)
          ?? null
        : null;
      setTimetableYear(year);
      setLessons(nextLessons);
      setUnscheduledSections(nextUnscheduledSections);
      setScheduleIssues(workspace.issues);
      setTeachers(workspace.teachers);
      setRooms(workspace.rooms);
      setActiveView("Year timetables");
      setShowForm(false);
      // 普通换年级会关闭旧编辑器；并发冲突则传入课程 ID，在同一批最新资料中
      // 重新找到它并打开，老师不用再到总表里寻找刚才那张卡。
      setEditingLesson(reopenedLesson);
      editingLessonRef.current = reopenedLesson;
      setLessonDraftIsStale(false);
      setPlacingSection(null);
      clearCandidateSlotWorkspace();
      return { loaded: true, reopenedLesson, unscheduledSections: nextUnscheduledSections };
    } catch {
      // 断网或服务器重启时 fetch 会直接抛错；保持当前画面并允许老师稍后重试。
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return { loaded: false, reopenedLesson: null, unscheduledSections: [] };
      if (requestNumber === visibleWorkspaceRefreshNumber.current) {
        setNotice("The year timetable could not be loaded. Check the connection and try again.", "error");
      }
      return { loaded: false, reopenedLesson: null, unscheduledSections: [] };
    } finally {
      // 旧显式请求结束时不能清除后来请求的保护号码；只有仍是当前请求才释放。
      if (activeManualTimetableRefreshNumber.current === requestNumber) {
        activeManualTimetableRefreshNumber.current = null;
      }
    }
  }

  function openLessonEditor(lesson: ScheduledLesson) {
    // 所有课程卡统一从这里打开 Inspector，确保上一门课的“远端已改变”标记
    // 不会错误带到新课程，也让 ref 在下一次轮询前就拥有最新对象。课程卡会在
    // 编辑期间被停用；若不先安排新焦点，浏览器会把焦点丢到 body，键盘老师
    // 既不知道 Inspector 已打开，也要重新 Tab 很久才能进入表单。
    const inspectorWasAlreadyOpen = showTimetableInspector;
    if (!inspectorWasAlreadyOpen) pendingInspectorFocusRef.current = "lesson-day";
    editingLessonRef.current = lesson;
    setLessonDraftIsStale(false);
    setEditingLesson(lesson);
    setShowTimetableInspector(true);
    if (inspectorWasAlreadyOpen) {
      window.requestAnimationFrame(() => lessonEditorDaySelectRef.current?.focus());
    }
  }

  function closeLessonEditor() {
    // Inspector 保持打开，但这门课的未保存输入被老师明确关闭；同步清理 ref，
    // 避免同一事件循环内的导航守卫仍把已经关闭的草稿当成有效编辑器。原 Close
    // 按钮会随表单卸载，所以完成后把焦点交给仍存在的 Inspector Close，不能掉到 body。
    editingLessonRef.current = null;
    setEditingLesson(null);
    setLessonDraftIsStale(false);
    window.requestAnimationFrame(() => inspectorCloseButtonRef.current?.focus());
  }

  function closePlacementEditor() {
    // 手工排课表单的 Close 也会卸载自身；统一回到 Inspector Close，让键盘用户知道仍在右侧面板内。
    setPlacingSection(null);
    window.requestAnimationFrame(() => inspectorCloseButtonRef.current?.focus());
  }

  function closeCandidateResults() {
    // 候选结果关闭时一并清除旧选项，并恢复到稳定存在的 Inspector Close，避免焦点落到页面背景。
    clearCandidateSlotWorkspace();
    window.requestAnimationFrame(() => inspectorCloseButtonRef.current?.focus());
  }

  function restoreCourseConfigureFocus(courseId: string, latestCourseListLoaded: boolean) {
    // React 需要先卸载课程设置表单并重新绘制表格；下一帧再按课程 ID 找按钮，
    // 即使课程排序发生变化，也不会依赖容易出错的行号。刷新失败时旧列表仍带着
    // 旧 revision，不能把焦点送回可立即重开的 Configure；这时回到课程搜索框。
    window.requestAnimationFrame(() => {
      const configureButton = courseConfigureButtonRefs.current.get(courseId);
      if (latestCourseListLoaded && configureButton?.isConnected) configureButton.focus();
      else courseSearchInputRef.current?.focus();
    });
  }

  async function reloadChangedLesson(lessonSnapshot: ScheduledLesson, conflictMessage: string, reopenLesson: boolean, sessionRequestGeneration: number) {
    // PATCH、拖动和 Return to tray 共用同一刷新流程。只有聚合 workspace 的五份年级
    // 资料全部读取成功才说“最新版本已载入”；网络失败时不能给出错误保证。
    const timetableResult = await openTimetable(timetableYear, undefined, reopenLesson ? lessonSnapshot : undefined);
    if (!sessionRequestIsCurrent(sessionRequestGeneration)) return false;
    if (!timetableResult.loaded) {
      window.requestAnimationFrame(() => inspectorCloseButtonRef.current?.focus());
      setNotice(`${conflictMessage} The latest timetable could not be reloaded. Refresh the page before continuing.`, "error");
      return false;
    }

    if (reopenLesson && !timetableResult.reopenedLesson) {
      // 只有同一个 section + occurrence 确实出现在当前年级待排清单时，才能断言
      // 另一位老师执行了 Return to tray。课程改到另一年级或 Cycle 被替换时，同年
      // lessons 也找不到 ID，但绝不能误导老师说它已经进入这张年级的待排区。
      const returnedToCurrentTray = timetableResult.unscheduledSections.some((section) => (
        section.sectionId === lessonSnapshot.sectionId && section.occurrence === lessonSnapshot.occurrence
      ));
      setShowTimetableInspector(false);
      if (returnedToCurrentTray) {
        setShowUnscheduledDrawer(true);
        window.requestAnimationFrame(() => unscheduledCloseButtonRef.current?.focus());
        setNotice(`${conflictMessage} This lesson was returned to the unscheduled tray; the latest timetable and tray have been loaded.`, "warning");
      } else {
        window.requestAnimationFrame(() => inspectorToggleButtonRef.current?.focus());
        setNotice(`${conflictMessage} This lesson is no longer in Year ${timetableYear}; it may have moved to another year or the scheduling cycle may have changed. The current year has been reloaded.`, "warning");
      }
      return true;
    }

    if (reopenLesson && timetableResult.reopenedLesson) {
      // 这一分支也可能来自总表直接拖动，而不是原本已打开的 Inspector；明确打开
      // 右侧面板并收起待排区，保证“latest lesson is open”与老师实际看到的一致。
      // 若面板原本关闭，让统一打开 Effect 聚焦 Day；若本来已打开，则下方 rAF
      // 直接移动焦点。两条路径互斥，不能再由 Close 的 rAF 把 Day 焦点抢走。
      const inspectorWasAlreadyOpen = showTimetableInspector;
      if (!inspectorWasAlreadyOpen) pendingInspectorFocusRef.current = "lesson-day";
      setShowUnscheduledDrawer(false);
      setShowTimetableInspector(true);
      if (inspectorWasAlreadyOpen) {
        window.requestAnimationFrame(() => lessonEditorDaySelectRef.current?.focus());
      }
    }

    if (!reopenLesson) window.requestAnimationFrame(() => inspectorCloseButtonRef.current?.focus());
    setNotice(`${conflictMessage} The latest timetable has been reloaded${reopenLesson ? " and the latest lesson is open for review" : ""}.`, "warning");
    return true;
  }

  async function openScheduleIssue(issue: ScheduleIssue) {
    // 从问题清单打开课程前重新读取该年级的一致工作区，确保编辑器使用最新 revision，
    // 并且总表与待排区来自同一 SQLite 快照，不会覆盖另一位老师刚保存的修改。
    if (lessonMutationIdRef.current || placingSessionKeyRef.current || managementMutationKeyRef.current) {
      setNotice(managementMutationKeyRef.current
        ? "A data change is still being saved. Wait for it to finish before opening another issue."
        : "A timetable update is still in progress. Wait for it to finish before opening another issue.", "warning");
      return;
    }
    // 复用主动刷新流程，让它提高 generation 并暂时挡住后台轮询。否则 Rules 页上一批
    // 已经在途的五秒请求可能晚于本次点击返回，再把旧问题资料写回新打开的年级页面。
    const requestNumber = visibleWorkspaceRefreshNumber.current + 1;
    const sessionRequestGeneration = authenticatedSessionGeneration.current;
    const timetableResult = await openTimetable(issue.primaryYear, undefined, {
      id: issue.lessonId,
      sectionId: issue.sectionId,
      occurrence: issue.occurrence,
    });
    if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
    // openTimetable 会同步领取上面的号码；等待期间若导航或写入又提高 generation，
    // 这次旧点击不得再写提示、打开 Inspector 或覆盖后来操作的焦点。
    if (requestNumber !== visibleWorkspaceRefreshNumber.current || managementMutationKeyRef.current) return;
    if (!timetableResult.loaded) return setNotice("The lesson linked to this issue could not be loaded.", "error");

    const linkedLesson = timetableResult.reopenedLesson;
    // 问题页显示后，其他账号可能已把课程退回待排区。openTimetable 已切换到该年级
    // 的最新工作区；若找不到课程，只说明旧问题已失效，不再假装仍停留在问题页。
    if (!linkedLesson) return setNotice("This lesson is no longer scheduled. The latest year workspace has been loaded.", "warning");

    // openTimetable 已原子应用五份最新资料；这里只负责把找到的课程交给标准编辑器。
    openLessonEditor(linkedLesson);
    setPlacingSection(null);
    clearCandidateSlotWorkspace();
    // 从问题清单进入编辑时，先收起左侧待排抽屉，给右侧 Inspector 和五天总表留下足够空间。
    setShowUnscheduledDrawer(false);
    setActiveView("Year timetables");
    setShowForm(false);
    setNotice(`${issue.sectionLabel} opened from the issue list.`, "info");

    // 问题记录可能位于长页面底部；等待 React 完成页面切换后，再把新编辑器滚动到可见位置。
    requestAnimationFrame(() => document.getElementById("lesson-editor")?.scrollIntoView({ behavior: preferredScrollBehavior(), block: "start" }));
  }

  const fetchRulesWorkspace = useCallback(async (sessionRequestGeneration?: number): Promise<RulesWorkspace> => {
    // 服务端在一个 SQLite DEFERRED 快照内读取窗口、问题、规则开关和教师。浏览器只
    // 发一个 GET，避免写入刚好夹在多个旧接口之间，拼出数据库从未同时存在的 Rules 页面。
    const response = await fetch("/api/rules/workspace", { cache: "no-store" });
    if (sessionRequestGeneration !== undefined && sessionRequestGeneration !== authenticatedSessionGeneration.current) throw new ProtectedSessionExpiredError();
    if (!response.ok) throw new RulesWorkspaceRequestError(response.status);
    const payload: unknown = await response.json();
    if (sessionRequestGeneration !== undefined && sessionRequestGeneration !== authenticatedSessionGeneration.current) throw new ProtectedSessionExpiredError();
    if (typeof payload !== "object" || payload === null) throw new Error("The rules workspace response was invalid.");
    const candidate = payload as Record<string, unknown>;
    if (!Array.isArray(candidate.unavailableWindows)
      || !Array.isArray(candidate.issues)
      || !Array.isArray(candidate.ruleSettings)
      || !Array.isArray(candidate.teachers)) {
      throw new Error("The rules workspace response was incomplete.");
    }
    return {
      unavailableWindows: candidate.unavailableWindows as UnavailableWindow[],
      issues: candidate.issues as ScheduleIssue[],
      ruleSettings: candidate.ruleSettings as RuleSetting[],
      teachers: candidate.teachers as Teacher[],
    };
  }, []);

  function applyRulesWorkspace(workspace: RulesWorkspace) {
    // React 会把同一异步 continuation 内的 state 写入合并为一次提交。四份数组只能从
    // 同一聚合响应一起应用；任何调用者都不得先写窗口再等待问题或教师，避免用户看到
    // 不可能版本，并让下一次表单提交始终引用与规则开关相同快照里的教师 ID。
    setUnavailableWindows(workspace.unavailableWindows);
    setScheduleIssues(workspace.issues);
    setRuleSettings(workspace.ruleSettings);
    setTeachers(workspace.teachers);
    setWorkspaceLoadErrorDetail(null);
    setLastSyncedAt(new Date());
  }

  async function refreshRulesWorkspace(mutationKey: string, sessionRequestGeneration: number): Promise<RulesWorkspace | null> {
    // beginManagementMutation 已使写入前的轮询失效；写入得到明确结果后再领取一个更高
    // generation。除了号码仍最新，还必须确认原 mutation key 仍持锁，防止迟到的旧写入
    // 刷新在登出、冻结或未来另一笔操作之后应用 state 并给出虚假的成功提示。
    const requestNumber = ++visibleWorkspaceRefreshNumber.current;
    activeManualTimetableRefreshNumber.current = requestNumber;
    try {
      const workspace = await fetchRulesWorkspace(sessionRequestGeneration);
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return null;
      if (requestNumber !== visibleWorkspaceRefreshNumber.current
        || managementMutationKeyRef.current !== mutationKey) return null;
      applyRulesWorkspace(workspace);
      return workspace;
    } finally {
      if (activeManualTimetableRefreshNumber.current === requestNumber) {
        activeManualTimetableRefreshNumber.current = null;
      }
    }
  }

  async function reloadRulesWorkspaceAfterConflict(mutationKey: string, message: string, failureMessage: string, sessionRequestGeneration: number) {
    // 409 表示服务端已经明确拒绝本次旧基线写入，结果并非未知；仍须在持锁期间取得
    // 一个完整新快照，才能再次开放按钮。若新快照也读不到，旧窗口／规则状态已知过期，
    // 必须冻结整页，不能只显示 toast 后让老师继续从旧值发出第二笔 CAS。
    try {
      const workspace = await refreshRulesWorkspace(mutationKey, sessionRequestGeneration);
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return false;
      if (!workspace) throw new Error("The conflict refresh was superseded.");
      setNotice(message, "warning");
      return true;
    } catch (error) {
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return false;
      if (error instanceof RulesWorkspaceRequestError && error.status === 401) {
        handleRulesMutationUnauthorized(sessionRequestGeneration);
        return false;
      }
      freezeManagementWorkspace(failureMessage, "error");
      return false;
    }
  }

  function handleRulesMutationUnauthorized(sessionRequestGeneration: number) {
    // 401 明确表示本次写入未通过会话保护；先清掉上一账号的全部业务资料，再切回登录页。
    // finally 稍后只负责释放当前 mutation key，不能让过期会话继续停留在可编辑 Rules 画面。
    if (sessionRequestIsCurrent(sessionRequestGeneration)) {
      expireSessionAndReturnToLogin("Your session expired. Please sign in again before changing rules.");
    }
  }

  async function openRules() {
    // 同时读取不可用时段、最新问题和可开关规则；只有完整读取成功才进入本页。
    if (lessonMutationIdRef.current || placingSessionKeyRef.current || managementMutationKeyRef.current) {
      setNotice(managementMutationKeyRef.current
        ? "A save is still in progress. Wait for it to finish before opening the rules workspace."
        : "A timetable update is still in progress. Wait for it to finish before leaving the Inspector.", "warning");
      return false;
    }
    const requestNumber = ++visibleWorkspaceRefreshNumber.current;
    activeManualTimetableRefreshNumber.current = requestNumber;
    const sessionRequestGeneration = authenticatedSessionGeneration.current;
    try {
      const workspace = await fetchRulesWorkspace(sessionRequestGeneration);
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return false;
      if (requestNumber !== visibleWorkspaceRefreshNumber.current || managementMutationKeyRef.current) return false;
      applyRulesWorkspace(workspace);
      setActiveView("Rules & issues");
      setShowForm(false);
      return true;
    } catch (error) {
      // 断网时保留老师当前页面和资料，不留下未处理的 Promise，也不误显示空白规则页。
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return false;
      if (requestNumber === visibleWorkspaceRefreshNumber.current) {
        if (error instanceof RulesWorkspaceRequestError && error.status === 401) {
          expireSessionAndReturnToLogin("Your session expired. Please sign in again.");
          return false;
        }
        setNotice("Rules and timetable issues could not be loaded. Check the connection and try again.", "error");
      }
      return false;
    } finally {
      if (activeManualTimetableRefreshNumber.current === requestNumber) {
        activeManualTimetableRefreshNumber.current = null;
      }
    }
  }

  async function openCycle() {
    // 新周期工具每年只使用两次，而且包含清空资料的高风险操作，因此只在进入专用页面时加载，不能与日常排课共用快捷入口。
    if (lessonMutationIdRef.current || placingSessionKeyRef.current || managementMutationKeyRef.current) {
      setNotice("A change is still in progress. Wait for it to finish before opening cycle recovery.", "warning");
      return false;
    }
    const requestNumber = ++visibleWorkspaceRefreshNumber.current;
    activeManualTimetableRefreshNumber.current = requestNumber;
    const sessionRequestGeneration = authenticatedSessionGeneration.current;
    try {
      const response = await fetch("/api/cycle");
      if (protectedResponseEndedSession(response, "Your session expired. Sign in again before opening cycle recovery.", sessionRequestGeneration)) return false;
      if (!response.ok) {
        if (requestNumber === visibleWorkspaceRefreshNumber.current) {
          setNotice("Cycle status could not be loaded. Check the connection and try again.", "error");
        }
        return false;
      }
      const nextCycle = await response.json() as CycleStatus;
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return false;
      if (requestNumber !== visibleWorkspaceRefreshNumber.current || managementMutationKeyRef.current) return false;
      setCurrentCycle(nextCycle);
      setActiveView("Cycle");
      setShowForm(false);
      return true;
    } catch {
      // 新周期属于高风险页面；读取失败时继续停留原页面，绝不能显示过期或不完整的清空状态。
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return false;
      if (requestNumber === visibleWorkspaceRefreshNumber.current) {
        setNotice("Cycle status could not be loaded. Check the connection and try again.", "error");
      }
      return false;
    } finally {
      if (activeManualTimetableRefreshNumber.current === requestNumber) {
        activeManualTimetableRefreshNumber.current = null;
      }
    }
  }

  async function loadPersonalTimetable(kind: "Teacher" | "StudentGroup" | "Room", requestedOwnerId?: string) {
    // 首次打开或切换个人课表类型时选择一个仍有效的默认对象；后续下拉变化始终明确保存教师、班级或教室编号。
    const availableOwners = kind === "Teacher"
      // 个人课表属于历史排课查询，因此停用教师仍必须可见；首次打开时则优先选择 Active 教师。
      ? [...teachers].sort((left, right) => Number(right.status === "Active") - Number(left.status === "Active"))
      : kind === "Room"
        // 教室停用也只阻止未来分配，不会删除历史 lesson。与教师采用相同顺序，
        // 让老师仍能查询停用教室的既有占用，而默认优先选择 Active 教室。
        ? [...rooms].sort((left, right) => Number(right.status === "Active") - Number(left.status === "Active"))
        : groups;
    const ownerId = requestedOwnerId || availableOwners[0]?.id || "";
    if (!ownerId) {
      const missingOwner = kind === "Teacher" ? "teacher" : kind === "Room" ? "room" : "student group";
      setNotice(`Add at least one ${missingOwner} before opening a personal timetable.`, "warning");
      return;
    }
    if (lessonMutationIdRef.current || placingSessionKeyRef.current || managementMutationKeyRef.current) {
      setNotice("A change is still in progress. Wait for it to finish before opening a personal timetable.", "warning");
      return;
    }
    const requestNumber = ++visibleWorkspaceRefreshNumber.current;
    activeManualTimetableRefreshNumber.current = requestNumber;
    const sessionRequestGeneration = authenticatedSessionGeneration.current;
    try {
      const response = await fetch(`/api/schedule/personal?kind=${kind}&ownerId=${encodeURIComponent(ownerId)}`);
      if (protectedResponseEndedSession(response, "Your session expired. Sign in again before opening a personal timetable.", sessionRequestGeneration)) return;
      if (!response.ok) {
        if (requestNumber === visibleWorkspaceRefreshNumber.current) {
          setNotice("The personal timetable could not be loaded. Check the connection and try again.", "error");
        }
        return;
      }
      const nextPersonalLessons = requireArrayPayload<ScheduledLesson>(
        await response.json(),
        "The personal timetable response was invalid.",
      );
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
      if (requestNumber !== visibleWorkspaceRefreshNumber.current || managementMutationKeyRef.current) return;
      // 只有新课表完整到达后才更新选择器和页面，失败时保留老师仍可阅读的上一版画面。
      setPersonalKind(kind);
      setPersonalOwnerId(ownerId);
      setPersonalLessons(nextPersonalLessons);
      setActiveView("Personal timetables");
      setShowForm(false);
    } catch {
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
      if (requestNumber === visibleWorkspaceRefreshNumber.current) {
        setNotice("The personal timetable could not be loaded. Check the connection and try again.", "error");
      }
    } finally {
      if (activeManualTimetableRefreshNumber.current === requestNumber) {
        activeManualTimetableRefreshNumber.current = null;
      }
    }
  }

  async function requestLessonPlacement(input: { sectionId: string; occurrence: number; dayOfWeek: number; startHour: number; roomId: string | null }) {
    // 拖放、Inspector 表单和 Clear slots 都通过这里建立新课次，保证它们使用相同的防重复、409 刷新和断网处理。
    const sessionKey = JSON.stringify([input.sectionId, input.occurrence]);
    if (placingSessionKeyRef.current) {
      setNotice("Another session placement is still in progress. Wait for it to finish before placing the next session.", "warning");
      return null;
    }

    placingSessionKeyRef.current = sessionKey;
    setPlacingSessionKey(sessionKey);
    // 连接长时间没有响应时主动释放全局锁；30 秒足够本地 SQLite 完成正常保存和随后刷新，
    // 同时避免断网后整个排课界面一直保持禁用，只能靠重新载入页面恢复。
    const requestController = new AbortController();
    let placementTimedOut = false;
    const requestTimeout = window.setTimeout(() => {
      placementTimedOut = true;
      requestController.abort();
    }, 30_000);
    const sessionRequestGeneration = authenticatedSessionGeneration.current;
    try {
      const response = await fetch("/api/schedule/lessons", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        signal: requestController.signal,
      });
      if (protectedResponseEndedSession(response, "Your session expired. Sign in again before placing a lesson.", sessionRequestGeneration)) return null;
      const body = await response.json() as ScheduledLesson & { changed?: boolean; code?: string; error?: string };
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return null;

      if (response.status === 409 && body.code === "LESSON_ALREADY_SCHEDULED") {
        // 另一账号已先完成同一课次时，必须重新读取总表和待排清单；
        // 否则旧卡片仍留在待排区，老师很容易继续重复操作或误判保存位置。
        const timetableResult = await openTimetable(timetableYear, requestController.signal);
        if (!sessionRequestIsCurrent(sessionRequestGeneration)) return null;
        window.requestAnimationFrame(() => inspectorCloseButtonRef.current?.focus());
        const conflictMessage = body.error ?? "This weekly session has already been placed by another scheduler.";
        if (!timetableResult.loaded) {
          freezeManagementWorkspace(`${conflictMessage} The latest timetable could not be reloaded, so the previous workspace is no longer safe to edit. Refresh before continuing.`);
          return null;
        }
        setNotice(`${conflictMessage} The latest timetable has been reloaded; review its saved position before continuing.`, "warning");
        return null;
      }
      if (!response.ok) {
        setNotice(body.error ?? "The section could not be placed.", "error");
        return null;
      }
      // 成功后的完整刷新仍属于同一次保存：锁必须保持到旧待排卡消失，
      // 否则慢速网络下老师可能再次拖动仍显示在页面上的同一课次。
      const timetableResult = await openTimetable(timetableYear, requestController.signal);
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return null;
      window.requestAnimationFrame(() => inspectorCloseButtonRef.current?.focus());
      if (!timetableResult.loaded) {
        freezeManagementWorkspace(`${body.sectionLabel} was saved, but the latest timetable could not be loaded. Refresh before making another change.`);
        return null;
      }
      return { lesson: body, timetableReloaded: true };
    } catch {
      // 网络异常时服务器是否收到请求并不确定，不能鼓励老师立刻重复点击；
      // 明确要求先刷新，借由唯一键确认该课次究竟是否已经保存。
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return null;
      freezeManagementWorkspace(placementTimedOut
        ? "The placement request timed out and its result is unknown. Refresh before trying this session again."
        : "The placement result could not be confirmed. Refresh before trying this session again.", "error");
      return null;
    } finally {
      window.clearTimeout(requestTimeout);
      if (sessionRequestIsCurrent(sessionRequestGeneration) && placingSessionKeyRef.current === sessionKey) {
        placingSessionKeyRef.current = null;
        setPlacingSessionKey(null);
      }
    }
  }

  async function placeSection(event: DragEvent<HTMLDivElement>, dayOfWeek: number, startHour: number) {
    // 拖动资料只负责标识班次或已排课程；服务端会重新读取课时、教师和班级，浏览器端即使被修改也不能绕过排课规则。
    event.preventDefault();
    const lessonId = event.dataTransfer.getData("application/x-scheduled-lesson");
    if (lessonId) {
      // 拖动开始时保存老师真正看到的 revision；即使五秒轮询在拖动过程中收到
      // 另一账号的新位置，drop 仍提交旧 revision 并得到409，绝不能借用新版 revision
      // 把对方刚保存的位置覆盖掉。
      const draggedSnapshot = draggingScheduledLessonRef.current;
      const lesson = draggedSnapshot?.id === lessonId ? draggedSnapshot : lessons.find((item) => item.id === lessonId);
      if (!lesson) return;
      if (lessonMutationIdRef.current) {
        setNotice("Another lesson update is still in progress. Wait for it to finish before moving this lesson.", "warning");
        return;
      }
      lessonMutationIdRef.current = lesson.id;
      setLessonMutation({ id: lesson.id, action: "move" });
      const sessionRequestGeneration = authenticatedSessionGeneration.current;
      try {
        // 移动课程只改变星期和时间，但 PATCH 接口会整体保存班次资料；因此必须把拖动开始时
        // 的教师、教室和学生班级原样带回，避免移动误清关联或绕过并发 revision。
        const response = await fetch(`/api/schedule/lessons/${encodeURIComponent(lessonId)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            dayOfWeek,
            startHour,
            roomId: lesson.roomId,
            teacherId: lesson.teacherId,
            studentGroupIds: lesson.studentGroupIds,
            revision: lesson.revision,
          }),
        });
        if (protectedResponseEndedSession(response, "Your session expired. Sign in again before moving a lesson.", sessionRequestGeneration)) return;
        const body = await response.json() as ScheduledLesson & { code?: string; error?: string };
        if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
        if (response.status === 409 && body.code === "SCHEDULED_LESSON_CHANGED") {
          await reloadChangedLesson(lesson, body.error ?? "This lesson was changed by another scheduler.", false, sessionRequestGeneration);
          return;
        }
        if (response.status === 404) {
          // 课程已经被另一位老师退回待排区时，按“尝试重开”流程刷新；找不到
          // lesson 后统一流程会打开最新待排清单并给出准确去向，而不是留下空 Inspector。
          await reloadChangedLesson(lesson, body.error ?? "This lesson is no longer scheduled.", true, sessionRequestGeneration);
          return;
        }
        if (!response.ok) {
          setNotice(body.error ?? "The lesson could not be moved.", "error");
          return;
        }
        setEditingLesson(null);
        const timetableResult = await openTimetable(timetableYear);
        if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
        if (!timetableResult.loaded) {
          freezeManagementWorkspace(`${body.sectionLabel} was moved, but the latest timetable could not be loaded. Refresh before continuing.`);
          return;
        }
        revealSavedLesson(body.id);
        setNotice(
          body.warnings.length ? `${body.sectionLabel} moved with warnings: ${body.warnings.join(", ")}.` : `${body.sectionLabel} moved successfully.`,
          body.warnings.length ? "warning" : "success",
        );
      } catch {
        if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
        freezeManagementWorkspace("The move result could not be confirmed. Refresh before moving this lesson again.", "error");
      } finally {
        if (sessionRequestIsCurrent(sessionRequestGeneration) && lessonMutationIdRef.current === lesson.id) {
          lessonMutationIdRef.current = null;
          setLessonMutation(null);
        }
      }
      return;
    }
    const sectionId = event.dataTransfer.getData("text/plain");
    const occurrence = Number(event.dataTransfer.getData("application/x-unscheduled-occurrence"));
    if (!sectionId || ![1, 2].includes(occurrence)) return;
    const sessionRequestGeneration = authenticatedSessionGeneration.current;
    const placement = await requestLessonPlacement({ sectionId, occurrence, dayOfWeek, startHour, roomId: null });
    if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
    if (!placement) return;
    const body = placement.lesson;
    revealSavedLesson(body.id);
    setNotice(
      body.warnings.length ? `${body.sectionLabel} saved with warnings: ${body.warnings.join(", ")}.` : `${body.sectionLabel} placed successfully. Assign its room next.`,
      body.warnings.length ? "warning" : "success",
    );
  }

  async function findCandidateSlots(section: UnscheduledSection) {
    // 每次开始、切换或关闭都会提高 generation；响应必须同时匹配号码和显式
    // sectionId + occurrence，旧班次的慢响应才不会覆盖当前候选面板。
    const requestNumber = ++candidateSlotRequestNumber.current;
    const { sectionId, occurrence } = section;
    candidateSectionIdentityRef.current = { requestNumber, sectionId, occurrence };
    setCandidateSection(section);
    setPlacingSection(null);
    setEditingLesson(null);
    setCandidateSlots([]);
    setCandidatesLoading(true);
    const sessionRequestGeneration = authenticatedSessionGeneration.current;
    try {
      const response = await fetch(`/api/course-sections/${encodeURIComponent(sectionId)}/candidates?occurrence=${occurrence}`);
      if (protectedResponseEndedSession(response, "Your session expired. Sign in again before checking candidate slots.", sessionRequestGeneration)) return;
      const body = await response.json() as { error?: string; slots?: CandidateSlot[] };
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
      if (!candidateSlotRequestIsCurrent(requestNumber, sectionId, occurrence)) return;
      if (!response.ok) {
        // 教师缺失或停用等资料问题不应伪装成“没有空位”；返回原排课表单后，老师仍可手工放课并接受警告。
        clearCandidateSlotWorkspace();
        setPlacingSection(section);
        return setNotice(body.error ?? "Candidate slots could not be calculated.", "error");
      }
      if (!Array.isArray(body.slots)) throw new Error("Candidate slot response was incomplete.");
      setCandidateSlots(body.slots);
      setNotice(
        body.slots.length ? `${body.slots.length} completely clear room and time options found for ${section.label}.` : `No completely clear options found for ${section.label}. Check its assignments and restrictions.`,
        body.slots.length ? "success" : "warning",
      );
    } catch {
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
      if (!candidateSlotRequestIsCurrent(requestNumber, sectionId, occurrence)) return;
      // 网络中断也要恢复面板和 loading 状态，不能把 Inspector 永久留在 Checking 状态。
      clearCandidateSlotWorkspace();
      setPlacingSection(section);
      setNotice("Candidate slots could not be calculated. Check the connection and try again.", "error");
    } finally {
      if (candidateSlotRequestIsCurrent(requestNumber, sectionId, occurrence)) setCandidatesLoading(false);
    }
  }

  async function placeCandidate(slot: CandidateSlot) {
    // 候选项已经包含校验过的教室，老师可一次点击完成排课；正式保存时接口仍会再次运行警告引擎，防止候选生成后资料发生变化。
    if (!candidateSection) return;
    const { sectionId, occurrence } = candidateSection;
    const currentIdentity = candidateSectionIdentityRef.current;
    if (currentIdentity?.sectionId !== sectionId || currentIdentity.occurrence !== occurrence || candidatesLoading) return;
    const sessionRequestGeneration = authenticatedSessionGeneration.current;
    const placement = await requestLessonPlacement({ sectionId, occurrence, dayOfWeek: slot.dayOfWeek, startHour: slot.startHour, roomId: slot.roomId });
    if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
    if (!placement) return;
    const body = placement.lesson;
    revealSavedLesson(body.id);
    setNotice(
      body.warnings.length ? `${body.sectionLabel} changed while placing and now has warnings: ${body.warnings.join(", ")}.` : `${body.sectionLabel} placed in ${slot.roomCode} with no warnings.`,
      body.warnings.length ? "warning" : "success",
    );
  }

  async function placeSectionWithoutDrag(event: FormEvent<HTMLFormElement>) {
    // 不方便拖动的老师可以在 Inspector 使用键盘或鼠标选择星期、时间和教室；提交接口与拖放完全相同，因此冲突提示也一致。
    event.preventDefault();
    if (!placingSection) return;
    const data = new FormData(event.currentTarget);
    const sessionRequestGeneration = authenticatedSessionGeneration.current;
    const placement = await requestLessonPlacement({
      sectionId: placingSection.sectionId,
      occurrence: placingSection.occurrence,
      dayOfWeek: Number(data.get("dayOfWeek")),
      startHour: Number(data.get("startHour")),
      roomId: String(data.get("roomId") ?? "") || null,
    });
    if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
    if (!placement) return;
    const body = placement.lesson;
    revealSavedLesson(body.id);
    setNotice(
      body.warnings.length ? `${body.sectionLabel} saved with warnings: ${body.warnings.join(", ")}.` : `${body.sectionLabel} placed successfully.`,
      body.warnings.length ? "warning" : "success",
    );
  }

  async function saveLesson(event: FormEvent<HTMLFormElement>) {
    // 编辑面板一次保存星期、开始时间、教师、教室和全部已勾选学生班级；成功后重新载入总表，使最新 warning 和 revision 立即显示。
    event.preventDefault();
    if (!editingLesson) return;
    if (lessonMutationIdRef.current) {
      setNotice("This lesson is already being updated. Wait for the current request to finish.", "warning");
      return;
    }
    // await 期间轮询或点击可能改变 React state，因此完整保存流程只使用提交瞬间的
    // 稳定对象。ref 同步加锁可挡住同一事件循环内的快速双击，state 负责按钮反馈。
    const lessonAtSubmit = editingLesson;
    lessonMutationIdRef.current = lessonAtSubmit.id;
    setLessonMutation({ id: lessonAtSubmit.id, action: "save" });
    const data = new FormData(event.currentTarget);
    // getAll 会保留每个复选框的值；没有勾选时传空数组，服务器就会把该班次明确设为“学生班级待分配”。
    const studentGroupIds = data.getAll("studentGroupIds").map(String);
    const sessionRequestGeneration = authenticatedSessionGeneration.current;
    try {
      const response = await fetch(`/api/schedule/lessons/${encodeURIComponent(lessonAtSubmit.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dayOfWeek: Number(data.get("dayOfWeek")),
          startHour: Number(data.get("startHour")),
          teacherId: String(data.get("teacherId") ?? "") || null,
          roomId: String(data.get("roomId") ?? "") || null,
          studentGroupIds,
          revision: lessonAtSubmit.revision,
        }),
      });
      if (protectedResponseEndedSession(response, "Your session expired. Sign in again before saving a lesson.", sessionRequestGeneration)) return;
      const body = await response.json() as ScheduledLesson & { changed?: boolean; code?: string; error?: string };
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
      if (response.status === 409 && body.code === "SCHEDULED_LESSON_CHANGED") {
        await reloadChangedLesson(lessonAtSubmit, body.error ?? "This lesson was changed by another scheduler.", true, sessionRequestGeneration);
        return;
      }
      if (response.status === 404) {
        // 404 通常表示另一位老师已经 Return to tray。传入 true 不是强行重开，
        // 而是让刷新流程确认课程确实缺失后展示最新待排区和正确焦点。
        await reloadChangedLesson(lessonAtSubmit, body.error ?? "This lesson is no longer scheduled.", true, sessionRequestGeneration);
        return;
      }
      if (!response.ok) {
        setNotice(body.error ?? "The lesson could not be updated.", "error");
        return;
      }

      // PATCH 已成功时先卸载旧 revision 表单；即使随后刷新失败，也不能留下一个
      // 看似可继续保存、实际必定409的编辑器让老师重复操作。
      editingLessonRef.current = null;
      setEditingLesson(null);
      setLessonDraftIsStale(false);
      const timetableResult = await openTimetable(timetableYear);
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
      window.requestAnimationFrame(() => inspectorCloseButtonRef.current?.focus());
      if (!timetableResult.loaded) {
        freezeManagementWorkspace(`${body.sectionLabel} was saved, but the latest timetable could not be loaded. Refresh before continuing.`);
        return;
      }
      revealSavedLesson(body.id);
      if (body.changed === false) {
        // API 已证明这次请求没有执行 UPDATE 或 warning 刷新。界面也应诚实说明
        // “资料本来就相同”，不能把 no-op 说成一次实际更新。
        setNotice(
          body.warnings.length
            ? `${body.sectionLabel} already matched these choices. Existing warnings: ${body.warnings.join(", ")}.`
            : `${body.sectionLabel} already matched these choices. No changes were needed.`,
          body.warnings.length ? "warning" : "info",
        );
      } else {
        setNotice(
          body.warnings.length ? `${body.sectionLabel} saved with warnings: ${body.warnings.join(", ")}.` : `${body.sectionLabel} updated successfully.`,
          body.warnings.length ? "warning" : "success",
        );
      }
    } catch {
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
      freezeManagementWorkspace("The lesson update result could not be confirmed. Refresh before trying again.", "error");
    } finally {
      if (sessionRequestIsCurrent(sessionRequestGeneration) && lessonMutationIdRef.current === lessonAtSubmit.id) {
        lessonMutationIdRef.current = null;
        setLessonMutation(null);
      }
    }
  }

  async function unscheduleLesson() {
    // 取消排课只删除具体时间安排并把班次退回待排区，不删除课程设置、教师分配或学生班级关联。
    if (!editingLesson) return;
    if (lessonMutationIdRef.current) {
      setNotice("This lesson is already being updated. Wait for the current request to finish.", "warning");
      return;
    }
    const lessonAtSubmit = editingLesson;
    lessonMutationIdRef.current = lessonAtSubmit.id;
    setLessonMutation({ id: lessonAtSubmit.id, action: "return" });
    const sessionRequestGeneration = authenticatedSessionGeneration.current;
    try {
      const response = await fetch(`/api/schedule/lessons/${encodeURIComponent(lessonAtSubmit.id)}?revision=${lessonAtSubmit.revision}`, { method: "DELETE" });
      if (protectedResponseEndedSession(response, "Your session expired. Sign in again before returning a lesson.", sessionRequestGeneration)) return;
      const body = await response.json() as { code?: string; error?: string; ok?: boolean };
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
      if (response.status === 409 && body.code === "SCHEDULED_LESSON_CHANGED") {
        await reloadChangedLesson(lessonAtSubmit, body.error ?? "This lesson was changed by another scheduler.", true, sessionRequestGeneration);
        return;
      }
      if (!response.ok) {
        setNotice(body.error ?? "The lesson could not be returned to the tray.", "error");
        return;
      }

      editingLessonRef.current = null;
      setEditingLesson(null);
      setLessonDraftIsStale(false);
      // DELETE 成功与聚合 workspace 请求之间，另一位老师仍可能立刻重新排入同一个
      // section + occurrence。服务端会在一个快照里读取总表与待排区；前端再按旧 ID／
      // 逻辑课次寻找替代记录，不能无条件宣称课程仍在待排区。
      const timetableResult = await openTimetable(timetableYear, undefined, lessonAtSubmit);
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
      if (!timetableResult.loaded) {
        window.requestAnimationFrame(() => inspectorCloseButtonRef.current?.focus());
        freezeManagementWorkspace(`${lessonAtSubmit.sectionLabel} was returned, but the latest timetable could not be loaded. Refresh before continuing.`);
        return;
      }

      if (timetableResult.reopenedLesson) {
        const inspectorWasAlreadyOpen = showTimetableInspector;
        if (!inspectorWasAlreadyOpen) pendingInspectorFocusRef.current = "lesson-day";
        setShowUnscheduledDrawer(false);
        setShowTimetableInspector(true);
        if (inspectorWasAlreadyOpen) {
          window.requestAnimationFrame(() => lessonEditorDaySelectRef.current?.focus());
        }
        setNotice(`${lessonAtSubmit.sectionLabel} was returned, but another scheduler immediately placed the same session again. The latest lesson is open for review.`, "warning");
        return;
      }

      const returnedToCurrentTray = timetableResult.unscheduledSections.some((section) => (
        section.sectionId === lessonAtSubmit.sectionId && section.occurrence === lessonAtSubmit.occurrence
      ));
      setShowTimetableInspector(false);
      if (returnedToCurrentTray) {
        setShowUnscheduledDrawer(true);
        window.requestAnimationFrame(() => unscheduledCloseButtonRef.current?.focus());
        setNotice(`${lessonAtSubmit.sectionLabel} returned to the unscheduled tray.`, "success");
      } else {
        window.requestAnimationFrame(() => inspectorToggleButtonRef.current?.focus());
        setNotice(`${lessonAtSubmit.sectionLabel} was returned, but it is no longer in Year ${timetableYear}; another scheduler may have changed its year or cycle. The current year has been reloaded.`, "warning");
      }
    } catch {
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
      freezeManagementWorkspace("The return-to-tray result could not be confirmed. Refresh before trying again.", "error");
    } finally {
      if (sessionRequestIsCurrent(sessionRequestGeneration) && lessonMutationIdRef.current === lessonAtSubmit.id) {
        lessonMutationIdRef.current = null;
        setLessonMutation(null);
      }
    }
  }

  async function saveUnavailableWindow(event: FormEvent<HTMLFormElement>, kind: "Teacher" | "Year") {
    // 教师和年级不可用时段共用同一个接口，但表单保留各自清楚的对象选择，减少重复代码又不牺牲可理解性。
    event.preventDefault();
    // 在等待服务器前保存真实表单元素；React 事件回调暂停后会把 event.currentTarget 清空，但这个独立引用仍可安全重置表单。
    const form = event.currentTarget;
    const data = new FormData(form);
    const mutationKey = `rule-window-add:${kind}`;
    if (!beginManagementMutation(mutationKey)) return;
    const sessionRequestGeneration = authenticatedSessionGeneration.current;
    let committed = false;
    try {
      const response = await fetch("/api/unavailability", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind, ownerId: String(data.get("ownerId") ?? ""), dayOfWeek: Number(data.get("dayOfWeek")), startHour: Number(data.get("startHour")), endHour: Number(data.get("endHour")) }) });
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
      if (!response.ok) {
        if (response.status === 401) {
          handleRulesMutationUnauthorized(sessionRequestGeneration);
          return;
        }
        const body = await response.json().catch(() => ({})) as { code?: string; error?: string };
        if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
        if (response.status === 409 && body.code === "UNAVAILABLE_WINDOW_EXISTS") {
          await reloadRulesWorkspaceAfterConflict(
            mutationKey,
            body.error
              ? `${body.error} The latest rules workspace has been loaded.`
              : "That unavailable time was already saved, possibly by another scheduler. The latest rules workspace has been loaded.",
            "That unavailable time already exists, but the latest rules workspace could not be loaded. Refresh before making another change.",
            sessionRequestGeneration,
          );
          return;
        }
        setNotice(body.error ?? "Unavailable time could not be saved.", "error");
        return;
      }
      committed = true;
      const workspace = await refreshRulesWorkspace(mutationKey, sessionRequestGeneration);
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
      if (!workspace) throw new Error("The saved rules refresh was superseded.");
      form.reset();
      setNotice(`${kind} unavailable time saved.`, "success");
    } catch (error) {
      // 写入响应成功后，会话仍可能恰好在 aggregate 重载前过期。401 是明确的认证
      // 状态，不应误报成资料未知；清空上一账号资料并回登录页，下一次登录会完整重载。
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
      if (error instanceof RulesWorkspaceRequestError && error.status === 401) {
        handleRulesMutationUnauthorized(sessionRequestGeneration);
        return;
      }
      freezeManagementWorkspace(committed
        ? `${kind} unavailable time was saved, but its latest result could not be loaded. Refresh before continuing.`
        : "The unavailable-time request was interrupted, so its result is unknown. Refresh the rules page before retrying.", "warning");
    } finally {
      finishManagementMutation(mutationKey, sessionRequestGeneration);
    }
  }

  async function removeUnavailableWindow(window: UnavailableWindow) {
    // 删除不可用时段会立即影响之后的排课检查；已有课程的 warning 会在重新打开或编辑时根据最新规则刷新。
    const mutationKey = `rule-window-remove:${window.id}`;
    if (!beginManagementMutation(mutationKey)) return;
    const sessionRequestGeneration = authenticatedSessionGeneration.current;
    let committed = false;
    try {
      // 数据库 ID 的公开契约允许不透明字符串；URLSearchParams 会安全编码 &、#、? 等
      // 字符，避免直接插值把一个 ID 拆成额外查询参数或截断真正的删除目标。
      const search = new URLSearchParams({ id: window.id, kind: window.kind });
      const response = await fetch(`/api/unavailability?${search.toString()}`, { method: "DELETE" });
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
      if (!response.ok) {
        if (response.status === 401) {
          handleRulesMutationUnauthorized(sessionRequestGeneration);
          return;
        }
        const body = await response.json().catch(() => ({})) as { error?: string };
        if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
        if (response.status === 404) {
          await reloadRulesWorkspaceAfterConflict(
            mutationKey,
            `${window.ownerLabel} unavailable time was already removed by another scheduler. The latest rules workspace has been loaded.`,
            `${window.ownerLabel} unavailable time was removed by another scheduler, but the latest rules workspace could not be loaded. Refresh before making another change.`,
            sessionRequestGeneration,
          );
          return;
        }
        setNotice(body.error ?? "Unavailable time could not be removed.", "error");
        return;
      }
      committed = true;
      const workspace = await refreshRulesWorkspace(mutationKey, sessionRequestGeneration);
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
      if (!workspace) throw new Error("The removed rules refresh was superseded.");
      setNotice(`${window.ownerLabel} unavailable time removed.`, "success");
    } catch (error) {
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
      if (error instanceof RulesWorkspaceRequestError && error.status === 401) {
        handleRulesMutationUnauthorized(sessionRequestGeneration);
        return;
      }
      freezeManagementWorkspace(committed
        ? "The unavailable time was removed, but the latest rules page could not be loaded. Refresh before continuing."
        : "The remove request was interrupted, so its result is unknown. Refresh the rules page before retrying.", "warning");
    } finally {
      finishManagementMutation(mutationKey, sessionRequestGeneration);
    }
  }

  async function toggleRuleSetting(rule: RuleSetting) {
    // 每次只保存一个规则开关，随后重新载入本页；服务端会用新政策重新计算全部问题，让开关影响立即可见。
    const mutationKey = `rule-setting:${rule.key}`;
    if (!beginManagementMutation(mutationKey)) return;
    const sessionRequestGeneration = authenticatedSessionGeneration.current;
    let committed = false;
    try {
      const response = await fetch("/api/rule-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        // expectedEnabled 是老师实际看到的基线。服务端在同一写事务里比较它，另一账号
        // 已先切换时返回 typed 409，而不是让迟到请求静默覆盖对方的新选择。
        body: JSON.stringify({ key: rule.key, expectedEnabled: rule.enabled, enabled: !rule.enabled }),
      });
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
      if (!response.ok) {
        if (response.status === 401) {
          handleRulesMutationUnauthorized(sessionRequestGeneration);
          return;
        }
        const body = await response.json().catch(() => ({})) as { code?: string; error?: string };
        if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
        if (response.status === 409 && body.code === "RULE_SETTING_CHANGED") {
          await reloadRulesWorkspaceAfterConflict(
            mutationKey,
            body.error
              ? `${body.error} The latest rules workspace has been loaded; review the current setting before trying again.`
              : `${rule.label} was changed by another scheduler. The latest rules workspace has been loaded; review it before trying again.`,
            `${rule.label} was changed by another scheduler, but the latest rules workspace could not be loaded. Refresh before making another change.`,
            sessionRequestGeneration,
          );
          return;
        }
        setNotice(body.error ?? "The rule setting could not be changed.", "error");
        return;
      }
      committed = true;
      const workspace = await refreshRulesWorkspace(mutationKey, sessionRequestGeneration);
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
      if (!workspace) throw new Error("The changed rules refresh was superseded.");
      setNotice(`${rule.label} ${rule.enabled ? "disabled" : "enabled"}.`, "success");
    } catch (error) {
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
      if (error instanceof RulesWorkspaceRequestError && error.status === 401) {
        handleRulesMutationUnauthorized(sessionRequestGeneration);
        return;
      }
      freezeManagementWorkspace(committed
        ? `${rule.label} was changed, but the latest rules page could not be loaded. Refresh before continuing.`
        : "The rule-setting request was interrupted, so its result is unknown. Refresh the rules page before retrying.", "warning");
    } finally {
      finishManagementMutation(mutationKey, sessionRequestGeneration);
    }
  }

  function toggleForm() {
    // 关闭表单时同时清除当前编辑对象，下一次新增不会误带上一条教师、班级、教室或课程资料。
    setShowForm((current) => !current);
    if (showForm) {
      setEditingTeacher(null);
      setEditingGroup(null);
      setEditingRoom(null);
      setEditingCourse(null);
    }
  }

  const fetchData = useCallback(async (sessionRequestGeneration: number) => {
    // 服务端在一个 SQLite DEFERRED 快照内读取四张清单。浏览器只发一个请求，
    // 因此 Teaching Members 导入不能夹在教师和课程响应之间制造“不可能版本”。
    try {
      const response = await fetch("/api/data-management/workspace", { cache: "no-store" });
      if (sessionRequestGeneration !== authenticatedSessionGeneration.current) throw new ProtectedSessionExpiredError();
      if (response.status === 401) {
        expireSessionAndReturnToLogin("Your session expired. Sign in again before loading master data.");
        throw new ProtectedSessionExpiredError();
      }
      if (!response.ok) throw new Error("Could not load the master-data workspace.");
      const workspace = await response.json() as DataManagementWorkspace;
      if (sessionRequestGeneration !== authenticatedSessionGeneration.current) throw new ProtectedSessionExpiredError();
      if (!Array.isArray(workspace.teachers) || !Array.isArray(workspace.groups)
        || !Array.isArray(workspace.rooms) || !Array.isArray(workspace.courses)) {
        throw new Error("The master-data workspace response was incomplete.");
      }
      return workspace;
    } catch (error) {
      if (sessionRequestGeneration !== authenticatedSessionGeneration.current) throw new ProtectedSessionExpiredError();
      throw error;
    }
  }, [expireSessionAndReturnToLogin]);

  const loadData = useCallback(async () => {
    // 每次显式资料刷新领取全局 generation；导航、登出或较新的读取都会提高它。
    // 慢响应即使最后成功，也只能返回 null，绝不能把旧清单或旧 revision 倒灌到新页面。
    const requestNumber = ++visibleWorkspaceRefreshNumber.current;
    activeManualTimetableRefreshNumber.current = requestNumber;
    const sessionRequestGeneration = authenticatedSessionGeneration.current;
    try {
      const workspace = await fetchData(sessionRequestGeneration);
      if (sessionRequestGeneration !== authenticatedSessionGeneration.current) throw new ProtectedSessionExpiredError();
      if (requestNumber !== visibleWorkspaceRefreshNumber.current) return null;
      setWorkspaceLoadErrorDetail(null);
      setTeachers(workspace.teachers);
      setGroups(workspace.groups);
      setRooms(workspace.rooms);
      setCourses(workspace.courses);
      // 四张清单的成功刷新可能来自 Course Setup、Teaching Members 导入或教师变更；
      // 这些操作都可能让已打开的 currentCourse、section revision、教师选项与 variance
      // 过期。统一卸载依赖编辑器，只有 changeSectionCount 会紧接着用本轮返回的最新版
      // course 显式 openSections 重开，其他路径要求老师重新审阅后再进入详情。
      setSelectedCourse(null);
      setSections([]);
      setAllocationVariances([]);
      sectionAssignmentFocusRefs.current.clear();
      // React state 要到下一次绘制才会更新；把本次原子响应直接返回给冲突处理者，
      // 让它立即使用服务器最新版对象，不从提交前的 render 再读旧 revision。
      return workspace;
    } finally {
      // 旧请求结束时不能释放后来请求的保护号码。
      if (activeManualTimetableRefreshNumber.current === requestNumber) {
        activeManualTimetableRefreshNumber.current = null;
      }
    }
  }, [fetchData]);

  const loadAuthenticatedWorkspaces = useCallback(async () => {
    // 登录成功后默认显示年级总表，因此“基础资料已载入”还不够。四张资料清单与
    // 当前年级五份工作区都完整到达后才允许把 authScreen 切成 ready；否则首次
    // Year 请求碰到短暂500或损坏 JSON 时，真实有资料的数据库会被伪装成一张
    // 可编辑的空总表。两批请求仍各自使用服务端一致快照，浏览器不会应用半份资料。
    const sessionRequestGeneration = authenticatedSessionGeneration.current;
    if (!await loadData()) return false;
    if (sessionRequestGeneration !== authenticatedSessionGeneration.current) throw new ProtectedSessionExpiredError();

    const requestNumber = ++visibleWorkspaceRefreshNumber.current;
    activeManualTimetableRefreshNumber.current = requestNumber;
    try {
      const response = await fetch("/api/schedule/workspace?year=1", { cache: "no-store" });
      if (sessionRequestGeneration !== authenticatedSessionGeneration.current) throw new ProtectedSessionExpiredError();
      if (response.status === 401) {
        expireSessionAndReturnToLogin("Your session expired. Sign in again before loading the timetable workspace.");
        throw new ProtectedSessionExpiredError();
      }
      if (!response.ok) throw new Error("The initial year workspace could not be loaded.");
      const workspace = parseYearTimetableWorkspace(await response.json());
      if (sessionRequestGeneration !== authenticatedSessionGeneration.current) throw new ProtectedSessionExpiredError();
      if (requestNumber !== visibleWorkspaceRefreshNumber.current) return false;

      setWorkspaceLoadErrorDetail(null);
      setTimetableYear(1);
      setLessons(workspace.lessons);
      setUnscheduledSections(workspace.unscheduledSections);
      setScheduleIssues(workspace.issues);
      // 年级工作区里的教师和教室与 lessons 来自同一 SQLite 快照；使用这一份
      // 作为默认排课页的下拉资料，避免课程卡与选择器跨提交版本。
      setTeachers(workspace.teachers);
      setRooms(workspace.rooms);
      setView("Year timetables");
      setShowForm(false);
      editingLessonRef.current = null;
      setEditingLesson(null);
      setLessonDraftIsStale(false);
      setPlacingSection(null);
      clearCandidateSlotWorkspace();
      return true;
    } catch (error) {
      if (sessionRequestGeneration !== authenticatedSessionGeneration.current) throw new ProtectedSessionExpiredError();
      throw error;
    } finally {
      if (activeManualTimetableRefreshNumber.current === requestNumber) {
        activeManualTimetableRefreshNumber.current = null;
      }
    }
  }, [clearCandidateSlotWorkspace, expireSessionAndReturnToLogin, loadData]);

  useEffect(() => {
    // 页面启动时先检查登录状态，再请求受保护的业务资料；未登录浏览器不会先下载教师或课程数据。
    void (async () => {
      try {
        const response = await fetch("/api/auth/status");
        // BUSY 503 和未知500都不能被当成“没有用户”而误显示登录表单。
        if (!response.ok) throw new Error("Authentication status is temporarily unavailable.");
        const status = await response.json() as { setupRequired: boolean; user: AppUser | null };
        if (status.setupRequired) {
          setWorkspaceLoadErrorDetail(null);
          setAuthScreen("setup");
          setNotice("Create the first administrator account to open the scheduling workspace.", "info");
          return;
        }
        if (!status.user) {
          setWorkspaceLoadErrorDetail(null);
          setAuthScreen("login");
          setNotice("Sign in with your scheduler account to load timetable data.", "info");
          return;
        }

        // 默认首页是 Year 1；基础资料和这一张总表必须同时准备完成后才开放编辑。
        if (!await loadAuthenticatedWorkspaces()) throw new Error("The initial authenticated workspace refresh was superseded.");
        setCurrentUser(status.user);
        setAuthScreen("ready");
        setNotice("Local data is saved and ready for scheduling setup.", "success");
      } catch (error) {
        if (error instanceof ProtectedSessionExpiredError) return;
        setCurrentUser(null);
        setAuthScreen("load-error");
        setNotice("The secure session or scheduling data could not be loaded. Refresh before making changes.", "error");
      } finally {
        setIsLoading(false);
      }
    })();
  }, [loadAuthenticatedWorkspaces]);

  const authenticatedUserId = currentUser?.id ?? null;

  useEffect(() => {
    // Year／Personal／Rules 会读取业务资料，但 Teachers、Courses、Accounts、Cycle 和
    // Profile 也必须及时发现管理员停用或完整恢复撤销了当前会话。独立状态轮询覆盖
    // 所有 ready 页面；临时500/断网只保留当前画面，只有明确 user=null 或身份改变
    // 才清空上一账号缓存并返回登录页。
    if (authScreen !== "ready" || !authenticatedUserId) return;
    let active = true;
    let requestInFlight = false;

    async function verifyCurrentSession() {
      if (requestInFlight) return;
      requestInFlight = true;
      try {
        const response = await fetch("/api/auth/status", { cache: "no-store" });
        if (!active || !response.ok) return;
        const payload = await response.json() as unknown;
        if (!active || typeof payload !== "object" || payload === null || !("user" in payload)) return;
        const nextUser = (payload as { user: unknown }).user;
        if (nextUser === null || (isAppUserPayload(nextUser) && nextUser.id !== authenticatedUserId)) {
          expireSessionAndReturnToLogin("Your session ended or changed in another browser. Sign in again to continue.");
        }
      } catch {
        // 状态端点短暂不可用并不能证明会话已撤销；保留当前完整资料，下一个 tick
        // 再核实。受保护写接口仍会由服务端拒绝，不能因网络抖动误登出老师。
      } finally {
        requestInFlight = false;
      }
    }

    void verifyCurrentSession();
    const interval = window.setInterval(() => void verifyCurrentSession(), 5000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [authScreen, authenticatedUserId, expireSessionAndReturnToLogin]);

  useEffect(() => {
    // 老师查看实时资料时，每五秒刷新当前功能所需数据；其他账号的修改会自动出现，不需要手工刷新整页。
    if (authScreen !== "ready") return;
    let active = true;

    async function refreshVisibleWorkspace() {
      // 轮询只请求当前可见的年级表、个人表或规则页，既保持多浏览器同步，也避免反复下载无关资料表。
      // 显式换年级或保存后重载期间直接跳过本次 tick；不能先领取更大号码再返回，
      // 否则一个没有实际请求的后台轮询也会把老师主动刷新误判成旧响应。
      if (activeManualTimetableRefreshNumber.current !== null || managementMutationKeyRef.current !== null) return;
      const pollableView = view === "Year timetables"
        || (view === "Personal timetables" && Boolean(personalOwnerId))
        || view === "Rules & issues";
      if (!pollableView) return;

      const requestNumber = ++visibleWorkspaceRefreshNumber.current;
      let responses: Response[] = [];
      try {
        if (view === "Rules & issues") {
          const workspace = await fetchRulesWorkspace();
          // 轮询开始后，导航或 beginManagementMutation 都会提高 generation；写入锁也要
          // 再核对一次，确保未来即使某个调用点漏提号码，保存前的旧快照仍不能覆盖页面。
          if (!active || requestNumber !== visibleWorkspaceRefreshNumber.current
            || managementMutationKeyRef.current !== null) return;
          applyRulesWorkspace(workspace);
          return;
        }
        if (view === "Year timetables") responses = await Promise.all([fetch(`/api/schedule/workspace?year=${timetableYear}`)]);
        if (view === "Personal timetables" && personalOwnerId) responses = await Promise.all([fetch(`/api/schedule/personal?kind=${personalKind}&ownerId=${encodeURIComponent(personalOwnerId)}`), fetch("/api/teachers")]);
      } catch (error) {
        // 短暂断网只保留当前完整画面；下一次五秒 tick 会自然重试，不能产生
        // 未处理的 Promise rejection 或把半套 payload 写进页面。
        if (active && requestNumber === visibleWorkspaceRefreshNumber.current
          && error instanceof RulesWorkspaceRequestError && error.status === 401) {
          expireSessionAndReturnToLogin("Your session expired. Please sign in again.");
        }
        return;
      }
      try {
        if (!active || responses.length === 0) return;
        if (responses.some((response) => response.status === 401)) {
          expireSessionAndReturnToLogin("Your session expired. Please sign in again.");
          return;
        }
        if (responses.some((response) => !response.ok)) return;
        const payloads: unknown[] = await Promise.all(responses.map((response) => response.json()));
        // 较新的轮询或显式 openTimetable 已经开始后，旧响应只能丢弃；否则慢网络会
        // 把保存前的课表倒灌回来，让刚移动的卡短暂回到原位置。
        if (!active || requestNumber !== visibleWorkspaceRefreshNumber.current) return;
        if (view === "Year timetables") {
          const workspace = parseYearTimetableWorkspace(payloads[0]);
          const nextLessons = workspace.lessons;
          const nextUnscheduledSections = workspace.unscheduledSections;
          setLessons(nextLessons);
          setUnscheduledSections(nextUnscheduledSections);
          setScheduleIssues(workspace.issues);
          setTeachers(workspace.teachers);
          setRooms(workspace.rooms);

          // Inspector 里的星期／时间／班级属于老师尚未提交的本地草稿。另一账号提高
          // revision 后，不能让五秒轮询替换 editingLesson 并利用 form key 重建表单，
          // 否则老师刚选的内容会无提示消失。这里保留旧对象并显示过期说明；Save 时
          // 服务器 409 会阻止覆盖，再由统一流程载入最新版本。
          const draftResult = reconcileLessonDraft(editingLessonRef.current, nextLessons);
          if (draftResult.lesson) {
            // revision 未改变时同步 warning 等服务器派生资料；改变或删除时 helper 会
            // 原样返回 current 对象，因此 form key、原生输入和受控下拉草稿都不重建。
            editingLessonRef.current = draftResult.lesson;
            setEditingLesson(draftResult.lesson);
            setLessonDraftIsStale(draftResult.stale);
          }
          // 首次排课表单同样属于未保存操作；另一账号先放置后先保留当前对象，
          // 让 Place／候选按钮通过稳定409给出明确去向，而不是轮询直接卸载面板。
          setPlacingSection((current) => current ? nextUnscheduledSections.find((section) => section.sectionId === current.sectionId && section.occurrence === current.occurrence) ?? current : null);
          setCandidateSection((current) => current ? nextUnscheduledSections.find((section) => section.sectionId === current.sectionId && section.occurrence === current.occurrence) ?? current : null);
        }
        if (view === "Personal timetables") {
          // 两个数组必须先全部验证成功再一起写入；若教师 payload 损坏，不能先应用
          // 新课表而留下旧教师清单，制造数据库中从未同时存在过的混合页面。
          const nextPersonalLessons = requireArrayPayload<ScheduledLesson>(payloads[0], "The personal timetable poll response was invalid.");
          const nextTeachers = requireArrayPayload<Teacher>(payloads[1], "The teacher poll response was invalid.");
          setPersonalLessons(nextPersonalLessons);
          setTeachers(nextTeachers);
        }
        setLastSyncedAt(new Date());
      } catch {
        // 200 HTML、损坏 JSON 或缺少聚合数组都只丢弃这一轮；上一份完整画面继续可读，
        // 下一个五秒 tick 会自然恢复，且 `void refreshVisibleWorkspace()` 不会产生未处理 rejection。
        return;
      }
    }

    // 五秒延迟对小型排课团队已接近实时，同时在本地 SQLite MVP 阶段不需要额外维护长期 WebSocket 服务。
    void refreshVisibleWorkspace();
    const interval = window.setInterval(() => void refreshVisibleWorkspace(), 5000);
    return () => { active = false; window.clearInterval(interval); };
  }, [authScreen, expireSessionAndReturnToLogin, fetchRulesWorkspace, personalKind, personalOwnerId, timetableYear, view]);

  async function submitAuthentication(event: FormEvent<HTMLFormElement>) {
    // 首次管理员建立和日常登录共用账号密码；部署令牌只发送给 setup 接口，普通登录请求绝不携带它。
    event.preventDefault();
    if (authenticationRequestInFlight.current) return;
    // 老师已开始新的显式认证尝试后，登录／设置结果可以正常更新提示；上一会话的
    // 所有请求仍持有旧 authenticatedSessionGeneration，迟到时会在响应边界被丢弃。
    authenticatedSessionGeneration.current += 1;
    sessionExpiryNoticeActive.current = false;
    authenticationRequestInFlight.current = true;
    setAuthenticationSubmitting(true);
    const data = new FormData(event.currentTarget);
    const endpoint = authScreen === "setup" ? "/api/auth/setup" : "/api/auth/login";
    const credentials = {
      username: String(data.get("username") ?? ""),
      password: String(data.get("password") ?? ""),
    };
    // 本地开发没有配置 TIMETABLING_SETUP_TOKEN 时允许空值；生产环境是否匹配由服务端统一判断。
    const requestBody = authScreen === "setup"
      ? { ...credentials, setupToken: String(data.get("setupToken") ?? "") }
      : credentials;
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        setNotice(body.error ?? "Authentication failed. Check the details and try again.", "error");
        return;
      }

      // HTTP 2xx 已表示 setup／login 事务被服务端接受。若正文在传输途中损坏，不能
      // 把已经建立的管理员或会话误报成失败并鼓励重复提交；改由受保护 status 端点
      // 核实 Cookie。核实仍失败时进入不可编辑画面，要求刷新，而不是继续显示表单。
      let authenticatedUser: AppUser | null = null;
      const body = await response.json().catch(() => null) as { user?: AppUser } | null;
      if (body?.user && typeof body.user.username === "string") authenticatedUser = body.user;
      if (!authenticatedUser) {
        try {
          const statusResponse = await fetch("/api/auth/status", { cache: "no-store" });
          if (!statusResponse.ok) throw new Error("Authentication status was unavailable.");
          const status = await statusResponse.json() as { user?: AppUser | null };
          if (!status.user || typeof status.user.username !== "string") throw new Error("The new session was not confirmed.");
          authenticatedUser = status.user;
        } catch {
          setCurrentUser(null);
          setAuthScreen("load-error");
          setNotice("The server accepted the credentials, but the new session could not be confirmed. Refresh before trying again.", "warning");
          return;
        }
      }
      try {
        // 登录接口成功只代表会话已建立；基础资料和默认 Year 1 工作区全部读取
        // 成功后才开放编辑页面，否则断网会把真实资料伪装成可修改的空总表。
        if (!await loadAuthenticatedWorkspaces()) throw new Error("The signed-in workspace refresh was superseded.");
        setCurrentUser(authenticatedUser);
        setAuthScreen("ready");
        setNotice(`Signed in as ${authenticatedUser.username}.`, "success");
      } catch (error) {
        if (error instanceof ProtectedSessionExpiredError) return;
        // 会话已经建立时不能再说“登录失败”；错误画面保留刷新入口，但绝不渲染空资料表。
        setCurrentUser(null);
        setAuthScreen("load-error");
        setNotice("Signed in, but scheduling data could not be loaded. Refresh before making changes.", "warning");
      }
    } catch {
      // 请求本身抛错时，服务器仍可能已经建立首位管理员或登录会话，只是响应头没有
      // 到达浏览器。先尝试核实现有 Cookie；无法核实时冻结表单并要求刷新，绝不能
      // 用“try again”鼓励重复 setup／login 写入。
      try {
        const statusResponse = await fetch("/api/auth/status", { cache: "no-store" });
        if (!statusResponse.ok) throw new Error("Authentication status was unavailable.");
        const status = await statusResponse.json() as { user?: AppUser | null };
        if (!status.user || typeof status.user.username !== "string") throw new Error("No confirmed session is available.");
        try {
          if (!await loadAuthenticatedWorkspaces()) throw new Error("The recovered-session workspace refresh was superseded.");
          setCurrentUser(status.user);
          setAuthScreen("ready");
          setNotice(`Signed in as ${status.user.username}. The original response was interrupted, but the session was confirmed.`, "warning");
        } catch (error) {
          if (error instanceof ProtectedSessionExpiredError) return;
          setCurrentUser(null);
          setAuthScreen("load-error");
          setNotice("A session was established, but scheduling data could not be loaded. Refresh before making changes.", "warning");
        }
      } catch {
        setCurrentUser(null);
        setAuthScreen("load-error");
        setNotice("The authentication result could not be confirmed. Refresh the page to check the current setup or session before trying again.", "warning");
      }
    } finally {
      authenticationRequestInFlight.current = false;
      setAuthenticationSubmitting(false);
    }
  }

  async function logout() {
    // 登出不仅清除浏览器 Cookie，也在服务端删除会话记录，复制旧 Cookie 也不能继续访问资料。
    const sessionRequestGeneration = authenticatedSessionGeneration.current;
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
      if (!response.ok) {
        setNotice(body.error ?? "Sign out could not be completed. Try again.", "error");
        return;
      }
      clearSessionBoundWorkspace();
      setAuthScreen("login");
      setNotice("Signed out.", "success");
    } catch {
      // 服务端没有确认撤销会话前保留当前画面，避免看似退出、刷新后又自动登录。
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
      setNotice("Sign out could not reach the server. Check the connection and try again.", "error");
    }
  }

  async function openAccounts() {
    // 只有管理员进入账号页时才读取账号清单和恢复指纹。先取得指纹、再读取清单：
    // 若两次读取之间有人写入，提交恢复时旧指纹必然得到409，而不会把未审阅的新资料覆盖。
    if (managementMutationKeyRef.current || lessonMutationIdRef.current || placingSessionKeyRef.current || savingCourseSetupIdRef.current || savingSectionIdRef.current) {
      setNotice("A change is still in progress. Wait for it to finish before opening Accounts.", "warning");
      return false;
    }
    const requestNumber = ++visibleWorkspaceRefreshNumber.current;
    activeManualTimetableRefreshNumber.current = requestNumber;
    const sessionRequestGeneration = authenticatedSessionGeneration.current;
    setSystemRestoreCurrentToken(null);
    try {
      const statusResponse = await fetch("/api/system-backup/status", { cache: "no-store" });
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return false;
      if (!statusResponse.ok) {
        if (statusResponse.status === 401) {
          expireSessionAndReturnToLogin("Your session expired. Sign in again before opening Accounts.");
          return false;
        }
        if (requestNumber === visibleWorkspaceRefreshNumber.current) {
          const body = await statusResponse.json().catch(() => ({})) as { error?: string };
          if (!sessionRequestIsCurrent(sessionRequestGeneration)) return false;
          setNotice(body.error ?? "The current system data could not be reviewed for restore.", "error");
        }
        return false;
      }
      const status = await statusResponse.json() as { currentToken?: string };
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return false;
      if (typeof status.currentToken !== "string" || !/^[0-9a-f]{64}$/.test(status.currentToken)) {
        throw new Error("The restore status response was invalid.");
      }

      const accountsResponse = await fetch("/api/auth/accounts", { cache: "no-store" });
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return false;
      if (!accountsResponse.ok) {
        if (accountsResponse.status === 401) {
          expireSessionAndReturnToLogin("Your session expired. Sign in again before opening Accounts.");
          return false;
        }
        if (requestNumber === visibleWorkspaceRefreshNumber.current) {
          const body = await accountsResponse.json().catch(() => ({})) as { error?: string };
          if (!sessionRequestIsCurrent(sessionRequestGeneration)) return false;
          setNotice(body.error ?? "Only the administrator can manage accounts.", "error");
        }
        return false;
      }
      const nextAccounts = parseAccountsPayload(await accountsResponse.json());
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return false;
      if (requestNumber !== visibleWorkspaceRefreshNumber.current || managementMutationKeyRef.current) return false;

      setAccounts(nextAccounts);
      setSystemRestoreCurrentToken(status.currentToken);
      setActiveView("Accounts");
      setShowForm(false);
      return true;
    } catch {
      // 两份资料只有全部读取和解析成功后才应用；断网时保留原页面，也绝不启用
      // 缺少状态确认的破坏性恢复表单。
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return false;
      if (requestNumber === visibleWorkspaceRefreshNumber.current) {
        setSystemRestoreCurrentToken(null);
        setNotice("Accounts and restore status could not be loaded. Check the connection and try again.", "error");
      }
      return false;
    } finally {
      if (activeManualTimetableRefreshNumber.current === requestNumber) {
        activeManualTimetableRefreshNumber.current = null;
      }
    }
  }

  async function refreshAccountsAfterMutation(requestNumber: number, sessionRequestGeneration: number) {
    // 账号写入已确认后只刷新清单，不再次执行页面导航，也不在 helper 内写提示；
    // 调用方才能准确区分“写入失败”和“已写入但清单刷新失败”。请求还要绑定
    // beginManagementMutation 后的 generation；会话轮询一旦清空页面，迟到的200
    // 账号清单也只能丢弃，不能在登录页复活上一位管理员的缓存。
    const response = await fetch("/api/auth/accounts", { cache: "no-store" });
    if (!sessionRequestIsCurrent(sessionRequestGeneration)) throw new ProtectedSessionExpiredError();
    if (response.status === 401) throw new ProtectedSessionExpiredError();
    if (!response.ok) throw new Error("Accounts could not be refreshed.");
    const nextAccounts = parseAccountsPayload(await response.json());
    if (!sessionRequestIsCurrent(sessionRequestGeneration)
      || requestNumber !== visibleWorkspaceRefreshNumber.current) throw new ProtectedSessionExpiredError();
    setAccounts(nextAccounts);
    // 账号本身属于完整恢复会覆盖的系统状态；任何账号写入后，旧恢复指纹即使仍在
    // React state 中也不能继续使用。管理员需重新进入本页审阅并取得新指纹。
    setSystemRestoreCurrentToken(null);
  }

  function restoreAccountStatusFocus(userId: string) {
    pendingAccountStatusFocusRef.current = userId;
  }

  async function createAccount(event: FormEvent<HTMLFormElement>) {
    // 新账号默认是普通排课账号，可以使用全部排课功能但不能建立新账号；只有初始管理员拥有账号创建权。
    event.preventDefault();
    // 请求前保存表单元素，避免异步响应回来后读取已被 React 清空的事件目标，导致账号其实已创建但页面误报错误。
    const form = event.currentTarget;
    const data = new FormData(form);
    const username = String(data.get("username") ?? "");
    const mutationKey = "account-create";
    if (!beginManagementMutation(mutationKey)) return;
    const requestNumber = visibleWorkspaceRefreshNumber.current;
    const sessionRequestGeneration = authenticatedSessionGeneration.current;
    let committed = false;
    try {
      const response = await fetch("/api/auth/accounts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password: String(data.get("password") ?? "") }) });
      if (!sessionRequestIsCurrent(sessionRequestGeneration) || requestNumber !== visibleWorkspaceRefreshNumber.current) return;
      const body = await response.json().catch(() => ({})) as { error?: string; username?: string };
      if (!sessionRequestIsCurrent(sessionRequestGeneration) || requestNumber !== visibleWorkspaceRefreshNumber.current) return;
      if (!response.ok) {
        if (response.status === 401) {
          expireSessionAndReturnToLogin("Your session expired. Sign in again before creating an account.");
          return;
        }
        setNotice(body.error ?? "Account could not be created.", "error");
        return;
      }
      committed = true;
      form.reset();
      try {
        await refreshAccountsAfterMutation(requestNumber, sessionRequestGeneration);
        if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
        setNotice(`${body.username ?? username} account created.`, "success");
      } catch (error) {
        if (!sessionRequestIsCurrent(sessionRequestGeneration) || requestNumber !== visibleWorkspaceRefreshNumber.current) return;
        if (error instanceof ProtectedSessionExpiredError) {
          expireSessionAndReturnToLogin("Your session expired after the account request. Sign in again to verify the latest account list.");
          return;
        }
        freezeManagementWorkspace(`${body.username ?? username} account was created, but the latest account list could not be loaded. Refresh before making another change.`);
      }
    } catch {
      if (!sessionRequestIsCurrent(sessionRequestGeneration) || requestNumber !== visibleWorkspaceRefreshNumber.current) return;
      freezeManagementWorkspace(committed
        ? "The account was created, but its latest details could not be loaded. Refresh before continuing."
        : "The create-account request was interrupted, so its result is unknown. Refresh the page before retrying.");
    } finally {
      finishManagementMutation(mutationKey, sessionRequestGeneration);
    }
  }

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    // 密码修改成功后撤销该账号的所有浏览器会话，包括当前页面，确保旧密码建立的会话不能继续使用。
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const mutationKey = "password-change";
    if (!beginManagementMutation(mutationKey)) return;
    const sessionRequestGeneration = authenticatedSessionGeneration.current;
    try {
      const response = await fetch("/api/auth/password", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ currentPassword: String(data.get("currentPassword") ?? ""), newPassword: String(data.get("newPassword") ?? "") }) });
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
      const body = await response.json().catch(() => ({})) as { code?: string; error?: string };
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
      if (!response.ok) {
        // 401 表示会话已在请求到达前失效；PASSWORD_CHANGED 则表示旧密码校验后
        // 管理员重置／停用先提交。两者都不能继续展示上一账号缓存的课表和 Accounts 资料。
        if (response.status === 401 || (response.status === 409 && body.code === "PASSWORD_CHANGED")) {
          expireSessionAndReturnToLogin(body.error ?? "Your account access changed. Sign in again before changing your password.");
          return;
        }
        setNotice(body.error ?? "Password could not be changed.", "error");
        return;
      }
      clearSessionBoundWorkspace();
      setAuthScreen("login");
      setNotice("Password changed. Sign in again with the new password.", "success");
    } catch {
      // 响应中断时密码可能已经提交且所有会话可能已经撤销。回到登录页比继续显示
      // 受保护资料更安全；老师可先尝试新密码，再决定是否需要重试。
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
      clearSessionBoundWorkspace();
      setAuthScreen("login");
      setNotice("The password-change result is unknown because the response was interrupted. Try signing in with the new password before retrying.", "warning");
    } finally {
      finishManagementMutation(mutationKey, sessionRequestGeneration);
    }
  }

  async function changeAccountStatus(account: AppUser) {
    // 停用账号会保留记录和审计关联，但阻止之后登录；保存后立即刷新清单，让管理员确认最新状态。
    const mutationKey = `account-status:${account.id}`;
    if (!beginManagementMutation(mutationKey)) return;
    const requestNumber = visibleWorkspaceRefreshNumber.current;
    const sessionRequestGeneration = authenticatedSessionGeneration.current;
    let committed = false;
    try {
      const response = await fetch("/api/auth/accounts", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "status", userId: account.id, isActive: !account.isActive, expectedRevision: account.revision }) });
      if (!sessionRequestIsCurrent(sessionRequestGeneration) || requestNumber !== visibleWorkspaceRefreshNumber.current) return;
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { code?: string; error?: string };
        if (!sessionRequestIsCurrent(sessionRequestGeneration) || requestNumber !== visibleWorkspaceRefreshNumber.current) return;
        if (response.status === 401) {
          expireSessionAndReturnToLogin("Your session expired. Sign in again before changing an account.");
          return;
        }
        if (response.status === 409 && body.code === "ACCOUNT_CHANGED") {
          // 另一管理员已先提交时，旧按钮必须失效并立刻换成服务器最新版；否则用户
          // 可能根据过期的 Active 标签再次操作，造成一连串可避免的冲突。
          try {
            await refreshAccountsAfterMutation(requestNumber, sessionRequestGeneration);
            if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
            // ACCOUNT_CHANGED 已是稳定 typed code；页面用一条完整文案说明“谁改变、
            // 已经重载、下一步是什么”，避免把服务端提示和客户端后缀重复朗读两次。
            setNotice(`${account.username} was changed by another administrator. The latest account list is now loaded; review it before trying again.`, "warning");
            restoreAccountStatusFocus(account.id);
          } catch (error) {
            if (!sessionRequestIsCurrent(sessionRequestGeneration) || requestNumber !== visibleWorkspaceRefreshNumber.current) return;
            if (error instanceof ProtectedSessionExpiredError) {
              expireSessionAndReturnToLogin("Your session expired while refreshing the changed account. Sign in again.");
              return;
            }
            freezeManagementWorkspace(`${account.username} was changed by another administrator, but the latest account list could not be loaded. Refresh before making another change.`);
          }
          return;
        }
        setNotice(body.error ?? "Account status could not be changed.", "error");
        return;
      }
      committed = true;
      try {
        await refreshAccountsAfterMutation(requestNumber, sessionRequestGeneration);
        if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
        setNotice(`${account.username} ${account.isActive ? "deactivated" : "activated"}.`, "success");
        restoreAccountStatusFocus(account.id);
      } catch (error) {
        if (!sessionRequestIsCurrent(sessionRequestGeneration) || requestNumber !== visibleWorkspaceRefreshNumber.current) return;
        if (error instanceof ProtectedSessionExpiredError) {
          expireSessionAndReturnToLogin("Your session expired after the account request. Sign in again to verify the latest account list.");
          return;
        }
        freezeManagementWorkspace(`${account.username} was ${account.isActive ? "deactivated" : "activated"}, but the latest account list could not be loaded. Refresh before making another change.`);
      }
    } catch {
      if (!sessionRequestIsCurrent(sessionRequestGeneration) || requestNumber !== visibleWorkspaceRefreshNumber.current) return;
      freezeManagementWorkspace(committed
        ? `${account.username} status changed, but the latest account list could not be loaded. Refresh before continuing.`
        : "The account-status request was interrupted, so its result is unknown. Refresh the page before retrying.");
    } finally {
      finishManagementMutation(mutationKey, sessionRequestGeneration);
    }
  }

  async function resetAccountPassword(event: FormEvent<HTMLFormElement>) {
    // 管理员可直接替换普通账号遗忘的密码，不需要知道旧密码；重置成功后服务端同时撤销该账号现有会话。
    event.preventDefault();
    // 先保存提交表单本身，因为 React 的事件目标只在同步回调期间可靠；服务器响应后使用稳定引用清空密码框。
    const form = event.currentTarget;
    const data = new FormData(form);
    const mutationKey = "account-password-reset";
    if (!beginManagementMutation(mutationKey)) return;
    const requestNumber = visibleWorkspaceRefreshNumber.current;
    const sessionRequestGeneration = authenticatedSessionGeneration.current;
    let committed = false;
    try {
      const response = await fetch("/api/auth/accounts", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "resetPassword", userId: String(data.get("userId") ?? ""), password: String(data.get("password") ?? "") }) });
      if (!sessionRequestIsCurrent(sessionRequestGeneration) || requestNumber !== visibleWorkspaceRefreshNumber.current) return;
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!sessionRequestIsCurrent(sessionRequestGeneration) || requestNumber !== visibleWorkspaceRefreshNumber.current) return;
      if (!response.ok) {
        if (response.status === 401) {
          expireSessionAndReturnToLogin("Your session expired. Sign in again before resetting a password.");
          return;
        }
        setNotice(body.error ?? "Password could not be reset.", "error");
        return;
      }
      committed = true;
      try {
        await refreshAccountsAfterMutation(requestNumber, sessionRequestGeneration);
        if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
        form.reset();
        setNotice("Password reset. Existing sessions for that account were signed out.", "success");
      } catch (error) {
        if (!sessionRequestIsCurrent(sessionRequestGeneration) || requestNumber !== visibleWorkspaceRefreshNumber.current) return;
        if (error instanceof ProtectedSessionExpiredError) {
          expireSessionAndReturnToLogin("Your session expired after the password-reset request. Sign in again to verify the account.");
          return;
        }
        freezeManagementWorkspace("The password was reset, but the latest account list could not be loaded. Refresh before making another change.");
      }
    } catch {
      if (!sessionRequestIsCurrent(sessionRequestGeneration) || requestNumber !== visibleWorkspaceRefreshNumber.current) return;
      freezeManagementWorkspace(committed
        ? "The password was reset, but its latest account details could not be loaded. Refresh before continuing."
        : "The password-reset response was interrupted, so its result is unknown. Refresh before resetting it again.");
    } finally {
      finishManagementMutation(mutationKey, sessionRequestGeneration);
    }
  }

  async function downloadSystemBackup() {
    // 由当前页面请求备份文件，权限或完整性失败时可显示易读提示，而不是跳转到只含 JSON 错误的新页面。
    setDownloadingBackup(true);
    setNotice("Creating and checking the full system backup...", "info");
    const sessionRequestGeneration = authenticatedSessionGeneration.current;
    try {
      const response = await fetch("/api/system-backup", { cache: "no-store" });
      if (protectedResponseEndedSession(response, "Your session expired. Sign in again before downloading a backup.", sessionRequestGeneration)) return;
      if (!response.ok) {
        const body = await response.json();
        if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
        return setNotice(body.error ?? "The full system backup could not be downloaded.", "error");
      }

      // 服务端提供安全的日期文件名；浏览器建立临时下载地址并触发下载，点击发出后立即撤销地址，避免长期占用内存。
      const disposition = response.headers.get("Content-Disposition") ?? "";
      const filename = disposition.match(/filename="([^"]+)"/)?.[1] ?? "timetabling-backup.sqlite";
      const backupBlob = await response.blob();
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
      const objectUrl = URL.createObjectURL(backupBlob);
      const downloadLink = document.createElement("a");
      downloadLink.href = objectUrl;
      downloadLink.download = filename;
      document.body.appendChild(downloadLink);
      downloadLink.click();
      downloadLink.remove();
      URL.revokeObjectURL(objectUrl);
      setNotice(`Full system backup downloaded as ${filename}.`, "success");
    } catch {
      // 本地服务断开或网络请求中断时保持页面可继续操作，并明确说明不能把这次请求当作成功备份。
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
      setNotice("The full system backup could not be downloaded. Check the connection and try again.", "error");
    } finally {
      // 无论成功、接口拒绝还是网络异常，最终都重新启用下载按钮，避免一次失败后按钮永久锁住。
      if (sessionRequestIsCurrent(sessionRequestGeneration)) setDownloadingBackup(false);
    }
  }

  async function restoreSystemBackup(event: FormEvent<HTMLFormElement>) {
    // 浏览器提交所选文件、确认项和进入 Accounts 页面时取得的资料指纹；服务端会在
    // 写锁内独立复核所有内容，不能信任前端判断或在提交前偷偷刷新成用户未审阅的新指纹。
    event.preventDefault();
    const form = event.currentTarget;
    const expectedCurrentToken = systemRestoreCurrentToken;
    if (!expectedCurrentToken) {
      setNotice("Restore review is stale or unavailable. Leave and reopen Accounts before choosing a backup.", "warning");
      return;
    }
    const mutationKey = "system-restore";
    if (!beginManagementMutation(mutationKey)) return;
    const sessionRequestGeneration = authenticatedSessionGeneration.current;
    const formData = new FormData(form);
    // beginManagementMutation 会立即让 React state 中的旧指纹失效；这里使用事件开始时
    // 捕获的稳定值完成本次已确认请求，后续点击则必须重新打开 Accounts。
    formData.set("expectedCurrentToken", expectedCurrentToken);
    setRestoringBackup(true);
    setNotice("Validating the backup and saving the current system state...", "info");
    try {
      const response = await fetch("/api/system-backup", { method: "POST", body: formData });
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
      const body = await response.json().catch(() => ({})) as { error?: string; code?: string; safetyBackupFilename?: string };
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
      if (!response.ok) {
        if (response.status === 409 && body.code === "SYSTEM_STATE_CHANGED") {
          // 另一账号在管理员审阅后又提交了资料。清掉文件和确认项，强制重新查看
          // 当前状态；绝不能只换一个隐藏 token 后自动重试破坏性操作。
          form.reset();
          setSystemRestoreCurrentToken(null);
          setNotice(body.error ?? "Current system data changed. Nothing was restored; reopen Accounts and review the latest data.", "warning");
          return;
        }
        if (response.status === 401 || response.status === 403 || response.status >= 500) {
          // 身份错误或通用服务器故障不能证明恢复没有到达提交边界。和断网结果未知
          // 采用相同安全姿态：清掉旧工作区、回到登录页，再检查实际资料。只凭 HTTP
          // 503 无法区分应用的数据库锁和平台网关故障，因此也不能安全留在旧画面。
          form.reset();
          clearSessionBoundWorkspace();
          setAuthScreen("login");
          setNotice(body.error ?? "The restore result could not be confirmed. Sign in again and verify the current system.", "warning");
          return;
        }
        setNotice(body.error ?? "The full system backup could not be restored.", "error");
        return;
      }

      // 完整恢复成功后当前会话已被删除，而且备份中的账号已取代在线账号；页面必须立即返回登录画面。
      form.reset();
      clearSessionBoundWorkspace();
      setAuthScreen("login");
      setNotice(body.safetyBackupFilename
        ? `Full system restored. All sessions were signed out. Server safety copy: ${body.safetyBackupFilename}.`
        : "The restore was accepted and all sessions were signed out. Sign in and verify the restored system.", body.safetyBackupFilename ? "success" : "warning");
    } catch {
      // 网络中断不能推断恢复成功或失败。立即关闭可编辑工作区并清除确认，要求重新
      // 登录检查实际资料后再决定下一步，不能保留旧画面并鼓励盲目重试。
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
      form.reset();
      clearSessionBoundWorkspace();
      setAuthScreen("login");
      setNotice("The restore response was interrupted. Sign in again and verify the current system before retrying.", "warning");
    } finally {
      if (sessionRequestIsCurrent(sessionRequestGeneration)) setRestoringBackup(false);
      finishManagementMutation(mutationKey, sessionRequestGeneration);
    }
  }

  async function beginNewCycle(event: FormEvent<HTMLFormElement>) {
    // 开始新周期要求两个勾选和完全一致的确认短语，构成约定的多重确认；服务端清空前还会独立验证一次。
    event.preventDefault();
    // 清空请求和资料重载都是异步操作，因此先保存表单元素；最终重置时不能再依赖临时 event.currentTarget。
    const form = event.currentTarget;
    const data = new FormData(form);
    if (!data.get("understandClear") || !data.get("understandBackup")) return setNotice("Complete both confirmations before starting a new cycle.", "warning");
    const mutationKey = "cycle-start";
    if (!beginManagementMutation(mutationKey)) return;
    const sessionRequestGeneration = authenticatedSessionGeneration.current;
    let committed = false;
    // 把老师打开页面时看到的周期指纹交给服务器；若另一账号已经修改课程，
    // 服务器会要求刷新复核，而不是把老师没有确认过的新资料直接清空。
    try {
      const response = await fetch("/api/cycle", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "start", confirmation: String(data.get("confirmation") ?? ""), currentToken: currentCycle?.currentToken ?? "" }) });
      if (protectedResponseEndedSession(response, "Your session expired. Sign in again before starting a new cycle.", sessionRequestGeneration)) return;
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
        setNotice(body.error ?? "A new cycle could not be started.", "error");
        return;
      }
      // HTTP 2xx 已明确表示清空事务提交；从这里开始即使读取正文或刷新失败，
      // 提示也只能说“已提交但未能刷新”，不能诱导老师重复清空。
      committed = true;
      const body = await response.json() as CycleStatus;
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
      setCurrentCycle(body);
      setLessons([]);
      setUnscheduledSections([]);
      setSelectedCourse(null);
      setSections([]);
      form.reset();
      try {
        if (!await loadData()) throw new Error("The new-cycle master-data workspace refresh was superseded.");
        if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
        setNotice("New cycle started. Courses and timetable work were cleared after the emergency backup was saved.", "success");
      } catch (error) {
        if (error instanceof ProtectedSessionExpiredError || !sessionRequestIsCurrent(sessionRequestGeneration)) return;
        // 清空已经提交后，旧课程清单不再可信。切到不可编辑错误画面，防止老师在
        // 重新载入前继续操作已从数据库删除的记录。
        setAuthScreen("load-error");
        setNotice("The new cycle was started, but the latest master-data lists could not be loaded. Refresh before continuing.", "warning");
      }
    } catch {
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
      if (committed) setCurrentCycle(null);
      // 连接中断时无法判断清空事务是否已经提交；保留可编辑旧画面会比要求刷新更
      // 危险，因此无论是否已读到2xx都先冻结工作区。
      setAuthScreen("load-error");
      setNotice(committed
        ? "The new cycle was started, but its latest status could not be loaded. Refresh before continuing."
        : "The new-cycle response was interrupted, so the result is unknown. Refresh the cycle status before retrying.", "warning");
    } finally {
      finishManagementMutation(mutationKey, sessionRequestGeneration);
    }
  }

  async function restoreCycle(event: FormEvent<HTMLFormElement>) {
    // 恢复应急副本会覆盖清空后新做的全部课程和排课，因此必须使用独立勾选与准确短语，不能设计成一键撤销。
    event.preventDefault();
    // 等待恢复接口前保存稳定表单引用，确保成功后可以安全清空确认内容。
    const form = event.currentTarget;
    const data = new FormData(form);
    if (!data.get("understandRestore")) return setNotice("Confirm that current cycle work may be replaced before restoring.", "warning");
    const mutationKey = "cycle-restore";
    if (!beginManagementMutation(mutationKey)) return;
    const sessionRequestGeneration = authenticatedSessionGeneration.current;
    let committed = false;
    // 同时提交页面显示的备份 ID 与当前周期指纹，防止多人操作时恢复了另一份新备份，
    // 或覆盖另一位老师在本页面打开后刚保存的课程工作。
    try {
      const response = await fetch("/api/cycle", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "restore", confirmation: String(data.get("confirmation") ?? ""), backupId: currentCycle?.backup?.id ?? "", currentToken: currentCycle?.currentToken ?? "" }) });
      if (protectedResponseEndedSession(response, "Your session expired. Sign in again before restoring a cycle.", sessionRequestGeneration)) return;
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
        setNotice(body.error ?? "The emergency backup could not be restored.", "error");
        return;
      }
      committed = true;
      const body = await response.json() as CycleStatus;
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
      setCurrentCycle(body);
      form.reset();
      try {
        if (!await loadData()) throw new Error("The restored-cycle master-data workspace refresh was superseded.");
        if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
        setNotice("The last emergency cycle backup was restored.", "success");
      } catch (error) {
        if (error instanceof ProtectedSessionExpiredError || !sessionRequestIsCurrent(sessionRequestGeneration)) return;
        // 恢复会替换整套课程资料；刷新失败时隐藏旧可编辑清单，直到完整页面重载。
        setAuthScreen("load-error");
        setNotice("The emergency cycle backup was restored, but the latest master-data lists could not be loaded. Refresh before continuing.", "warning");
      }
    } catch {
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
      if (committed) setCurrentCycle(null);
      setAuthScreen("load-error");
      setNotice(committed
        ? "The emergency cycle backup was restored, but its latest status could not be loaded. Refresh before continuing."
        : "The restore response was interrupted, so the result is unknown. Refresh the cycle status before retrying.", "warning");
    } finally {
      finishManagementMutation(mutationKey, sessionRequestGeneration);
    }
  }

  type MasterRecordView = "Teachers" | "Student groups" | "Rooms";
  type MasterRecordAction = "edit" | "status" | "delete";

  function masterRecordButtonKey(recordView: MasterRecordView, recordId: string, action: MasterRecordAction) {
    // 同一个数据库 ID 可能在不同资料种类中重复，所以引用键同时包含页面和动作，
    // 才能在刷新后准确找回原来的 Edit 或 Activate／Deactivate 按钮。
    return `${recordView}:${recordId}:${action}`;
  }

  function closeMasterRecordForm() {
    // 任何 MASTER_DATA_CHANGED 都表示打开表单时看到的 revision 已经失效。
    // 一次清掉三种编辑对象，确保旧原生输入不会在切换资料页后被意外再次提交。
    setShowForm(false);
    setEditingTeacher(null);
    setEditingGroup(null);
    setEditingRoom(null);
  }

  async function reloadMasterRecordAfterConflict(input: {
    recordView: MasterRecordView;
    recordId: string;
    action: MasterRecordAction;
    label: string;
    serverMessage?: string;
    sessionRequestGeneration: number;
  }) {
    // 冲突一经确认就先卸载旧表单并清除筛选，让刷新后的目标记录一定有机会重新出现在表格中。
    // 管理资料全局锁会保持到此函数结束，所以等待 GET 时也不能打开另一张表单或发出第二笔写入。
    closeMasterRecordForm();
    setQuery("");
    try {
      const latest = await loadData();
      if (!sessionRequestIsCurrent(input.sessionRequestGeneration)) return;
      if (!latest) throw new Error("The conflict refresh was superseded before it could establish a new editing baseline.");
      const targetStillExists = input.recordView === "Teachers"
        ? latest.teachers.some((teacher) => teacher.id === input.recordId)
        : input.recordView === "Student groups"
          ? latest.groups.some((group) => group.id === input.recordId)
          : latest.rooms.some((room) => room.id === input.recordId);
      pendingMasterRecordFocusRef.current = {
        kind: "record",
        recordView: input.recordView,
        recordId: input.recordId,
        action: input.action,
      };
      setNotice(targetStillExists
        ? `${input.serverMessage ?? `${input.label} was changed by another scheduler.`} The latest record has been loaded; review it before trying again.`
        : `${input.serverMessage ?? `${input.label} changed in another session.`} The latest list has been loaded, but that record is no longer available.`, "warning");
    } catch {
      // 冲突后旧列表已知不可信；如果最新版也读不到，继续显示任何可编辑资料都会鼓励用户依据旧 revision 操作。
      // 切换到 load-error 会完全卸载工作区，并由专用 Effect 聚焦“Refresh and try again”。
      if (!sessionRequestIsCurrent(input.sessionRequestGeneration)) return;
      setAuthScreen("load-error");
      setNotice(`${input.label} was changed by another scheduler, but the latest master-data lists could not be loaded. Refresh before making changes.`, "error");
    }
  }

  async function removeStudentGroup(group: StudentGroup) {
    // 删除是不可撤销的基础资料动作，先说明精确年级和编号。服务端只允许删除完全
    // 未使用的记录；任何班次或应急周期引用都会返回保护性409，不会级联清资料。
    const confirmed = window.confirm(
      `Delete ${group.code} from Year ${group.year}?\n\nThis only succeeds when no course section or emergency cycle backup uses the group.`,
    );
    if (!confirmed) return;
    const mutationKey = `student-group-delete:${group.id}`;
    if (!beginManagementMutation(mutationKey)) return;
    const sessionRequestGeneration = authenticatedSessionGeneration.current;
    let committed = false;
    try {
      const response = await fetch(`/api/student-groups/${encodeURIComponent(group.id)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision: group.revision }),
      });
      if (protectedResponseEndedSession(response, "Your session expired. Sign in again before deleting a student group.", sessionRequestGeneration)) return;
      const body = await response.json().catch(() => ({})) as { code?: string; error?: string };
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
      if (!response.ok) {
        if (response.status === 409 && body.code === "MASTER_DATA_CHANGED") {
          await reloadMasterRecordAfterConflict({
            recordView: "Student groups",
            recordId: group.id,
            action: "delete",
            label: `${group.code} · Year ${group.year}`,
            serverMessage: body.error,
            sessionRequestGeneration,
          });
          return;
        }
        if (response.status === 409 && body.code === "STUDENT_GROUP_IN_USE") {
          setNotice(body.error ?? "Clear this student group's section assignments before deleting it.", "warning");
          return;
        }
        if (response.status === 404) {
          // 404 已明确证明记录不存在；即使是另一位老师先删除，也不能在后续刷新
          // 失败时把它误报成“删除结果未知”并鼓励重复尝试。
          committed = true;
          closeMasterRecordForm();
          setQuery("");
          pendingMasterRecordFocusRef.current = { kind: "form-toggle" };
          if (!await loadData()) throw new Error("The already-deleted student-group refresh was superseded.");
          if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
          setNotice(`${group.code} · Year ${group.year} was already removed by another scheduler.`, "warning");
          return;
        }
        setNotice(body.error ?? "The student group could not be deleted.", "error");
        return;
      }
      committed = true;
      closeMasterRecordForm();
      setQuery("");
      pendingMasterRecordFocusRef.current = { kind: "form-toggle" };
      try {
        if (!await loadData()) throw new Error("The student-group refresh was superseded after deletion committed.");
        if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
        setNotice(`${group.code} · Year ${group.year} was deleted.`, "success");
      } catch {
        if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
        freezeManagementWorkspace(`${group.code} · Year ${group.year} was deleted, but the latest lists could not be loaded. Refresh before continuing.`);
      }
    } catch {
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
      freezeManagementWorkspace(committed
        ? "The student group was deleted, but the latest data could not be loaded. Refresh before continuing."
        : "The delete response was interrupted, so the result is unknown. Refresh the student-group list before retrying.");
    } finally {
      finishManagementMutation(mutationKey, sessionRequestGeneration);
    }
  }

  async function toggleTeacher(teacher: Teacher) {
    // 教师只切换启用状态而不删除记录，保护历史排课和分配关联；停用后不再出现在新的选择清单。
    const isActive = teacher.status !== "Active";
    const mutationKey = `teacher-status:${teacher.id}`;
    if (!beginManagementMutation(mutationKey)) return;
    const sessionRequestGeneration = authenticatedSessionGeneration.current;
    let committed = false;
    try {
      const response = await fetch(`/api/teachers/${encodeURIComponent(teacher.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ isActive, revision: teacher.revision }) });
      if (protectedResponseEndedSession(response, "Your session expired. Sign in again before changing a teacher.", sessionRequestGeneration)) return;
      const body = await response.json().catch(() => ({})) as { code?: string; error?: string };
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
      if (!response.ok) {
        if (response.status === 409 && body.code === "MASTER_DATA_CHANGED") {
          await reloadMasterRecordAfterConflict({ recordView: "Teachers", recordId: teacher.id, action: "status", label: teacher.name, serverMessage: body.error, sessionRequestGeneration });
          return;
        }
        setNotice(body.error ?? "Teacher status could not be updated.", "error");
        return;
      }
      committed = true;
      pendingMasterRecordFocusRef.current = { kind: "record", recordView: "Teachers", recordId: teacher.id, action: "status" };
      try {
        if (!await loadData()) throw new Error("The teacher refresh was superseded after the status change committed.");
        if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
        setNotice(`${teacher.name} is now ${isActive ? "active" : "inactive"}.`, "success");
      } catch {
        if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
        freezeManagementWorkspace(`${teacher.name} is now ${isActive ? "active" : "inactive"}, but the latest master-data lists could not be loaded. Refresh before continuing.`);
      }
    } catch {
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
      freezeManagementWorkspace(committed
        ? "Teacher status changed, but the latest data could not be loaded. Refresh before continuing."
        : "The teacher-status response was interrupted, so the result is unknown. Refresh the teacher list before retrying.");
    } finally {
      finishManagementMutation(mutationKey, sessionRequestGeneration);
    }
  }

  async function toggleRoom(room: Room) {
    // 教室采用相同的非破坏性停用方式，保留历史课程使用记录，同时阻止新的排课继续选择它。
    const isActive = room.status !== "Active";
    const mutationKey = `room-status:${room.id}`;
    if (!beginManagementMutation(mutationKey)) return;
    const sessionRequestGeneration = authenticatedSessionGeneration.current;
    let committed = false;
    try {
      const response = await fetch(`/api/rooms/${encodeURIComponent(room.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ isActive, revision: room.revision }) });
      if (protectedResponseEndedSession(response, "Your session expired. Sign in again before changing a room.", sessionRequestGeneration)) return;
      const body = await response.json().catch(() => ({})) as { code?: string; error?: string };
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
      if (!response.ok) {
        if (response.status === 409 && body.code === "MASTER_DATA_CHANGED") {
          await reloadMasterRecordAfterConflict({ recordView: "Rooms", recordId: room.id, action: "status", label: room.code, serverMessage: body.error, sessionRequestGeneration });
          return;
        }
        setNotice(body.error ?? "Room status could not be updated.", "error");
        return;
      }
      committed = true;
      pendingMasterRecordFocusRef.current = { kind: "record", recordView: "Rooms", recordId: room.id, action: "status" };
      try {
        if (!await loadData()) throw new Error("The room refresh was superseded after the status change committed.");
        if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
        setNotice(`${room.code} is now ${isActive ? "active" : "inactive"}.`, "success");
      } catch {
        if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
        freezeManagementWorkspace(`${room.code} is now ${isActive ? "active" : "inactive"}, but the latest master-data lists could not be loaded. Refresh before continuing.`);
      }
    } catch {
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
      freezeManagementWorkspace(committed
        ? "Room status changed, but the latest data could not be loaded. Refresh before continuing."
        : "The room-status response was interrupted, so the result is unknown. Refresh the room list before retrying.");
    } finally {
      finishManagementMutation(mutationKey, sessionRequestGeneration);
    }
  }

  async function addRecord(event: FormEvent<HTMLFormElement>) {
    // 教师、学生班级和教室三种手工资料共用一个提交入口；根据当前页面建立对应接口、方法和请求内容。
    event.preventDefault();
    // 保存请求是异步的，先保存真实表单；教师、学生班级或教室成功写入后，不能再使用已经释放的 React 事件目标。
    const form = event.currentTarget;
    const data = new FormData(form);
    let endpoint = "";
    let method = "POST";
    let payload: Record<string, unknown> = {};
    let editedRecord: { view: MasterRecordView; id: string; label: string } | null = null;

    if (view === "Teachers") {
      // 教师新增和更正共用姓名与类别字段；编辑时沿用原数据库编号，使既有课程分配不会因为改名而断开。
      const name = String(data.get("name") ?? "").trim().toUpperCase();
      if (!name) return;
      endpoint = editingTeacher ? `/api/teachers/${encodeURIComponent(editingTeacher.id)}` : "/api/teachers";
      method = editingTeacher ? "PATCH" : "POST";
      // revision 来自打开表单时保存的完整教师快照；后台清单即使稍后刷新，也不能改写本次提交的比较基准。
      payload = { name, staffType: data.get("staffType"), ...(editingTeacher ? { revision: editingTeacher.revision } : {}) };
      if (editingTeacher) editedRecord = { view: "Teachers", id: editingTeacher.id, label: editingTeacher.name };
    }

    if (view === "Student groups") {
      // 学生班级更正直接更新稳定记录，已关联的班次与冲突检查仍指向同一个班级编号。
      const code = String(data.get("code") ?? "").trim().toUpperCase();
      if (!code) return;
      endpoint = editingGroup ? `/api/student-groups/${encodeURIComponent(editingGroup.id)}` : "/api/student-groups";
      method = editingGroup ? "PATCH" : "POST";
      payload = { code, year: Number(data.get("year")), program: String(data.get("program") ?? "").trim().toUpperCase(), ...(editingGroup ? { revision: editingGroup.revision } : {}) };
      if (editingGroup) editedRecord = { view: "Student groups", id: editingGroup.id, label: editingGroup.code };
    }

    if (view === "Rooms") {
      // 教室容量和设施保存为结构化标记，后续候选时段和警告引擎可以准确匹配课程的多重教室要求。
      const code = String(data.get("room") ?? "").trim().toUpperCase();
      if (!code) return;
      endpoint = editingRoom ? `/api/rooms/${encodeURIComponent(editingRoom.id)}` : "/api/rooms";
      method = editingRoom ? "PATCH" : "POST";
      payload = { code, capacity: Number(data.get("capacity")), hasLab: Boolean(data.get("lab")), hasMultiProjector: Boolean(data.get("projector")), isSmartClassroom: Boolean(data.get("smart")), ...(editingRoom ? { revision: editingRoom.revision } : {}) };
      if (editingRoom) editedRecord = { view: "Rooms", id: editingRoom.id, label: editingRoom.code };
    }

    const viewAtSubmit = view;
    const mutationKey = `master-record:${viewAtSubmit}`;
    if (!beginManagementMutation(mutationKey)) return;
    const sessionRequestGeneration = authenticatedSessionGeneration.current;
    let committed = false;
    // 浏览器先统一大小写和数字格式再发送；数据库约束与服务端验证仍是最终防线，不能只依赖表单。
    try {
      const response = await fetch(endpoint, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (protectedResponseEndedSession(response, "Your session expired. Sign in again before saving master data.", sessionRequestGeneration)) return;
      const body = await response.json().catch(() => ({})) as { code?: string; error?: string };
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
      if (!response.ok) {
        if (response.status === 409 && body.code === "MASTER_DATA_CHANGED" && editedRecord) {
          await reloadMasterRecordAfterConflict({
            recordView: editedRecord.view,
            recordId: editedRecord.id,
            action: "edit",
            label: editedRecord.label,
            serverMessage: body.error,
            sessionRequestGeneration,
          });
          return;
        }
        setNotice(body.error ?? "This record could not be saved.", "error");
        return;
      }
      committed = true;
      pendingMasterRecordFocusRef.current = editedRecord
        ? { kind: "record", recordView: editedRecord.view, recordId: editedRecord.id, action: "edit" }
        : { kind: "form-toggle" };
      form.reset();
      setShowForm(false);
      setEditingTeacher(null);
      setEditingGroup(null);
      setEditingRoom(null);
      try {
        if (!await loadData()) throw new Error("The record refresh was superseded after the save committed.");
        if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
        setNotice(`${viewAtSubmit.slice(0, -1)} saved to the local database.`, "success");
      } catch {
        if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
        freezeManagementWorkspace("The record was saved, but the latest master-data lists could not be loaded. Refresh before continuing.");
      }
    } catch {
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
      freezeManagementWorkspace(committed
        ? "The record was saved, but the latest data could not be loaded. Refresh before continuing."
        : "The save response was interrupted, so the result is unknown. Refresh this list before retrying.");
    } finally {
      finishManagementMutation(mutationKey, sessionRequestGeneration);
    }
  }

  async function importTeachingMembers(event: FormEvent<HTMLFormElement>) {
    // Excel 使用独立上传流程，浏览器不自行转换 JSON；服务端以同一解析规则读取原始工作簿，减少格式差异。
    event.preventDefault();
    // 工作簿上传时间较长，第一次 await 后 event.currentTarget 已不可靠；预先保存表单，导入成功后才能正常清空文件选择。
    const form = event.currentTarget;
    const formData = new FormData(form);
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) return setNotice("Choose a Teaching Members .xlsx file first.", "warning");
    const mutationKey = "teaching-members-import";
    if (!beginManagementMutation(mutationKey)) return;
    const sessionRequestGeneration = authenticatedSessionGeneration.current;
    setImporting(true);
    let committed = false;
    // 工作表名称、表头、每行内容和全部分配由服务端校验，并在一个事务中更新，失败时不会留下半份导入资料。
    try {
      const response = await fetch("/api/imports/teaching-members", { method: "POST", body: formData });
      if (protectedResponseEndedSession(response, "Your session expired. Sign in again before importing teaching allocations.", sessionRequestGeneration)) return;
      const body = await response.json().catch(() => ({})) as { error?: string; courses?: number; teachers?: number; sections?: number; zeroAllocationRows?: number; ignoredZeroRows?: number };
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
      if (!response.ok) {
        setNotice(body.error ?? "Teaching allocation import failed.", "error");
        return;
      }
      committed = true;
      form.reset();
      try {
        if (!await loadData()) throw new Error("The import refresh was superseded after the transaction committed.");
        if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
        // 新接口使用 zeroAllocationRows；部署滚动更新期间旧服务器仍可能只返回
        // ignoredZeroRows，所以仅把旧名称当兼容后备，展示语义始终是“已处理的明确零分配”。
        const zeroAllocationRows = body.zeroAllocationRows ?? body.ignoredZeroRows;
        const summary = [body.courses, body.teachers, body.sections, zeroAllocationRows].every((value) => typeof value === "number")
          ? `Imported ${body.courses} courses, ${body.teachers} teachers and ${body.sections} pre-assigned sections. ${zeroAllocationRows} explicit zero-allocation rows processed; matching existing allocations were cleared.`
          : "Teaching allocation import completed.";
        setNotice(summary, "success");
      } catch {
        if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
        freezeManagementWorkspace("Teaching allocation import completed, but the latest master-data lists could not be loaded. Refresh before continuing.");
      }
    } catch {
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
      freezeManagementWorkspace(committed
        ? "Teaching allocation import completed, but its latest result could not be loaded. Refresh before continuing."
        : "The import response was interrupted, so the result is unknown. Refresh the course and teacher lists before retrying.");
    } finally {
      if (sessionRequestIsCurrent(sessionRequestGeneration)) setImporting(false);
      finishManagementMutation(mutationKey, sessionRequestGeneration);
    }
  }

  async function addManualCourse(event: FormEvent<HTMLFormElement>) {
    // 手工课程只用于补充 Excel 遗漏项；系统建立未分配教师的班次，不伪造 teaching allocation，老师之后逐班分配。
    event.preventDefault();
    // 调用接口前保存表单节点，使成功后的重置不依赖已经失效的 React 事件对象。
    const form = event.currentTarget;
    const data = new FormData(form);
    const submittedCode = String(data.get("code") ?? "").trim().toUpperCase();
    const mutationKey = "manual-course-create";
    if (!beginManagementMutation(mutationKey)) return;
    const sessionRequestGeneration = authenticatedSessionGeneration.current;
    let committed = false;
    try {
      const response = await fetch("/api/courses", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: submittedCode, catalog: String(data.get("catalog") ?? ""), sectionCount: Number(data.get("sectionCount")) }) });
      if (protectedResponseEndedSession(response, "Your session expired. Sign in again before creating a course.", sessionRequestGeneration)) return;
      const body = await response.json().catch(() => ({})) as { error?: string; code?: string; configuredSections?: number };
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
      if (!response.ok) {
        setNotice(body.error ?? "Manual course could not be created.", "error");
        return;
      }
      committed = true;
      pendingMasterRecordFocusRef.current = { kind: "form-toggle" };
      form.reset();
      setShowForm(false);
      try {
        if (!await loadData()) throw new Error("The course refresh was superseded after manual creation committed.");
        if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
        const createdSummary = typeof body.configuredSections === "number"
          ? `${body.code ?? submittedCode} and ${body.configuredSections} unassigned sections created.`
          : `${body.code ?? submittedCode} and its unassigned sections were created.`;
        setNotice(createdSummary, "success");
      } catch {
        if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
        freezeManagementWorkspace(`${body.code ?? submittedCode} was created, but the latest course list could not be loaded. Refresh before continuing.`);
      }
    } catch {
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
      freezeManagementWorkspace(committed
        ? `${submittedCode || "The course"} was created, but its latest details could not be loaded. Refresh before continuing.`
        : "The create-course response was interrupted, so the result is unknown. Refresh the course list before retrying.");
    } finally {
      finishManagementMutation(mutationKey, sessionRequestGeneration);
    }
  }

  function closeCourseWorkspaces(courseId: string) {
    // 删除或确认课程已不存在时，只有目标课程的 Configure／Sections 工作区需要卸载；
    // 其他课程不可能在全局写锁期间被打开，因此无需清除不相关的用户上下文。
    if (editingCourse?.id === courseId) {
      setEditingCourse(null);
      setShowForm(false);
    }
    if (selectedCourse?.id === courseId) {
      setSelectedCourse(null);
      setSections([]);
      setAllocationVariances([]);
    }
  }

  async function removeCourse(course: Course) {
    // 课程拥有自动生成的班次和 Teaching Members baseline；确认框明确说明删除范围，
    // 服务端仍会保护所有已排课、学生班级和人工教师，不依赖浏览器自行判断关系。
    const allocationNote = course.allocatedSections > 0
      ? `\n• Its Teaching Members allocation baseline (${course.allocatedSections} expected section${course.allocatedSections === 1 ? "" : "s"}) will also be removed.`
      : "";
    const confirmed = window.confirm(
      `Delete ${course.code}?\n\nThis will remove:\n• The course and ${course.configuredSections} unscheduled section${course.configuredSections === 1 ? "" : "s"}.${allocationNote}\n\nScheduled lessons, student-group assignments and manually maintained teachers must be cleared first. Re-importing Teaching Members or restoring an emergency cycle backup can create the course again.`,
    );
    if (!confirmed) return;

    const mutationKey = `course-delete:${course.id}`;
    if (!beginManagementMutation(mutationKey)) return;
    const sessionRequestGeneration = authenticatedSessionGeneration.current;
    let committed = false;
    try {
      const response = await fetch(`/api/courses/${encodeURIComponent(course.id)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision: course.revision }),
      });
      if (protectedResponseEndedSession(response, "Your session expired. Sign in again before deleting a course.", sessionRequestGeneration)) return;
      // 收到 2xx 已经证明服务端提交；即使响应 JSON 随后损坏，也不能把已删除课程
      // 误报成未知结果。404 同样明确证明目标已不存在。
      committed = response.ok || response.status === 404;
      const body = await response.json().catch(() => ({})) as { code?: string; error?: string };
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;

      if (!response.ok) {
        if (response.status === 409 && body.code === "COURSE_CHANGED") {
          closeCourseWorkspaces(course.id);
          setQuery("");
          try {
            const latest = await loadData();
            if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
            if (!latest) throw new Error("The course-delete conflict refresh was superseded.");
            const targetStillExists = latest.courses.some((item) => item.id === course.id);
            pendingCourseDeleteFocusRef.current = targetStillExists
              ? { kind: "delete", courseId: course.id }
              : { kind: "search" };
            setNotice(targetStillExists
              ? `${body.error ?? `${course.code} was changed by another scheduler.`} The latest course list has now been loaded; review it before trying again.`
              : `${course.code} changed in another session and is no longer in the latest course list.`, "warning");
          } catch {
            if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
            freezeManagementWorkspace(`${course.code} changed in another session, but the latest course list could not be loaded. Refresh before making changes.`, "error");
          }
          return;
        }
        if (response.status === 409 && body.code === "COURSE_IN_USE") {
          // `confirm()` drops keyboard focus. Once the global write lock is released,
          // return it to the same stable action so keyboard users do not land on body.
          pendingCourseDeleteFocusRef.current = { kind: "delete", courseId: course.id };
          setNotice(body.error ?? "Clear this course's scheduled lessons and manual assignments before deleting it.", "warning");
          return;
        }
        if (response.status === 404) {
          closeCourseWorkspaces(course.id);
          setQuery("");
          pendingCourseDeleteFocusRef.current = { kind: "search" };
          if (!await loadData()) throw new Error("The already-deleted course refresh was superseded.");
          if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
          setNotice(`${course.code} was already removed by another scheduler.`, "warning");
          return;
        }
        setNotice(body.error ?? "The course could not be deleted.", "error");
        return;
      }

      closeCourseWorkspaces(course.id);
      setQuery("");
      pendingCourseDeleteFocusRef.current = { kind: "search" };
      try {
        if (!await loadData()) throw new Error("The course-list refresh was superseded after deletion committed.");
        if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
        setNotice(`${course.code} and its ${course.configuredSections} owned section${course.configuredSections === 1 ? "" : "s"}${course.allocatedSections > 0 ? " and Teaching Members allocation baseline" : ""} were deleted.`, "success");
      } catch {
        if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
        freezeManagementWorkspace(`${course.code} was deleted, but the latest course list could not be loaded. Refresh before continuing.`);
      }
    } catch {
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
      freezeManagementWorkspace(committed
        ? `${course.code} is no longer present, but the latest course list could not be loaded. Refresh before continuing.`
        : "The course-delete response was interrupted, so the result is unknown. Refresh the course list before retrying.");
    } finally {
      finishManagementMutation(mutationKey, sessionRequestGeneration);
    }
  }

  async function changeSectionCount(event: FormEvent<HTMLFormElement>) {
    // 减少数量只处理最高编号尾部；确认文案同时说明自动教师与 Excel baseline 的区别，
    // 避免老师误以为手工修正 section 数量也会悄悄改写来源工作簿。
    event.preventDefault();
    if (!selectedCourse) return;
    const courseAtSubmit = selectedCourse;
    const data = new FormData(event.currentTarget);
    const sectionCount = Number(data.get("sectionCount"));
    if (sectionCount < sections.length) {
      const firstRemoved = sectionCount + 1;
      const lastRemoved = sections.length;
      const removalRange = firstRemoved === lastRemoved
        ? `${courseAtSubmit.code}_${String(firstRemoved).padStart(2, "0")}`
        : `${courseAtSubmit.code}_${String(firstRemoved).padStart(2, "0")}–${courseAtSubmit.code}_${String(lastRemoved).padStart(2, "0")}`;
      const baselineNote = courseAtSubmit.allocatedSections > 0
        ? "\n\nTeaching Members allocation stays unchanged, so an allocation mismatch may appear and re-importing the unchanged file can recreate these sections."
        : "";
      if (!window.confirm(`Remove ${removalRange}?\n\nOnly unscheduled highest-numbered sections can be removed. Student groups and manually maintained teachers must be cleared first; automatic allocation teachers can be removed with their sections.${baselineNote}`)) return;
    }
    const mutationKey = `section-count:${courseAtSubmit.id}`;
    if (!beginManagementMutation(mutationKey)) return;
    const sessionRequestGeneration = authenticatedSessionGeneration.current;
    let committed = false;
    try {
      const response = await fetch(`/api/courses/${encodeURIComponent(courseAtSubmit.id)}/sections`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        // 课程 revision 是老师打开 Sections 面板时看到的版本。导入、课程设置或另一位
        // 老师先调整班次数量后，服务器会拒绝这个旧基准，避免依据旧总数误删新版班次。
        body: JSON.stringify({ sectionCount, revision: courseAtSubmit.revision }),
      });
      if (protectedResponseEndedSession(response, "Your session expired. Sign in again before changing section count.", sessionRequestGeneration)) return;
      const body = await response.json().catch(() => ({})) as { code?: string; error?: string };
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
      if (!response.ok) {
        if (response.status === 404) {
          // 新周期会原子删除全部课程；从旧画面提交到404时，不只是当前课程过期，
          // 整张课程清单都可能已被替换，必须卸载可编辑 workspace 后完整刷新。
          freezeManagementWorkspace(`${body.error ?? `${courseAtSubmit.code} is no longer available.`} Refresh the master-data workspace before continuing.`, "error");
          return;
        }
        if (response.status === 409 && body.code === "COURSE_SETUP_CHANGED") {
          try {
            // loadData 返回本次 GET 的实际对象；不能紧接着从 React courses state 读取，
            // 因为它仍可能是提交前的旧 render。openSections 也必须收到这个最新版 course。
            const latest = await loadData();
            if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
            if (!latest) throw new Error("The section-count conflict refresh was superseded.");
            const latestCourse = latest.courses.find((course) => course.id === courseAtSubmit.id);
            if (!latestCourse || !await openSections(latestCourse, false)) throw new Error("Latest course details could not be loaded.");
            if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
            setNotice(`${body.error ?? `${courseAtSubmit.code} was changed by another scheduler.`} The latest course and sections have been loaded; review the count before trying again.`, "warning");
            window.requestAnimationFrame(() => sectionCountInputRef.current?.focus());
          } catch {
            // 旧课程对象已经明确过期；只要最新版课程或班次读取不完整，就必须卸载整个可编辑工作区。
            if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
            freezeManagementWorkspace(`${courseAtSubmit.code} changed in another session, but its latest course details could not be loaded. Refresh before making changes.`, "error");
          }
          return;
        }
        if (response.status === 409 && body.code === "COURSE_SECTION_IN_USE") {
          setNotice(body.error ?? "Clear the protected tail-section work before reducing the section count.", "warning");
          window.requestAnimationFrame(() => sectionCountInputRef.current?.focus());
          return;
        }
        setNotice(body.error ?? "Section count could not be changed.", "error");
        window.requestAnimationFrame(() => sectionCountInputRef.current?.focus());
        return;
      }
      committed = true;
      try {
        // PATCH 成功也可能提高 course revision；从同一轮刷新结果取得新对象，再用它
        // 重开班次面板，避免 selectedCourse 留着旧 revision 导致下一次调整产生假冲突。
        const latest = await loadData();
        if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
        if (!latest) throw new Error("The section-count refresh was superseded after the change committed.");
        const latestCourse = latest.courses.find((course) => course.id === courseAtSubmit.id);
        if (!latestCourse || !await openSections(latestCourse, false)) throw new Error("Sections could not be refreshed.");
        if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
        setNotice(`${latestCourse.code} now has ${latestCourse.configuredSections} section${latestCourse.configuredSections === 1 ? "" : "s"}.${latestCourse.allocationVarianceCount > 0 ? " Teaching Members allocation differs from the current sections; review the mismatch below." : ""}`, "success");
        window.requestAnimationFrame(() => sectionCountInputRef.current?.focus());
      } catch {
        // 保存已经提交后，旧对象不能继续作为可编辑基准；隐藏工作区直到完整重载。
        if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
        freezeManagementWorkspace(`${courseAtSubmit.code} section count was changed, but the latest course details could not be loaded. Refresh before changing it again.`);
      }
    } catch {
      // 连接中断时无法知道 PATCH 是否到达提交边界。冻结旧 revision，避免老师在
      // 结果未知时继续缩减班次或重复保存一笔其实已经提交的变更。
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
      freezeManagementWorkspace(committed
        ? `${courseAtSubmit.code} section count was changed, but its latest details could not be loaded. Refresh before continuing.`
        : "The section-count response was interrupted, so the result is unknown. Refresh the course sections before retrying.");
    } finally {
      finishManagementMutation(mutationKey, sessionRequestGeneration);
    }
  }

  async function saveCourseSetup(event: FormEvent<HTMLFormElement>) {
    // 课程清单每次只打开一门课的设置，避免老师同时面对 52 门课程的大量必填规则。
    event.preventDefault();
    if (!editingCourse) return;
    if (savingCourseSetupIdRef.current || managementMutationKeyRef.current) {
      setNotice("A course setup is already being saved. Wait for it to finish.", "warning");
      return;
    }
    // 提交瞬间保存稳定课程对象，并同步锁住所有 Configure 入口。只用 React state
    // 无法挡住同一事件循环内的快速双击，第二个请求会把首个成功伪装成409冲突。
    const courseAtSubmit = editingCourse;
    savingCourseSetupIdRef.current = courseAtSubmit.id;
    setSavingCourseSetupId(courseAtSubmit.id);
    // Course Setup 使用自己的即时锁而不是 managementMutationKey；仍必须主动废弃此前
    // 已发出的 Sections／workspace 读取，防止保存完成后旧响应覆盖新的 course revision。
    visibleWorkspaceRefreshNumber.current += 1;
    activeManualTimetableRefreshNumber.current = null;
    const sessionRequestGeneration = authenticatedSessionGeneration.current;
    const data = new FormData(event.currentTarget);
    let committed = false;
    try {
      const response = await fetch(`/api/courses/${encodeURIComponent(courseAtSubmit.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // 表单打开时的课程 revision 与全部设置一起提交；另一账号若已先保存，
          // 服务端会返回稳定 409，而不是让当前旧表单覆盖对方的新内容。
          revision: courseAtSubmit.revision,
          durationHours: Number(data.get("durationHours")),
          sessionsPerWeek: Number(data.get("sessionsPerWeek")),
          primaryYear: data.get("primaryYear") ? Number(data.get("primaryYear")) : null,
          minimumRoomCapacity: data.get("minimumRoomCapacity") ? Number(data.get("minimumRoomCapacity")) : null,
          requiresLab: Boolean(data.get("requiresLab")),
          requiresMultiProjector: Boolean(data.get("requiresMultiProjector")),
          requiresSmartClassroom: Boolean(data.get("requiresSmartClassroom")),
          separateSectionsAcrossDays: Boolean(data.get("separateSectionsAcrossDays")),
          // 起止周都留空表示每周上课；否则必须同时提供，并把开始周和结束周都包含在教学区间内。
          weekStart: data.get("weekStart") ? Number(data.get("weekStart")) : null,
          weekEnd: data.get("weekEnd") ? Number(data.get("weekEnd")) : null,
        }),
      });
      if (protectedResponseEndedSession(response, "Your session expired. Sign in again before saving course setup.", sessionRequestGeneration)) return;
      committed = response.ok;
      const body = await response.json().catch(() => ({})) as { code?: string; error?: string };
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
      if (!response.ok) {
        if (response.status === 404) {
          // Course Setup 的目标消失通常表示另一进程已开始新周期；旧 courses state
          // 不能继续 Configure 或 Sections，因此直接进入唯一安全恢复入口。
          setShowForm(false);
          setEditingCourse(null);
          freezeManagementWorkspace(`${body.error ?? `${courseAtSubmit.code} is no longer available.`} Refresh the master-data workspace before continuing.`, "error");
          return;
        }
        if (response.status === 409 && body.code === "COURSE_SETUP_CHANGED") {
          // 旧表单已经不可信，关闭它并重新载入课程清单；老师再次点 Configure 时
          // 会看到赢家版本，不会在不知道变化的情况下直接重试覆盖。
          try {
            if (!await loadData()) throw new Error("The course-setup conflict refresh was superseded.");
            if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
            setNotice("This course setup was changed by another scheduler. The latest setup has been loaded; reopen Configure to review it.", "warning");
          } catch {
            if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
            setShowForm(false);
            setEditingCourse(null);
            freezeManagementWorkspace("This course setup was changed by another scheduler, but the latest setup could not be loaded. Refresh before editing it again.", "error");
            return;
          }
          setShowForm(false);
          setEditingCourse(null);
          restoreCourseConfigureFocus(courseAtSubmit.id, true);
          return;
        }
        return setNotice(body.error ?? "Course setup could not be saved.", "error");
      }
      try {
        if (!await loadData()) throw new Error("The course-setup refresh was superseded after the save committed.");
        if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
      } catch {
        // PATCH 已经明确返回成功时不能再说“保存失败”。关闭持有旧 revision 的表单，
        // 并准确说明只有刷新清单失败，避免老师重复提交已经保存的配置。
        if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
        setShowForm(false);
        setEditingCourse(null);
        freezeManagementWorkspace(`${courseAtSubmit.code} setup was saved, but the latest course list could not be loaded. Refresh before continuing.`);
        return;
      }
      setShowForm(false);
      setEditingCourse(null);
      restoreCourseConfigureFocus(courseAtSubmit.id, true);
      setNotice(`${courseAtSubmit.code} setup saved. Its generated sections will use these requirements.`, "success");
    } catch {
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
      if (committed) {
        setShowForm(false);
        setEditingCourse(null);
      }
      freezeManagementWorkspace(committed
        ? `${courseAtSubmit.code} setup was saved, but the latest course list could not be loaded. Refresh before continuing.`
        : "The course-setup response was interrupted, so the result is unknown. Refresh the course list before retrying.");
    } finally {
      if (sessionRequestIsCurrent(sessionRequestGeneration) && savingCourseSetupIdRef.current === courseAtSubmit.id) {
        savingCourseSetupIdRef.current = null;
        setSavingCourseSetupId(null);
      }
    }
  }

  async function openSections(course: Course, showFailureNotice = true, focusSectionCount = false) {
    // currentCourse、班次和 allocation variance 由同一个服务端快照返回；每次点击
    // 也领取 generation，较慢的上一门课程不能在后来点击或导航后重新打开自己。
    const requestNumber = ++visibleWorkspaceRefreshNumber.current;
    activeManualTimetableRefreshNumber.current = requestNumber;
    const sessionRequestGeneration = authenticatedSessionGeneration.current;
    try {
      const response = await fetch(`/api/courses/${encodeURIComponent(course.id)}/workspace`, { cache: "no-store" });
      if (protectedResponseEndedSession(response, "Your session expired. Sign in again before opening course sections.", sessionRequestGeneration)) return false;
      if (response.status === 404) {
        // 只有新周期或另一账号移除课程后才会从既有清单点击到404；此时整张旧课程表
        // 都已知不可信，不能只关掉详情并继续允许 Configure／Sections。
        if (requestNumber === visibleWorkspaceRefreshNumber.current) {
          freezeManagementWorkspace(`${course.code} is no longer available. Refresh the master-data workspace before continuing.`, "error");
        }
        return false;
      }
      if (!response.ok) throw new Error("Course sections workspace request failed.");
      const workspace = await response.json() as CourseSectionsWorkspace;
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return false;
      if (!workspace.currentCourse || !Array.isArray(workspace.sections) || !Array.isArray(workspace.allocationVariances)) {
        throw new Error("Course sections workspace response was incomplete.");
      }
      if (requestNumber !== visibleWorkspaceRefreshNumber.current) return false;
      setSections(workspace.sections);
      setAllocationVariances(workspace.allocationVariances);
      // 面板必须使用响应里的 currentCourse，而不是点击时闭包捕获的旧 revision。
      setSelectedCourse(workspace.currentCourse);
      setCourses((currentCourses) => {
        const currentIndex = currentCourses.findIndex((item) => item.id === workspace.currentCourse.id);
        if (currentIndex < 0) return [...currentCourses, workspace.currentCourse].sort((left, right) => left.code.localeCompare(right.code));
        return currentCourses.map((item) => item.id === workspace.currentCourse.id ? workspace.currentCourse : item);
      });
      setShowForm(false);
      setEditingCourse(null);
      if (focusSectionCount) window.requestAnimationFrame(() => sectionCountInputRef.current?.focus());
      return true;
    } catch {
      // 已被更新 generation 取代的请求保持安静；只有仍属当前画面的失败可以写提示。
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return false;
      if (showFailureNotice && requestNumber === visibleWorkspaceRefreshNumber.current) {
        setNotice("Course sections could not be loaded. Check the connection and try again.", "error");
      }
      return false;
    } finally {
      if (activeManualTimetableRefreshNumber.current === requestNumber) {
        activeManualTimetableRefreshNumber.current = null;
      }
    }
  }

  async function saveSection(event: FormEvent<HTMLFormElement>, section: CourseSection) {
    // 勾选的学生班级会成为该班次之后所有学生冲突、每日时数和个人课表检查的范围；
    // revision 让服务器确认老师保存的正是当前看到的这一版资料。
    event.preventDefault();
    if (savingSectionIdRef.current) {
      setNotice("A section assignment is already being saved. Wait for it to finish.", "warning");
      return;
    }
    const mutationKey = `section-assignment:${section.id}`;
    if (!beginManagementMutation(mutationKey)) return;
    savingSectionIdRef.current = section.id;
    setSavingSectionId(section.id);
    const data = new FormData(event.currentTarget);
    const courseAtStart = selectedCourse;
    const sessionRequestGeneration = authenticatedSessionGeneration.current;
    let committed = false;
    try {
      const response = await fetch(`/api/course-sections/${encodeURIComponent(section.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          teacherId: String(data.get("teacherId") ?? "") || null,
          studentGroupIds: data.getAll("studentGroupIds").map(String),
          revision: section.revision,
        }),
      });
      if (protectedResponseEndedSession(response, "Your session expired. Sign in again before saving a section assignment.", sessionRequestGeneration)) return;
      const body = await response.json().catch(() => ({})) as { error?: string; allocationVariances?: AllocationVariance[] };
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
      if (!response.ok) {
        if (response.status === 404) {
          // 另一进程开始新周期后，旧 section ID 会稳定404。不能只提示并让同一面板
          // 继续保存其他已删除班次；load-error 会卸载整套旧课程与关联表单。
          freezeManagementWorkspace(`${body.error ?? `${section.label} is no longer available.`} Refresh the master-data workspace before continuing.`, "error");
          return;
        }
        // 409 表示另一位老师已经先保存；强制重新读取并用 revision 作为 form key，
        // 让非受控下拉框和复选框也立刻显示最新资料，而不是继续保留旧选择。
        const latestLoaded = response.status === 409 && courseAtStart ? await openSections(courseAtStart, false) : true;
        if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
        if (response.status === 409 && !latestLoaded) {
          freezeManagementWorkspace(`${body.error ?? "Section changed in another session."} The latest section details could not be loaded; refresh before editing again.`, "error");
          return;
        }
        setNotice(latestLoaded
          ? body.error ?? "Section could not be saved."
          : `${body.error ?? "Section changed in another session."} The latest section details could not be loaded; refresh before editing again.`, "error");
        if (response.status === 409) restoreSectionAssignmentFocus(section.id);
        return;
      }
      committed = true;
      const latestLoaded = courseAtStart ? await openSections(courseAtStart, false) : true;
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
      if (!latestLoaded) {
        freezeManagementWorkspace(`${section.label} assignment was saved, but the latest section details could not be loaded. Refresh before editing it again.`);
        return;
      }
      restoreSectionAssignmentFocus(section.id);
      if (!Array.isArray(body.allocationVariances)) {
        setNotice(`${section.label} assignment was saved and reloaded, but the allocation summary was missing from the response. Refresh before relying on the mismatch count.`, "warning");
        return;
      }
      const mismatchCount = body.allocationVariances?.length ?? 0;
      setNotice(mismatchCount ? `${section.label} saved. Teaching allocation now has ${mismatchCount} teacher count mismatch${mismatchCount === 1 ? "" : "es"}.` : `${section.label} assignment saved and matches the Teaching Members counts.`, mismatchCount ? "warning" : "success");
    } catch {
      // 请求中断时不能断言数据库没有写入；旧班次和旧 course revision 都不可再编辑，
      // 必须先通过唯一 Refresh 入口取得新的原子 workspace 后才能决定是否重试。
      if (!sessionRequestIsCurrent(sessionRequestGeneration)) return;
      freezeManagementWorkspace(committed
        ? `${section.label} assignment was saved, but the latest section details could not be loaded. Refresh before continuing.`
        : "The section-save response was interrupted, so the result is unknown. Refresh the section before retrying.");
    } finally {
      if (sessionRequestIsCurrent(sessionRequestGeneration) && savingSectionIdRef.current === section.id) {
        savingSectionIdRef.current = null;
        setSavingSectionId(null);
      }
      finishManagementMutation(mutationKey, sessionRequestGeneration);
    }
  }

  // 页面主按钮根据当前资料类型自动显示新增教师、班级、教室或导入课程，减少需要记忆的不同操作入口。
  const actionLabel = view === "Student groups" ? "Add student group" : view === "Courses" ? "Import or add course" : `Add ${view.slice(0, -1).toLowerCase()}`;
  const isDataManagementView = !["Year timetables", "Personal timetables", "Rules & issues", "Cycle", "Accounts", "Profile"].includes(view);
  // 页面标题集中映射，避免在 JSX 中重复多层三元判断；基础开发人员可直接在同一区块核对每个 Workspace 的说明。
  const pageEyebrow = view === "Year timetables" ? "Year timetables"
    : view === "Personal timetables" ? "Personal timetables"
      : view === "Rules & issues" ? "Rules & issues"
        : view === "Cycle" ? "Cycle safety"
          : view === "Accounts" ? "Administration"
            : view === "Profile" ? "My account"
              : "Data management";
  const pageTitle = view === "Year timetables" ? `Year ${timetableYear} scheduling workspace`
    : view === "Personal timetables" ? "View a teacher or class timetable"
      : view === "Rules & issues" ? "Review rules and timetable issues"
        : view === "Cycle" ? "Start a new scheduling cycle safely"
          : view === "Accounts" ? "Manage scheduler accounts"
            : view === "Profile" ? "Change my password"
              : "Build the scheduling foundation";
  const pageDescription = view === "Year timetables" ? "Choose a session, place it, and resolve issues without leaving this workspace."
    : view === "Personal timetables" ? "Read the same saved schedule across years for one teacher, student group or room."
      : view === "Rules & issues" ? "Maintain unavailable windows and review every current warning in one place."
        : view === "Cycle" ? "Back up and clear only cycle data, or restore the latest emergency snapshot."
          : view === "Accounts" ? "Create individual logins for the small scheduling team."
            : view === "Profile" ? "Changing your password signs out all existing sessions for this account."
              : "Maintain teachers, student groups and rooms before importing teaching allocations or placing course sections.";
  const personalIssueTone = personalLessons.some((lesson) => lesson.warningSeverity === "High") ? "red"
    : personalLessons.some((lesson) => lesson.warningSeverity === "Warning") ? "amber"
      : personalLessons.some((lesson) => lesson.warningSeverity === "Advisory") ? "blue"
        : "green";
  const personalIssueLabel = personalIssueTone === "red" ? "Has serious issues"
    : personalIssueTone === "amber" ? "Has warnings"
      : personalIssueTone === "blue" ? "Has advisories"
        : "No saved issues";

  if (authScreen !== "ready") {
    // 未登录浏览器看不到任何排课资料；数据库尚无账号时，同一画面改为建立首位管理员。
    return (
      <main className="grid min-h-screen place-items-center bg-[#f6f8fb] p-6 text-slate-900">
        <div className="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-7 shadow-xl">
          <div className="mb-6 flex items-center gap-3">
            <div className="grid h-11 w-11 place-items-center rounded-xl bg-[#153d75] font-black text-white">NP</div>
            <div>
              <p className="font-black">ICT Timetabling</p>
              <p className="text-xs text-slate-500">Department scheduling workspace</p>
            </div>
          </div>
          {authScreen === "checking" ? (
            <p className="text-sm text-slate-500">Checking secure session...</p>
          ) : authScreen === "load-error" ? (
            <div>
              <h1 className="text-2xl font-black">Workspace unavailable</h1>
              <p className="mt-2 text-sm leading-6 text-slate-500">
                {workspaceLoadErrorDetail ?? "The secure session or scheduling data could not be loaded. No editable empty workspace has been opened."}
              </p>
              <button ref={loadErrorRefreshButtonRef} onClick={() => window.location.reload()} className="mt-5 w-full rounded-xl bg-[#153d75] px-4 py-3 font-bold text-white" type="button">Refresh and try again</button>
            </div>
          ) : (
            <form onSubmit={submitAuthentication}>
              <h1 className="text-2xl font-black">{authScreen === "setup" ? "Create the administrator" : "Sign in"}</h1>
              <p className="mt-2 text-sm leading-6 text-slate-500">
                {authScreen === "setup" ? "This first account can create the small team of scheduler accounts." : "Use your department scheduler account."}
              </p>
              <div className="mt-5 grid gap-3">
                <label className="text-sm font-semibold">
                  Username
                  <input name="username" required minLength={3} autoComplete="username" className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2.5 font-normal" />
                </label>
                <label className="text-sm font-semibold">
                  Password
                  <input
                    name="password"
                    required
                    minLength={10}
                    autoComplete={authScreen === "setup" ? "new-password" : "current-password"}
                    type="password"
                    className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2.5 font-normal"
                  />
                </label>
                {authScreen === "setup" && (
                  <label className="text-sm font-semibold">
                    Deployment setup token
                    <input
                      name="setupToken"
                      maxLength={512}
                      autoComplete="off"
                      type="password"
                      className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2.5 font-normal"
                    />
                    <span className="mt-1.5 block text-xs font-normal leading-5 text-slate-500">
                      Required for the first production setup: enter Railway&apos;s TIMETABLING_SETUP_TOKEN. Leave blank only in local development when that variable is not configured.
                    </span>
                  </label>
                )}
              </div>
              <button disabled={authenticationSubmitting} className="mt-5 w-full rounded-xl bg-[#153d75] px-4 py-3 font-bold text-white disabled:cursor-wait disabled:opacity-60" type="submit">
                {authenticationSubmitting
                  ? (authScreen === "setup" ? "Creating administrator…" : "Signing in…")
                  : (authScreen === "setup" ? "Create administrator" : "Sign in")}
              </button>
            </form>
          )}
          {/* 登录／首次设置还没有主工作台的顶部 toast，因此这里本身必须提供正确
              颜色与 live-region 语义；错误不能永远显示成 amber，也不能让读屏器
              在 setup token 或密码失败后完全听不到反馈。 */}
          <p
            role={noticeTone === "error" ? "alert" : "status"}
            aria-live={noticeTone === "error" ? "assertive" : "polite"}
            aria-atomic="true"
            className={`mt-4 text-xs ${noticeTone === "error" ? "text-red-700" : noticeTone === "success" ? "text-emerald-700" : noticeTone === "warning" ? "text-amber-700" : "text-blue-700"}`}
          >
            {notice}
          </p>
        </div>
      </main>
    );
  }

  // 桌面端年级排课工作区占满可视高度：Workspace 已移到顶栏，总表默认占据页面安全边距之外的全部宽度，待排抽屉只在需要时临时加入左栏。
  // Inspector 浮在总表右侧并独立滚动；操作提示固定在顶部且可关闭，避免遮住 Inspector 底部的保存按钮。
  return (
    <main className={`min-h-screen bg-[#f6f8fb] text-slate-900 ${view === "Year timetables" ? "lg:flex lg:h-screen lg:min-h-0 lg:flex-col lg:overflow-hidden" : ""}`}>
      {/* Workspace 进入顶栏后，操作提示改放在顶栏下方中央，只覆盖无操作的页面标题；这样不会挡住菜单、账号、总表工具栏或 Inspector。 */}
      {notice && showNoticeToast && (
        <div className="pointer-events-none fixed left-1/2 top-28 z-30 flex w-[calc(100%-1.5rem)] max-w-md -translate-x-1/2 justify-center md:top-16">
          {/* Inspector 使用更高层级；在窄窗口两者相交时，课程编辑和关闭按钮仍然位于提示之上且可以操作。 */}
          <div
            key={noticeRequestNumber}
            role={noticeTone === "error" ? "alert" : "status"}
            aria-live={noticeTone === "error" ? "assertive" : "polite"}
            aria-atomic="true"
            className={`pointer-events-auto flex max-h-32 w-full items-start gap-3 overflow-hidden rounded-xl border px-4 py-3 text-sm font-semibold shadow-lg ${noticeToneClasses(noticeTone)}`}
          >
            <span className="sr-only">System status: </span>
            <p className="min-w-0 flex-1 overflow-y-auto leading-5">{notice}</p>
            <button
              onClick={() => setShowNoticeToast(false)}
              className="-mr-1 shrink-0 rounded-md px-2 py-1 text-base leading-none opacity-70 hover:bg-black/5 hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-current"
              type="button"
              aria-label="Dismiss notification"
            >
              ×
            </button>
          </div>
        </div>
      )}
      {/* 顶栏同时容纳系统身份、Workspace 菜单和当前账号；桌面端保持单行以保留课表高度，窄屏时只有菜单换到下一行并自行横向滚动。 */}
      <header className="shrink-0 border-b border-slate-200 bg-white">
        <div className={`mx-auto flex flex-wrap items-center gap-x-3 gap-y-2 py-2 ${view === "Year timetables" ? "w-full px-3" : "w-full max-w-7xl px-3 sm:px-6"}`}>
          <div className="flex shrink-0 items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-[#153d75] text-sm font-black tracking-tight text-white">NP</div>
            <div>
              <p className="text-sm font-bold tracking-tight text-slate-950">ICT Timetabling</p>
              <p className="hidden text-xs text-slate-500 sm:block">Department scheduling workspace</p>
            </div>
          </div>

          {/* 菜单按钮不换行也不压缩；如果电脑窗口不足，只有这个 nav 区域横向滚动，账号和退出按钮始终留在画面中。 */}
          <nav className="order-3 w-full min-w-0 overflow-x-auto border-t border-slate-100 pt-1.5 md:order-none md:w-auto md:flex-1 md:border-t-0 md:pt-0" aria-label="Workspace">
            <div className="flex w-max items-center gap-1">
              <WorkspaceMenuButton active={view === "Year timetables"} disabled={workspaceNavigationLocked} icon="▦" label="Year timetables" onClick={() => void openTimetable(timetableYear)} />
              <WorkspaceMenuButton active={view === "Personal timetables"} disabled={workspaceNavigationLocked} icon="▥" label="Personal timetables" onClick={() => void loadPersonalTimetable(personalKind, personalOwnerId)} />
              <WorkspaceMenuButton active={view === "Courses"} disabled={workspaceNavigationLocked} icon="◫" label="Courses" onClick={() => openView("Courses")} />
              <WorkspaceMenuButton active={["Teachers", "Student groups", "Rooms"].includes(view)} disabled={workspaceNavigationLocked} icon="▤" label="Data management" onClick={() => openView("Teachers")} />
              <WorkspaceMenuButton active={view === "Rules & issues"} disabled={workspaceNavigationLocked} icon="◌" label="Rules & issues" onClick={() => void openRules()} />
              <WorkspaceMenuButton active={view === "Cycle"} disabled={workspaceNavigationLocked} icon="↻" label="New cycle & recovery" onClick={() => void openCycle()} />
              {currentUser?.isAdmin && <WorkspaceMenuButton active={view === "Accounts"} disabled={workspaceNavigationLocked} icon="⚿" label="Accounts" onClick={() => void openAccounts()} />}
            </div>
          </nav>

          {/* 超宽屏显示同步与班次数量；一般电脑优先把有限宽度交给导航，资料不会丢失，页面定时刷新逻辑仍然照常运行。 */}
          <div className="hidden shrink-0 items-center gap-2 2xl:flex">
            <Pill tone="amber">Draft · {courses.reduce((total, course) => total + course.configuredSections, 0)} sections</Pill>
            <span className="text-xs text-slate-400">{lastSyncedAt ? `Synced ${lastSyncedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}` : "Sync starting"}</span>
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-2 md:ml-0">
            <button disabled={workspaceNavigationLocked} onClick={() => openView("Profile")} className="max-w-24 truncate text-sm font-bold text-slate-700 hover:text-blue-700 disabled:cursor-wait disabled:opacity-50" type="button">{currentUser?.username}</button>
            <button disabled={workspaceNavigationLocked} onClick={() => void logout()} className="rounded-lg border border-slate-200 px-2 py-1.5 text-xs font-semibold text-slate-600 disabled:cursor-wait disabled:opacity-50" type="button">Sign out</button>
          </div>
        </div>
      </header>

      {/* 左侧导航已经移除，内容区现在是真正的单栏；年级总表取得原来 140px 导航列及间距，资料页面也取得原来 220px 导航列。 */}
      <div className={`mx-auto ${view === "Year timetables" ? "flex w-full max-w-none flex-col gap-3 px-3 py-3 lg:min-h-0 lg:flex-1" : "w-full max-w-7xl px-6 py-8"}`}>
        <section className={`min-w-0 ${view === "Year timetables" ? "flex flex-col lg:min-h-0 lg:flex-1" : ""}`}>
          {/* 页面标题说明当前任务；右侧只保留与当前资料类型对应的主要操作，减少误点。 */}
          <div className={`${view === "Year timetables" ? "mb-3" : "mb-6"} flex flex-col justify-between gap-4 sm:flex-row sm:items-end`}>
            <div>
              <p className="text-sm font-semibold text-blue-700">{pageEyebrow}</p>
              <h1 className={`${view === "Year timetables" ? "text-2xl" : "mt-1 text-3xl"} font-black tracking-tight text-slate-950`}>{pageTitle}</h1>
              <p className={`${view === "Year timetables" ? "mt-1" : "mt-2"} max-w-2xl text-sm leading-6 text-slate-500`}>{pageDescription}</p>
            </div>
            {isDataManagementView && (
              <button
                ref={dataManagementFormToggleButtonRef}
                onClick={toggleForm}
                disabled={savingCourseSetupId !== null || managementMutationKey !== null}
                className="rounded-xl bg-[#153d75] px-4 py-2.5 text-sm font-bold text-white shadow-sm transition hover:bg-[#0f315f] disabled:cursor-wait disabled:opacity-60"
                type="button"
              >
                {showForm ? "Close form" : `+ ${actionLabel}`}
              </button>
            )}
          </div>

          {isDataManagementView && <div className="mb-6 grid gap-4 sm:grid-cols-3">
            {/* 汇总数字让老师快速确认教师、学生班级和预生成班次是否准备完成，再开始正式排课。 */}
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"><p className="text-sm text-slate-500">Teachers</p><p className="mt-1 text-2xl font-black">{teachers.length}</p><p className="mt-1 text-xs text-amber-700">{teachers.filter((teacher) => teacher.staffType === "PT").length} PT priority teachers</p></div>
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"><p className="text-sm text-slate-500">Student groups</p><p className="mt-1 text-2xl font-black">{groups.length}</p><p className="mt-1 text-xs text-slate-500">Across Years 1–3</p></div>
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"><p className="text-sm text-slate-500">Course sections</p><p className="mt-1 text-2xl font-black">{courses.reduce((total, course) => total + course.configuredSections, 0)}</p><p className="mt-1 text-xs text-slate-500">Pre-generated from allocation</p></div>
          </div>}

          {view === "Personal timetables" && (
            /* 教师、学生班级和教室三种个人课表都读取同一批已保存课程，不复制资料，避免不同视图出现不一致。 */
            <div className="mb-6 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="mb-4 grid gap-3 sm:grid-cols-2">
                <label className="text-xs font-semibold text-slate-700">
                  View by
                  <select value={personalKind} onChange={(event) => void loadPersonalTimetable(event.target.value as "Teacher" | "StudentGroup" | "Room")} className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm">
                    <option value="Teacher">Teacher</option>
                    <option value="StudentGroup">Student group</option>
                    <option value="Room">Room</option>
                  </select>
                </label>
                <label className="text-xs font-semibold text-slate-700">
                  {personalKind === "Teacher" ? "Teacher" : personalKind === "Room" ? "Room" : "Student group"}
                  <select value={personalOwnerId} onChange={(event) => void loadPersonalTimetable(personalKind, event.target.value)} className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm">
                    {personalKind === "Teacher" && teachers.filter((teacher) => teacher.status === "Active").map((teacher) => <option key={teacher.id} value={teacher.id}>{teacher.name} ({teacher.staffType})</option>)}
                    {personalKind === "Teacher" && teachers.filter((teacher) => teacher.status === "Inactive").map((teacher) => <option key={teacher.id} value={teacher.id}>{teacher.name} ({teacher.staffType}, Inactive)</option>)}
                    {personalKind === "StudentGroup" && groups.map((group) => <option key={group.id} value={group.id}>{group.code} · Year {group.year}</option>)}
                    {personalKind === "Room" && rooms.filter((room) => room.status === "Active").map((room) => <option key={room.id} value={room.id}>{room.code} · {room.capacity} seats</option>)}
                    {personalKind === "Room" && rooms.filter((room) => room.status === "Inactive").map((room) => <option key={room.id} value={room.id}>{room.code} · {room.capacity} seats · Inactive</option>)}
                  </select>
                </label>
              </div>
              <div className="mb-3 flex items-center justify-between">
                <div><p className="font-black text-slate-950">Weekly timetable</p><p className="text-xs text-slate-500">{personalLessons.length} scheduled lessons across all year master tables</p></div>
                <Pill tone={personalIssueTone}>{personalIssueLabel}</Pill>
              </div>
              <WeeklyTimetableGrid
                lessons={personalLessons}
                renderLesson={(lesson) => {
                  // 个人课表沿用总表的跨小时布局但保持只读；卡片只显示与当前查看对象最有关联的教师或教室信息。
                  const issueClasses = lessonIssueClasses(lesson.warningSeverity);
                  const relatedResource = personalKind === "Teacher" ? lesson.roomCode ?? "Room pending"
                    : personalKind === "Room" ? lesson.teacherName ?? "Teacher pending"
                      : `${lesson.teacherName ?? "Teacher pending"} · ${lesson.roomCode ?? "Room pending"}`;
                  return (
                    <div className={`h-full overflow-y-auto rounded-md p-2 shadow-sm ${issueClasses.card}`}>
                      <p className="font-black">{lesson.sectionLabel} · {lesson.durationHours}h</p>
                      <p className="mt-1 font-semibold">
                        {String(lesson.startHour).padStart(2, "0")}:00–{String(lesson.startHour + lesson.durationHours).padStart(2, "0")}:00
                      </p>
                      <p className="mt-1">{relatedResource}</p>
                      {lesson.warnings.length > 0 && (
                        <p className={`mt-1 ${issueClasses.message}`}>
                          ⚠ {lesson.warnings.length} issue{lesson.warnings.length === 1 ? "" : "s"}
                        </p>
                      )}
                    </div>
                  );
                }}
              />
            </div>
          )}

          {view === "Year timetables" && (
            // Master timetable 始终是唯一长期占据宽度的主栏；待排抽屉只在用户主动打开时加入左栏，关闭后不保留任何空白列。
            <div className={`relative grid gap-2 lg:min-h-0 lg:flex-1 ${showUnscheduledDrawer ? "lg:grid-cols-[220px_minmax(0,1fr)] xl:grid-cols-[240px_minmax(0,1fr)]" : "lg:grid-cols-1"}`}>
              {showUnscheduledDrawer && <aside
                id="unscheduled-drawer"
                className="flex max-h-[420px] min-h-0 flex-col rounded-2xl border border-slate-200 bg-white p-3 shadow-lg lg:max-h-none"
                aria-labelledby="unscheduled-drawer-title"
                onKeyDown={(event) => {
                  if (event.key === "Escape" && lessonMutation === null && placingSessionKey === null) closeUnscheduledDrawerAndRestoreFocus();
                }}
              >
                <div className="mb-2 flex items-start justify-between gap-2">
                  <div><p id="unscheduled-drawer-title" className="font-bold text-slate-950">Unscheduled sessions</p><p className="text-xs text-slate-500">{filteredUnscheduledSections.length} of {unscheduledSections.length} ready to place</p></div>
                  <button ref={unscheduledCloseButtonRef} disabled={lessonMutation !== null || placingSessionKey !== null} onClick={closeUnscheduledDrawerAndRestoreFocus} className="rounded-md px-2 py-1 text-xs font-bold text-slate-500 hover:bg-slate-100 hover:text-slate-900 disabled:cursor-wait disabled:opacity-50" type="button" aria-label="Close unscheduled sessions">Close</button>
                </div>
                {/* 待排筛选直接处理当前年级已加载资料；即使有数百个班次也能即时缩小范围，不产生额外接口请求。 */}
                <div className="mb-2 grid shrink-0 gap-2 rounded-xl bg-slate-50 p-2">
                  <input value={unscheduledQuery} onChange={(event) => setUnscheduledQuery(event.target.value)} placeholder="Course or teacher..." className="rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs" />
                  <div className="grid grid-cols-2 gap-2">
                    <select value={unscheduledStaffType} onChange={(event) => setUnscheduledStaffType(event.target.value as "All" | "FT" | "PT")} className="rounded-lg border border-slate-200 bg-white px-2 py-2 text-xs">
                      <option value="All">FT + PT</option>
                      <option value="PT">PT priority</option>
                      <option value="FT">FT only</option>
                    </select>
                    <select value={unscheduledProgram} onChange={(event) => setUnscheduledProgram(event.target.value)} className="rounded-lg border border-slate-200 bg-white px-2 py-2 text-xs">
                      <option value="">All programmes</option>
                      {unscheduledPrograms.map((program) => <option key={program} value={program}>{program}</option>)}
                    </select>
                  </div>
                  <select value={unscheduledGroupId} onChange={(event) => setUnscheduledGroupId(event.target.value)} className="rounded-lg border border-slate-200 bg-white px-2 py-2 text-xs"><option value="">All student groups</option>{groups.map((group) => <option key={group.id} value={group.id}>{group.code} · {group.program}</option>)}</select>
                  {(unscheduledQuery || unscheduledStaffType !== "All" || unscheduledGroupId || unscheduledProgram) && <button onClick={() => { setUnscheduledQuery(""); setUnscheduledStaffType("All"); setUnscheduledGroupId(""); setUnscheduledProgram(""); }} className="text-left text-xs font-bold text-blue-700" type="button">Clear filters</button>}
                </div>
                <div className="grid min-h-0 flex-1 content-start gap-2 overflow-y-auto pr-1">
                  {filteredUnscheduledSections.map((section) => (
                    <div
                      key={section.id}
                      draggable={placingSessionKey === null && lessonMutation === null}
                      onDragStart={(event) => {
                        event.dataTransfer.setData("text/plain", section.sectionId);
                        event.dataTransfer.setData("application/x-unscheduled-occurrence", String(section.occurrence));
                        event.dataTransfer.effectAllowed = "move";
                        setCompactDragPreview(event, section.label);
                      }}
                      className={`rounded-lg border p-2 text-[11px] ${placingSessionKey || lessonMutation ? "cursor-wait opacity-60" : "cursor-grab active:cursor-grabbing"} ${section.teacherIsActive === false ? "border-red-300 bg-red-50 text-red-950" : section.staffType === "PT" ? "border-amber-300 bg-amber-50 text-amber-950" : "border-blue-200 bg-blue-50 text-blue-950"}`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p className="font-black">{section.label}</p>
                        <div className="flex flex-wrap justify-end gap-1">
                          {section.teacherIsActive === false && <Pill tone="red">Inactive teacher</Pill>}
                          {section.teacherIsActive !== false && section.staffType === "PT" && <Pill tone="amber">PT priority</Pill>}
                        </div>
                      </div>
                      <p className="mt-1">{section.durationHours}h · {section.teacherName ?? "Teacher pending"}</p>
                      <p className={`mt-1 ${section.teacherIsActive === false ? "text-red-700" : section.staffType === "PT" ? "text-amber-800" : "text-blue-700"}`}>{section.studentGroups.join(", ") || "Student group pending"}</p>
                      {/* 使用按钮开始排课或寻找空位时，右侧 Inspector 会接管下一步操作，因此同步收起待排抽屉，避免两个面板夹窄总表。 */}
                      <div className="mt-1.5 grid grid-cols-2 gap-1">
                        <button
                          draggable={false}
                          disabled={placingSessionKey !== null || lessonMutation !== null}
                          onClick={(event) => {
                            event.stopPropagation();
                            setShowUnscheduledDrawer(false);
                            setShowTimetableInspector(true);
                            setPlacingSection(section);
                            setEditingLesson(null);
                            clearCandidateSlotWorkspace();
                          }}
                          className="rounded-md bg-[#153d75] px-1.5 py-1 font-bold text-white disabled:cursor-wait disabled:opacity-50"
                          type="button"
                        >
                          Schedule
                        </button>
                        <button
                          draggable={false}
                          disabled={placingSessionKey !== null || lessonMutation !== null}
                          onClick={(event) => {
                            event.stopPropagation();
                            setShowUnscheduledDrawer(false);
                            setShowTimetableInspector(true);
                            void findCandidateSlots(section);
                          }}
                          className="rounded-md border border-blue-200 bg-white px-1.5 py-1 font-bold text-blue-800 hover:border-blue-400 disabled:cursor-wait disabled:opacity-50"
                          type="button"
                        >
                          Clear slots
                        </button>
                      </div>
                    </div>
                  ))}
                  {/* 待排区为空有三种不同含义：尚无课程、课程仍缺设置，或所有已配置
                      课次都已经排入总表。必须结合当前 lessons 区分；否则最后一种正常
                      状态会被错误提示为“仍缺 duration／year”，误导老师重复修改课程。 */}
                  {filteredUnscheduledSections.length === 0 && (
                    unscheduledSections.length === 0 ? (
                      <div className="rounded-xl border border-blue-100 bg-blue-50 p-3 text-xs leading-5 text-blue-900">
                        <p className="font-black">No sessions are ready for Year {timetableYear} yet.</p>
                        {courses.length === 0 ? (
                          <p className="mt-1">No courses have been added yet. Import the Teaching Members workbook or add a course before scheduling.</p>
                        ) : lessons.length > 0 ? (
                          <p className="mt-1">All currently configured Year {timetableYear} sessions are scheduled. Use Return to tray on a lesson if it needs to be placed again.</p>
                        ) : (
                          <p className="mt-1">Courses are available, but they still need a duration and primary year before their sections can enter this tray.</p>
                        )}
                        <button
                          onClick={() => openView("Courses")}
                          className="mt-2 rounded-lg bg-[#153d75] px-3 py-1.5 font-bold text-white"
                          type="button"
                        >
                          {courses.length === 0 ? "Import or add courses" : lessons.length > 0 ? "Review courses" : "Configure courses"}
                        </button>
                      </div>
                    ) : (
                      <p className="rounded-xl bg-slate-50 p-3 text-xs text-slate-500">No sessions match these filters.</p>
                    )
                  )}
                </div>
              </aside>}

              {/* 总表是年级页唯一永久主栏；relative 只为右侧浮动 Inspector 提供定位边界，面板打开时不会改变五个日期栏的宽度。 */}
              <div className="relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div><p className="text-xs font-semibold text-blue-700">Master timetable</p><h2 className="text-lg font-black">Year {timetableYear}</h2></div>
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    {/* 问题数字只作快速总览；详细内容仍由 Inspector 或 Rules & issues 页面负责展示。 */}
                    <div className="hidden gap-1 sm:flex">
                      <Pill tone="red">{visibleYearIssues.filter((issue) => issue.severity === "High").length}</Pill>
                      <Pill tone="amber">{visibleYearIssues.filter((issue) => issue.severity === "Warning").length}</Pill>
                    </div>

                    {/* 左右工具面板保持互斥：老师一次只处理一种辅助任务，中央总表不会同时被两个面板遮挡或挤压。 */}
                    <button
                      ref={unscheduledToggleButtonRef}
                      disabled={workspaceNavigationLocked}
                      onClick={() => {
                        const willOpen = !showUnscheduledDrawer;
                        setShowUnscheduledDrawer(willOpen);
                        if (willOpen) setShowTimetableInspector(false);
                      }}
                      className={`rounded-lg border px-2.5 py-1.5 text-xs font-bold disabled:cursor-wait disabled:opacity-50 ${showUnscheduledDrawer ? "border-blue-300 bg-blue-50 text-blue-800" : "border-slate-200 bg-white text-slate-700 hover:border-blue-400 hover:text-blue-700"}`}
                      type="button"
                      aria-expanded={showUnscheduledDrawer}
                      aria-controls="unscheduled-drawer"
                    >
                      {showUnscheduledDrawer ? "Hide unscheduled sessions" : "Unscheduled sessions"} ({unscheduledSections.length})
                    </button>
                    <button
                      ref={inspectorToggleButtonRef}
                      disabled={workspaceNavigationLocked}
                      onClick={() => {
                        const willOpen = !showTimetableInspector;
                        setShowTimetableInspector(willOpen);
                        if (willOpen) setShowUnscheduledDrawer(false);
                      }}
                      className={`rounded-lg border px-2.5 py-1.5 text-xs font-bold disabled:cursor-wait disabled:opacity-50 ${showTimetableInspector ? "border-blue-300 bg-blue-50 text-blue-800" : "border-slate-200 bg-white text-slate-700 hover:border-blue-400 hover:text-blue-700"}`}
                      type="button"
                      aria-expanded={showTimetableInspector}
                      aria-controls="timetable-inspector"
                    >
                      {showTimetableInspector ? "Hide inspector" : "Inspector"}
                    </button>

                    {/* 三个年级仍共享同一个排课工作区，切换年级只重新加载对应总表数据。 */}
                    <div className="flex gap-1 rounded-xl bg-slate-100 p-1">
                      {[1, 2, 3].map((year) => (
                        <button
                          key={year}
                          disabled={workspaceNavigationLocked}
                          onClick={() => void openTimetable(year)}
                          className={`rounded-lg px-2.5 py-1.5 text-sm font-semibold disabled:cursor-wait disabled:opacity-50 ${year === timetableYear ? "bg-white shadow-sm" : "text-slate-500"}`}
                          type="button"
                        >
                          Y{year}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto"><WeeklyTimetableGrid
                    lessons={lessons}
                    focusLesson={recentlySavedLesson}
                    onCellDrop={(event, dayOfWeek, startHour) => void placeSection(event, dayOfWeek, startHour)}
                    renderLesson={(lesson) => {
                      // 总表卡片的实际高度已经表达两、三或四小时，因此不重复显示“3h”。
                      // 课程编号使用最大的固定字号和最粗字重，让老师扫视满表时先认出课程；教师与教室使用统一的小字号作为第二层资料。
                      // 同一小时即使出现很多横向通道，也只截断过长文字，不再缩小字号，避免不同繁忙程度的日期出现忽大忽小的字。
                      const issueClasses = lessonIssueClasses(lesson.warningSeverity);
                      const lessonTime = `${String(lesson.startHour).padStart(2, "0")}:00–${String(lesson.startHour + lesson.durationHours).padStart(2, "0")}:00`;
                      const lessonGroups = lesson.studentGroups.join(", ") || "Student group pending";
                      const completeLessonLabel = `${lesson.sectionLabel}; ${lessonTime}; teacher ${lesson.teacherName ?? "pending"}; student groups ${lessonGroups}; room ${lesson.roomCode ?? "pending"}; ${lesson.warnings.length} issues`;

                      return (
                        <button
                          title={`${lesson.sectionLabel} · ${lessonTime} · ${lesson.teacherName ?? "Teacher pending"} · ${lessonGroups} · ${lesson.roomCode ?? "Room pending"}`}
                          aria-label={completeLessonLabel}
                          disabled={workspaceNavigationLocked}
                          draggable={!workspaceNavigationLocked}
                          onDragStart={(event) => {
                            draggingScheduledLessonRef.current = lesson;
                            event.dataTransfer.setData("application/x-scheduled-lesson", lesson.id);
                            event.dataTransfer.effectAllowed = "move";
                            setCompactDragPreview(event, lesson.sectionLabel);
                          }}
                          onDragEnd={() => {
                            draggingScheduledLessonRef.current = null;
                          }}
                          onClick={() => {
                            setShowUnscheduledDrawer(false);
                            setShowTimetableInspector(true);
                            openLessonEditor(lesson);
                            setPlacingSection(null);
                            clearCandidateSlotWorkspace();
                          }}
                          className={`h-full w-full cursor-pointer overflow-hidden rounded p-1 text-left leading-tight shadow-sm hover:ring-2 focus-visible:outline-none focus-visible:ring-2 ${workspaceNavigationLocked ? "cursor-wait opacity-60" : ""} ${issueClasses.card}`}
                          type="button"
                        >
                          <span className="block truncate text-[11px] font-black">{lesson.sectionLabel}</span>
                          <span className="mt-0.5 block truncate text-[10px] font-medium">{lesson.teacherName ?? "Teacher pending"}</span>
                          <span className="block truncate text-[10px] font-medium">{lessonGroups}</span>
                          <span className="block truncate text-[10px] font-semibold">{lesson.roomCode ?? "Room pending"}</span>
                          {lesson.warnings.length > 0 && (
                            <span className={`mt-0.5 block text-[10px] font-bold ${issueClasses.message}`}>
                              ⚠ {lesson.warnings.length}
                            </span>
                          )}
                        </button>
                      );
                    }}
                  /></div>

                {/* Inspector 以绝对定位覆盖总表右侧，不再成为 CSS Grid 的第三栏；关闭时不会留下任何空白宽度。 */}
                {showTimetableInspector && <aside
                  id="timetable-inspector"
                  className="absolute inset-y-0 right-0 z-40 flex w-full min-h-0 flex-col overflow-hidden border-l border-slate-200 bg-white shadow-2xl sm:w-[320px]"
                  aria-labelledby="timetable-inspector-title"
                  onKeyDown={(event) => {
                    // 保存／退回请求尚未完成时，Escape 也不能把编辑器卸载；否则老师会
                    // 误以为请求已取消，并可能在旧响应回来前打开另一张课程卡。
                    if (event.key === "Escape" && lessonMutation === null && placingSessionKey === null) closeInspectorAndRestoreFocus();
                  }}
                >
                <div className="flex items-center justify-between border-b border-slate-200 p-3">
                  <div>
                    <p id="timetable-inspector-title" className="font-black text-slate-950">Inspector</p>
                    <p className="text-xs text-slate-500">Edit or resolve in context</p>
                  </div>
                  <div className="flex items-center gap-1">
                    <Pill tone="red">{visibleYearIssues.filter((issue) => issue.severity === "High").length}</Pill>
                    <Pill tone="amber">{visibleYearIssues.filter((issue) => issue.severity === "Warning").length}</Pill>
                    <button
                      ref={inspectorCloseButtonRef}
                      disabled={lessonMutation !== null || placingSessionKey !== null}
                      onClick={closeInspectorAndRestoreFocus}
                      className="ml-1 rounded-md px-2 py-1 text-base font-bold leading-none text-slate-500 hover:bg-slate-100 hover:text-slate-900 disabled:cursor-wait disabled:opacity-50"
                      type="button"
                      aria-label="Close inspector"
                    >
                      ×
                    </button>
                  </div>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-3">
                  {/* 学生班级选择器使用 form 属性连接到下方编辑表单，因此可以保持独立、易读的代码区块，同时仍由同一个 Save changes 一次提交。 */}
                  {editingLesson && <div className="mb-3"><StudentGroupSelector key={`${editingLesson.id}:${editingLesson.revision}`} groups={groups} selectedIds={editingLesson.studentGroupIds} disabled={lessonMutation?.id === editingLesson.id} /></div>}
                  {editingLesson ? (
                    <form key={`${editingLesson.id}:${editingLesson.revision}`} id="lesson-editor" onSubmit={saveLesson} className="grid gap-3">
                      {/* 标题和关闭按钮只控制当前课程编辑器，不会关闭整个 Inspector。 */}
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="font-black text-slate-950">Edit {editingLesson.sectionLabel}</p>
                          <p className="text-xs text-slate-500">{editingLesson.durationHours} hours · occurrence {editingLesson.occurrence}</p>
                        </div>
                        <button onClick={closeLessonEditor} disabled={lessonMutation?.id === editingLesson.id} className="text-xs font-bold text-slate-500 disabled:cursor-wait disabled:opacity-50" type="button">Close</button>
                      </div>

                      {/* 远端 revision 改变时保留本地草稿，但必须把事实直接显示在编辑器内。
                          老师仍可按 Save；服务器会以409阻止覆盖并自动打开最新版本。 */}
                      {lessonDraftIsStale && (
                        <div role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-2 text-xs leading-5 text-amber-950">
                          <p className="font-black">Another scheduler changed or returned this lesson.</p>
                          <p>Your unsaved choices are still shown here. Saving will not overwrite their work; the latest lesson will be reloaded for review.</p>
                        </div>
                      )}

                      {/* 当前规则消息直接放在表单上方，老师保存前可以确认哪些问题仍会保留。 */}
                      {editingLesson.warnings.length > 0 && (
                        <div className={`rounded-xl border p-2 text-xs ${lessonIssueClasses(editingLesson.warningSeverity).panel}`}>
                          <p className="font-black">
                            {editingLesson.warningSeverity ?? "Advisory"} · Review {editingLesson.warnings.length} issue{editingLesson.warnings.length === 1 ? "" : "s"}
                          </p>
                          <ul className="mt-1 list-disc space-y-1 pl-4">
                            {editingLesson.warnings.map((warning) => <li key={warning}>{warning}</li>)}
                          </ul>
                        </div>
                      )}

                      {/* 星期和开始时间都使用整点选项，并按课程时长排除超过 18:00 的开始时间。 */}
                      <label className="text-xs font-semibold text-slate-700">
                        Day
                        <select ref={lessonEditorDaySelectRef} name="dayOfWeek" defaultValue={editingLesson.dayOfWeek} disabled={lessonMutation?.id === editingLesson.id} className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm disabled:cursor-wait disabled:bg-slate-100">
                          {["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"].map((day, index) => <option key={day} value={index + 1}>{day}</option>)}
                        </select>
                      </label>
                      <label className="text-xs font-semibold text-slate-700">
                        Start hour
                        <select name="startHour" defaultValue={editingLesson.startHour} disabled={lessonMutation?.id === editingLesson.id} className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm disabled:cursor-wait disabled:bg-slate-100">
                          {timetableHours.filter((hour) => hour + editingLesson.durationHours <= 18).map((hour) => <option key={hour} value={hour}>{String(hour).padStart(2, "0")}:00</option>)}
                        </select>
                      </label>

                      {/* 停用教师若已经属于这门课，会作为“当前分配”保留；其他可改选项只来自 Active 名单。 */}
                      <div className="grid gap-1 text-xs font-semibold text-slate-700">
                        <span>Teacher</span>
                        <TeacherSelect teachers={teachers} selectedTeacherId={editingLesson.teacherId} selectedTeacherName={editingLesson.teacherName} ariaLabel={`Teacher for ${editingLesson.sectionLabel}`} disabled={lessonMutation?.id === editingLesson.id} />
                      </div>

                      {/* 当前停用教室会作为旧分配保留；新改选项只来自 Active 名单，空值仍表示稍后再分配。 */}
                      <div className="grid gap-1 text-xs font-semibold text-slate-700">
                        <span>Room</span>
                        <RoomSelect rooms={rooms} selectedRoomId={editingLesson.roomId} selectedRoomCode={editingLesson.roomCode} ariaLabel={`Room for ${editingLesson.sectionLabel}`} disabled={lessonMutation?.id === editingLesson.id} />
                      </div>

                      {/* Return to tray 删除当前课次位置；Save changes 则保留课次并重新计算全部警告。 */}
                      <div className="grid grid-cols-2 gap-2">
                        <button disabled={lessonMutation !== null} onClick={() => void unscheduleLesson()} className="rounded-lg border border-red-200 px-3 py-2 text-xs font-bold text-red-700 disabled:cursor-wait disabled:opacity-50" type="button">{lessonMutation?.id === editingLesson.id && lessonMutation.action === "return" ? "Returning..." : "Return to tray"}</button>
                        <button disabled={lessonMutation !== null} className="rounded-lg bg-[#153d75] px-3 py-2 text-xs font-bold text-white disabled:cursor-wait disabled:opacity-60" type="submit">{lessonMutation?.id === editingLesson.id && lessonMutation.action === "save" ? "Saving..." : "Save changes"}</button>
                      </div>
                    </form>
                  )
                  : placingSection ? (
                    <form onSubmit={placeSectionWithoutDrag} className="grid gap-3">
                      {/* 标题区始终保留当前班次编号；保存进行中不允许关闭，避免老师误以为请求已经取消。 */}
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="font-black text-slate-950">Schedule {placingSection.label}</p>
                          <p className="text-xs text-slate-500">Keyboard and click alternative to dragging</p>
                        </div>
                        <button
                          onClick={closePlacementEditor}
                          disabled={placingSessionKey !== null}
                          className="text-xs font-bold text-slate-500 disabled:cursor-wait disabled:opacity-50"
                          type="button"
                        >
                          Close
                        </button>
                      </div>

                      {/* 共享教师、学生班级和课时来自班次资料；首次放置这里只决定时间与教室。 */}
                      <div className={`rounded-xl p-3 text-xs ${placingSection.teacherIsActive === false ? "bg-red-50 text-red-900" : "bg-blue-50 text-blue-900"}`}>
                        <p className="font-bold">{placingSection.teacherName ?? "Teacher pending"}{placingSection.teacherIsActive === false ? " (Inactive)" : ""}</p>
                        <p className="mt-1">{placingSection.studentGroups.join(", ") || "Student group pending"} · {placingSection.durationHours}h</p>
                        {placingSection.teacherIsActive === false && <p className="mt-1 font-semibold">Manual placement is allowed, but it will be saved with a serious warning.</p>}
                      </div>

                      {/* 请求发出后锁定三个选择器，确保按钮显示的资料与服务器实际收到的资料完全一致。 */}
                      <label className="text-xs font-semibold text-slate-700">
                        Day
                        <select name="dayOfWeek" disabled={placingSessionKey !== null} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm disabled:cursor-wait disabled:bg-slate-100">
                          {["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"].map((day, index) => <option key={day} value={index + 1}>{day}</option>)}
                        </select>
                      </label>
                      <label className="text-xs font-semibold text-slate-700">
                        Start hour
                        <select name="startHour" disabled={placingSessionKey !== null} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm disabled:cursor-wait disabled:bg-slate-100">
                          {timetableHours.filter((hour) => hour + placingSection.durationHours <= 18).map((hour) => <option key={hour} value={hour}>{String(hour).padStart(2, "0")}:00</option>)}
                        </select>
                      </label>
                      <label className="text-xs font-semibold text-slate-700">
                        Room
                        <select name="roomId" disabled={placingSessionKey !== null} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm disabled:cursor-wait disabled:bg-slate-100">
                          <option value="">Assign later</option>
                          {rooms.filter((room) => room.status === "Active").map((room) => <option key={room.id} value={room.id}>{room.code} · {room.capacity} seats</option>)}
                        </select>
                      </label>

                      {/* 主按钮提供明确的进行中状态；候选搜索同时停用，防止同一 Inspector 发起第二条异步流程。 */}
                      <button disabled={placingSessionKey !== null} className="rounded-lg bg-[#153d75] px-3 py-2.5 text-sm font-bold text-white disabled:cursor-wait disabled:opacity-60" type="submit">{placingSessionKey ? "Placing..." : "Place session"}</button>
                      <button onClick={() => void findCandidateSlots(placingSection)} disabled={placingSessionKey !== null} className="rounded-lg border border-emerald-200 px-3 py-2 text-xs font-bold text-emerald-800 disabled:cursor-wait disabled:opacity-50" type="button">Show only clear options</button>
                    </form>
                  ) : candidateSection ? (
                    <div>
                      {/* 候选结果属于当前班次；保存期间保持面板可见但锁定关闭和其他候选，避免请求上下文被切换。 */}
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="font-black text-emerald-950">Clear slots</p>
                          <p className="text-xs text-emerald-800">{candidateSection.label} · no saved issue</p>
                        </div>
                        <button
                          onClick={closeCandidateResults}
                          disabled={placingSessionKey !== null}
                          className="text-xs font-bold text-slate-500 disabled:cursor-wait disabled:opacity-50"
                          type="button"
                        >
                          Close
                        </button>
                      </div>
                      {placingSessionKey && <p className="mt-3 rounded-lg bg-blue-50 p-2 text-xs font-bold text-blue-800" role="status">Placing the selected option...</p>}

                      {/* 搜索中、没有结果和可选结果分别显示，不让空白面板掩盖当前系统状态。 */}
                      {candidatesLoading ? (
                        <p className="mt-4 text-sm text-slate-500">Checking every room and hour...</p>
                      ) : candidateSlots.length === 0 ? (
                        <p className="mt-4 rounded-xl bg-slate-50 p-3 text-xs text-slate-600">No completely clear option is available. Check assignments and restrictions.</p>
                      ) : (
                        <div className="mt-3 grid gap-2">
                          {candidateSlots.map((slot) => (
                            <button key={`${slot.dayOfWeek}-${slot.startHour}-${slot.roomId}`} onClick={() => void placeCandidate(slot)} disabled={placingSessionKey !== null} className="rounded-xl border border-emerald-200 bg-emerald-50 p-2.5 text-left text-xs hover:border-emerald-500 disabled:cursor-wait disabled:opacity-50" type="button">
                              <span className="block font-black text-emerald-950">{timetableDays[slot.dayOfWeek - 1]} {String(slot.startHour).padStart(2, "0")}:00–{String(slot.endHour).padStart(2, "0")}:00</span>
                              <span className="mt-1 block font-semibold text-slate-700">{slot.roomCode} · {slot.roomCapacity} seats</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                  : (
                    <div>
                      <p className="text-xs leading-5 text-slate-500">Select a lesson to edit it, or choose Schedule on an unscheduled session.</p>
                      <div className="my-3 border-t border-slate-100" />
                      <div className="mb-2 flex items-center justify-between">
                        <p className="text-sm font-black text-slate-950">Year {timetableYear} issues</p>
                        <button
                          disabled={lessonMutation !== null || placingSessionKey !== null || managementMutationKey !== null}
                          onClick={() => void openRules()}
                          className="text-xs font-bold text-blue-700 disabled:cursor-wait disabled:opacity-50"
                          type="button"
                        >
                          All rules
                        </button>
                      </div>
                      {visibleYearIssues.length === 0 ? (
                        <p className="rounded-xl bg-emerald-50 p-3 text-xs font-semibold text-emerald-800">No issues in this year.</p>
                      ) : (
                        <div className="grid gap-2">
                          {visibleYearIssues.map((issue) => (
                            <button
                              key={issue.id}
                              disabled={lessonMutation !== null || placingSessionKey !== null || managementMutationKey !== null}
                              onClick={() => void openScheduleIssue(issue)}
                              className="rounded-xl border border-slate-200 p-2.5 text-left text-xs hover:border-blue-300 hover:bg-blue-50 disabled:cursor-wait disabled:opacity-50"
                              type="button"
                            >
                              <span className="flex items-center justify-between gap-2">
                                <span className="font-black text-slate-900">{issue.sectionLabel}</span>
                                <Pill tone={issue.severity === "High" ? "red" : issue.severity === "Warning" ? "amber" : "blue"}>{issue.severity}</Pill>
                              </span>
                              <span className="mt-1 block font-semibold text-slate-700">{issue.message}</span>
                              <span className="mt-1 block text-slate-500">
                                {timetableDays[issue.dayOfWeek - 1]} {String(issue.startHour).padStart(2, "0")}:00
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
                </aside>}
              </div>
            </div>
          )}

          {view === "Cycle" && currentCycle && (
            /* 会清空或恢复资料的新周期操作放在独立页面，并用不同视觉样式与日常排课彻底分开。 */
            <div className="mb-6 grid gap-4 lg:grid-cols-2">
              <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm lg:col-span-2">
                <p className="font-black text-slate-950">Current cycle contents</p>
                <div className="mt-3 flex flex-wrap gap-2"><Pill tone="blue">{currentCycle.courses} courses</Pill><Pill tone="blue">{currentCycle.sections} sections</Pill><Pill tone="blue">{currentCycle.lessons} scheduled lessons</Pill></div>
                <p className="mt-3 text-xs leading-5 text-slate-500">Retained after a clear: teachers, rooms, student groups, unavailable times, rule settings and all accounts.</p>
              </div>
              <form onSubmit={beginNewCycle} className="rounded-2xl border border-red-200 bg-red-50 p-5 shadow-sm">
                <p className="font-black text-red-950">Start a new cycle</p>
                <p className="mt-1 text-xs leading-5 text-red-800">An emergency snapshot is saved first. The current courses, generated sections, section student groups and scheduled lessons are then cleared together.</p>
                <div className="mt-4 grid gap-3 text-sm text-red-950">
                  <label className="flex items-start gap-2"><input name="understandClear" type="checkbox" className="mt-1" /><span>I understand that all current course and timetable work will disappear from the active workspace.</span></label>
                  <label className="flex items-start gap-2"><input name="understandBackup" type="checkbox" className="mt-1" /><span>I understand that only the latest emergency snapshot is retained.</span></label>
                  <label className="font-semibold">Type START NEW CYCLE<input name="confirmation" required autoComplete="off" className="mt-1 w-full rounded-xl border border-red-200 bg-white px-3 py-2 font-normal" /></label>
                </div>
                <button disabled={currentCycle.courses === 0 || managementMutationKey !== null} className="mt-4 rounded-xl bg-red-700 px-4 py-2.5 text-sm font-bold text-white disabled:cursor-wait disabled:opacity-50" type="submit">{managementMutationKey === "cycle-start" ? "Starting new cycle..." : "Back up and start new cycle"}</button>
              </form>
              <form onSubmit={restoreCycle} className="rounded-2xl border border-amber-200 bg-amber-50 p-5 shadow-sm">
                <p className="font-black text-amber-950">Restore latest emergency backup</p>
                {currentCycle.backup ? (
                  <>
                    <p className="mt-1 text-xs leading-5 text-amber-800">
                      Saved {new Date(currentCycle.backup.createdAt).toLocaleString()} · {currentCycle.backup.courses} courses · {currentCycle.backup.sections} sections · {currentCycle.backup.lessons} lessons.
                    </p>
                    <div className="mt-4 grid gap-3 text-sm text-amber-950">
                      <label className="flex items-start gap-2">
                        <input name="understandRestore" type="checkbox" className="mt-1" />
                        <span>I understand this replaces any course and timetable work currently in the active workspace.</span>
                      </label>
                      <label className="font-semibold">
                        Type RESTORE LAST BACKUP
                        <input name="confirmation" required autoComplete="off" className="mt-1 w-full rounded-xl border border-amber-200 bg-white px-3 py-2 font-normal" />
                      </label>
                    </div>
                    <button disabled={managementMutationKey !== null} className="mt-4 rounded-xl bg-amber-700 px-4 py-2.5 text-sm font-bold text-white disabled:cursor-wait disabled:opacity-50" type="submit">{managementMutationKey === "cycle-restore" ? "Restoring..." : "Restore emergency backup"}</button>
                  </>
                ) : (
                  <p className="mt-3 text-sm text-slate-500">No emergency cycle backup is available yet.</p>
                )}
              </form>
            </div>
          )}

          {view === "Profile" && (
            <form onSubmit={changePassword} className="mb-6 max-w-lg rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <p className="font-black">Change password</p>
              <p className="mt-1 text-xs text-slate-500">At least 10 characters. All logged-in browsers will be signed out.</p>
              <div className="mt-4 grid gap-3">
                <label className="text-sm font-semibold">
                  Current password
                  <input name="currentPassword" required autoComplete="current-password" type="password" className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 font-normal" />
                </label>
                <label className="text-sm font-semibold">
                  New password
                  <input name="newPassword" required minLength={10} autoComplete="new-password" type="password" className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 font-normal" />
                </label>
              </div>
              <button disabled={managementMutationKey !== null} className="mt-4 rounded-xl bg-[#153d75] px-4 py-2.5 text-sm font-bold text-white disabled:cursor-wait disabled:opacity-60" type="submit">{managementMutationKey === "password-change" ? "Changing password..." : "Change password"}</button>
            </form>
          )}

          {view === "Accounts" && currentUser?.isAdmin && (
            /* 完整备份和恢复包含密码哈希、全部账号和部门排课资料，因此只放在管理员受限页面。 */
            <div className="mb-6 grid gap-4 lg:grid-cols-[400px_1fr]">
              <div className="grid content-start gap-4">
                <section className="rounded-2xl border border-blue-200 bg-blue-50 p-5 shadow-sm">
                  <p className="font-black text-blue-950">Full system backup</p>
                  <p className="mt-1 text-xs leading-5 text-blue-800">Download a verified SQLite backup containing master data, rules, courses, timetables and accounts. Active login sessions are excluded.</p>
                  <p className="mt-3 text-xs font-semibold leading-5 text-amber-800">Keep this sensitive file in an access-controlled department folder.</p>
                  <button onClick={() => void downloadSystemBackup()} disabled={downloadingBackup || restoringBackup || managementMutationKey !== null} className="mt-4 rounded-xl bg-[#153d75] px-4 py-2.5 text-sm font-bold text-white disabled:cursor-wait disabled:opacity-60" type="button">{downloadingBackup ? "Checking backup..." : "Download full backup"}</button>
                </section>

                <form onSubmit={restoreSystemBackup} className="rounded-2xl border border-red-200 bg-red-50 p-5 shadow-sm">
                  {/* 服务端恢复前会保存当前状态；旁边的下载再提供一份由管理员独立保管的系统外副本。 */}
                  <p className="font-black text-red-950">Restore full system backup</p>
                  <p className="mt-1 text-xs leading-5 text-red-800">The uploaded file replaces all current data and accounts. The server first retains an automatic safety copy of the current state.</p>
                  {systemRestoreCurrentToken ? (
                    <p className="mt-3 text-xs font-semibold leading-5 text-emerald-800">Current system state was reviewed when this Accounts page opened. Any later change will stop restore with no data replaced.</p>
                  ) : (
                    <p className="mt-3 text-xs font-semibold leading-5 text-red-800">Restore review is stale or unavailable. Leave and reopen Accounts to review the latest system state before selecting a backup.</p>
                  )}
                  <div className="mt-4 grid gap-3 text-sm text-red-950">
                    <label className="font-semibold">Verified .sqlite backup<input disabled={!systemRestoreCurrentToken || managementMutationKey !== null} name="backupFile" required accept=".sqlite,application/vnd.sqlite3" type="file" className="mt-1 block w-full rounded-xl border border-red-200 bg-white p-2 text-xs font-normal disabled:cursor-not-allowed disabled:opacity-60" /></label>
                    <label className="flex items-start gap-2"><input disabled={!systemRestoreCurrentToken || managementMutationKey !== null} name="understandReplace" type="checkbox" className="mt-1 disabled:cursor-not-allowed" /><span>I understand that all current timetable data and accounts will be replaced.</span></label>
                    <label className="flex items-start gap-2"><input disabled={!systemRestoreCurrentToken || managementMutationKey !== null} name="understandSignOut" type="checkbox" className="mt-1 disabled:cursor-not-allowed" /><span>I understand that every browser will be signed out and I must use an account from the backup.</span></label>
                    <label className="font-semibold">Type RESTORE FULL BACKUP<input disabled={!systemRestoreCurrentToken || managementMutationKey !== null} name="confirmation" required autoComplete="off" className="mt-1 w-full rounded-xl border border-red-200 bg-white px-3 py-2 font-normal disabled:cursor-not-allowed disabled:opacity-60" /></label>
                  </div>
                  <button disabled={!systemRestoreCurrentToken || restoringBackup || downloadingBackup || managementMutationKey !== null} className="mt-4 rounded-xl bg-red-700 px-4 py-2.5 text-sm font-bold text-white disabled:cursor-wait disabled:opacity-60" type="submit">{restoringBackup ? "Validating and restoring..." : "Restore and sign out everyone"}</button>
                </form>

                <form onSubmit={createAccount} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                  {/* 只有初始管理员能进入此表单，因此新排课账号只需用户名和初始密码。 */}
                  <p className="font-black">Create scheduler account</p>
                  <p className="mt-1 text-xs leading-5 text-slate-500">Schedulers receive full timetable access but cannot create accounts.</p>
                  <div className="mt-4 grid gap-3">
                    <label className="text-sm font-semibold">Username<input name="username" required minLength={3} autoComplete="off" className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 font-normal" /></label>
                    <label className="text-sm font-semibold">Temporary password<input name="password" required minLength={10} autoComplete="new-password" type="password" className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 font-normal" /></label>
                  </div>
                  <button disabled={managementMutationKey !== null} className="mt-4 rounded-xl bg-[#153d75] px-4 py-2.5 text-sm font-bold text-white disabled:cursor-wait disabled:opacity-60" type="submit">{managementMutationKey === "account-create" ? "Creating account..." : "Create account"}</button>
                </form>

                <form onSubmit={resetAccountPassword} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                  {/* 密码重置只撤销所选普通排课账号的会话，绝不修改管理员账号。 */}
                  <p className="font-black">Reset scheduler password</p>
                  <div className="mt-4 grid gap-3">
                    <select name="userId" required className="rounded-xl border border-slate-200 px-3 py-2 text-sm"><option value="">Choose scheduler</option>{accounts.filter((account) => !account.isAdmin).map((account) => <option key={account.id} value={account.id}>{account.username}</option>)}</select>
                    <input name="password" required minLength={10} placeholder="New temporary password" autoComplete="new-password" type="password" className="rounded-xl border border-slate-200 px-3 py-2 text-sm" />
                  </div>
                  <button disabled={managementMutationKey !== null} className="mt-4 rounded-xl border border-blue-200 px-4 py-2 text-sm font-bold text-blue-800 disabled:cursor-wait disabled:opacity-60" type="submit">{managementMutationKey === "account-password-reset" ? "Resetting password..." : "Reset and sign out account"}</button>
                </form>
              </div>

              {/* 账号清单除普通账号启停外保持只读；管理员不能在这里误停用自己。 */}
              <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
                <div className="border-b border-slate-200 p-4"><p className="font-black">Current accounts</p></div>
                <div className="divide-y divide-slate-100">
                  {accounts.map((account) => (
                    <div key={account.id} className="flex items-center justify-between gap-3 p-4 text-sm">
                      <div>
                        <p className="font-bold">{account.username}</p>
                        <p className="text-xs text-slate-500">
                          {account.isAdmin ? "Administrator · can create accounts" : "Scheduler · full timetable access"}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Pill tone={account.isActive ? "green" : "slate"}>{account.isActive ? "Active" : "Inactive"}</Pill>
                        {!account.isAdmin && (
                          <button
                            ref={(button) => {
                              if (button) accountStatusButtonRefs.current.set(account.id, button);
                              else accountStatusButtonRefs.current.delete(account.id);
                            }}
                            aria-label={`${account.isActive ? "Deactivate" : "Activate"} ${account.username}`}
                            disabled={managementMutationKey !== null}
                            onClick={() => void changeAccountStatus(account)}
                            className="text-xs font-bold text-blue-700 disabled:cursor-wait disabled:opacity-50"
                            type="button"
                          >
                            {account.isActive ? "Deactivate" : "Activate"}
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {view === "Rules & issues" && (
            /* 可变部门政策在此开关；教师、教室和学生班级同时冲突等核心检查始终固定启用。 */
            <div className="mb-4 rounded-2xl border border-slate-200 bg-white shadow-sm">
              <div className="border-b border-slate-200 p-4"><p className="font-black">Policy rule settings</p><p className="mt-1 text-xs text-slate-500">Changes immediately recalculate the issue list and future candidate slots.</p></div>
              <div className="grid gap-px bg-slate-100 md:grid-cols-2">
                {ruleSettings.map((rule) => (
                  <div key={rule.key} className="flex items-center justify-between gap-4 bg-white p-4">
                    <div><p className="text-sm font-bold text-slate-900">{rule.label}</p><p className="mt-1 text-xs text-slate-500">{rule.description}</p></div>
                    <button disabled={managementMutationKey !== null} onClick={() => void toggleRuleSetting(rule)} className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-bold disabled:cursor-wait disabled:opacity-50 ${rule.enabled ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-500"}`} type="button">{managementMutationKey === `rule-setting:${rule.key}` ? "Saving..." : rule.enabled ? "Enabled" : "Disabled"}</button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {view === "Rules & issues" && (
            <div className="mb-6 grid gap-4 lg:grid-cols-2">
              {(["Teacher", "Year"] as const).map((kind) => (
                <form
                  key={kind}
                  onSubmit={(event) => saveUnavailableWindow(event, kind)}
                  className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
                >
                  <p className="font-black text-slate-950">{kind} unavailable time</p>
                  <p className="mb-3 text-xs text-slate-500">
                    {kind === "Teacher" ? "Example: a PT teacher can only teach on selected days." : "Example: Year 1 has no classes on Wednesday."}
                  </p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <select name="ownerId" required={kind === "Teacher"} className="rounded-lg border border-slate-200 px-3 py-2 text-sm">
                      {kind === "Teacher" ? (
                        <>
                          <option value="">Choose teacher</option>
                          {teachers.filter((teacher) => teacher.status === "Active").map((teacher) => <option key={teacher.id} value={teacher.id}>{teacher.name}</option>)}
                        </>
                      ) : (
                        <><option value="1">Year 1</option><option value="2">Year 2</option><option value="3">Year 3</option></>
                      )}
                    </select>
                    <select name="dayOfWeek" className="rounded-lg border border-slate-200 px-3 py-2 text-sm">
                      {["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"].map((day, index) => <option key={day} value={index + 1}>{day}</option>)}
                    </select>
                    <select name="startHour" defaultValue="8" className="rounded-lg border border-slate-200 px-3 py-2 text-sm">
                      {[8, 9, 10, 11, 12, 13, 14, 15, 16, 17].map((hour) => <option key={hour} value={hour}>{hour}:00 start</option>)}
                    </select>
                    <select name="endHour" defaultValue="18" className="rounded-lg border border-slate-200 px-3 py-2 text-sm">
                      {[9, 10, 11, 12, 13, 14, 15, 16, 17, 18].map((hour) => <option key={hour} value={hour}>{hour}:00 end</option>)}
                    </select>
                  </div>
                  <button disabled={managementMutationKey !== null} className="mt-3 rounded-lg bg-[#153d75] px-4 py-2 text-sm font-bold text-white disabled:cursor-wait disabled:opacity-60" type="submit">
                    {managementMutationKey === `rule-window-add:${kind}` ? "Saving..." : `Add ${kind.toLowerCase()} restriction`}
                  </button>
                </form>
              ))}
              <div className="rounded-2xl border border-slate-200 bg-white shadow-sm lg:col-span-2">
                <div className="border-b border-slate-200 p-4"><p className="font-black">Current unavailable windows</p></div>
                {unavailableWindows.length === 0 ? (
                  <p className="p-4 text-sm text-slate-500">No unavailable windows have been added.</p>
                ) : (
                  <div className="divide-y divide-slate-100">
                    {unavailableWindows.map((window) => (
                      <div key={window.id} className="flex items-center justify-between gap-3 p-4 text-sm">
                        <div>
                          <Pill tone={window.kind === "Teacher" ? "amber" : "blue"}>{window.kind}</Pill>
                          <span className="ml-3 font-bold">{window.ownerLabel}</span>
                          <span className="ml-3 text-slate-500">{["Mon", "Tue", "Wed", "Thu", "Fri"][window.dayOfWeek - 1]} {window.startHour}:00–{window.endHour}:00</span>
                        </div>
                        <button disabled={managementMutationKey !== null} onClick={() => void removeUnavailableWindow(window)} className="font-semibold text-red-700 disabled:cursor-wait disabled:opacity-50" type="button">{managementMutationKey === `rule-window-remove:${window.id}` ? "Removing..." : "Remove"}</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="rounded-2xl border border-slate-200 bg-white shadow-sm lg:col-span-2">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 p-4">
                  <div><p className="font-black">Current timetable issues</p><p className="text-xs text-slate-500">Recalculated from every scheduled lesson and current rule.</p></div>
                  <div className="flex gap-2">
                    <Pill tone="red">{scheduleIssues.filter((issue) => issue.severity === "High").length} high</Pill>
                    <Pill tone="amber">{scheduleIssues.filter((issue) => issue.severity === "Warning").length} warnings</Pill>
                    <Pill tone="blue">{scheduleIssues.filter((issue) => issue.severity === "Advisory").length} advisory</Pill>
                  </div>
                </div>
                {scheduleIssues.length === 0 ? (
                  <p className="p-4 text-sm text-emerald-700">No issues found in scheduled lessons.</p>
                ) : (
                  <div className="max-h-[520px] divide-y divide-slate-100 overflow-y-auto">
                    {scheduleIssues.map((issue) => (
                      <div key={issue.id} className="grid gap-2 p-4 text-sm md:grid-cols-[110px_1fr_auto]">
                        <div><Pill tone={issue.severity === "High" ? "red" : issue.severity === "Warning" ? "amber" : "blue"}>{issue.severity}</Pill><p className="mt-2 text-xs font-semibold text-slate-500">{issue.category}</p></div>
                        <div><p className="font-black text-slate-950">{issue.sectionLabel} · Year {issue.primaryYear}</p><p className="mt-1 font-semibold text-slate-700">{issue.message}</p><p className="mt-1 text-xs text-slate-500">{issue.teacherName ?? "Teacher pending"} · {issue.studentGroups.join(", ") || "Student group pending"} · {issue.roomCode ?? "Room pending"}</p></div>
                        <div className="text-right"><p className="text-xs font-semibold text-slate-500">{["Mon", "Tue", "Wed", "Thu", "Fri"][issue.dayOfWeek - 1]} {String(issue.startHour).padStart(2, "0")}:00–{String(issue.endHour).padStart(2, "0")}:00</p><button disabled={managementMutationKey !== null} onClick={() => void openScheduleIssue(issue)} className="mt-2 rounded-lg border border-blue-200 px-3 py-1.5 text-xs font-bold text-blue-700 hover:bg-blue-50 disabled:cursor-wait disabled:opacity-50" type="button">Open lesson</button></div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {view !== "Year timetables" && view !== "Personal timetables" && view !== "Rules & issues" && view !== "Cycle" && view !== "Accounts" && view !== "Profile" && <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
            {/* 资料分页与搜索共用同一卡片，减少页面跳转并保持操作位置一致。 */}
            <div className="flex flex-col gap-4 border-b border-slate-200 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex gap-1 rounded-xl bg-slate-100 p-1">
                {(["Teachers", "Student groups", "Rooms", "Courses"] as View[]).map((item) => (
                  <button key={item} disabled={savingCourseSetupId !== null || managementMutationKey !== null} onClick={() => openView(item)} className={`rounded-lg px-3 py-2 text-sm font-semibold transition disabled:cursor-wait disabled:opacity-50 ${view === item ? "bg-white text-slate-950 shadow-sm" : "text-slate-500 hover:text-slate-800"}`} type="button">{item}</button>
                ))}
              </div>
              <label className="relative block sm:w-64"><span className="sr-only">Search data</span><input ref={view === "Courses" ? courseSearchInputRef : masterDataSearchInputRef} value={query} onChange={(event) => setQuery(event.target.value)} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none transition placeholder:text-slate-400 focus:border-blue-500 focus:bg-white" placeholder={`Search ${view.toLowerCase()}...`} /></label>
            </div>

            {showForm && view === "Courses" && !editingCourse && (
              /* Excel 导入是正常入口；右侧表单只用于明确补充工作簿遗漏课程，不能代替 teaching allocation。 */
              <div className="grid border-b border-blue-100 bg-blue-50/60 lg:grid-cols-2 lg:divide-x lg:divide-blue-100">
                <form onSubmit={importTeachingMembers} className="p-4">
                  <p className="mb-1 text-sm font-bold text-blue-950">Import Teaching Members</p>
                  <p className="mb-3 text-xs leading-5 text-blue-800">Reads <strong>Mod</strong>, <strong>Lecturer</strong>, <strong>Staff Type</strong> and <strong># of grps teaching</strong>. Positive rows create pre-assigned sections. A row with 0 explicitly clears that lecturer&apos;s existing allocation for the course; it is processed, not ignored.</p>
                  <div className="flex flex-col gap-3">
                    <input ref={dataManagementFormFirstInputRef} name="file" required accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" type="file" className="block text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-white file:px-3 file:py-2 file:text-sm file:font-semibold file:text-blue-800" />
                    <button disabled={managementMutationKey !== null} className="w-fit rounded-xl bg-[#153d75] px-4 py-2 text-sm font-bold text-white disabled:cursor-wait disabled:opacity-70" type="submit">
                      {importing ? "Importing..." : "Import allocation"}
                    </button>
                  </div>
                </form>
                <form onSubmit={addManualCourse} className="p-4">
                  <p className="mb-1 text-sm font-bold text-blue-950">Add a missing course manually</p>
                  <p className="mb-3 text-xs leading-5 text-blue-800">Use this only when the Teaching Members file omitted a course. New sections start without teachers.</p>
                  <div className="grid gap-3 sm:grid-cols-[1fr_1fr_110px_auto]">
                    {/* 浏览器长度边界直接复用服务端公开常量；用户会在输入时得到原生反馈，API 仍负责最终验证。 */}
                    <input name="code" required maxLength={COURSE_CODE_MAX_LENGTH} placeholder="Mod" className="rounded-xl border border-blue-200 bg-white px-3 py-2 text-sm" />
                    <input name="catalog" maxLength={COURSE_CATALOG_MAX_LENGTH} placeholder="Catalog (optional)" className="rounded-xl border border-blue-200 bg-white px-3 py-2 text-sm" />
                    <input name="sectionCount" required min="1" max="999" type="number" placeholder="Sections" className="rounded-xl border border-blue-200 bg-white px-3 py-2 text-sm" />
                    <button disabled={managementMutationKey !== null} className="rounded-xl bg-blue-700 px-4 py-2 text-sm font-bold text-white disabled:cursor-wait disabled:opacity-60" type="submit">{managementMutationKey === "manual-course-create" ? "Adding..." : "Add"}</button>
                  </div>
                </form>
              </div>
            )}

            {showForm && view === "Courses" && editingCourse && (
              /* 课程课时、周次数、主年级和教室要求只保存一次，并统一应用到该课程全部班次。 */
              <form key={`${editingCourse.id}-${editingCourse.revision}`} onSubmit={saveCourseSetup} className="border-b border-emerald-100 bg-emerald-50/60 p-4">
                <p className="mb-1 text-sm font-bold text-emerald-950">Configure {editingCourse.code}</p>
                <p className="mb-3 text-xs leading-5 text-emerald-800">These requirements are retained when Teaching Members is imported again.</p>
                <div className="grid gap-3 md:grid-cols-4">
                  <label className="text-xs font-semibold text-slate-700">
                    Duration (hours)
                    <input ref={courseDurationInputRef} name="durationHours" required min="2" max="4" defaultValue={editingCourse.durationHours ?? ""} disabled={savingCourseSetupId !== null || managementMutationKey !== null} type="number" className="mt-1 w-full rounded-xl border border-emerald-200 bg-white px-3 py-2 text-sm disabled:cursor-wait disabled:bg-slate-100" />
                  </label>
                  <label className="text-xs font-semibold text-slate-700">
                    Sessions/week
                    <select name="sessionsPerWeek" defaultValue={editingCourse.sessionsPerWeek} disabled={savingCourseSetupId !== null || managementMutationKey !== null} className="mt-1 w-full rounded-xl border border-emerald-200 bg-white px-3 py-2 text-sm disabled:cursor-wait disabled:bg-slate-100">
                      <option value="1">1</option>
                      <option value="2">2</option>
                    </select>
                  </label>
                  <label className="text-xs font-semibold text-slate-700">
                    Primary year
                    {/* 已有排课必须始终属于一张年级总表；禁用空选项可在界面第一层防止课程被无意隐藏。 */}
                    <select name="primaryYear" required={editingCourse.scheduledLessons > 0} defaultValue={editingCourse.primaryYear ?? ""} disabled={savingCourseSetupId !== null || managementMutationKey !== null} className="mt-1 w-full rounded-xl border border-emerald-200 bg-white px-3 py-2 text-sm disabled:cursor-wait disabled:bg-slate-100">
                      <option value="" disabled={editingCourse.scheduledLessons > 0}>Choose later</option>
                      <option value="1">Year 1</option>
                      <option value="2">Year 2</option>
                      <option value="3">Year 3</option>
                    </select>
                    {editingCourse.scheduledLessons > 0 && <span className="mt-1 block font-normal text-emerald-800">Required because this course is already on a timetable.</span>}
                  </label>
                  <label className="text-xs font-semibold text-slate-700">
                    Minimum capacity
                    <input name="minimumRoomCapacity" min="1" max={ROOM_CAPACITY_MAXIMUM} defaultValue={editingCourse.minimumRoomCapacity ?? ""} disabled={savingCourseSetupId !== null || managementMutationKey !== null} type="number" className="mt-1 w-full rounded-xl border border-emerald-200 bg-white px-3 py-2 text-sm disabled:cursor-wait disabled:bg-slate-100" />
                  </label>
                </div>
                {/* 起止周都留空表示每周上课；同时填写时支持 1–4、3–6、5–8 等包含两端的区间。 */}
                <div className="mt-3 max-w-lg rounded-xl border border-emerald-100 bg-white/70 p-3">
                  <p className="text-xs font-bold text-slate-700">Teaching weeks</p>
                  <div className="mt-2 grid grid-cols-2 gap-3">
                    <label className="text-xs font-semibold text-slate-700">Start week<input name="weekStart" min="1" max="52" defaultValue={editingCourse.weekStart ?? ""} disabled={savingCourseSetupId !== null || managementMutationKey !== null} type="number" placeholder="All weeks" className="mt-1 w-full rounded-xl border border-emerald-200 bg-white px-3 py-2 text-sm disabled:cursor-wait disabled:bg-slate-100" /></label>
                    <label className="text-xs font-semibold text-slate-700">End week<input name="weekEnd" min="1" max="52" defaultValue={editingCourse.weekEnd ?? ""} disabled={savingCourseSetupId !== null || managementMutationKey !== null} type="number" placeholder="All weeks" className="mt-1 w-full rounded-xl border border-emerald-200 bg-white px-3 py-2 text-sm disabled:cursor-wait disabled:bg-slate-100" /></label>
                  </div>
                  <p className="mt-2 text-xs text-emerald-800">Leave both blank for every week. Limited ranges include both the start and end week.</p>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-4 text-sm text-slate-700">
                  <label className="flex items-center gap-2"><input name="requiresLab" defaultChecked={editingCourse.requiresLab} disabled={savingCourseSetupId !== null || managementMutationKey !== null} type="checkbox" /> Lab</label>
                  <label className="flex items-center gap-2"><input name="requiresMultiProjector" defaultChecked={editingCourse.requiresMultiProjector} disabled={savingCourseSetupId !== null || managementMutationKey !== null} type="checkbox" /> Multi projector</label>
                  <label className="flex items-center gap-2"><input name="requiresSmartClassroom" defaultChecked={editingCourse.requiresSmartClassroom} disabled={savingCourseSetupId !== null || managementMutationKey !== null} type="checkbox" /> Smart classroom</label>
                  <label className="flex items-center gap-2"><input name="separateSectionsAcrossDays" defaultChecked={editingCourse.separateSectionsAcrossDays} disabled={savingCourseSetupId !== null || managementMutationKey !== null} type="checkbox" /> Keep sections on different days</label>
                  <button disabled={savingCourseSetupId !== null || managementMutationKey !== null} className="rounded-xl bg-emerald-700 px-4 py-2 font-bold text-white disabled:cursor-wait disabled:opacity-60" type="submit">
                    {savingCourseSetupId === editingCourse.id ? "Saving..." : "Save course setup"}
                  </button>
                </div>
              </form>
            )}

            {showForm && view !== "Courses" && (
              /* 手工资料表只收集当前排课和冲突检查真正需要的字段，避免加入没有明确用途的资料。 */
              <form
                key={editingTeacher ? `${editingTeacher.id}:${editingTeacher.revision}` : editingGroup ? `${editingGroup.id}:${editingGroup.revision}` : editingRoom ? `${editingRoom.id}:${editingRoom.revision}` : `new:${view}`}
                onSubmit={addRecord}
                className="border-b border-blue-100 bg-blue-50/60 p-4"
              >
                <p className="mb-3 text-sm font-bold text-blue-950">{editingTeacher ? `Edit ${editingTeacher.name}` : editingGroup ? `Edit ${editingGroup.code}` : editingRoom ? `Edit ${editingRoom.code}` : `New ${view.slice(0, -1)}`}</p>
                {/* fieldset 会一次冻结当前表单的输入、复选框和提交按钮；保存期间不仅按钮不能再按，
                    也不能继续修改一份已经发往服务器的草稿，避免响应回来时画面与实际保存值不同。 */}
                <fieldset disabled={managementMutationKey !== null} className="min-w-0 disabled:cursor-wait disabled:opacity-60">
                {view === "Teachers" && (
                  <div className="grid gap-3 sm:grid-cols-[1fr_140px_auto]">
                    <input ref={dataManagementFormFirstInputRef} name="name" required maxLength={TEACHER_NAME_MAX_LENGTH} defaultValue={editingTeacher?.name} placeholder="Teacher name" className="rounded-xl border border-blue-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500" />
                    <select name="staffType" defaultValue={editingTeacher?.staffType ?? "FT"} className="rounded-xl border border-blue-200 bg-white px-3 py-2 text-sm"><option value="FT">Full-time (FT)</option><option value="PT">Part-time (PT)</option></select>
                    <button disabled={managementMutationKey !== null} className="rounded-xl bg-[#153d75] px-4 py-2 text-sm font-bold text-white disabled:cursor-wait disabled:opacity-60" type="submit">{managementMutationKey === "master-record:Teachers" ? "Saving..." : editingTeacher ? "Save changes" : "Save teacher"}</button>
                  </div>
                )}
                {view === "Student groups" && (
                  <div className="grid gap-3 sm:grid-cols-[1fr_120px_130px_auto]">
                    <input ref={dataManagementFormFirstInputRef} name="code" required maxLength={STUDENT_GROUP_CODE_MAX_LENGTH} defaultValue={editingGroup?.code} placeholder="e.g. AAA_01" className="rounded-xl border border-blue-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500" />
                    <select name="year" defaultValue={editingGroup?.year ?? 1} className="rounded-xl border border-blue-200 bg-white px-3 py-2 text-sm"><option value="1">Year 1</option><option value="2">Year 2</option><option value="3">Year 3</option></select>
                    <input name="program" required maxLength={STUDENT_GROUP_PROGRAM_MAX_LENGTH} defaultValue={editingGroup?.program} placeholder="Programme" className="rounded-xl border border-blue-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500" />
                    <button disabled={managementMutationKey !== null} className="rounded-xl bg-[#153d75] px-4 py-2 text-sm font-bold text-white disabled:cursor-wait disabled:opacity-60" type="submit">{managementMutationKey === "master-record:Student groups" ? "Saving..." : editingGroup ? "Save changes" : "Save group"}</button>
                  </div>
                )}
                {view === "Rooms" && (
                  /* 教室新增和编辑共用表单；编辑时回填原容量和设施，避免只改地址却意外清除设备标记。 */
                  <div className="grid gap-3 lg:grid-cols-[1fr_110px_auto_auto_auto_auto]">
                    <input ref={dataManagementFormFirstInputRef} name="room" required maxLength={ROOM_CODE_MAX_LENGTH} defaultValue={editingRoom?.code} placeholder="e.g. 31-05-10" className="rounded-xl border border-blue-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500" />
                    <input name="capacity" required min="1" max={ROOM_CAPACITY_MAXIMUM} defaultValue={editingRoom?.capacity} type="number" placeholder="Capacity" className="rounded-xl border border-blue-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500" />
                    <label className="flex items-center gap-2 text-sm"><input name="lab" defaultChecked={editingRoom?.features.includes("Lab")} type="checkbox" /> Lab</label>
                    <label className="flex items-center gap-2 text-sm"><input name="projector" defaultChecked={editingRoom?.features.includes("Multi projector")} type="checkbox" /> Projector</label>
                    <label className="flex items-center gap-2 text-sm"><input name="smart" defaultChecked={editingRoom?.features.includes("Smart classroom")} type="checkbox" /> Smart</label>
                    <button disabled={managementMutationKey !== null} className="rounded-xl bg-[#153d75] px-4 py-2 text-sm font-bold text-white disabled:cursor-wait disabled:opacity-60" type="submit">{managementMutationKey === "master-record:Rooms" ? "Saving..." : editingRoom ? "Save changes" : "Save room"}</button>
                  </div>
                )}
                </fieldset>
              </form>
            )}

            <div className="overflow-x-auto">
              {/* 首次数据库请求完成后才渲染资料表，避免加载中短暂空表被误认为资料消失。 */}
              {isLoading && <div className="p-8 text-sm text-slate-500">Loading data...</div>}
              {!isLoading && view === "Teachers" && (
                <table className="w-full min-w-[650px] text-left text-sm">
                  <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-400"><tr><th className="px-5 py-3 font-bold">Teacher</th><th className="px-5 py-3 font-bold">Type</th><th className="px-5 py-3 font-bold">Allocated sections</th><th className="px-5 py-3 font-bold">Status</th><th className="px-5 py-3 font-bold" /></tr></thead>
                  <tbody>{filteredTeachers.map((teacher) => (
                    <tr className="border-t border-slate-100" key={teacher.id}>
                      <td className="px-5 py-4 font-semibold text-slate-800">{teacher.name}</td>
                      <td className="px-5 py-4"><Pill tone={teacher.staffType === "PT" ? "amber" : "blue"}>{teacher.staffType}</Pill></td>
                      <td className="px-5 py-4 text-slate-600">{teacher.sections}</td>
                      <td className="px-5 py-4"><Pill tone={teacher.status === "Active" ? "green" : "slate"}>{teacher.status}</Pill></td>
                      <td className="px-5 py-4 text-right">
                        <div className="flex justify-end gap-3">
                          {/* 两个入口都登记真实 DOM 节点；冲突刷新完成后会按原动作恢复焦点。 */}
                          <button
                            ref={(button) => {
                              const key = masterRecordButtonKey("Teachers", teacher.id, "edit");
                              if (button) masterRecordButtonRefs.current.set(key, button);
                              else masterRecordButtonRefs.current.delete(key);
                            }}
                            disabled={managementMutationKey !== null}
                            onClick={() => { setEditingTeacher(teacher); setShowForm(true); }}
                            className="font-semibold text-emerald-700 hover:text-emerald-900 disabled:cursor-wait disabled:opacity-50"
                            type="button"
                          >
                            Edit
                          </button>
                          <button
                            ref={(button) => {
                              const key = masterRecordButtonKey("Teachers", teacher.id, "status");
                              if (button) masterRecordButtonRefs.current.set(key, button);
                              else masterRecordButtonRefs.current.delete(key);
                            }}
                            disabled={managementMutationKey !== null}
                            onClick={() => toggleTeacher(teacher)}
                            className="font-semibold text-blue-700 hover:text-blue-900 disabled:cursor-wait disabled:opacity-50"
                            type="button"
                          >
                            {managementMutationKey === `teacher-status:${teacher.id}` ? "Saving..." : teacher.status === "Active" ? "Deactivate" : "Activate"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}</tbody>
                </table>
              )}
              {!isLoading && view === "Student groups" && (
                <table className="w-full min-w-[650px] text-left text-sm">
                  <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-400"><tr><th className="px-5 py-3 font-bold">Student group</th><th className="px-5 py-3 font-bold">Year</th><th className="px-5 py-3 font-bold">Programme</th><th className="px-5 py-3 font-bold">Scheduling scope</th><th className="px-5 py-3 font-bold" /></tr></thead>
                  <tbody>{filteredGroups.map((group) => (
                    <tr className="border-t border-slate-100" key={group.id}>
                      <td className="px-5 py-4 font-semibold text-slate-800">{group.code}</td><td className="px-5 py-4"><Pill tone="blue">Year {group.year}</Pill></td><td className="px-5 py-4 text-slate-600">{group.program}</td><td className="px-5 py-4 text-slate-500">Checks conflicts and daily limits</td>
                      <td className="px-5 py-4 text-right">
                        <div className="flex justify-end gap-3">
                          <button
                            ref={(button) => {
                              const key = masterRecordButtonKey("Student groups", group.id, "edit");
                              if (button) masterRecordButtonRefs.current.set(key, button);
                              else masterRecordButtonRefs.current.delete(key);
                            }}
                            disabled={managementMutationKey !== null}
                            onClick={() => { setEditingGroup(group); setShowForm(true); }}
                            className="font-semibold text-emerald-700 hover:text-emerald-900 disabled:cursor-wait disabled:opacity-50"
                            type="button"
                          >
                            Edit
                          </button>
                          <button
                            ref={(button) => {
                              const key = masterRecordButtonKey("Student groups", group.id, "delete");
                              if (button) masterRecordButtonRefs.current.set(key, button);
                              else masterRecordButtonRefs.current.delete(key);
                            }}
                            aria-label={`Delete ${group.code} from Year ${group.year}`}
                            disabled={managementMutationKey !== null}
                            onClick={() => void removeStudentGroup(group)}
                            className="font-semibold text-red-700 hover:text-red-900 disabled:cursor-wait disabled:opacity-50"
                            type="button"
                          >
                            {managementMutationKey === `student-group-delete:${group.id}` ? "Deleting..." : "Delete"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}</tbody>
                </table>
              )}
              {!isLoading && view === "Rooms" && (
                <table className="w-full min-w-[650px] text-left text-sm">
                  <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-400"><tr><th className="px-5 py-3 font-bold">Room</th><th className="px-5 py-3 font-bold">Capacity</th><th className="px-5 py-3 font-bold">Facilities</th><th className="px-5 py-3 font-bold">Status</th><th className="px-5 py-3 font-bold" /></tr></thead>
                  <tbody>{filteredRooms.map((room) => (
                    <tr className="border-t border-slate-100" key={room.id}>
                      <td className="px-5 py-4 font-semibold text-slate-800">{room.code}</td><td className="px-5 py-4 text-slate-600">{room.capacity}</td>
                      <td className="px-5 py-4"><div className="flex flex-wrap gap-1.5">{room.features.length ? room.features.map((feature) => <Pill key={feature} tone="slate">{feature}</Pill>) : <span className="text-slate-400">None</span>}</div></td>
                      <td className="px-5 py-4"><Pill tone={room.status === "Active" ? "green" : "slate"}>{room.status}</Pill></td>
                      <td className="px-5 py-4 text-right">
                        <div className="flex justify-end gap-3">
                          <button
                            ref={(button) => {
                              const key = masterRecordButtonKey("Rooms", room.id, "edit");
                              if (button) masterRecordButtonRefs.current.set(key, button);
                              else masterRecordButtonRefs.current.delete(key);
                            }}
                            disabled={managementMutationKey !== null}
                            onClick={() => { setEditingRoom(room); setShowForm(true); }}
                            className="font-semibold text-emerald-700 hover:text-emerald-900 disabled:cursor-wait disabled:opacity-50"
                            type="button"
                          >
                            Edit
                          </button>
                          <button
                            ref={(button) => {
                              const key = masterRecordButtonKey("Rooms", room.id, "status");
                              if (button) masterRecordButtonRefs.current.set(key, button);
                              else masterRecordButtonRefs.current.delete(key);
                            }}
                            disabled={managementMutationKey !== null}
                            onClick={() => toggleRoom(room)}
                            className="font-semibold text-blue-700 hover:text-blue-900 disabled:cursor-wait disabled:opacity-50"
                            type="button"
                          >
                            {managementMutationKey === `room-status:${room.id}` ? "Saving..." : room.status === "Active" ? "Deactivate" : "Activate"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}</tbody>
                </table>
              )}
              {!isLoading && view === "Courses" && (
                <table className="w-full min-w-[760px] text-left text-sm">
                  <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-400"><tr><th className="px-5 py-3 font-bold">Mod</th><th className="px-5 py-3 font-bold">Catalog</th><th className="px-5 py-3 font-bold">Sections</th><th className="px-5 py-3 font-bold">Setup</th><th className="px-5 py-3 font-bold" /></tr></thead>
                  <tbody>
                    {filteredCourses.map((course) => (
                      <tr className="border-t border-slate-100" key={course.id}>
                        <td className="px-5 py-4 font-semibold text-slate-800">{course.code}</td>
                        <td className="px-5 py-4 text-slate-600">{course.catalog ?? <span className="text-slate-400">—</span>}</td>
                        <td className="px-5 py-4"><div className="flex flex-wrap gap-2"><Pill tone="blue">{course.configuredSections}</Pill>{course.allocationVarianceCount > 0 && <Pill tone="amber">{course.allocationVarianceCount} allocation mismatch{course.allocationVarianceCount === 1 ? "" : "es"}</Pill>}</div></td>
                        <td className="px-5 py-4 text-slate-500">{course.durationHours ? `${course.durationHours}h · ${course.sessionsPerWeek}×/week · ${course.primaryYear ? `Y${course.primaryYear}` : "year pending"} · ${course.weekStart !== null && course.weekEnd !== null ? `W${course.weekStart}–${course.weekEnd}` : "all weeks"}` : "Not configured"}</td>
                        <td className="px-5 py-4 text-right">
                          <div className="flex justify-end gap-3">
                            <button disabled={savingCourseSetupId !== null || managementMutationKey !== null} onClick={() => void openSections(course, true, true)} className="font-semibold text-emerald-700 hover:text-emerald-900 disabled:cursor-wait disabled:opacity-50" type="button" aria-label={`Manage ${course.code} sections`}>Manage sections</button>
                            {/* callback ref 会在筛选隐藏课程时删除旧节点；409 后不会把焦点送到已脱离 DOM 的按钮。 */}
                            <button
                              ref={(button) => {
                                if (button) courseConfigureButtonRefs.current.set(course.id, button);
                                else courseConfigureButtonRefs.current.delete(course.id);
                              }}
                              disabled={savingCourseSetupId !== null || managementMutationKey !== null}
                              onClick={() => { setEditingCourse(course); setShowForm(true); }}
                              className="font-semibold text-blue-700 hover:text-blue-900 disabled:cursor-wait disabled:opacity-50"
                              type="button"
                              aria-label={`Configure ${course.code}`}
                            >
                              Configure
                            </button>
                            <button
                              ref={(button) => {
                                if (button) courseDeleteButtonRefs.current.set(course.id, button);
                                else courseDeleteButtonRefs.current.delete(course.id);
                              }}
                              disabled={savingCourseSetupId !== null || managementMutationKey !== null}
                              onClick={() => void removeCourse(course)}
                              className="font-semibold text-red-700 hover:text-red-900 disabled:cursor-wait disabled:opacity-50"
                              type="button"
                              aria-label={`Delete ${course.code}`}
                            >
                              {managementMutationKey === `course-delete:${course.id}` ? "Deleting..." : "Delete"}
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {selectedCourse && (
              /* 班次分配与课程统一设置分开，因为不同班次可有不同教师和学生班级。 */
              <div className="border-t border-slate-200 bg-slate-50 p-4">
                <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                  <div><p className="font-bold text-slate-950">Manage {selectedCourse.code} sections</p><p className="text-xs text-slate-500">Change the number of sections, then assign a teacher and one or more student groups to each section.</p></div>
                  <button ref={sectionsCloseButtonRef} disabled={managementMutationKey !== null} onClick={() => { setSelectedCourse(null); setSections([]); setAllocationVariances([]); }} className="text-sm font-semibold text-blue-700 disabled:cursor-wait disabled:opacity-50" type="button" aria-label={`Close ${selectedCourse.code} sections`}>Close</button>
                </div>
                {/* 修正班次数量时保留低编号班次；仍含排课或班级关联的班次，服务端会拒绝删除。 */}
                <form key={`${selectedCourse.id}:${selectedCourse.revision}:${sections.length}`} onSubmit={changeSectionCount} className="mb-3 flex flex-wrap items-end gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3">
                  <label className="text-xs font-semibold text-amber-950">Number of sections<input ref={sectionCountInputRef} name="sectionCount" required min="1" max="999" defaultValue={sections.length} disabled={managementMutationKey !== null} type="number" className="mt-1 block w-28 rounded-lg border border-amber-200 bg-white px-3 py-2 text-sm disabled:cursor-wait disabled:bg-slate-100" /></label>
                  <button disabled={managementMutationKey !== null} className="rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm font-bold text-amber-900 disabled:cursor-wait disabled:opacity-60" type="submit">{managementMutationKey === `section-count:${selectedCourse.id}` ? "Saving..." : "Save section count"}</button>
                  <p className="text-xs text-amber-800">Reducing removes only the highest unscheduled numbers. Clear student groups and manual teachers first; imported allocation remains as an auditable baseline.</p>
                </form>
                {allocationVariances.length > 0 && (
                  <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 p-3">
                    <p className="text-sm font-black text-amber-950">Teaching allocation differs from current teachers</p>
                    <p className="mt-1 text-xs text-amber-800">Saving is allowed. Review these counts against the imported Teaching Members file.</p>
                    <div className="mt-2 grid gap-1">
                      {allocationVariances.map((variance) => <p key={variance.teacherId} className="text-xs font-semibold text-amber-900">{variance.teacherName}: expected {variance.expectedSections}, currently {variance.actualSections}</p>)}
                    </div>
                  </div>
                )}
                <div className="grid gap-3">
                  {sections.map((section) => (
                    /* revision 放进 key 后，并发冲突重新载入时会重建表单，确保 defaultValue 与 defaultChecked 不残留旧资料。 */
                    <form key={`${section.id}:${section.revision}`} onSubmit={(event) => saveSection(event, section)} className="rounded-xl border border-slate-200 bg-white p-3">
                      <div className="grid gap-3 md:grid-cols-[130px_1fr_auto]">
                        <p
                          ref={(target) => {
                            if (target) sectionAssignmentFocusRefs.current.set(section.id, target);
                            else sectionAssignmentFocusRefs.current.delete(section.id);
                          }}
                          className="pt-2 font-bold text-slate-900 outline-none focus-visible:rounded focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
                          tabIndex={-1}
                          aria-label={`${section.label} assignments`}
                        >
                          {section.label}
                        </p>
                        {/* 旧班次可保留当前停用教师，但只有 Active 教师会出现在可改选名单中。 */}
                        <TeacherSelect teachers={teachers} selectedTeacherId={section.teacherId} selectedTeacherName={section.teacherName} ariaLabel={`Teacher for ${section.label}`} disabled={managementMutationKey !== null} />
                        <button disabled={savingSectionId !== null || managementMutationKey !== null} className="rounded-lg bg-[#153d75] px-3 py-2 text-sm font-bold text-white disabled:cursor-wait disabled:opacity-60" type="submit" aria-label={`Save ${section.label} assignments`}>
                          {savingSectionId === section.id ? "Saving..." : "Save"}
                        </button>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-3 text-xs text-slate-700">
                        {groups.map((group) => (
                          <label key={group.id} className="flex items-center gap-1.5">
                            <input name="studentGroupIds" value={group.id} defaultChecked={section.studentGroupIds.includes(group.id)} disabled={managementMutationKey !== null} type="checkbox" />
                            {group.code}
                          </label>
                        ))}
                      </div>
                    </form>
                  ))}
                </div>
              </div>
            )}
          </div>}

          {view !== "Year timetables" && <p className="mt-4 text-sm text-slate-500"><span className="font-semibold text-slate-700">System status:</span> {notice}</p>}
        </section>
      </div>
    </main>
  );
}
