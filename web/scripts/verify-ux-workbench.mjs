import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const webRoot = fileURLToPath(new URL("..", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

const files = {
  page: await readFile(new URL("../src/app/page.tsx", import.meta.url), "utf8"),
  workspaceRoute: await readFile(
    new URL("../src/app/api/schedule/workspace/route.ts", import.meta.url),
    "utf8",
  ),
  draftReconciliation: await readFile(
    new URL("../src/lib/lesson-draft-reconciliation.mjs", import.meta.url),
    "utf8",
  ),
  prd: await readFile(new URL("../../docs/PRD.md", import.meta.url), "utf8"),
  taskProtocol: await readFile(
    new URL("../../docs/UX_TASK_TEST.md", import.meta.url),
    "utf8",
  ),
};

// 这是“源码契约”检查：它能防止已经确认的 UX 结构在改代码时被无意删掉，
// 但不能代替浏览器里的拖放实测，也不能代替五名真实用户的任务测试。
const requiredEvidence = [
  {
    area: "顶部 Workspace",
    source: "page",
    markers: [
      'aria-label="Workspace"',
      'useState<View>("Year timetables")',
      'aria-current={active ? "page" : undefined}',
    ],
  },
  {
    area: "待排课默认开启",
    source: "page",
    markers: [
      "const [showUnscheduledDrawer, setShowUnscheduledDrawer] = useState(true)",
      'aria-controls="unscheduled-drawer"',
      "aria-expanded={showUnscheduledDrawer}",
    ],
  },
  {
    area: "待排课关闭后零占位",
    source: "page",
    markers: [
      'showUnscheduledDrawer ? "lg:grid-cols-[220px_minmax(0,1fr)] xl:grid-cols-[240px_minmax(0,1fr)]" : "lg:grid-cols-1"',
      "{showUnscheduledDrawer &&",
    ],
  },
  {
    area: "浮动 Inspector 不挤压课表",
    source: "page",
    markers: [
      'aria-controls="timetable-inspector"',
      "aria-expanded={showTimetableInspector}",
      "absolute inset-y-0 right-0 z-40",
      "if (willOpen) setShowUnscheduledDrawer(false)",
    ],
  },
  {
    area: "课表卡片固定字号与信息层级",
    source: "page",
    markers: [
      "text-[11px] font-black",
      "text-[10px] font-medium",
      "text-[10px] font-semibold",
      "const lessonGroups = lesson.studentGroups.join",
      'lesson.roomCode ?? "Room pending"',
    ],
  },
  {
    area: "Inspector 可分配和更改 Student Groups",
    source: "page",
    markers: [
      "function StudentGroupSelector",
      'name="studentGroupIds"',
      'form="lesson-editor"',
      "editingLesson.studentGroupIds",
      'data.getAll("studentGroupIds")',
    ],
  },
  {
    area: "聚合 Workspace 读取",
    source: "page",
    markers: [
      "/api/schedule/workspace?year=",
      "const workspace = await workspaceResponse.json() as YearTimetableWorkspace",
      "setLessons(nextLessons)",
      "setUnscheduledSections(nextUnscheduledSections)",
    ],
  },
  {
    area: "聚合 Workspace API",
    source: "workspaceRoute",
    markers: ["listYearTimetableWorkspace", "Response.json"],
  },
  {
    area: "编辑草稿并发保护",
    source: "page",
    markers: [
      "reconcileLessonDraft",
      "lessonDraftIsStale",
      "workspaceNavigationLocked",
    ],
  },
  {
    area: "资料表单键盘焦点",
    source: "page",
    markers: [
      "dataManagementFormFirstInputRef",
      "dataManagementFormToggleButtonRef",
      "pendingMasterRecordFocusRef",
      "if (!showForm || (view === \"Courses\" && editingCourse)) return",
      'kind: "record"',
    ],
  },
  {
    area: "草稿修订号判断",
    source: "draftReconciliation",
    markers: [
      "latestLesson.revision !== currentLesson.revision",
      "stale: true",
    ],
  },
  {
    area: "当前 PRD 的三天同屏口径",
    source: "prd",
    markers: [
      "至少同时完整显示连续 3 个工作日",
      "右侧浮动面板",
      "分配或更改一个或多个学生班级",
    ],
  },
  {
    area: "五人 UX 任务测试协议",
    source: "taskProtocol",
    markers: ["P1", "P5", "90%", "60 秒"],
  },
];

const missingEvidence = requiredEvidence.flatMap(({ area, source, markers }) =>
  markers
    .filter((marker) => !files[source].includes(marker))
    .map((marker) => `${area}（${source} 缺少 ${JSON.stringify(marker)}）`),
);

// 1024px 是 PRD 的桌面验收宽度。扣除页面左右各 12px 后，
// 时间轴加三个普通密度日期仍必须能同时出现；极繁忙日期则通过横向滚动保持卡片可读。
const viewportWidth = 1024;
const pageHorizontalPadding = 24;
const timeColumnWidth = 48;
const normalDayMinimumWidth = 152;
const readableLaneWidth = 112;
const columnGap = 4;
const visibleDayCount = 3;
const threeDayGridWidth =
  timeColumnWidth +
  visibleDayCount * normalDayMinimumWidth +
  visibleDayCount * columnGap;
const availableWidth = viewportWidth - pageHorizontalPadding;

const widthContractMarkers = [
  "Math.max(152, laneCount * 112)",
  "48 + dayMinimumWidths.reduce",
  "timetableDays.length * 4",
];
for (const marker of widthContractMarkers) {
  if (!files.page.includes(marker)) {
    missingEvidence.push(
      `至少三天宽度计算（page 缺少 ${JSON.stringify(marker)}）`,
    );
  }
}
if (readableLaneWidth < 112) {
  missingEvidence.push("繁忙日每张课程卡必须保留至少 112px 可读宽度");
}

// 总表卡片可以用课程时长计算结束时间，但不能再把“2h/3h”作为可见的一行。
const masterCardStart = files.page.indexOf(
  "const lessonGroups = lesson.studentGroups.join",
);
const masterCardEnd = files.page.indexOf("{/* Inspector 以绝对定位覆盖", masterCardStart);
const masterCardSource = files.page.slice(masterCardStart, masterCardEnd);
if (masterCardStart < 0 || masterCardEnd < 0) {
  missingEvidence.push("无法定位总表卡片渲染区块，不能检查时长文字是否已移除。");
} else if (masterCardSource.includes("lesson.durationHours}h")) {
  missingEvidence.push("总表卡片仍显示时长文字（例如 2h/3h）。");
}

if (threeDayGridWidth > availableWidth) {
  missingEvidence.push(
    `至少三天宽度数学不成立：需要 ${threeDayGridWidth}px，但 1024px 视口扣除页面边距后只有 ${availableWidth}px`,
  );
}

if (missingEvidence.length > 0) {
  console.error("UX 工作台静态门槛未通过。以下源码契约缺失：");
  for (const item of missingEvidence) console.error(`- ${item}`);
  console.error(`\n检查范围：${webRoot} 与 ${repositoryRoot}/docs`);
  console.error(
    "请先修复源码或同步 PRD/任务测试协议；不要通过放宽断言来掩盖真实回归。",
  );
  process.exit(1);
}

console.log("UX 工作台静态门槛通过。");
console.log(
  `三天宽度预算：${threeDayGridWidth}px / 可用 ${availableWidth}px（1024px 视口）。`,
);
console.log(
  "注意：本检查只验证源码契约；发布前仍须完成浏览器拖放实测和五名真实用户任务测试。",
);
