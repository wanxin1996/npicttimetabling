# 技术架构说明

## 当前技术栈

- 前端与服务层：Next.js App Router、React、TypeScript。
- 样式：Tailwind CSS。
- 数据模型：Prisma ORM schema，用于维护可迁移的领域模型。
- 本地开发数据访问：Node.js SQLite（`better-sqlite3`）及 Next.js Route Handlers。
- 本地开发数据库：SQLite。
- 生产数据库目标：PostgreSQL；切换时保留同一业务模型，通过 Prisma 迁移调整数据库提供方。

## 数据模型要点

- `Course`、`Teacher`、`TeachingAllocation`：承载 `Teaching Members` Excel 的课程、教师与每位教师负责班次数量。
- `Course`：记录课程共同配置，包括主年级、时长、每周次数、教室要求和可选的教学周起止范围；起止周均为空代表全部教学周。
- `CourseSection`：由课程生成的 `课程编号_01` 等独立班次，记录该班次的教师。
- `ScheduledLesson`：每个班次的每次周课；可分别设置教室和时间，并沿用课程的教学周范围，支持同一班次的两次课使用不同教室。
- `StudentGroup` 与 `SectionStudentGroup`：支持一个班次关联多个学生班级，并用于学生冲突校验。
- `TeacherUnavailableWindow`、`YearBlockedWindow`、`RuleSetting`：存储禁排时段和可启停规则。
- `ScheduleBackup`：用于“开始新一轮排课”前的恢复备份。

## 本地运行与验证

在 `web/` 目录中：

- `npm run lint`：检查代码风格。
- `npm run build`：生产构建（使用 Webpack 兼容模式）。
- `npm run db:generate`：生成 Prisma Client。
- `npm run db:check`：校验 Prisma schema，并从空数据库生成 SQLite 建表 SQL，用于验证模型、关系和索引。

基础资料维护页面通过下列本地 API 持久化数据：

- `GET`/`POST /api/teachers`、`PATCH /api/teachers/:id`
- `GET`/`POST /api/student-groups`
- `GET`/`POST /api/rooms`、`PATCH /api/rooms/:id`
- `GET /api/courses`
- `PATCH /api/courses/:id`：保存课程的时长、每周次数、主年级、最低容量、教室设施要求和任意教学周起止范围。
- `GET /api/courses/:id/sections`、`PATCH /api/course-sections/:id`：读取并调整每个课程班次的授课教师及关联学生班级。
- `GET`/`POST /api/schedule/lessons`：读取年级总表并放置课程；保存时返回教师和教室冲突警告，但不会阻止保存。
- `PATCH`/`DELETE /api/schedule/lessons/:id`：编辑已排课程的时间、教师、教室，或将班次退回未排清单。
- `GET /api/schedule/unscheduled?year=:year`：返回指定年级已完成课程配置、但尚未放入总表的班次，用于拖拽清单。
- `GET`/`POST`/`DELETE /api/unavailability`：维护教师个人和 Year 1–3 的不可上课时段。

排课写入与编辑共用同一警告引擎，当前检查教师／教室／学生班级重叠、资料缺失、教室容量和设施、08:00 开课、午餐时段、连续课时、每日总时数以及跨 Block 连堂。只有教学周范围实际重叠的课程才会互相影响；全部周课程会与任何范围重叠。问题会保存到排课记录并附带最高严重程度，年级总表、个人课表和集中问题清单共用红／黄／蓝标准；任何级别都不会阻止用户保存。
- `POST /api/imports/teaching-members`：读取 `Teaching Members` 工作表；所有有效行维护教师清单，只有正数的 `# of grps teaching` 建立课程、教师分配及预分配的课程班次。导入会更新本次分配与班次，但保留课程日后手工配置的时长、频次及教室要求字段。

本地数据库保存为 `web/data/timetabling.db`，不纳入 Git。首次运行时自动创建，并插入最小示例资料；后续真实资料会保留在该文件中。

## 后续基础设施决策

首版的多人实时协作、跨设备访问和正式账号认证需要线上 PostgreSQL 及实时服务。该线上环境尚未创建；在取得部署平台/数据库账号后，将把当前本地 SQLite 数据访问层迁移至 PostgreSQL，并接入认证与实时同步。
