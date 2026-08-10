# 技术架构说明

## 当前技术栈

- 前端与服务层：Next.js App Router、React、TypeScript。
- 样式：Tailwind CSS。
- 数据模型：Prisma ORM schema，与当前 SQLite 的真实表名、字段、关系和删除策略保持一致，用作后续迁移来源。
- 本地开发数据访问：Node.js SQLite（`better-sqlite3`）及 Next.js Route Handlers。
- 本地开发数据库：SQLite。
- 生产数据存储：已选择 Railway 单实例 SQLite 持久卷；账号量或高可用要求增长时迁移 PostgreSQL。

当前业务读写仍集中在 `src/lib/database.ts` 的同步 SQLite 查询中；Prisma Client 尚未接管 API 数据访问。迁移 PostgreSQL 时必须把这些查询改为异步数据访问，不能只修改 datasource provider。

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
- `npm start` 或 `npm run start:standalone`：先验证数据库目录可写，再启动构建后的自包含生产服务器；`PORT`、`HOSTNAME` 与数据库路径可由托管平台注入。
- `npm run verify:deployment -- https://部署域名`：只读验证健康检查、安全响应头、公开认证状态和业务 API 的未登录保护；提供临时验收账号环境变量时，再验证安全 Cookie、认证访问和自动退出。
- `npm run db:generate`：生成 Prisma Client。
- `npm run db:check`：校验 Prisma schema，并从空数据库生成 SQLite 建表 SQL，用于验证模型、关系和索引。

基础资料维护页面通过下列本地 API 持久化数据：

- `GET /api/health`：公开的最小健康检查，只验证应用和数据库可查询，不返回课表数量、路径或账号资料。
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
- `GET /api/system-backup`：仅管理员下载经结构与外键检查的完整 SQLite 副本；账号保留，所有登录会话从副本清除并通过 `VACUUM` 移除空闲页。
- `POST /api/system-backup`：仅管理员上传当前版本生成的 `.sqlite` 副本；固定短语和双确认后，先保存在线库安全副本，再以单一事务恢复全部表并撤销所有会话。

排课写入与编辑共用同一警告引擎，当前检查教师／教室／学生班级重叠、资料缺失、教室容量和设施、08:00 开课、午餐时段、连续课时、每日总时数以及跨 Block 连堂。只有教学周范围实际重叠的课程才会互相影响；全部周课程会与任何范围重叠。问题会保存到排课记录并附带最高严重程度，年级总表、个人课表和集中问题清单共用红／黄／蓝标准；任何级别都不会阻止用户保存。
- `POST /api/imports/teaching-members`：读取 `Teaching Members` 工作表；所有有效行维护教师清单，只有正数的 `# of grps teaching` 建立课程、教师分配及预分配的课程班次。导入会更新本次分配与班次，但保留课程日后手工配置的时长、频次及教室要求字段。

本地数据库保存为 `web/data/timetabling.db`，不纳入 Git。每次完整恢复前，系统把已经清除会话且再次验证过的当前状态保存在数据库同目录的 `timetabling-restore-safety/`；文件使用仅拥有者可读写权限，供管理员在误选备份后回退。Railway 环境会自动读取 `RAILWAY_VOLUME_MOUNT_PATH`，并把数据库和恢复安全副本都保存到挂载卷；`TIMETABLING_DATABASE_PATH` 可作为明确覆盖。若 Railway 运行时没有挂载卷，启动检查会直接中止，避免误把正式资料写入部署容器的临时文件系统。首次运行时自动创建数据库；只有开发模式会插入最小示例资料，生产模式始终以空资料开始，避免真实系统混入演示教师、班级或教室。

生产构建启用 Next.js standalone 输出。构建完成后，`scripts/prepare-standalone.mjs` 会把 `public/` 和 `.next/static/` 复制到自包含目录，避免部署后出现页面有 HTML 但缺少图标、CSS 或浏览器脚本的问题。

## 上线安全基线

- 密码使用带独立随机盐的 scrypt 哈希；数据库不保存明文密码，会话也只保存随机 token 的 SHA-256 摘要。
- 生产会话 Cookie 使用 Secure、HttpOnly、SameSite=Strict 与 12 小时过期时间；改密、重置密码或停用账号会撤销相关会话。
- 登录同时按“来源地址 + 用户名”限制 5 次失败，并按来源地址限制 25 次失败；达到上限后暂停 15 分钟。计数只存在单实例内存中，重新部署会清空，符合当前单实例路线。
- 全站返回 HSTS、`nosniff`、禁止 iframe、无 Referrer 和禁用摄像头/麦克风/定位权限；所有 API 返回 `Cache-Control: no-store`。
- Teaching Members 仅接受 `.xlsx`，文件最大 20 MB、工作表最多 5,000 行，并继续校验固定工作表、必需列和每行资料。
- 完整恢复仅接受 16 字节以上、20 MB 以下且带 SQLite 3 文件头的 `.sqlite`；继续检查完整性、外键、全部表与字段形状，以及至少一个可用管理员密码哈希，任何验证失败都不会开始替换资料。
- 恢复复制在单一同步 SQLite 事务中完成，关系复检也在提交前执行；成功后不保留上传文件或任何旧会话，当前及其他浏览器都必须使用备份内账号重新登录。
- 公网环境必须由托管平台提供 HTTPS；否则生产模式的 Secure Cookie 不会通过普通 HTTP 发送。

## 公网基础设施

首版公网环境已确定为 Railway 单实例 + SQLite 持久卷，保留现有 5 秒同步与 revision 防覆盖机制。仓库根目录下的 `web/railway.json` 固定 Railpack 构建、standalone 启动、健康检查和失败重启策略；详细控制台步骤见 `docs/RAILWAY_DEPLOYMENT.md`。真实线上环境、平台备份和双账号验收仍待完成。未来若改用 PostgreSQL，需先把当前同步 SQLite 数据访问层改写为异步 PostgreSQL 查询；两条路线的依据见 `docs/DEPLOYMENT_DECISION.md`。
