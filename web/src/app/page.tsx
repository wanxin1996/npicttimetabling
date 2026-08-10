"use client";

import { DragEvent, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

// 所有功能页面共用同一个外层布局；View 只决定中间区域显示哪一种排课资料，避免为每张资料表重复维护导航和登录逻辑。
type View = "Year timetables" | "Personal timetables" | "Rules & issues" | "Cycle" | "Accounts" | "Profile" | "Teachers" | "Student groups" | "Rooms" | "Courses";
type AppUser = { id: string; username: string; isAdmin: boolean; isActive: boolean };

type Teacher = {
  id: string;
  name: string;
  staffType: "FT" | "PT";
  status: "Active" | "Inactive";
  sections: number;
};

type StudentGroup = {
  id: string;
  code: string;
  year: number;
  program: string;
};

type Room = {
  id: string;
  code: string;
  capacity: number;
  features: string[];
  status: "Active" | "Inactive";
};

type Course = {
  id: string;
  code: string;
  catalog: string | null;
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
  allocationVarianceCount: number;
};

type CourseSection = { id: string; label: string; teacherId: string | null; teacherName: string | null; studentGroupIds: string[]; studentGroupCodes: string[] };
type AllocationVariance = { teacherId: string; teacherName: string; expectedSections: number; actualSections: number };
type ScheduledLesson = { id: string; sectionId: string; sectionLabel: string; courseCode: string; teacherId: string | null; teacherName: string | null; dayOfWeek: number; startHour: number; durationHours: number; roomId: string | null; roomCode: string | null; studentGroups: string[]; occurrence: number; sessionsPerWeek: number; revision: number; warnings: string[]; warningSeverity: "High" | "Warning" | "Advisory" | null };
type UnscheduledSection = { id: string; label: string; teacherName: string | null; staffType: "FT" | "PT" | null; durationHours: number; studentGroups: string[]; occurrence: number; sessionsPerWeek: number };
type UnavailableWindow = { id: string; kind: "Teacher" | "Year"; ownerId: string; ownerLabel: string; dayOfWeek: number; startHour: number; endHour: number };
type ScheduleIssue = { id: string; lessonId: string; sectionLabel: string; primaryYear: number; dayOfWeek: number; startHour: number; endHour: number; teacherName: string | null; roomCode: string | null; studentGroups: string[]; category: "Assignment" | "Availability" | "Conflict" | "Course rule" | "Preference" | "Room" | "Travel" | "Workload"; severity: "High" | "Warning" | "Advisory"; message: string };
type CandidateSlot = { dayOfWeek: number; startHour: number; endHour: number; roomId: string; roomCode: string; roomCapacity: number; roomFeatures: string[] };
type RuleSetting = { key: string; label: string; description: string; enabled: boolean };
type CycleStatus = { courses: number; sections: number; lessons: number; backup: null | { id: string; createdAt: string; courses: number; sections: number; lessons: number } };
type PositionedLesson = { lesson: ScheduledLesson; lane: number; laneCount: number };
type TimetableDropTarget = { dayOfWeek: number; startHour: number };

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

function lessonIssueClasses(severity: ScheduledLesson["warningSeverity"]) {
  // 按需求约定统一课程卡颜色：红色代表严重冲突，黄色代表每日时数等软性上限，蓝色代表建议事项或尚未完成的教师／教室分配。
  if (severity === "High") return { card: "bg-red-50 text-red-950 ring-red-300", message: "text-red-700" };
  if (severity === "Warning") return { card: "bg-amber-50 text-amber-950 ring-amber-300", message: "text-amber-700" };
  return { card: "bg-blue-50 text-blue-900 ring-blue-300", message: "text-blue-700" };
}

function noticeTone(message: string) {
  // 根据给老师看的操作结果文字选择固定提示框颜色；这样不需要每个保存函数都另外传递一套颜色状态。
  const normalized = message.toLowerCase();
  if (["could not", "unable", "failed", "error", "interrupted", "expired"].some((word) => normalized.includes(word))) return "border-red-200 bg-red-50 text-red-900";
  // “no warnings”虽然包含 warnings 单词，实际含义是成功；因此必须先识别完整成功短语，再处理一般警告文字，避免成功结果被误标成黄色。
  if (["no warnings", "successfully", "downloaded as", "full system restored"].some((phrase) => normalized.includes(phrase))) return "border-emerald-200 bg-emerald-50 text-emerald-950";
  if (["warning", "mismatch", "no completely clear"].some((word) => normalized.includes(word))) return "border-amber-200 bg-amber-50 text-amber-950";
  if (["saved", "success", "placed", "updated", "created", "ready", "signed in"].some((word) => normalized.includes(word))) return "border-emerald-200 bg-emerald-50 text-emerald-950";
  return "border-slate-200 bg-white text-slate-800";
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
  // 先统计每天最多有多少门课同时上课，再只给繁忙日期有限的额外宽度；每条并排课程预留约 36px，但一天的最低宽度最多只增长到 252px。
  // 旧版会继续按通道数无限放大繁忙日期；现在宽度增长有上限，并且普通日期缩到 104px，把有限屏幕优先留给需要显示教师姓名的卡片。
  const laneCountsByDay = timetableDays.map((_, dayIndex) => Math.max(1, ...positionedLessons.filter((item) => item.lesson.dayOfWeek === dayIndex + 1).map((item) => item.laneCount)));
  const dayWidthWeights = laneCountsByDay.map((laneCount) => laneCount <= 2 ? 1 : Math.min(2.5, 1 + ((laneCount - 2) * 0.3)));
  const dayMinimumWidths = laneCountsByDay.map((laneCount) => Math.min(252, Math.max(104, laneCount * 36)));
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
    savedLesson?.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
  }, [focusLesson, positionedLessons]);

  const scrollTimetable = (direction: -1 | 1) => {
    // 横向按钮每次移动约四分之三可见宽度，保留一小段原画面作为位置参照，避免老师滚动后不知道刚才离开了哪一天。
    const container = scrollContainerRef.current;
    if (!container) return;
    container.scrollBy({ left: direction * Math.max(320, container.clientWidth * 0.75), behavior: "smooth" });
  };

  return (
    <div>
      {/* 五天默认保持在同一屏；繁忙日期只取得有限的额外宽度，横向导航只作为小窗口的备用方式。 */}
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
        <span>{onCellDrop ? "All five days stay on screen. Busy days receive limited extra space for readable cards." : "All five days stay on screen; use the arrows only on a narrow window."}</span>
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
  const [courses, setCourses] = useState<Course[]>([]);
  const [editingCourse, setEditingCourse] = useState<Course | null>(null);
  const [selectedCourse, setSelectedCourse] = useState<Course | null>(null);
  const [sections, setSections] = useState<CourseSection[]>([]);
  const [allocationVariances, setAllocationVariances] = useState<AllocationVariance[]>([]);
  const [timetableYear, setTimetableYear] = useState(1);
  const [lessons, setLessons] = useState<ScheduledLesson[]>([]);
  const [unscheduledSections, setUnscheduledSections] = useState<UnscheduledSection[]>([]);
  const [unscheduledQuery, setUnscheduledQuery] = useState("");
  const [unscheduledStaffType, setUnscheduledStaffType] = useState<"All" | "FT" | "PT">("All");
  const [unscheduledGroupId, setUnscheduledGroupId] = useState("");
  const [unscheduledProgram, setUnscheduledProgram] = useState("");
  const [editingLesson, setEditingLesson] = useState<ScheduledLesson | null>(null);
  const [showTimetableInspector, setShowTimetableInspector] = useState(false);
  const [unavailableWindows, setUnavailableWindows] = useState<UnavailableWindow[]>([]);
  const [scheduleIssues, setScheduleIssues] = useState<ScheduleIssue[]>([]);
  const [placingSection, setPlacingSection] = useState<UnscheduledSection | null>(null);
  const [candidateSection, setCandidateSection] = useState<UnscheduledSection | null>(null);
  const [candidateSlots, setCandidateSlots] = useState<CandidateSlot[]>([]);
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  const [recentlySavedLesson, setRecentlySavedLesson] = useState<{ id: string; requestNumber: number } | null>(null);
  const savedLessonRequestNumber = useRef(0);
  const [personalKind, setPersonalKind] = useState<"Teacher" | "StudentGroup" | "Room">("Teacher");
  const [personalOwnerId, setPersonalOwnerId] = useState("");
  const [personalLessons, setPersonalLessons] = useState<ScheduledLesson[]>([]);
  const [ruleSettings, setRuleSettings] = useState<RuleSetting[]>([]);
  const [currentCycle, setCurrentCycle] = useState<CycleStatus | null>(null);
  const [authScreen, setAuthScreen] = useState<"checking" | "setup" | "login" | "ready">("checking");
  const [currentUser, setCurrentUser] = useState<AppUser | null>(null);
  const [accounts, setAccounts] = useState<AppUser[]>([]);
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);
  const [importing, setImporting] = useState(false);
  const [downloadingBackup, setDownloadingBackup] = useState(false);
  const [restoringBackup, setRestoringBackup] = useState(false);
  const [notice, setNotice] = useState("Loading the local scheduling database...");
  const [showNoticeToast, setShowNoticeToast] = useState(true);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // 每次产生新的操作结果时重新显示浮动提示，八秒后只隐藏浮层而不删除 notice 内容。
    // 因此其他页面底部的 System status 仍可保留完整结果，同时排课页不会长期被提示框遮挡。
    if (!notice) return;
    // 状态更新放进计时器回调，让 Effect 只负责同步浏览器计时器，避免在 Effect 本体中连续触发 React 重绘。
    const showTimeout = window.setTimeout(() => setShowNoticeToast(true), 0);
    const hideTimeout = window.setTimeout(() => setShowNoticeToast(false), 8000);
    return () => {
      window.clearTimeout(showTimeout);
      window.clearTimeout(hideTimeout);
    };
  }, [notice]);

  useEffect(() => {
    // 保存后的绿色外框保留六秒，让老师能把右上角操作提示和总表课程对应起来；随后自动消失，避免被误认为永久冲突标记。
    if (!recentlySavedLesson) return;
    const timeout = window.setTimeout(() => setRecentlySavedLesson(null), 6000);
    return () => window.clearTimeout(timeout);
  }, [recentlySavedLesson]);

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
    const selectedGroupCode = groups.find((group) => group.id === unscheduledGroupId)?.code;
    return unscheduledSections.filter((section) => {
      const sectionGroups = groups.filter((group) => section.studentGroups.includes(group.code));
      const searchableText = [section.label, section.teacherName ?? "", section.staffType ?? "", ...section.studentGroups, ...sectionGroups.map((group) => group.program)].join(" ").toLowerCase();
      return (!normalizedQuery || searchableText.includes(normalizedQuery))
        && (unscheduledStaffType === "All" || section.staffType === unscheduledStaffType)
        && (!selectedGroupCode || section.studentGroups.includes(selectedGroupCode))
        && (!unscheduledProgram || sectionGroups.some((group) => group.program === unscheduledProgram));
    });
  }, [groups, unscheduledGroupId, unscheduledProgram, unscheduledQuery, unscheduledSections, unscheduledStaffType]);
  const visibleYearIssues = useMemo(() => {
    const severityRank = { High: 0, Warning: 1, Advisory: 2 } as const;
    return scheduleIssues
      .filter((issue) => issue.primaryYear === timetableYear)
      .sort((left, right) => severityRank[left.severity] - severityRank[right.severity] || left.dayOfWeek - right.dayOfWeek || left.startHour - right.startHour);
  }, [scheduleIssues, timetableYear]);

  function openView(nextView: View) {
    // 切换资料页面时清除上一页专用的编辑对象、筛选和课程详情，防止旧状态被错误带到新的表格。
    setView(nextView);
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
    setCandidateSection(null);
    setCandidateSlots([]);
  }

  async function openTimetable(year: number) {
    // 系里分别维护三个年级总表，因此这里只加载一个年级的已排课程、待排课程和问题，减少页面数据量并保持年级边界清楚。
    const [lessonResponse, unscheduledResponse, issuesResponse] = await Promise.all([fetch(`/api/schedule/lessons?year=${year}`), fetch(`/api/schedule/unscheduled?year=${year}`), fetch("/api/issues")]);
    if (!lessonResponse.ok || !unscheduledResponse.ok || !issuesResponse.ok) return setNotice("The year timetable could not be loaded.");
    setTimetableYear(year);
    setLessons(await lessonResponse.json());
    setUnscheduledSections(await unscheduledResponse.json());
    setScheduleIssues(await issuesResponse.json());
    setView("Year timetables");
    setShowForm(false);
    setEditingLesson(null);
    setPlacingSection(null);
    setCandidateSection(null);
    setCandidateSlots([]);
  }

  async function openScheduleIssue(issue: ScheduleIssue) {
    // 从问题清单打开课程前重新读取该年级的总表与待排区，确保编辑器使用最新 revision，不会覆盖另一位老师刚保存的修改。
    const [lessonResponse, unscheduledResponse] = await Promise.all([
      fetch(`/api/schedule/lessons?year=${issue.primaryYear}`),
      fetch(`/api/schedule/unscheduled?year=${issue.primaryYear}`),
    ]);
    if (!lessonResponse.ok || !unscheduledResponse.ok) return setNotice("The lesson linked to this issue could not be loaded.");

    const nextLessons = await lessonResponse.json() as ScheduledLesson[];
    const linkedLesson = nextLessons.find((lesson) => lesson.id === issue.lessonId);
    // 问题页显示后，其他账号可能已把课程退回待排区；如果找不到课程，就留在问题页并说明该记录已经过期。
    if (!linkedLesson) return setNotice("This lesson is no longer scheduled. Refresh the issue list to remove the old item.");

    // 找到课程后切换到正确年级、保留该年级待排区并打开标准编辑器，让老师可以立即修正或把准确课程退回待排区。
    setTimetableYear(issue.primaryYear);
    setLessons(nextLessons);
    setUnscheduledSections(await unscheduledResponse.json() as UnscheduledSection[]);
    setEditingLesson(linkedLesson);
    setPlacingSection(null);
    setCandidateSection(null);
    setCandidateSlots([]);
    setShowTimetableInspector(true);
    setView("Year timetables");
    setShowForm(false);
    setNotice(`${issue.sectionLabel} opened from the issue list.`);

    // 问题记录可能位于长页面底部；等待 React 完成页面切换后，再把新编辑器滚动到可见位置。
    requestAnimationFrame(() => document.getElementById("lesson-editor")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  async function openRules() {
    // 同时读取不可用时段、最新问题和可开关规则；规则改变后重新打开本页即可看到所有受影响课程的重新计算结果。
    const [rulesResponse, issuesResponse, settingsResponse] = await Promise.all([fetch("/api/unavailability"), fetch("/api/issues"), fetch("/api/rule-settings")]);
    if (!rulesResponse.ok || !issuesResponse.ok || !settingsResponse.ok) return setNotice("Rules and timetable issues could not be loaded.");
    setUnavailableWindows(await rulesResponse.json());
    setScheduleIssues(await issuesResponse.json());
    setRuleSettings(await settingsResponse.json());
    setView("Rules & issues");
    setShowForm(false);
  }

  async function openCycle() {
    // 新周期工具每年只使用两次，而且包含清空资料的高风险操作，因此只在进入专用页面时加载，不能与日常排课共用快捷入口。
    const response = await fetch("/api/cycle");
    if (!response.ok) return setNotice("Cycle status could not be loaded.");
    setCurrentCycle(await response.json());
    setView("Cycle");
    setShowForm(false);
  }

  async function loadPersonalTimetable(kind: "Teacher" | "StudentGroup" | "Room", requestedOwnerId?: string) {
    // 首次打开或切换个人课表类型时选择一个仍有效的默认对象；后续下拉变化始终明确保存教师、班级或教室编号。
    const availableOwners = kind === "Teacher"
      ? teachers.filter((teacher) => teacher.status === "Active")
      : kind === "Room"
        ? rooms.filter((room) => room.status === "Active")
        : groups;
    const ownerId = requestedOwnerId || availableOwners[0]?.id || "";
    setPersonalKind(kind);
    setPersonalOwnerId(ownerId);
    setView("Personal timetables");
    setShowForm(false);
    if (!ownerId) {
      setPersonalLessons([]);
      const missingOwner = kind === "Teacher" ? "active teacher" : kind === "Room" ? "active room" : "student group";
      return setNotice(`Add at least one ${missingOwner} before opening a personal timetable.`);
    }
    const response = await fetch(`/api/schedule/personal?kind=${kind}&ownerId=${encodeURIComponent(ownerId)}`);
    if (!response.ok) return setNotice("The personal timetable could not be loaded.");
    setPersonalLessons(await response.json());
  }

  async function placeSection(event: DragEvent<HTMLDivElement>, dayOfWeek: number, startHour: number) {
    // 拖动资料只负责标识班次或已排课程；服务端会重新读取课时、教师和班级，浏览器端即使被修改也不能绕过排课规则。
    event.preventDefault();
    const lessonId = event.dataTransfer.getData("application/x-scheduled-lesson");
    if (lessonId) {
      const lesson = lessons.find((item) => item.id === lessonId);
      if (!lesson) return;
      const response = await fetch(`/api/schedule/lessons/${lessonId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dayOfWeek, startHour, roomId: lesson.roomId, teacherId: lesson.teacherId, revision: lesson.revision }) });
      const body = await response.json();
      if (!response.ok) return setNotice(body.error ?? "The lesson could not be moved.");
      setEditingLesson(null);
      await openTimetable(timetableYear);
      revealSavedLesson(body.id);
      return setNotice(body.warnings.length ? `${body.sectionLabel} moved with warnings: ${body.warnings.join(", ")}.` : `${body.sectionLabel} moved successfully.`);
    }
    const draggedSession = event.dataTransfer.getData("text/plain");
    if (!draggedSession) return;
    const [sectionId, occurrenceText] = draggedSession.split(":");
    const occurrence = Number(occurrenceText ?? 1);
    const response = await fetch("/api/schedule/lessons", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sectionId, occurrence, dayOfWeek, startHour, roomId: null }) });
    const body = await response.json();
    if (!response.ok) return setNotice(body.error ?? "The section could not be placed.");
    await openTimetable(timetableYear);
    revealSavedLesson(body.id);
    setNotice(body.warnings.length ? `${body.sectionLabel} saved with warnings: ${body.warnings.join(", ")}.` : `${body.sectionLabel} placed successfully. Assign its room next.`);
  }

  async function findCandidateSlots(section: UnscheduledSection) {
    // 只有老师点击 Clear slots 时才计算候选时段，并用新班次结果替换旧结果，避免数百个班次的建议同时挤满侧栏。
    setCandidateSection(section);
    setPlacingSection(null);
    setEditingLesson(null);
    setCandidateSlots([]);
    setCandidatesLoading(true);
    const [sectionId] = section.id.split(":");
    const response = await fetch(`/api/course-sections/${sectionId}/candidates?occurrence=${section.occurrence}`);
    const body = await response.json();
    setCandidatesLoading(false);
    if (!response.ok) return setNotice(body.error ?? "Candidate slots could not be calculated.");
    setCandidateSlots(body.slots);
    setNotice(body.slots.length ? `${body.slots.length} completely clear room and time options found for ${section.label}.` : `No completely clear options found for ${section.label}. Check its assignments and restrictions.`);
  }

  async function placeCandidate(slot: CandidateSlot) {
    // 候选项已经包含校验过的教室，老师可一次点击完成排课；正式保存时接口仍会再次运行警告引擎，防止候选生成后资料发生变化。
    if (!candidateSection) return;
    const [sectionId] = candidateSection.id.split(":");
    const response = await fetch("/api/schedule/lessons", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sectionId, occurrence: candidateSection.occurrence, dayOfWeek: slot.dayOfWeek, startHour: slot.startHour, roomId: slot.roomId }) });
    const body = await response.json();
    if (!response.ok) return setNotice(body.error ?? "The candidate placement could not be saved.");
    setCandidateSection(null);
    setCandidateSlots([]);
    await openTimetable(timetableYear);
    revealSavedLesson(body.id);
    setNotice(body.warnings.length ? `${body.sectionLabel} changed while placing and now has warnings: ${body.warnings.join(", ")}.` : `${body.sectionLabel} placed in ${slot.roomCode} with no warnings.`);
  }

  async function placeSectionWithoutDrag(event: FormEvent<HTMLFormElement>) {
    // 不方便拖动的老师可以在 Inspector 使用键盘或鼠标选择星期、时间和教室；提交接口与拖放完全相同，因此冲突提示也一致。
    event.preventDefault();
    if (!placingSection) return;
    const data = new FormData(event.currentTarget);
    const [sectionId] = placingSection.id.split(":");
    const response = await fetch("/api/schedule/lessons", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sectionId,
        occurrence: placingSection.occurrence,
        dayOfWeek: Number(data.get("dayOfWeek")),
        startHour: Number(data.get("startHour")),
        roomId: String(data.get("roomId") ?? "") || null,
      }),
    });
    const body = await response.json();
    if (!response.ok) return setNotice(body.error ?? "The section could not be placed.");
    setPlacingSection(null);
    await openTimetable(timetableYear);
    revealSavedLesson(body.id);
    setNotice(body.warnings.length ? `${body.sectionLabel} saved with warnings: ${body.warnings.join(", ")}.` : `${body.sectionLabel} placed successfully.`);
  }

  async function saveLesson(event: FormEvent<HTMLFormElement>) {
    // 编辑面板一次保存星期、开始时间、教师和教室；成功后重新载入总表，使最新 warning 和 revision 立即显示。
    event.preventDefault();
    if (!editingLesson) return;
    const data = new FormData(event.currentTarget);
    const response = await fetch(`/api/schedule/lessons/${editingLesson.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dayOfWeek: Number(data.get("dayOfWeek")), startHour: Number(data.get("startHour")), teacherId: String(data.get("teacherId") ?? "") || null, roomId: String(data.get("roomId") ?? "") || null, revision: editingLesson.revision }) });
    const body = await response.json();
    if (!response.ok) return setNotice(body.error ?? "The lesson could not be updated.");
    setEditingLesson(null);
    await openTimetable(timetableYear);
    revealSavedLesson(body.id);
    setNotice(body.warnings.length ? `${body.sectionLabel} saved with warnings: ${body.warnings.join(", ")}.` : `${body.sectionLabel} updated successfully.`);
  }

  async function unscheduleLesson() {
    // 取消排课只删除具体时间安排并把班次退回待排区，不删除课程设置、教师分配或学生班级关联。
    if (!editingLesson) return;
    const response = await fetch(`/api/schedule/lessons/${editingLesson.id}?revision=${editingLesson.revision}`, { method: "DELETE" });
    if (!response.ok) return setNotice("The lesson could not be returned to the tray.");
    const label = editingLesson.sectionLabel;
    setEditingLesson(null);
    await openTimetable(timetableYear);
    setNotice(`${label} returned to the unscheduled tray.`);
  }

  async function saveUnavailableWindow(event: FormEvent<HTMLFormElement>, kind: "Teacher" | "Year") {
    // 教师和年级不可用时段共用同一个接口，但表单保留各自清楚的对象选择，减少重复代码又不牺牲可理解性。
    event.preventDefault();
    // 在等待服务器前保存真实表单元素；React 事件回调暂停后会把 event.currentTarget 清空，但这个独立引用仍可安全重置表单。
    const form = event.currentTarget;
    const data = new FormData(form);
    const response = await fetch("/api/unavailability", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind, ownerId: String(data.get("ownerId") ?? ""), dayOfWeek: Number(data.get("dayOfWeek")), startHour: Number(data.get("startHour")), endHour: Number(data.get("endHour")) }) });
    const body = await response.json();
    if (!response.ok) return setNotice(body.error ?? "Unavailable time could not be saved.");
    form.reset();
    await openRules();
    setNotice(`${kind} unavailable time saved.`);
  }

  async function removeUnavailableWindow(window: UnavailableWindow) {
    // 删除不可用时段会立即影响之后的排课检查；已有课程的 warning 会在重新打开或编辑时根据最新规则刷新。
    const response = await fetch(`/api/unavailability?id=${window.id}&kind=${window.kind}`, { method: "DELETE" });
    if (!response.ok) return setNotice("Unavailable time could not be removed.");
    await openRules();
    setNotice(`${window.ownerLabel} unavailable time removed.`);
  }

  async function toggleRuleSetting(rule: RuleSetting) {
    // 每次只保存一个规则开关，随后重新载入本页；服务端会用新政策重新计算全部问题，让开关影响立即可见。
    const response = await fetch("/api/rule-settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: rule.key, enabled: !rule.enabled }) });
    if (!response.ok) return setNotice("The rule setting could not be changed.");
    await openRules();
    setNotice(`${rule.label} ${rule.enabled ? "disabled" : "enabled"}.`);
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

  const fetchData = useCallback(async () => {
    // 教师、学生班级、教室和课程互不依赖，因此并行读取四张清单，缩短首次进入资料维护页的等待时间。
    const [teacherResponse, groupResponse, roomResponse, courseResponse] = await Promise.all([fetch("/api/teachers"), fetch("/api/student-groups"), fetch("/api/rooms"), fetch("/api/courses")]);
    if (!teacherResponse.ok || !groupResponse.ok || !roomResponse.ok || !courseResponse.ok) throw new Error("Could not load data.");
    return Promise.all([teacherResponse.json() as Promise<Teacher[]>, groupResponse.json() as Promise<StudentGroup[]>, roomResponse.json() as Promise<Room[]>, courseResponse.json() as Promise<Course[]>]);
  }, []);

  const loadData = useCallback(async () => {
    // 所有新增、编辑和 Excel 导入成功后共用这一套刷新流程，确保页面四张基础清单保持同步。
    const [nextTeachers, nextGroups, nextRooms, nextCourses] = await fetchData();
    setTeachers(nextTeachers);
    setGroups(nextGroups);
    setRooms(nextRooms);
    setCourses(nextCourses);
  }, [fetchData]);

  useEffect(() => {
    // 页面启动时先检查登录状态，再请求受保护的业务资料；未登录浏览器不会先下载教师或课程数据。
    void fetch("/api/auth/status").then(async (response) => {
      const status = await response.json() as { setupRequired: boolean; user: AppUser | null };
      if (status.setupRequired) return setAuthScreen("setup");
      if (!status.user) return setAuthScreen("login");
      setCurrentUser(status.user);
      setAuthScreen("ready");
      await loadData();
      setNotice("Local data is saved and ready for scheduling setup.");
    }).catch(() => setNotice("Unable to check authentication. Please refresh and try again.")).finally(() => setIsLoading(false));
  }, [loadData]);

  useEffect(() => {
    // 老师查看实时资料时，每五秒刷新当前功能所需数据；其他账号的修改会自动出现，不需要手工刷新整页。
    if (authScreen !== "ready") return;
    let active = true;

    async function refreshVisibleWorkspace() {
      // 轮询只请求当前可见的年级表、个人表或规则页，既保持多浏览器同步，也避免反复下载无关资料表。
      let responses: Response[] = [];
      if (view === "Year timetables") responses = await Promise.all([fetch(`/api/schedule/lessons?year=${timetableYear}`), fetch(`/api/schedule/unscheduled?year=${timetableYear}`), fetch("/api/issues")]);
      if (view === "Personal timetables" && personalOwnerId) responses = [await fetch(`/api/schedule/personal?kind=${personalKind}&ownerId=${encodeURIComponent(personalOwnerId)}`)];
      if (view === "Rules & issues") responses = await Promise.all([fetch("/api/unavailability"), fetch("/api/issues"), fetch("/api/rule-settings")]);
      if (!active || responses.length === 0) return;
      if (responses.some((response) => response.status === 401)) {
        setCurrentUser(null);
        setAuthScreen("login");
        return setNotice("Your session expired. Please sign in again.");
      }
      if (responses.some((response) => !response.ok)) return;
      const payloads = await Promise.all(responses.map((response) => response.json()));
      if (!active) return;
      if (view === "Year timetables") { setLessons(payloads[0]); setUnscheduledSections(payloads[1]); setScheduleIssues(payloads[2]); }
      if (view === "Personal timetables") setPersonalLessons(payloads[0]);
      if (view === "Rules & issues") { setUnavailableWindows(payloads[0]); setScheduleIssues(payloads[1]); setRuleSettings(payloads[2]); }
      setLastSyncedAt(new Date());
    }

    // 五秒延迟对小型排课团队已接近实时，同时在本地 SQLite MVP 阶段不需要额外维护长期 WebSocket 服务。
    void refreshVisibleWorkspace();
    const interval = window.setInterval(() => void refreshVisibleWorkspace(), 5000);
    return () => { active = false; window.clearInterval(interval); };
  }, [authScreen, personalKind, personalOwnerId, timetableYear, view]);

  async function submitAuthentication(event: FormEvent<HTMLFormElement>) {
    // 首次管理员建立和日常登录共用同一套简洁字段；浏览器根据当前认证画面选择接口，真正的安全校验全部由服务端完成。
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const endpoint = authScreen === "setup" ? "/api/auth/setup" : "/api/auth/login";
    const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: String(data.get("username") ?? ""), password: String(data.get("password") ?? "") }) });
    const body = await response.json();
    if (!response.ok) return setNotice(body.error ?? "Authentication failed.");
    setCurrentUser(body.user);
    setAuthScreen("ready");
    await loadData();
    setNotice(`Signed in as ${body.user.username}.`);
  }

  async function logout() {
    // 登出不仅清除浏览器 Cookie，也在服务端删除会话记录，复制旧 Cookie 也不能继续访问资料。
    await fetch("/api/auth/logout", { method: "POST" });
    setCurrentUser(null);
    setAuthScreen("login");
    setNotice("Signed out.");
  }

  async function openAccounts() {
    // 只有管理员进入账号页时才读取账号清单，日常排课请求不会附带其他用户名，减少不必要的账号资料暴露。
    const response = await fetch("/api/auth/accounts");
    if (!response.ok) return setNotice("Only the administrator can manage accounts.");
    setAccounts(await response.json());
    setView("Accounts");
    setShowForm(false);
  }

  async function createAccount(event: FormEvent<HTMLFormElement>) {
    // 新账号默认是普通排课账号，可以使用全部排课功能但不能建立新账号；只有初始管理员拥有账号创建权。
    event.preventDefault();
    // 请求前保存表单元素，避免异步响应回来后读取已被 React 清空的事件目标，导致账号其实已创建但页面误报错误。
    const form = event.currentTarget;
    const data = new FormData(form);
    const response = await fetch("/api/auth/accounts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: String(data.get("username") ?? ""), password: String(data.get("password") ?? "") }) });
    const body = await response.json();
    if (!response.ok) return setNotice(body.error ?? "Account could not be created.");
    form.reset();
    await openAccounts();
    setNotice(`${body.username} account created.`);
  }

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    // 密码修改成功后撤销该账号的所有浏览器会话，包括当前页面，确保旧密码建立的会话不能继续使用。
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const response = await fetch("/api/auth/password", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ currentPassword: String(data.get("currentPassword") ?? ""), newPassword: String(data.get("newPassword") ?? "") }) });
    const body = await response.json();
    if (!response.ok) return setNotice(body.error ?? "Password could not be changed.");
    setCurrentUser(null);
    setAuthScreen("login");
    setNotice("Password changed. Sign in again with the new password.");
  }

  async function changeAccountStatus(account: AppUser) {
    // 停用账号会保留记录和审计关联，但阻止之后登录；保存后立即刷新清单，让管理员确认最新状态。
    const response = await fetch("/api/auth/accounts", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "status", userId: account.id, isActive: !account.isActive }) });
    if (!response.ok) return setNotice("Account status could not be changed.");
    await openAccounts();
    setNotice(`${account.username} ${account.isActive ? "deactivated" : "activated"}.`);
  }

  async function resetAccountPassword(event: FormEvent<HTMLFormElement>) {
    // 管理员可直接替换普通账号遗忘的密码，不需要知道旧密码；重置成功后服务端同时撤销该账号现有会话。
    event.preventDefault();
    // 先保存提交表单本身，因为 React 的事件目标只在同步回调期间可靠；服务器响应后使用稳定引用清空密码框。
    const form = event.currentTarget;
    const data = new FormData(form);
    const response = await fetch("/api/auth/accounts", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "resetPassword", userId: String(data.get("userId") ?? ""), password: String(data.get("password") ?? "") }) });
    const body = await response.json();
    if (!response.ok) return setNotice(body.error ?? "Password could not be reset.");
    form.reset();
    setNotice("Password reset. Existing sessions for that account were signed out.");
  }

  async function downloadSystemBackup() {
    // 由当前页面请求备份文件，权限或完整性失败时可显示易读提示，而不是跳转到只含 JSON 错误的新页面。
    setDownloadingBackup(true);
    setNotice("Creating and checking the full system backup...");
    try {
      const response = await fetch("/api/system-backup", { cache: "no-store" });
      if (!response.ok) {
        const body = await response.json();
        return setNotice(body.error ?? "The full system backup could not be downloaded.");
      }

      // 服务端提供安全的日期文件名；浏览器建立临时下载地址并触发下载，点击发出后立即撤销地址，避免长期占用内存。
      const disposition = response.headers.get("Content-Disposition") ?? "";
      const filename = disposition.match(/filename="([^"]+)"/)?.[1] ?? "timetabling-backup.sqlite";
      const objectUrl = URL.createObjectURL(await response.blob());
      const downloadLink = document.createElement("a");
      downloadLink.href = objectUrl;
      downloadLink.download = filename;
      document.body.appendChild(downloadLink);
      downloadLink.click();
      downloadLink.remove();
      URL.revokeObjectURL(objectUrl);
      setNotice(`Full system backup downloaded as ${filename}.`);
    } catch {
      // 本地服务断开或网络请求中断时保持页面可继续操作，并明确说明不能把这次请求当作成功备份。
      setNotice("The full system backup could not be downloaded. Check the connection and try again.");
    } finally {
      // 无论成功、接口拒绝还是网络异常，最终都重新启用下载按钮，避免一次失败后按钮永久锁住。
      setDownloadingBackup(false);
    }
  }

  async function restoreSystemBackup(event: FormEvent<HTMLFormElement>) {
    // 浏览器用 FormData 原样上传所选文件和确认项；服务端会独立重复检查所有确认、文件结构和数据库完整性，不能信任前端结果。
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    setRestoringBackup(true);
    setNotice("Validating the backup and saving the current system state...");
    try {
      const response = await fetch("/api/system-backup", { method: "POST", body: formData });
      const body = await response.json();
      if (!response.ok) return setNotice(body.error ?? "The full system backup could not be restored.");

      // 完整恢复成功后当前会话已被删除，而且备份中的账号已取代在线账号；页面必须立即返回登录画面。
      form.reset();
      setCurrentUser(null);
      setAccounts([]);
      setAuthScreen("login");
      setNotice(`Full system restored. All sessions were signed out. Server safety copy: ${body.safetyBackupFilename}.`);
    } catch {
      // 网络中断不能推断恢复成功或失败；提示老师重新登录检查实际资料，再决定是否需要再次恢复。
      setNotice("The restore response was interrupted. Sign in again and verify the current system before retrying.");
    } finally {
      setRestoringBackup(false);
    }
  }

  async function beginNewCycle(event: FormEvent<HTMLFormElement>) {
    // 开始新周期要求两个勾选和完全一致的确认短语，构成约定的多重确认；服务端清空前还会独立验证一次。
    event.preventDefault();
    // 清空请求和资料重载都是异步操作，因此先保存表单元素；最终重置时不能再依赖临时 event.currentTarget。
    const form = event.currentTarget;
    const data = new FormData(form);
    if (!data.get("understandClear") || !data.get("understandBackup")) return setNotice("Complete both confirmations before starting a new cycle.");
    const response = await fetch("/api/cycle", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "start", confirmation: String(data.get("confirmation") ?? "") }) });
    const body = await response.json();
    if (!response.ok) return setNotice(body.error ?? "A new cycle could not be started.");
    setCurrentCycle(body);
    setLessons([]);
    setUnscheduledSections([]);
    setSelectedCourse(null);
    setSections([]);
    await loadData();
    form.reset();
    setNotice("New cycle started. Courses and timetable work were cleared after the emergency backup was saved.");
  }

  async function restoreCycle(event: FormEvent<HTMLFormElement>) {
    // 恢复应急副本会覆盖清空后新做的全部课程和排课，因此必须使用独立勾选与准确短语，不能设计成一键撤销。
    event.preventDefault();
    // 等待恢复接口前保存稳定表单引用，确保成功后可以安全清空确认内容。
    const form = event.currentTarget;
    const data = new FormData(form);
    if (!data.get("understandRestore")) return setNotice("Confirm that current cycle work may be replaced before restoring.");
    const response = await fetch("/api/cycle", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "restore", confirmation: String(data.get("confirmation") ?? "") }) });
    const body = await response.json();
    if (!response.ok) return setNotice(body.error ?? "The emergency backup could not be restored.");
    setCurrentCycle(body);
    await loadData();
    form.reset();
    setNotice("The last emergency cycle backup was restored.");
  }

  async function toggleTeacher(teacher: Teacher) {
    // 教师只切换启用状态而不删除记录，保护历史排课和分配关联；停用后不再出现在新的选择清单。
    const isActive = teacher.status !== "Active";
    const response = await fetch(`/api/teachers/${teacher.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ isActive }) });
    if (!response.ok) return setNotice("Teacher status could not be updated.");
    try {
      await loadData();
      setNotice(`${teacher.name} is now ${isActive ? "active" : "inactive"}.`);
    } catch {
      setNotice("Teacher status changed but the latest data could not be loaded.");
    }
  }

  async function toggleRoom(room: Room) {
    // 教室采用相同的非破坏性停用方式，保留历史课程使用记录，同时阻止新的排课继续选择它。
    const isActive = room.status !== "Active";
    const response = await fetch(`/api/rooms/${room.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ isActive }) });
    if (!response.ok) return setNotice("Room status could not be updated.");
    try {
      await loadData();
      setNotice(`${room.code} is now ${isActive ? "active" : "inactive"}.`);
    } catch {
      setNotice("Room status changed but the latest data could not be loaded.");
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

    if (view === "Teachers") {
      // 教师新增和更正共用姓名与类别字段；编辑时沿用原数据库编号，使既有课程分配不会因为改名而断开。
      const name = String(data.get("name") ?? "").trim().toUpperCase();
      if (!name) return;
      endpoint = editingTeacher ? `/api/teachers/${editingTeacher.id}` : "/api/teachers";
      method = editingTeacher ? "PATCH" : "POST";
      payload = { name, staffType: data.get("staffType") };
    }

    if (view === "Student groups") {
      // 学生班级更正直接更新稳定记录，已关联的班次与冲突检查仍指向同一个班级编号。
      const code = String(data.get("code") ?? "").trim().toUpperCase();
      if (!code) return;
      endpoint = editingGroup ? `/api/student-groups/${editingGroup.id}` : "/api/student-groups";
      method = editingGroup ? "PATCH" : "POST";
      payload = { code, year: Number(data.get("year")), program: String(data.get("program") ?? "").trim().toUpperCase() };
    }

    if (view === "Rooms") {
      // 教室容量和设施保存为结构化标记，后续候选时段和警告引擎可以准确匹配课程的多重教室要求。
      const code = String(data.get("room") ?? "").trim().toUpperCase();
      if (!code) return;
      endpoint = editingRoom ? `/api/rooms/${editingRoom.id}` : "/api/rooms";
      method = editingRoom ? "PATCH" : "POST";
      payload = { code, capacity: Number(data.get("capacity")), hasLab: Boolean(data.get("lab")), hasMultiProjector: Boolean(data.get("projector")), isSmartClassroom: Boolean(data.get("smart")) };
    }

    // 浏览器先统一大小写和数字格式再发送；数据库约束与服务端验证仍是最终防线，不能只依赖表单。
    const response = await fetch(endpoint, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (!response.ok) {
      const body = await response.json();
      setNotice(body.error ?? "This record could not be saved.");
      return;
    }

    form.reset();
    setShowForm(false);
    setEditingTeacher(null);
    setEditingGroup(null);
    setEditingRoom(null);
    try {
      await loadData();
      setNotice(`${view.slice(0, -1)} saved to the local database.`);
    } catch {
      setNotice("Record was saved but the latest data could not be loaded.");
    }
  }

  async function importTeachingMembers(event: FormEvent<HTMLFormElement>) {
    // Excel 使用独立上传流程，浏览器不自行转换 JSON；服务端以同一解析规则读取原始工作簿，减少格式差异。
    event.preventDefault();
    // 工作簿上传时间较长，第一次 await 后 event.currentTarget 已不可靠；预先保存表单，导入成功后才能正常清空文件选择。
    const form = event.currentTarget;
    const formData = new FormData(form);
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) return setNotice("Choose a Teaching Members .xlsx file first.");
    setImporting(true);
    // 工作表名称、表头、每行内容和全部分配由服务端校验，并在一个事务中更新，失败时不会留下半份导入资料。
    const response = await fetch("/api/imports/teaching-members", { method: "POST", body: formData });
    const body = await response.json();
    setImporting(false);
    if (!response.ok) return setNotice(body.error ?? "Teaching allocation import failed.");
    form.reset();
    try {
      await loadData();
      setNotice(`Imported ${body.courses} courses, ${body.teachers} teachers and ${body.sections} pre-assigned sections. ${body.ignoredZeroRows} zero-allocation rows were ignored.`);
    } catch {
      setNotice("Import completed, but the latest data could not be loaded.");
    }
  }

  async function addManualCourse(event: FormEvent<HTMLFormElement>) {
    // 手工课程只用于补充 Excel 遗漏项；系统建立未分配教师的班次，不伪造 teaching allocation，老师之后逐班分配。
    event.preventDefault();
    // 调用接口前保存表单节点，使成功后的重置不依赖已经失效的 React 事件对象。
    const form = event.currentTarget;
    const data = new FormData(form);
    const response = await fetch("/api/courses", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: String(data.get("code") ?? ""), catalog: String(data.get("catalog") ?? ""), sectionCount: Number(data.get("sectionCount")) }) });
    const body = await response.json();
    if (!response.ok) return setNotice(body.error ?? "Manual course could not be created.");
    form.reset();
    setShowForm(false);
    await loadData();
    setNotice(`${body.code} and ${body.configuredSections} unassigned sections created.`);
  }

  async function changeSectionCount(event: FormEvent<HTMLFormElement>) {
    // 减少班次数量时只删除编号最高的班次；即使尚未排课也是有意义的课程资料，因此提交前要求明确确认。
    event.preventDefault();
    if (!selectedCourse) return;
    const data = new FormData(event.currentTarget);
    const sectionCount = Number(data.get("sectionCount"));
    if (sectionCount < sections.length && !window.confirm(`Remove ${sections.length - sectionCount} highest-numbered unscheduled section(s) from ${selectedCourse.code}?`)) return;
    const response = await fetch(`/api/courses/${selectedCourse.id}/sections`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sectionCount }) });
    const body = await response.json();
    if (!response.ok) return setNotice(body.error ?? "Section count could not be changed.");
    await loadData();
    await openSections(selectedCourse);
    setNotice(`${selectedCourse.code} now has ${sectionCount} sections.`);
  }

  async function saveCourseSetup(event: FormEvent<HTMLFormElement>) {
    // 课程清单每次只打开一门课的设置，避免老师同时面对 52 门课程的大量必填规则。
    event.preventDefault();
    if (!editingCourse) return;
    const data = new FormData(event.currentTarget);
    const response = await fetch(`/api/courses/${editingCourse.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
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
    const body = await response.json();
    if (!response.ok) return setNotice(body.error ?? "Course setup could not be saved.");
    await loadData();
    setShowForm(false);
    setEditingCourse(null);
    setNotice(`${editingCourse.code} setup saved. Its generated sections will use these requirements.`);
  }

  async function openSections(course: Course) {
    // 只有点击 Sections 时才读取班次明细和教师分配差异，让最初的 52 门课程清单保持简洁且加载快速。
    const [sectionsResponse, allocationResponse] = await Promise.all([fetch(`/api/courses/${course.id}/sections`), fetch(`/api/courses/${course.id}/allocation`)]);
    if (!sectionsResponse.ok || !allocationResponse.ok) return setNotice("Course sections could not be loaded.");
    setSections(await sectionsResponse.json());
    setAllocationVariances(await allocationResponse.json());
    setSelectedCourse(course);
    setShowForm(false);
    setEditingCourse(null);
  }

  async function saveSection(event: FormEvent<HTMLFormElement>, section: CourseSection) {
    // 勾选的学生班级会成为该班次之后所有学生冲突、每日时数和个人课表检查的范围。
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const response = await fetch(`/api/course-sections/${section.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ teacherId: String(data.get("teacherId") ?? "") || null, studentGroupIds: data.getAll("studentGroupIds").map(String) }) });
    const body = await response.json();
    if (!response.ok) return setNotice(body.error ?? "Section could not be saved.");
    if (selectedCourse) await openSections(selectedCourse);
    const mismatchCount = (body.allocationVariances as AllocationVariance[]).length;
    setNotice(mismatchCount ? `${section.label} saved. Teaching allocation now has ${mismatchCount} teacher count mismatch${mismatchCount === 1 ? "" : "es"}.` : `${section.label} assignment saved and matches the Teaching Members counts.`);
  }

  // 页面主按钮根据当前资料类型自动显示新增教师、班级、教室或导入课程，减少需要记忆的不同操作入口。
  const actionLabel = view === "Student groups" ? "Add student group" : view === "Courses" ? "Import or add course" : `Add ${view.slice(0, -1).toLowerCase()}`;

  if (authScreen !== "ready") {
    // 未登录浏览器看不到任何排课资料；数据库尚无账号时，同一画面改为建立首位管理员。
    return <main className="grid min-h-screen place-items-center bg-[#f6f8fb] p-6 text-slate-900"><div className="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-7 shadow-xl"><div className="mb-6 flex items-center gap-3"><div className="grid h-11 w-11 place-items-center rounded-xl bg-[#153d75] font-black text-white">NP</div><div><p className="font-black">ICT Timetabling</p><p className="text-xs text-slate-500">Department scheduling workspace</p></div></div>{authScreen === "checking" ? <p className="text-sm text-slate-500">Checking secure session...</p> : <form onSubmit={submitAuthentication}><h1 className="text-2xl font-black">{authScreen === "setup" ? "Create the administrator" : "Sign in"}</h1><p className="mt-2 text-sm leading-6 text-slate-500">{authScreen === "setup" ? "This first account can create the small team of scheduler accounts." : "Use your department scheduler account."}</p><div className="mt-5 grid gap-3"><label className="text-sm font-semibold">Username<input name="username" required minLength={3} autoComplete="username" className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2.5 font-normal" /></label><label className="text-sm font-semibold">Password<input name="password" required minLength={10} autoComplete={authScreen === "setup" ? "new-password" : "current-password"} type="password" className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2.5 font-normal" /></label></div><button className="mt-5 w-full rounded-xl bg-[#153d75] px-4 py-3 font-bold text-white" type="submit">{authScreen === "setup" ? "Create administrator" : "Sign in"}</button></form>}<p className="mt-4 text-xs text-amber-700">{notice}</p></div></main>;
  }

  // 桌面端年级排课工作区占满可视高度，待排区、总表和 Inspector 各自滚动；
  // 操作提示固定在顶部并可关闭，避免像旧版底部提示一样遮住 Inspector 的保存按钮。
  return (
    <main className={`min-h-screen bg-[#f6f8fb] text-slate-900 ${view === "Year timetables" ? "xl:flex xl:h-screen xl:min-h-0 xl:flex-col xl:overflow-hidden" : ""}`}>
      {notice && showNoticeToast && <div className="pointer-events-none fixed inset-x-3 top-3 z-50 flex justify-end sm:left-auto sm:right-4 sm:max-w-sm"><div role="status" aria-live="polite" aria-atomic="true" className={`pointer-events-auto flex max-h-32 w-full items-start gap-3 overflow-hidden rounded-xl border px-4 py-3 text-sm font-semibold shadow-lg ${noticeTone(notice)}`}><span className="sr-only">System status: </span><p className="min-w-0 flex-1 overflow-y-auto leading-5">{notice}</p><button onClick={() => setShowNoticeToast(false)} className="-mr-1 shrink-0 rounded-md px-2 py-1 text-base leading-none opacity-70 hover:bg-black/5 hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-current" type="button" aria-label="Dismiss notification">×</button></div></div>}
      {/* 顶部身份栏始终显示系统名称、同步时间和当前账号，让老师确认自己正在操作哪一个工作区。 */}
      <header className="shrink-0 border-b border-slate-200 bg-white">
        <div className={`mx-auto flex items-center justify-between gap-4 px-3 py-3 ${view === "Year timetables" ? "max-w-[1920px]" : "max-w-7xl sm:px-6 sm:py-4"}`}>
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-[#153d75] text-sm font-black tracking-tight text-white">NP</div>
            <div>
              <p className="text-sm font-bold tracking-tight text-slate-950">ICT Timetabling</p>
              <p className="text-xs text-slate-500">Department scheduling workspace</p>
            </div>
          </div>
          <div className="hidden items-center gap-2 md:flex">
            <Pill tone="amber">Draft workspace</Pill>
            <span className="text-xs text-slate-400">{lastSyncedAt ? `Synced ${lastSyncedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}` : "Sync starting"}</span>
            <button onClick={() => setView("Profile")} className="ml-2 text-sm font-bold text-slate-700 hover:text-blue-700" type="button">{currentUser?.username}</button>
            <button onClick={() => void logout()} className="rounded-lg px-2 py-1 text-xs font-semibold text-slate-500 hover:bg-slate-100" type="button">Sign out</button>
          </div>
          <div className="flex items-center gap-2 md:hidden">
            <button onClick={() => setView("Profile")} className="max-w-28 truncate text-sm font-bold text-slate-700" type="button">{currentUser?.username}</button>
            <button onClick={() => void logout()} className="rounded-lg border border-slate-200 px-2 py-1.5 text-xs font-semibold text-slate-600" type="button">Sign out</button>
          </div>
        </div>
      </header>

      <div className={`mx-auto grid ${view === "Year timetables" ? "max-w-[1920px] gap-3 px-3 py-3 lg:grid-cols-[140px_minmax(0,1fr)] xl:min-h-0 xl:w-full xl:flex-1" : "max-w-7xl gap-6 px-6 py-8 lg:grid-cols-[220px_1fr]"}`}>
        {/* 左侧导航集中全部排课模块，并用选中样式标明当前位置，避免在相似资料页面之间迷失。 */}
        <aside className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm lg:h-fit">
          <p className="px-3 pb-2 pt-1 text-xs font-bold uppercase tracking-[0.14em] text-slate-400">Workspace</p>
          <button onClick={() => void openTimetable(timetableYear)} className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm ${view === "Year timetables" ? "bg-blue-50 font-bold text-blue-800" : "font-medium text-slate-500 hover:bg-slate-50"}`} type="button">
            <span className="text-base">▦</span> Year timetables
          </button>
          <button onClick={() => void loadPersonalTimetable(personalKind, personalOwnerId)} className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm ${view === "Personal timetables" ? "bg-blue-50 font-bold text-blue-800" : "font-medium text-slate-500 hover:bg-slate-50"}`} type="button">
            <span className="text-base">▥</span> Personal timetables
          </button>
          <button onClick={() => openView("Courses")} className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm ${view === "Courses" ? "bg-blue-50 font-bold text-blue-800" : "font-medium text-slate-500 hover:bg-slate-50"}`} type="button">
            <span className="text-base">◫</span> Courses
          </button>
          <button onClick={() => openView("Teachers")} className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm ${["Teachers", "Student groups", "Rooms"].includes(view) ? "bg-blue-50 font-bold text-blue-800" : "font-medium text-slate-500 hover:bg-slate-50"}`} type="button">
            <span className="text-base">▤</span> Data management
          </button>
          <button onClick={() => void openRules()} className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm ${view === "Rules & issues" ? "bg-blue-50 font-bold text-blue-800" : "font-medium text-slate-500 hover:bg-slate-50"}`} type="button">
            <span className="text-base">◌</span> Rules & issues
          </button>
          <button onClick={() => void openCycle()} className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm ${view === "Cycle" ? "bg-blue-50 font-bold text-blue-800" : "font-medium text-slate-500 hover:bg-slate-50"}`} type="button">
            <span className="text-base">↻</span> New cycle & recovery
          </button>
          {currentUser?.isAdmin && <button onClick={() => void openAccounts()} className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm ${view === "Accounts" ? "bg-blue-50 font-bold text-blue-800" : "font-medium text-slate-500 hover:bg-slate-50"}`} type="button"><span className="text-base">⚿</span> Accounts</button>}
          {view !== "Year timetables" && <><div className="my-3 border-t border-slate-100" /><p className="px-3 pb-2 text-xs font-bold uppercase tracking-[0.14em] text-slate-400">Current cycle</p><div className="rounded-xl bg-slate-50 px-3 py-3 text-xs leading-5 text-slate-500">Working timetable · {courses.reduce((total, course) => total + course.configuredSections, 0)} generated sections</div></>}
        </aside>

        <section className={`min-w-0 ${view === "Year timetables" ? "xl:flex xl:min-h-0 xl:flex-col" : ""}`}>
          {/* 页面标题说明当前任务；右侧只保留与当前资料类型对应的主要操作，减少误点。 */}
          <div className={`${view === "Year timetables" ? "mb-3" : "mb-6"} flex flex-col justify-between gap-4 sm:flex-row sm:items-end`}>
            <div>
              <p className="text-sm font-semibold text-blue-700">{view === "Year timetables" ? "Year timetables" : view === "Personal timetables" ? "Personal timetables" : view === "Rules & issues" ? "Rules & issues" : view === "Cycle" ? "Cycle safety" : view === "Accounts" ? "Administration" : view === "Profile" ? "My account" : "Data management"}</p>
              <h1 className={`${view === "Year timetables" ? "text-2xl" : "mt-1 text-3xl"} font-black tracking-tight text-slate-950`}>{view === "Year timetables" ? `Year ${timetableYear} scheduling workspace` : view === "Personal timetables" ? "View a teacher or class timetable" : view === "Rules & issues" ? "Review rules and timetable issues" : view === "Cycle" ? "Start a new scheduling cycle safely" : view === "Accounts" ? "Manage scheduler accounts" : view === "Profile" ? "Change my password" : "Build the scheduling foundation"}</h1>
              <p className={`${view === "Year timetables" ? "mt-1" : "mt-2"} max-w-2xl text-sm leading-6 text-slate-500`}>{view === "Year timetables" ? "Choose a session, place it, and resolve issues without leaving this workspace." : view === "Personal timetables" ? "Read the same saved schedule across years for one teacher, student group or room." : view === "Rules & issues" ? "Maintain unavailable windows and review every current warning in one place." : view === "Cycle" ? "Back up and clear only cycle data, or restore the latest emergency snapshot." : view === "Accounts" ? "Create individual logins for the small scheduling team." : view === "Profile" ? "Changing your password signs out all existing sessions for this account." : "Maintain teachers, student groups and rooms before importing teaching allocations or placing course sections."}</p>
            </div>
            {view !== "Year timetables" && view !== "Personal timetables" && view !== "Rules & issues" && view !== "Cycle" && view !== "Accounts" && view !== "Profile" && <button onClick={toggleForm} className="rounded-xl bg-[#153d75] px-4 py-2.5 text-sm font-bold text-white shadow-sm transition hover:bg-[#0f315f]" type="button">
              {showForm ? "Close form" : `+ ${actionLabel}`}
            </button>}
          </div>

          {!["Year timetables", "Personal timetables", "Rules & issues", "Cycle", "Accounts", "Profile"].includes(view) && <div className="mb-6 grid gap-4 sm:grid-cols-3">
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
                    {personalKind === "StudentGroup" && groups.map((group) => <option key={group.id} value={group.id}>{group.code} · Year {group.year}</option>)}
                    {personalKind === "Room" && rooms.filter((room) => room.status === "Active").map((room) => <option key={room.id} value={room.id}>{room.code} · {room.capacity} seats</option>)}
                  </select>
                </label>
              </div>
              <div className="mb-3 flex items-center justify-between">
                <div><p className="font-black text-slate-950">Weekly timetable</p><p className="text-xs text-slate-500">{personalLessons.length} scheduled lessons across all year master tables</p></div>
                <Pill tone={personalLessons.some((lesson) => lesson.warningSeverity === "High") ? "red" : personalLessons.some((lesson) => lesson.warningSeverity === "Warning") ? "amber" : personalLessons.some((lesson) => lesson.warningSeverity === "Advisory") ? "blue" : "green"}>{personalLessons.some((lesson) => lesson.warningSeverity === "High") ? "Has serious issues" : personalLessons.some((lesson) => lesson.warningSeverity === "Warning") ? "Has warnings" : personalLessons.some((lesson) => lesson.warningSeverity === "Advisory") ? "Has advisories" : "No saved issues"}</Pill>
              </div>
              <WeeklyTimetableGrid
                lessons={personalLessons}
                renderLesson={(lesson) => {
                  // 个人课表沿用总表的跨小时布局但保持只读；卡片只显示与当前查看对象最有关联的教师或教室信息。
                  const issueClasses = lessonIssueClasses(lesson.warningSeverity);
                  return <div className={`h-full overflow-y-auto rounded-md p-2 shadow-sm ${issueClasses.card}`}><p className="font-black">{lesson.sectionLabel} · {lesson.durationHours}h</p><p className="mt-1 font-semibold">{String(lesson.startHour).padStart(2, "0")}:00–{String(lesson.startHour + lesson.durationHours).padStart(2, "0")}:00</p><p className="mt-1">{personalKind === "Teacher" ? lesson.roomCode ?? "Room pending" : personalKind === "Room" ? lesson.teacherName ?? "Teacher pending" : `${lesson.teacherName ?? "Teacher pending"} · ${lesson.roomCode ?? "Room pending"}`}</p>{lesson.warnings.length > 0 && <p className={`mt-1 ${issueClasses.message}`}>⚠ {lesson.warnings.length} issue{lesson.warnings.length === 1 ? "" : "s"}</p>}</div>;
                }}
              />
            </div>
          )}

          {view === "Year timetables" && (
            <div className={`grid gap-2 xl:min-h-0 xl:flex-1 ${showTimetableInspector ? "xl:grid-cols-[190px_minmax(0,1fr)_220px]" : "xl:grid-cols-[190px_minmax(0,1fr)]"}`}>
              <aside className="flex min-h-0 flex-col rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
                <div className="mb-2">
                  <p className="font-bold text-slate-950">Unscheduled sessions</p>
                  <p className="text-xs text-slate-500">{filteredUnscheduledSections.length} of {unscheduledSections.length} ready to place</p>
                </div>
                {/* 待排筛选直接处理当前年级已加载资料；即使有数百个班次也能即时缩小范围，不产生额外接口请求。 */}
                <div className="mb-2 grid shrink-0 gap-2 rounded-xl bg-slate-50 p-2">
                  <input value={unscheduledQuery} onChange={(event) => setUnscheduledQuery(event.target.value)} placeholder="Course or teacher..." className="rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs" />
                  <div className="grid grid-cols-2 gap-2"><select value={unscheduledStaffType} onChange={(event) => setUnscheduledStaffType(event.target.value as "All" | "FT" | "PT")} className="rounded-lg border border-slate-200 bg-white px-2 py-2 text-xs"><option value="All">FT + PT</option><option value="PT">PT priority</option><option value="FT">FT only</option></select><select value={unscheduledProgram} onChange={(event) => setUnscheduledProgram(event.target.value)} className="rounded-lg border border-slate-200 bg-white px-2 py-2 text-xs"><option value="">All programmes</option>{unscheduledPrograms.map((program) => <option key={program} value={program}>{program}</option>)}</select></div>
                  <select value={unscheduledGroupId} onChange={(event) => setUnscheduledGroupId(event.target.value)} className="rounded-lg border border-slate-200 bg-white px-2 py-2 text-xs"><option value="">All student groups</option>{groups.map((group) => <option key={group.id} value={group.id}>{group.code} · {group.program}</option>)}</select>
                  {(unscheduledQuery || unscheduledStaffType !== "All" || unscheduledGroupId || unscheduledProgram) && <button onClick={() => { setUnscheduledQuery(""); setUnscheduledStaffType("All"); setUnscheduledGroupId(""); setUnscheduledProgram(""); }} className="text-left text-xs font-bold text-blue-700" type="button">Clear filters</button>}
                </div>
                <div className="grid min-h-0 flex-1 content-start gap-2 overflow-y-auto pr-1">
                  {filteredUnscheduledSections.map((section) => (
                    <div key={section.id} draggable onDragStart={(event) => { event.dataTransfer.setData("text/plain", section.id); event.dataTransfer.effectAllowed = "move"; setCompactDragPreview(event, section.label); }} className={`cursor-grab rounded-lg border p-2 text-[11px] active:cursor-grabbing ${section.staffType === "PT" ? "border-amber-300 bg-amber-50 text-amber-950" : "border-blue-200 bg-blue-50 text-blue-950"}`}>
                      <div className="flex items-start justify-between gap-2"><p className="font-black">{section.label}</p>{section.staffType === "PT" && <Pill tone="amber">PT priority</Pill>}</div>
                      <p className="mt-1">{section.durationHours}h · {section.teacherName ?? "Teacher pending"}</p>
                      <p className={`mt-1 ${section.staffType === "PT" ? "text-amber-800" : "text-blue-700"}`}>{section.studentGroups.join(", ") || "Student group pending"}</p>
                      <div className="mt-1.5 grid grid-cols-2 gap-1"><button draggable={false} onClick={(event) => { event.stopPropagation(); setShowTimetableInspector(true); setPlacingSection(section); setEditingLesson(null); setCandidateSection(null); }} className="rounded-md bg-[#153d75] px-1.5 py-1 font-bold text-white" type="button">Schedule</button><button draggable={false} onClick={(event) => { event.stopPropagation(); setShowTimetableInspector(true); void findCandidateSlots(section); }} className="rounded-md border border-blue-200 bg-white px-1.5 py-1 font-bold text-blue-800 hover:border-blue-400" type="button">Clear slots</button></div>
                    </div>
                  ))}
                  {/* Excel 导入只知道课程和教师分配，无法自动猜测课时与所属年级。
                      当待排区为空时，直接解释缺少的资料并提供课程设置入口，避免老师误以为导入失败。 */}
                  {filteredUnscheduledSections.length === 0 && (unscheduledSections.length === 0 ? <div className="rounded-xl border border-blue-100 bg-blue-50 p-3 text-xs leading-5 text-blue-900"><p className="font-black">No sessions are ready for Year {timetableYear} yet.</p><p className="mt-1">The allocation was imported, but every course still needs its duration and primary year before its sections can enter this tray.</p><button onClick={() => openView("Courses")} className="mt-2 rounded-lg bg-[#153d75] px-3 py-1.5 font-bold text-white" type="button">Configure courses</button></div> : <p className="rounded-xl bg-slate-50 p-3 text-xs text-slate-500">No sessions match these filters.</p>)}
                </div>
              </aside>

              {/* min-w-0 强制高冲突总表留在中间栏；需要时只滚动总表本身，不把整个页面和导航一起撑宽。 */}
              <div className="flex min-h-0 min-w-0 flex-col rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div><p className="text-xs font-semibold text-blue-700">Master timetable</p><h2 className="text-lg font-black">Year {timetableYear}</h2></div>
                  <div className="flex items-center gap-2"><div className="hidden gap-1 sm:flex"><Pill tone="red">{visibleYearIssues.filter((issue) => issue.severity === "High").length}</Pill><Pill tone="amber">{visibleYearIssues.filter((issue) => issue.severity === "Warning").length}</Pill></div><button onClick={() => setShowTimetableInspector((current) => !current)} className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-bold text-slate-700 hover:border-blue-400 hover:text-blue-700" type="button">{showTimetableInspector ? "Hide inspector" : "Show inspector"}</button><div className="flex gap-1 rounded-xl bg-slate-100 p-1">{[1, 2, 3].map((year) => <button key={year} onClick={() => void openTimetable(year)} className={`rounded-lg px-2.5 py-1.5 text-sm font-semibold ${year === timetableYear ? "bg-white shadow-sm" : "text-slate-500"}`} type="button">Y{year}</button>)}</div></div>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto"><WeeklyTimetableGrid
                    lessons={lessons}
                    focusLesson={recentlySavedLesson}
                    onCellDrop={(event, dayOfWeek, startHour) => void placeSection(event, dayOfWeek, startHour)}
                    renderLesson={(lesson, isDense) => {
                      // 总表卡片的实际高度已经表达两、三或四小时，因此不重复显示“3h”；
                      // 无论同一时间有多少门课，都优先保留课程编号和教师姓名，教室与问题数排在其后。
                      const issueClasses = lessonIssueClasses(lesson.warningSeverity);
                      return <button title={`${lesson.sectionLabel} · ${String(lesson.startHour).padStart(2, "0")}:00–${String(lesson.startHour + lesson.durationHours).padStart(2, "0")}:00 · ${lesson.teacherName ?? "Teacher pending"} · ${lesson.roomCode ?? "Room pending"}`} draggable onDragStart={(event) => { event.dataTransfer.setData("application/x-scheduled-lesson", lesson.id); event.dataTransfer.effectAllowed = "move"; setCompactDragPreview(event, lesson.sectionLabel); }} onClick={() => { setShowTimetableInspector(true); setEditingLesson(lesson); setPlacingSection(null); setCandidateSection(null); }} className={`h-full w-full cursor-pointer overflow-hidden rounded text-left ${isDense ? "p-0.5 text-[9px] leading-[1.05]" : "p-1 text-[10px] leading-tight"} shadow-sm hover:ring-2 focus-visible:outline-none focus-visible:ring-2 ${issueClasses.card}`} type="button">
                        <span className={`block font-black ${isDense ? "whitespace-nowrap text-[7px] tracking-[-0.06em]" : "truncate"}`}>{lesson.sectionLabel}</span>
                        <span className={`mt-0.5 block ${isDense ? "break-words" : "truncate"}`}>{lesson.teacherName ?? "Teacher pending"}</span>
                        <span className="block truncate font-semibold">{lesson.roomCode ?? "Room pending"}</span>
                        {lesson.warnings.length > 0 && <span className={`mt-0.5 block font-bold ${issueClasses.message}`}>⚠ {lesson.warnings.length}</span>}
                      </button>;
                    }}
                  /></div>
              </div>

              {/* Inspector 只在主动点击或选择课程时打开；总览阶段把右侧宽度还给总表，方便一次看见更多课程。 */}
              {showTimetableInspector && <aside className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm" aria-label="Timetable inspector">
                <div className="flex items-center justify-between border-b border-slate-200 p-3"><div><p className="font-black text-slate-950">Inspector</p><p className="text-xs text-slate-500">Edit or resolve in context</p></div><div className="flex gap-1"><Pill tone="red">{visibleYearIssues.filter((issue) => issue.severity === "High").length}</Pill><Pill tone="amber">{visibleYearIssues.filter((issue) => issue.severity === "Warning").length}</Pill></div></div>
                <div className="min-h-0 flex-1 overflow-y-auto p-3">
                  {editingLesson ? <form id="lesson-editor" onSubmit={saveLesson} className="grid gap-3"><div className="flex items-start justify-between gap-2"><div><p className="font-black text-slate-950">Edit {editingLesson.sectionLabel}</p><p className="text-xs text-slate-500">{editingLesson.durationHours} hours · occurrence {editingLesson.occurrence}</p></div><button onClick={() => setEditingLesson(null)} className="text-xs font-bold text-slate-500" type="button">Close</button></div>{editingLesson.warnings.length > 0 && <div className="rounded-xl border border-red-200 bg-red-50 p-2 text-xs text-red-800"><p className="font-black">Resolve {editingLesson.warnings.length} issue{editingLesson.warnings.length === 1 ? "" : "s"}</p><ul className="mt-1 list-disc space-y-1 pl-4">{editingLesson.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></div>}<label className="text-xs font-semibold text-slate-700">Day<select name="dayOfWeek" defaultValue={editingLesson.dayOfWeek} className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm">{["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"].map((day, index) => <option key={day} value={index + 1}>{day}</option>)}</select></label><label className="text-xs font-semibold text-slate-700">Start hour<select name="startHour" defaultValue={editingLesson.startHour} className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm">{timetableHours.filter((hour) => hour + editingLesson.durationHours <= 18).map((hour) => <option key={hour} value={hour}>{String(hour).padStart(2, "0")}:00</option>)}</select></label><label className="text-xs font-semibold text-slate-700">Teacher<select name="teacherId" defaultValue={editingLesson.teacherId ?? ""} className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"><option value="">Teacher pending</option>{teachers.filter((teacher) => teacher.status === "Active").map((teacher) => <option key={teacher.id} value={teacher.id}>{teacher.name} ({teacher.staffType})</option>)}</select></label><label className="text-xs font-semibold text-slate-700">Room<select name="roomId" defaultValue={editingLesson.roomId ?? ""} className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"><option value="">Room pending</option>{rooms.filter((room) => room.status === "Active").map((room) => <option key={room.id} value={room.id}>{room.code} · {room.capacity} seats</option>)}</select></label><div className="grid grid-cols-2 gap-2"><button onClick={() => void unscheduleLesson()} className="rounded-lg border border-red-200 px-3 py-2 text-xs font-bold text-red-700" type="button">Return to tray</button><button className="rounded-lg bg-[#153d75] px-3 py-2 text-xs font-bold text-white" type="submit">Save changes</button></div></form>
                  : placingSection ? <form onSubmit={placeSectionWithoutDrag} className="grid gap-3"><div className="flex items-start justify-between gap-2"><div><p className="font-black text-slate-950">Schedule {placingSection.label}</p><p className="text-xs text-slate-500">Keyboard and click alternative to dragging</p></div><button onClick={() => setPlacingSection(null)} className="text-xs font-bold text-slate-500" type="button">Close</button></div><div className="rounded-xl bg-blue-50 p-3 text-xs text-blue-900"><p className="font-bold">{placingSection.teacherName ?? "Teacher pending"}</p><p className="mt-1">{placingSection.studentGroups.join(", ") || "Student group pending"} · {placingSection.durationHours}h</p></div><label className="text-xs font-semibold text-slate-700">Day<select name="dayOfWeek" className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm">{["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"].map((day, index) => <option key={day} value={index + 1}>{day}</option>)}</select></label><label className="text-xs font-semibold text-slate-700">Start hour<select name="startHour" className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm">{timetableHours.filter((hour) => hour + placingSection.durationHours <= 18).map((hour) => <option key={hour} value={hour}>{String(hour).padStart(2, "0")}:00</option>)}</select></label><label className="text-xs font-semibold text-slate-700">Room<select name="roomId" className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"><option value="">Assign later</option>{rooms.filter((room) => room.status === "Active").map((room) => <option key={room.id} value={room.id}>{room.code} · {room.capacity} seats</option>)}</select></label><button className="rounded-lg bg-[#153d75] px-3 py-2.5 text-sm font-bold text-white" type="submit">Place session</button><button onClick={() => void findCandidateSlots(placingSection)} className="rounded-lg border border-emerald-200 px-3 py-2 text-xs font-bold text-emerald-800" type="button">Show only clear options</button></form>
                  : candidateSection ? <div><div className="flex items-start justify-between gap-2"><div><p className="font-black text-emerald-950">Clear slots</p><p className="text-xs text-emerald-800">{candidateSection.label} · no saved issue</p></div><button onClick={() => { setCandidateSection(null); setCandidateSlots([]); }} className="text-xs font-bold text-slate-500" type="button">Close</button></div>{candidatesLoading ? <p className="mt-4 text-sm text-slate-500">Checking every room and hour...</p> : candidateSlots.length === 0 ? <p className="mt-4 rounded-xl bg-slate-50 p-3 text-xs text-slate-600">No completely clear option is available. Check assignments and restrictions.</p> : <div className="mt-3 grid gap-2">{candidateSlots.map((slot) => <button key={`${slot.dayOfWeek}-${slot.startHour}-${slot.roomId}`} onClick={() => void placeCandidate(slot)} className="rounded-xl border border-emerald-200 bg-emerald-50 p-2.5 text-left text-xs hover:border-emerald-500" type="button"><span className="block font-black text-emerald-950">{timetableDays[slot.dayOfWeek - 1]} {String(slot.startHour).padStart(2, "0")}:00–{String(slot.endHour).padStart(2, "0")}:00</span><span className="mt-1 block font-semibold text-slate-700">{slot.roomCode} · {slot.roomCapacity} seats</span></button>)}</div>}</div>
                  : <div><p className="text-xs leading-5 text-slate-500">Select a lesson to edit it, or choose Schedule on an unscheduled session.</p><div className="my-3 border-t border-slate-100" /><div className="mb-2 flex items-center justify-between"><p className="text-sm font-black text-slate-950">Year {timetableYear} issues</p><button onClick={() => void openRules()} className="text-xs font-bold text-blue-700" type="button">All rules</button></div>{visibleYearIssues.length === 0 ? <p className="rounded-xl bg-emerald-50 p-3 text-xs font-semibold text-emerald-800">No issues in this year.</p> : <div className="grid gap-2">{visibleYearIssues.map((issue) => <button key={issue.id} onClick={() => void openScheduleIssue(issue)} className="rounded-xl border border-slate-200 p-2.5 text-left text-xs hover:border-blue-300 hover:bg-blue-50" type="button"><span className="flex items-center justify-between gap-2"><span className="font-black text-slate-900">{issue.sectionLabel}</span><Pill tone={issue.severity === "High" ? "red" : issue.severity === "Warning" ? "amber" : "blue"}>{issue.severity}</Pill></span><span className="mt-1 block font-semibold text-slate-700">{issue.message}</span><span className="mt-1 block text-slate-500">{timetableDays[issue.dayOfWeek - 1]} {String(issue.startHour).padStart(2, "0")}:00</span></button>)}</div>}</div>}
                </div>
              </aside>}
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
                <button disabled={currentCycle.courses === 0} className="mt-4 rounded-xl bg-red-700 px-4 py-2.5 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-50" type="submit">Back up and start new cycle</button>
              </form>
              <form onSubmit={restoreCycle} className="rounded-2xl border border-amber-200 bg-amber-50 p-5 shadow-sm">
                <p className="font-black text-amber-950">Restore latest emergency backup</p>
                {currentCycle.backup ? <><p className="mt-1 text-xs leading-5 text-amber-800">Saved {new Date(currentCycle.backup.createdAt).toLocaleString()} · {currentCycle.backup.courses} courses · {currentCycle.backup.sections} sections · {currentCycle.backup.lessons} lessons.</p><div className="mt-4 grid gap-3 text-sm text-amber-950"><label className="flex items-start gap-2"><input name="understandRestore" type="checkbox" className="mt-1" /><span>I understand this replaces any course and timetable work currently in the active workspace.</span></label><label className="font-semibold">Type RESTORE LAST BACKUP<input name="confirmation" required autoComplete="off" className="mt-1 w-full rounded-xl border border-amber-200 bg-white px-3 py-2 font-normal" /></label></div><button className="mt-4 rounded-xl bg-amber-700 px-4 py-2.5 text-sm font-bold text-white" type="submit">Restore emergency backup</button></> : <p className="mt-3 text-sm text-slate-500">No emergency cycle backup is available yet.</p>}
              </form>
            </div>
          )}

          {view === "Profile" && <form onSubmit={changePassword} className="mb-6 max-w-lg rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><p className="font-black">Change password</p><p className="mt-1 text-xs text-slate-500">At least 10 characters. All logged-in browsers will be signed out.</p><div className="mt-4 grid gap-3"><label className="text-sm font-semibold">Current password<input name="currentPassword" required autoComplete="current-password" type="password" className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 font-normal" /></label><label className="text-sm font-semibold">New password<input name="newPassword" required minLength={10} autoComplete="new-password" type="password" className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 font-normal" /></label></div><button className="mt-4 rounded-xl bg-[#153d75] px-4 py-2.5 text-sm font-bold text-white" type="submit">Change password</button></form>}

          {view === "Accounts" && (
            /* 完整备份和恢复包含密码哈希、全部账号和部门排课资料，因此只放在管理员受限页面。 */
            <div className="mb-6 grid gap-4 lg:grid-cols-[400px_1fr]">
              <div className="grid content-start gap-4">
                <section className="rounded-2xl border border-blue-200 bg-blue-50 p-5 shadow-sm">
                  <p className="font-black text-blue-950">Full system backup</p>
                  <p className="mt-1 text-xs leading-5 text-blue-800">Download a verified SQLite backup containing master data, rules, courses, timetables and accounts. Active login sessions are excluded.</p>
                  <p className="mt-3 text-xs font-semibold leading-5 text-amber-800">Keep this sensitive file in an access-controlled department folder.</p>
                  <button onClick={() => void downloadSystemBackup()} disabled={downloadingBackup || restoringBackup} className="mt-4 rounded-xl bg-[#153d75] px-4 py-2.5 text-sm font-bold text-white disabled:cursor-wait disabled:opacity-60" type="button">{downloadingBackup ? "Checking backup..." : "Download full backup"}</button>
                </section>

                <form onSubmit={restoreSystemBackup} className="rounded-2xl border border-red-200 bg-red-50 p-5 shadow-sm">
                  {/* 服务端恢复前会保存当前状态；旁边的下载再提供一份由管理员独立保管的系统外副本。 */}
                  <p className="font-black text-red-950">Restore full system backup</p>
                  <p className="mt-1 text-xs leading-5 text-red-800">The uploaded file replaces all current data and accounts. The server first retains an automatic safety copy of the current state.</p>
                  <div className="mt-4 grid gap-3 text-sm text-red-950">
                    <label className="font-semibold">Verified .sqlite backup<input name="backupFile" required accept=".sqlite,application/vnd.sqlite3" type="file" className="mt-1 block w-full rounded-xl border border-red-200 bg-white p-2 text-xs font-normal" /></label>
                    <label className="flex items-start gap-2"><input name="understandReplace" type="checkbox" className="mt-1" /><span>I understand that all current timetable data and accounts will be replaced.</span></label>
                    <label className="flex items-start gap-2"><input name="understandSignOut" type="checkbox" className="mt-1" /><span>I understand that every browser will be signed out and I must use an account from the backup.</span></label>
                    <label className="font-semibold">Type RESTORE FULL BACKUP<input name="confirmation" required autoComplete="off" className="mt-1 w-full rounded-xl border border-red-200 bg-white px-3 py-2 font-normal" /></label>
                  </div>
                  <button disabled={restoringBackup || downloadingBackup} className="mt-4 rounded-xl bg-red-700 px-4 py-2.5 text-sm font-bold text-white disabled:cursor-wait disabled:opacity-60" type="submit">{restoringBackup ? "Validating and restoring..." : "Restore and sign out everyone"}</button>
                </form>

                <form onSubmit={createAccount} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                  {/* 只有初始管理员能进入此表单，因此新排课账号只需用户名和初始密码。 */}
                  <p className="font-black">Create scheduler account</p>
                  <p className="mt-1 text-xs leading-5 text-slate-500">Schedulers receive full timetable access but cannot create accounts.</p>
                  <div className="mt-4 grid gap-3">
                    <label className="text-sm font-semibold">Username<input name="username" required minLength={3} autoComplete="off" className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 font-normal" /></label>
                    <label className="text-sm font-semibold">Temporary password<input name="password" required minLength={10} autoComplete="new-password" type="password" className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 font-normal" /></label>
                  </div>
                  <button className="mt-4 rounded-xl bg-[#153d75] px-4 py-2.5 text-sm font-bold text-white" type="submit">Create account</button>
                </form>

                <form onSubmit={resetAccountPassword} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                  {/* 密码重置只撤销所选普通排课账号的会话，绝不修改管理员账号。 */}
                  <p className="font-black">Reset scheduler password</p>
                  <div className="mt-4 grid gap-3">
                    <select name="userId" required className="rounded-xl border border-slate-200 px-3 py-2 text-sm"><option value="">Choose scheduler</option>{accounts.filter((account) => !account.isAdmin).map((account) => <option key={account.id} value={account.id}>{account.username}</option>)}</select>
                    <input name="password" required minLength={10} placeholder="New temporary password" autoComplete="new-password" type="password" className="rounded-xl border border-slate-200 px-3 py-2 text-sm" />
                  </div>
                  <button className="mt-4 rounded-xl border border-blue-200 px-4 py-2 text-sm font-bold text-blue-800" type="submit">Reset and sign out account</button>
                </form>
              </div>

              {/* 账号清单除普通账号启停外保持只读；管理员不能在这里误停用自己。 */}
              <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
                <div className="border-b border-slate-200 p-4"><p className="font-black">Current accounts</p></div>
                <div className="divide-y divide-slate-100">{accounts.map((account) => <div key={account.id} className="flex items-center justify-between gap-3 p-4 text-sm"><div><p className="font-bold">{account.username}</p><p className="text-xs text-slate-500">{account.isAdmin ? "Administrator · can create accounts" : "Scheduler · full timetable access"}</p></div><div className="flex items-center gap-2"><Pill tone={account.isActive ? "green" : "slate"}>{account.isActive ? "Active" : "Inactive"}</Pill>{!account.isAdmin && <button onClick={() => void changeAccountStatus(account)} className="text-xs font-bold text-blue-700" type="button">{account.isActive ? "Deactivate" : "Activate"}</button>}</div></div>)}</div>
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
                    <button onClick={() => void toggleRuleSetting(rule)} className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-bold ${rule.enabled ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-500"}`} type="button">{rule.enabled ? "Enabled" : "Disabled"}</button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {view === "Rules & issues" && <div className="mb-6 grid gap-4 lg:grid-cols-2"><form onSubmit={(event) => saveUnavailableWindow(event, "Teacher")} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"><p className="font-black text-slate-950">Teacher unavailable time</p><p className="mb-3 text-xs text-slate-500">Example: a PT teacher can only teach on selected days.</p><div className="grid gap-2 sm:grid-cols-2"><select name="ownerId" required className="rounded-lg border border-slate-200 px-3 py-2 text-sm"><option value="">Choose teacher</option>{teachers.filter((teacher) => teacher.status === "Active").map((teacher) => <option key={teacher.id} value={teacher.id}>{teacher.name}</option>)}</select><select name="dayOfWeek" className="rounded-lg border border-slate-200 px-3 py-2 text-sm">{["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"].map((day, index) => <option key={day} value={index + 1}>{day}</option>)}</select><select name="startHour" defaultValue="8" className="rounded-lg border border-slate-200 px-3 py-2 text-sm">{[8, 9, 10, 11, 12, 13, 14, 15, 16, 17].map((hour) => <option key={hour} value={hour}>{hour}:00 start</option>)}</select><select name="endHour" defaultValue="18" className="rounded-lg border border-slate-200 px-3 py-2 text-sm">{[9, 10, 11, 12, 13, 14, 15, 16, 17, 18].map((hour) => <option key={hour} value={hour}>{hour}:00 end</option>)}</select></div><button className="mt-3 rounded-lg bg-[#153d75] px-4 py-2 text-sm font-bold text-white" type="submit">Add teacher restriction</button></form><form onSubmit={(event) => saveUnavailableWindow(event, "Year")} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"><p className="font-black text-slate-950">Year unavailable time</p><p className="mb-3 text-xs text-slate-500">Example: Year 1 has no classes on Wednesday.</p><div className="grid gap-2 sm:grid-cols-2"><select name="ownerId" className="rounded-lg border border-slate-200 px-3 py-2 text-sm"><option value="1">Year 1</option><option value="2">Year 2</option><option value="3">Year 3</option></select><select name="dayOfWeek" className="rounded-lg border border-slate-200 px-3 py-2 text-sm">{["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"].map((day, index) => <option key={day} value={index + 1}>{day}</option>)}</select><select name="startHour" defaultValue="8" className="rounded-lg border border-slate-200 px-3 py-2 text-sm">{[8, 9, 10, 11, 12, 13, 14, 15, 16, 17].map((hour) => <option key={hour} value={hour}>{hour}:00 start</option>)}</select><select name="endHour" defaultValue="18" className="rounded-lg border border-slate-200 px-3 py-2 text-sm">{[9, 10, 11, 12, 13, 14, 15, 16, 17, 18].map((hour) => <option key={hour} value={hour}>{hour}:00 end</option>)}</select></div><button className="mt-3 rounded-lg bg-[#153d75] px-4 py-2 text-sm font-bold text-white" type="submit">Add year restriction</button></form><div className="rounded-2xl border border-slate-200 bg-white shadow-sm lg:col-span-2"><div className="border-b border-slate-200 p-4"><p className="font-black">Current unavailable windows</p></div>{unavailableWindows.length === 0 ? <p className="p-4 text-sm text-slate-500">No unavailable windows have been added.</p> : <div className="divide-y divide-slate-100">{unavailableWindows.map((window) => <div key={window.id} className="flex items-center justify-between gap-3 p-4 text-sm"><div><Pill tone={window.kind === "Teacher" ? "amber" : "blue"}>{window.kind}</Pill><span className="ml-3 font-bold">{window.ownerLabel}</span><span className="ml-3 text-slate-500">{["Mon", "Tue", "Wed", "Thu", "Fri"][window.dayOfWeek - 1]} {window.startHour}:00–{window.endHour}:00</span></div><button onClick={() => void removeUnavailableWindow(window)} className="font-semibold text-red-700" type="button">Remove</button></div>)}</div>}</div><div className="rounded-2xl border border-slate-200 bg-white shadow-sm lg:col-span-2"><div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 p-4"><div><p className="font-black">Current timetable issues</p><p className="text-xs text-slate-500">Recalculated from every scheduled lesson and current rule.</p></div><div className="flex gap-2"><Pill tone="red">{scheduleIssues.filter((issue) => issue.severity === "High").length} high</Pill><Pill tone="amber">{scheduleIssues.filter((issue) => issue.severity === "Warning").length} warnings</Pill><Pill tone="blue">{scheduleIssues.filter((issue) => issue.severity === "Advisory").length} advisory</Pill></div></div>{scheduleIssues.length === 0 ? <p className="p-4 text-sm text-emerald-700">No issues found in scheduled lessons.</p> : <div className="max-h-[520px] divide-y divide-slate-100 overflow-y-auto">{scheduleIssues.map((issue) => <div key={issue.id} className="grid gap-2 p-4 text-sm md:grid-cols-[110px_1fr_auto]"><div><Pill tone={issue.severity === "High" ? "red" : issue.severity === "Warning" ? "amber" : "blue"}>{issue.severity}</Pill><p className="mt-2 text-xs font-semibold text-slate-500">{issue.category}</p></div><div><p className="font-black text-slate-950">{issue.sectionLabel} · Year {issue.primaryYear}</p><p className="mt-1 font-semibold text-slate-700">{issue.message}</p><p className="mt-1 text-xs text-slate-500">{issue.teacherName ?? "Teacher pending"} · {issue.studentGroups.join(", ") || "Student group pending"} · {issue.roomCode ?? "Room pending"}</p></div><div className="text-right"><p className="text-xs font-semibold text-slate-500">{["Mon", "Tue", "Wed", "Thu", "Fri"][issue.dayOfWeek - 1]} {String(issue.startHour).padStart(2, "0")}:00–{String(issue.endHour).padStart(2, "0")}:00</p><button onClick={() => void openScheduleIssue(issue)} className="mt-2 rounded-lg border border-blue-200 px-3 py-1.5 text-xs font-bold text-blue-700 hover:bg-blue-50" type="button">Open lesson</button></div></div>)}</div>}</div></div>}

          {view !== "Year timetables" && view !== "Personal timetables" && view !== "Rules & issues" && view !== "Cycle" && view !== "Accounts" && view !== "Profile" && <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
            {/* 资料分页与搜索共用同一卡片，减少页面跳转并保持操作位置一致。 */}
            <div className="flex flex-col gap-4 border-b border-slate-200 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex gap-1 rounded-xl bg-slate-100 p-1">
                {(["Teachers", "Student groups", "Rooms", "Courses"] as View[]).map((item) => (
                  <button key={item} onClick={() => openView(item)} className={`rounded-lg px-3 py-2 text-sm font-semibold transition ${view === item ? "bg-white text-slate-950 shadow-sm" : "text-slate-500 hover:text-slate-800"}`} type="button">{item}</button>
                ))}
              </div>
              <label className="relative block sm:w-64"><span className="sr-only">Search data</span><input value={query} onChange={(event) => setQuery(event.target.value)} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none transition placeholder:text-slate-400 focus:border-blue-500 focus:bg-white" placeholder={`Search ${view.toLowerCase()}...`} /></label>
            </div>

            {showForm && view === "Courses" && !editingCourse && (
              /* Excel 导入是正常入口；右侧表单只用于明确补充工作簿遗漏课程，不能代替 teaching allocation。 */
              <div className="grid border-b border-blue-100 bg-blue-50/60 lg:grid-cols-2 lg:divide-x lg:divide-blue-100">
                <form onSubmit={importTeachingMembers} className="p-4">
                  <p className="mb-1 text-sm font-bold text-blue-950">Import Teaching Members</p>
                  <p className="mb-3 text-xs leading-5 text-blue-800">Reads <strong>Mod</strong>, <strong>Lecturer</strong>, <strong>Staff Type</strong> and <strong># of grps teaching</strong>. Positive rows create pre-assigned sections; rows with 0 are ignored.</p>
                  <div className="flex flex-col gap-3"><input name="file" required accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" type="file" className="block text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-white file:px-3 file:py-2 file:text-sm file:font-semibold file:text-blue-800" /><button disabled={importing} className="w-fit rounded-xl bg-[#153d75] px-4 py-2 text-sm font-bold text-white disabled:cursor-wait disabled:opacity-70" type="submit">{importing ? "Importing..." : "Import allocation"}</button></div>
                </form>
                <form onSubmit={addManualCourse} className="p-4">
                  <p className="mb-1 text-sm font-bold text-blue-950">Add a missing course manually</p>
                  <p className="mb-3 text-xs leading-5 text-blue-800">Use this only when the Teaching Members file omitted a course. New sections start without teachers.</p>
                  <div className="grid gap-3 sm:grid-cols-[1fr_1fr_110px_auto]"><input name="code" required placeholder="Mod" className="rounded-xl border border-blue-200 bg-white px-3 py-2 text-sm" /><input name="catalog" placeholder="Catalog (optional)" className="rounded-xl border border-blue-200 bg-white px-3 py-2 text-sm" /><input name="sectionCount" required min="1" max="999" type="number" placeholder="Sections" className="rounded-xl border border-blue-200 bg-white px-3 py-2 text-sm" /><button className="rounded-xl bg-blue-700 px-4 py-2 text-sm font-bold text-white" type="submit">Add</button></div>
                </form>
              </div>
            )}

            {showForm && view === "Courses" && editingCourse && (
              /* 课程课时、周次数、主年级和教室要求只保存一次，并统一应用到该课程全部班次。 */
              <form key={editingCourse.id} onSubmit={saveCourseSetup} className="border-b border-emerald-100 bg-emerald-50/60 p-4">
                <p className="mb-1 text-sm font-bold text-emerald-950">Configure {editingCourse.code}</p>
                <p className="mb-3 text-xs leading-5 text-emerald-800">These requirements are retained when Teaching Members is imported again.</p>
                <div className="grid gap-3 md:grid-cols-4"><label className="text-xs font-semibold text-slate-700">Duration (hours)<input name="durationHours" required min="2" max="4" defaultValue={editingCourse.durationHours ?? ""} type="number" className="mt-1 w-full rounded-xl border border-emerald-200 bg-white px-3 py-2 text-sm" /></label><label className="text-xs font-semibold text-slate-700">Sessions/week<select name="sessionsPerWeek" defaultValue={editingCourse.sessionsPerWeek} className="mt-1 w-full rounded-xl border border-emerald-200 bg-white px-3 py-2 text-sm"><option value="1">1</option><option value="2">2</option></select></label><label className="text-xs font-semibold text-slate-700">Primary year<select name="primaryYear" defaultValue={editingCourse.primaryYear ?? ""} className="mt-1 w-full rounded-xl border border-emerald-200 bg-white px-3 py-2 text-sm"><option value="">Choose later</option><option value="1">Year 1</option><option value="2">Year 2</option><option value="3">Year 3</option></select></label><label className="text-xs font-semibold text-slate-700">Minimum capacity<input name="minimumRoomCapacity" min="1" defaultValue={editingCourse.minimumRoomCapacity ?? ""} type="number" className="mt-1 w-full rounded-xl border border-emerald-200 bg-white px-3 py-2 text-sm" /></label></div>
                {/* 起止周都留空表示每周上课；同时填写时支持 1–4、3–6、5–8 等包含两端的区间。 */}
                <div className="mt-3 max-w-lg rounded-xl border border-emerald-100 bg-white/70 p-3"><p className="text-xs font-bold text-slate-700">Teaching weeks</p><div className="mt-2 grid grid-cols-2 gap-3"><label className="text-xs font-semibold text-slate-700">Start week<input name="weekStart" min="1" defaultValue={editingCourse.weekStart ?? ""} type="number" placeholder="All weeks" className="mt-1 w-full rounded-xl border border-emerald-200 bg-white px-3 py-2 text-sm" /></label><label className="text-xs font-semibold text-slate-700">End week<input name="weekEnd" min="1" defaultValue={editingCourse.weekEnd ?? ""} type="number" placeholder="All weeks" className="mt-1 w-full rounded-xl border border-emerald-200 bg-white px-3 py-2 text-sm" /></label></div><p className="mt-2 text-xs text-emerald-800">Leave both blank for every week. Limited ranges include both the start and end week.</p></div>
                <div className="mt-3 flex flex-wrap items-center gap-4 text-sm text-slate-700"><label className="flex items-center gap-2"><input name="requiresLab" defaultChecked={editingCourse.requiresLab} type="checkbox" /> Lab</label><label className="flex items-center gap-2"><input name="requiresMultiProjector" defaultChecked={editingCourse.requiresMultiProjector} type="checkbox" /> Multi projector</label><label className="flex items-center gap-2"><input name="requiresSmartClassroom" defaultChecked={editingCourse.requiresSmartClassroom} type="checkbox" /> Smart classroom</label><label className="flex items-center gap-2"><input name="separateSectionsAcrossDays" defaultChecked={editingCourse.separateSectionsAcrossDays} type="checkbox" /> Keep sections on different days</label><button className="rounded-xl bg-emerald-700 px-4 py-2 font-bold text-white" type="submit">Save course setup</button></div>
              </form>
            )}

            {showForm && view !== "Courses" && (
              /* 手工资料表只收集当前排课和冲突检查真正需要的字段，避免加入没有明确用途的资料。 */
              <form onSubmit={addRecord} className="border-b border-blue-100 bg-blue-50/60 p-4">
                <p className="mb-3 text-sm font-bold text-blue-950">{editingTeacher ? `Edit ${editingTeacher.name}` : editingGroup ? `Edit ${editingGroup.code}` : editingRoom ? `Edit ${editingRoom.code}` : `New ${view.slice(0, -1)}`}</p>
                {view === "Teachers" && <div className="grid gap-3 sm:grid-cols-[1fr_140px_auto]"><input name="name" required defaultValue={editingTeacher?.name} placeholder="Teacher name" className="rounded-xl border border-blue-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500" /><select name="staffType" defaultValue={editingTeacher?.staffType ?? "FT"} className="rounded-xl border border-blue-200 bg-white px-3 py-2 text-sm"><option value="FT">Full-time (FT)</option><option value="PT">Part-time (PT)</option></select><button className="rounded-xl bg-[#153d75] px-4 py-2 text-sm font-bold text-white" type="submit">{editingTeacher ? "Save changes" : "Save teacher"}</button></div>}
                {view === "Student groups" && <div className="grid gap-3 sm:grid-cols-[1fr_120px_130px_auto]"><input name="code" required defaultValue={editingGroup?.code} placeholder="e.g. AAA_01" className="rounded-xl border border-blue-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500" /><select name="year" defaultValue={editingGroup?.year ?? 1} className="rounded-xl border border-blue-200 bg-white px-3 py-2 text-sm"><option value="1">Year 1</option><option value="2">Year 2</option><option value="3">Year 3</option></select><input name="program" required defaultValue={editingGroup?.program} placeholder="Programme" className="rounded-xl border border-blue-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500" /><button className="rounded-xl bg-[#153d75] px-4 py-2 text-sm font-bold text-white" type="submit">{editingGroup ? "Save changes" : "Save group"}</button></div>}
                {view === "Rooms" && (
                  /* 教室新增和编辑共用表单；编辑时回填原容量和设施，避免只改地址却意外清除设备标记。 */
                  <div className="grid gap-3 lg:grid-cols-[1fr_110px_auto_auto_auto_auto]">
                    <input name="room" required defaultValue={editingRoom?.code} placeholder="e.g. 31-05-10" className="rounded-xl border border-blue-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500" />
                    <input name="capacity" required min="1" defaultValue={editingRoom?.capacity} type="number" placeholder="Capacity" className="rounded-xl border border-blue-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500" />
                    <label className="flex items-center gap-2 text-sm"><input name="lab" defaultChecked={editingRoom?.features.includes("Lab")} type="checkbox" /> Lab</label>
                    <label className="flex items-center gap-2 text-sm"><input name="projector" defaultChecked={editingRoom?.features.includes("Multi projector")} type="checkbox" /> Projector</label>
                    <label className="flex items-center gap-2 text-sm"><input name="smart" defaultChecked={editingRoom?.features.includes("Smart classroom")} type="checkbox" /> Smart</label>
                    <button className="rounded-xl bg-[#153d75] px-4 py-2 text-sm font-bold text-white" type="submit">{editingRoom ? "Save changes" : "Save room"}</button>
                  </div>
                )}
              </form>
            )}

            <div className="overflow-x-auto">
              {/* 首次数据库请求完成后才渲染资料表，避免加载中短暂空表被误认为资料消失。 */}
              {isLoading && <div className="p-8 text-sm text-slate-500">Loading data...</div>}
              {!isLoading && view === "Teachers" && <table className="w-full min-w-[650px] text-left text-sm"><thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-400"><tr><th className="px-5 py-3 font-bold">Teacher</th><th className="px-5 py-3 font-bold">Type</th><th className="px-5 py-3 font-bold">Allocated sections</th><th className="px-5 py-3 font-bold">Status</th><th className="px-5 py-3 font-bold" /></tr></thead><tbody>{filteredTeachers.map((teacher) => <tr className="border-t border-slate-100" key={teacher.id}><td className="px-5 py-4 font-semibold text-slate-800">{teacher.name}</td><td className="px-5 py-4"><Pill tone={teacher.staffType === "PT" ? "amber" : "blue"}>{teacher.staffType}</Pill></td><td className="px-5 py-4 text-slate-600">{teacher.sections}</td><td className="px-5 py-4"><Pill tone={teacher.status === "Active" ? "green" : "slate"}>{teacher.status}</Pill></td><td className="px-5 py-4 text-right"><div className="flex justify-end gap-3"><button onClick={() => { setEditingTeacher(teacher); setShowForm(true); }} className="font-semibold text-emerald-700 hover:text-emerald-900" type="button">Edit</button><button onClick={() => toggleTeacher(teacher)} className="font-semibold text-blue-700 hover:text-blue-900" type="button">{teacher.status === "Active" ? "Deactivate" : "Activate"}</button></div></td></tr>)}</tbody></table>}
              {!isLoading && view === "Student groups" && <table className="w-full min-w-[650px] text-left text-sm"><thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-400"><tr><th className="px-5 py-3 font-bold">Student group</th><th className="px-5 py-3 font-bold">Year</th><th className="px-5 py-3 font-bold">Programme</th><th className="px-5 py-3 font-bold">Scheduling scope</th><th className="px-5 py-3 font-bold" /></tr></thead><tbody>{filteredGroups.map((group) => <tr className="border-t border-slate-100" key={group.id}><td className="px-5 py-4 font-semibold text-slate-800">{group.code}</td><td className="px-5 py-4"><Pill tone="blue">Year {group.year}</Pill></td><td className="px-5 py-4 text-slate-600">{group.program}</td><td className="px-5 py-4 text-slate-500">Checks conflicts and daily limits</td><td className="px-5 py-4 text-right"><button onClick={() => { setEditingGroup(group); setShowForm(true); }} className="font-semibold text-emerald-700 hover:text-emerald-900" type="button">Edit</button></td></tr>)}</tbody></table>}
              {!isLoading && view === "Rooms" && <table className="w-full min-w-[650px] text-left text-sm"><thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-400"><tr><th className="px-5 py-3 font-bold">Room</th><th className="px-5 py-3 font-bold">Capacity</th><th className="px-5 py-3 font-bold">Facilities</th><th className="px-5 py-3 font-bold">Status</th><th className="px-5 py-3 font-bold" /></tr></thead><tbody>{filteredRooms.map((room) => <tr className="border-t border-slate-100" key={room.id}><td className="px-5 py-4 font-semibold text-slate-800">{room.code}</td><td className="px-5 py-4 text-slate-600">{room.capacity}</td><td className="px-5 py-4"><div className="flex flex-wrap gap-1.5">{room.features.length ? room.features.map((feature) => <Pill key={feature} tone="slate">{feature}</Pill>) : <span className="text-slate-400">None</span>}</div></td><td className="px-5 py-4"><Pill tone={room.status === "Active" ? "green" : "slate"}>{room.status}</Pill></td><td className="px-5 py-4 text-right"><div className="flex justify-end gap-3"><button onClick={() => { setEditingRoom(room); setShowForm(true); }} className="font-semibold text-emerald-700 hover:text-emerald-900" type="button">Edit</button><button onClick={() => toggleRoom(room)} className="font-semibold text-blue-700 hover:text-blue-900" type="button">{room.status === "Active" ? "Deactivate" : "Activate"}</button></div></td></tr>)}</tbody></table>}
              {!isLoading && view === "Courses" && <table className="w-full min-w-[760px] text-left text-sm"><thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-400"><tr><th className="px-5 py-3 font-bold">Mod</th><th className="px-5 py-3 font-bold">Catalog</th><th className="px-5 py-3 font-bold">Sections</th><th className="px-5 py-3 font-bold">Setup</th><th className="px-5 py-3 font-bold" /></tr></thead><tbody>{filteredCourses.map((course) => <tr className="border-t border-slate-100" key={course.id}><td className="px-5 py-4 font-semibold text-slate-800">{course.code}</td><td className="px-5 py-4 text-slate-600">{course.catalog ?? <span className="text-slate-400">—</span>}</td><td className="px-5 py-4"><div className="flex flex-wrap gap-2"><Pill tone="blue">{course.configuredSections}</Pill>{course.allocationVarianceCount > 0 && <Pill tone="amber">{course.allocationVarianceCount} allocation mismatch{course.allocationVarianceCount === 1 ? "" : "es"}</Pill>}</div></td><td className="px-5 py-4 text-slate-500">{course.durationHours ? `${course.durationHours}h · ${course.sessionsPerWeek}×/week · ${course.primaryYear ? `Y${course.primaryYear}` : "year pending"} · ${course.weekStart !== null && course.weekEnd !== null ? `W${course.weekStart}–${course.weekEnd}` : "all weeks"}` : "Not configured"}</td><td className="px-5 py-4 text-right"><div className="flex justify-end gap-3"><button onClick={() => void openSections(course)} className="font-semibold text-emerald-700 hover:text-emerald-900" type="button">Sections</button><button onClick={() => { setEditingCourse(course); setShowForm(true); }} className="font-semibold text-blue-700 hover:text-blue-900" type="button">Configure</button></div></td></tr>)}</tbody></table>}
            </div>

            {selectedCourse && (
              /* 班次分配与课程统一设置分开，因为不同班次可有不同教师和学生班级。 */
              <div className="border-t border-slate-200 bg-slate-50 p-4">
                <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                  <div><p className="font-bold text-slate-950">{selectedCourse.code} sections</p><p className="text-xs text-slate-500">Assign a teacher and one or more student groups to each section.</p></div>
                  <button onClick={() => { setSelectedCourse(null); setSections([]); setAllocationVariances([]); }} className="text-sm font-semibold text-blue-700" type="button">Close</button>
                </div>
                {/* 修正班次数量时保留低编号班次；仍含排课或班级关联的班次，服务端会拒绝删除。 */}
                <form key={`${selectedCourse.id}:${sections.length}`} onSubmit={changeSectionCount} className="mb-3 flex flex-wrap items-end gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3">
                  <label className="text-xs font-semibold text-amber-950">Total sections<input name="sectionCount" required min="1" max="999" defaultValue={sections.length} type="number" className="mt-1 block w-28 rounded-lg border border-amber-200 bg-white px-3 py-2 text-sm" /></label>
                  <button className="rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm font-bold text-amber-900" type="submit">Update count</button>
                  <p className="text-xs text-amber-800">Reducing removes only the highest numbers after their timetable and student groups are cleared.</p>
                </form>
                {allocationVariances.length > 0 && <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 p-3"><p className="text-sm font-black text-amber-950">Teaching allocation differs from current teachers</p><p className="mt-1 text-xs text-amber-800">Saving is allowed. Review these counts against the imported Teaching Members file.</p><div className="mt-2 grid gap-1">{allocationVariances.map((variance) => <p key={variance.teacherId} className="text-xs font-semibold text-amber-900">{variance.teacherName}: expected {variance.expectedSections}, currently {variance.actualSections}</p>)}</div></div>}
                <div className="grid gap-3">{sections.map((section) => <form key={section.id} onSubmit={(event) => saveSection(event, section)} className="rounded-xl border border-slate-200 bg-white p-3"><div className="grid gap-3 md:grid-cols-[130px_1fr_auto]"><p className="pt-2 font-bold text-slate-900">{section.label}</p><select name="teacherId" defaultValue={section.teacherId ?? ""} className="rounded-lg border border-slate-200 px-3 py-2 text-sm"><option value="">Teacher pending</option>{teachers.filter((teacher) => teacher.status === "Active").map((teacher) => <option key={teacher.id} value={teacher.id}>{teacher.name} ({teacher.staffType})</option>)}</select><button className="rounded-lg bg-[#153d75] px-3 py-2 text-sm font-bold text-white" type="submit">Save</button></div><div className="mt-3 flex flex-wrap gap-3 text-xs text-slate-700">{groups.map((group) => <label key={group.id} className="flex items-center gap-1.5"><input name="studentGroupIds" value={group.id} defaultChecked={section.studentGroupIds.includes(group.id)} type="checkbox" /> {group.code}</label>)}</div></form>)}</div>
              </div>
            )}
          </div>}

          {view !== "Year timetables" && <p className="mt-4 text-sm text-slate-500"><span className="font-semibold text-slate-700">System status:</span> {notice}</p>}
        </section>
      </div>
    </main>
  );
}
