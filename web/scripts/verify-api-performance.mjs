import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import Database from "better-sqlite3";

// 这项回归使用已经生成的 production standalone 服务器，同时把全部资料写入
// 操作系统临时目录。它不会连接 data/timetabling.db，也不会占用开发页面的 3000 端口。
const projectRoot = process.cwd();
const standaloneServerPath = path.join(projectRoot, ".next", "standalone", "server.js");
const statementAuditPreloadPath = path.join(projectRoot, "scripts", "support", "statement-reuse-audit-preload.cjs");
const requestTimeoutMilliseconds = 30_000;

// 固定资料量接近老师真实 Teaching allocation：52 门课共 374 个班次。
// 其中 360 个已经排入总表、14 个留在待排区，方便同时测试读取与候选位置。
const scale = Object.freeze({
  courses: 52,
  sections: 374,
  scheduledLessons: 360,
  teachers: 87,
  studentGroups: 54,
  rooms: 30,
  schedulers: 6,
  initialIssues: 270,
});

// 性能阈值使用宽松的“数量级保护”，避免普通电脑偶发抖动让测试误失败。
// 功能错误、500、503、超时或资料变化仍会立即失败，不受这些宽松阈值影响。
const limits = Object.freeze({
  readP95Milliseconds: 1_500,
  pollWallMilliseconds: 6_000,
  pollP95Milliseconds: 3_000,
  candidateMedianMilliseconds: 6_000,
  warningRefreshMedianMilliseconds: 10_000,
  mixedBurstMedianMilliseconds: 15_000,
});

// 固定课程分布产生的精确年级数量。性能请求也必须返回正确资料；如果路由错误地
// 退化成空数组，响应虽然更快，测试仍应立即失败而不是产生漂亮但无意义的数字。
const scheduledLessonsPerYear = Object.freeze({ 1: 123, 2: 122, 3: 115 });
const unscheduledSectionsPerYear = Object.freeze({ 1: 7, 2: 0, 3: 7 });

let baseUrl;
let serverProcess;
let serverOutput = "";
let serverProcessError;
let temporaryDirectory;
let testDatabasePath;
let statementAuditToken = "";
let statementAuditReportPath = "";
let administratorCookie = "";
let cleanupPromise;

function report(message) {
  // 每完成一个可独立理解的门槛就输出一行，方便基础开发人员定位失败阶段。
  console.log(`✓ ${message}`);
}

function keepRecentServerOutput(chunk) {
  // 正常情况下不重复打印 Next.js 输出；失败时只保留最后一小段服务器日志。
  serverOutput = `${serverOutput}${String(chunk)}`.slice(-12_000);
}

function delay(milliseconds) {
  // 异步短等待只用于服务启动轮询，不会阻塞子进程输出。
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function chooseAvailablePort() {
  // 让操作系统选择空闲端口，马上释放后交给 production 服务使用。
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  assert(address && typeof address === "object", "The performance server could not obtain a local port.");
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitForServer() {
  // 健康检查把“仍在启动”和“已经异常退出”分开，最长等待 15 秒。
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (serverProcessError) throw new Error(`The performance server could not start: ${serverProcessError.message}`);
    if (serverProcess.exitCode !== null || serverProcess.signalCode !== null) {
      throw new Error("The performance server exited before becoming ready.");
    }
    try {
      const response = await fetch(new URL("/api/health", baseUrl), { signal: AbortSignal.timeout(1_000) });
      if (response.status === 200) return;
    } catch {
      // 端口尚未开始监听是正常启动过程，稍后再试。
    }
    await delay(100);
  }
  throw new Error("The performance server did not become ready within 15 seconds.");
}

async function stopServer() {
  // 先让 Node 正常退出；三秒内仍未停止才强制结束，避免留下 SQLite 锁或后台端口。
  const child = serverProcess;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exitPromise = new Promise((resolve) => child.once("exit", () => resolve(true)));
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const stoppedNormally = await Promise.race([exitPromise, delay(3_000).then(() => false)]);
  if (!stoppedNormally && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exitPromise;
  }
}

async function startServer({ auditStatements = false } = {}) {
  // 端口释放与 standalone 监听之间有极短竞争窗口；只有明确 EADDRINUSE 才重试。
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const port = await chooseAvailablePort();
    baseUrl = new URL(`http://127.0.0.1:${port}`);
    serverOutput = "";
    serverProcessError = undefined;

    // 删除可能继承的 Railway／正式数据库路径，再明确指定唯一临时数据库。
    const environment = { ...process.env };
    for (const name of ["RAILWAY_ENVIRONMENT", "RAILWAY_SERVICE_ID", "RAILWAY_VOLUME_MOUNT_PATH", "TIMETABLING_DATABASE_PATH", "PORT", "HOSTNAME"]) {
      delete environment[name];
    }
    Object.assign(environment, {
      NODE_ENV: "production",
      HOSTNAME: "127.0.0.1",
      PORT: String(port),
      TIMETABLING_DATABASE_PATH: testDatabasePath,
    });
    // 正常性能计时不加载任何插桩；只有最后两个结构审计进程显式传入随机 token 和临时报告路径。
    if (auditStatements) {
      Object.assign(environment, {
        TIMETABLING_STATEMENT_AUDIT_MODE: "timetabling-statement-reuse-audit-v1",
        TIMETABLING_STATEMENT_AUDIT_TOKEN: statementAuditToken,
        TIMETABLING_STATEMENT_AUDIT_REPORT: statementAuditReportPath,
      });
    }

    const serverArguments = auditStatements
      ? ["--require", statementAuditPreloadPath, standaloneServerPath]
      : [standaloneServerPath];
    serverProcess = spawn(process.execPath, serverArguments, {
      cwd: projectRoot,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    serverProcess.stdout.on("data", keepRecentServerOutput);
    serverProcess.stderr.on("data", keepRecentServerOutput);
    serverProcess.once("error", (error) => {
      serverProcessError = error;
      keepRecentServerOutput(`\nServer process error: ${error.message}\n`);
    });

    try {
      await waitForServer();
      return;
    } catch (error) {
      const portWasTaken = /EADDRINUSE/.test(serverOutput);
      await stopServer();
      if (!portWasTaken || attempt === 3) throw error;
      serverProcess = undefined;
    }
  }
}

async function requestApi(pathname, options = {}) {
  // 共用请求器负责 Cookie、JSON、状态码和完整响应耗时；性能数字包含读取与 JSON 解析，
  // 更接近浏览器实际等待时间，而不是只计算服务器开始响应的时间。
  const {
    method = "GET",
    json,
    expectedStatus = 200,
    cookie = administratorCookie,
    authenticated = true,
  } = options;
  const headers = new Headers();
  if (authenticated && cookie) headers.set("Cookie", cookie);
  if (json !== undefined) headers.set("Content-Type", "application/json");
  const startedAt = performance.now();
  const response = await fetch(new URL(pathname, baseUrl), {
    method,
    headers,
    body: json === undefined ? undefined : JSON.stringify(json),
    redirect: "error",
    signal: AbortSignal.timeout(requestTimeoutMilliseconds),
  });
  const responseText = await response.text();
  const durationMilliseconds = performance.now() - startedAt;
  assert((response.headers.get("content-type") || "").includes("application/json"), `${method} ${pathname} returned non-JSON.`);
  let body;
  try {
    body = responseText ? JSON.parse(responseText) : null;
  } catch {
    throw new Error(`${method} ${pathname} returned invalid JSON: ${responseText.slice(0, 200)}`);
  }
  assert.equal(response.status, expectedStatus, `${method} ${pathname} returned ${response.status}: ${responseText.slice(0, 500)}`);
  return { body, response, durationMilliseconds };
}

function cookieFrom(response) {
  // 测试只在内存中保存 Cookie 的第一段，不输出原始会话令牌。
  const setCookie = response.headers.get("set-cookie") || "";
  const cookie = setCookie.split(";", 1)[0];
  assert(cookie.includes("="), "Authentication did not return a usable session cookie.");
  return cookie;
}

async function initializeAdministrator() {
  // 公开健康检查先建立空数据库结构，再用正式首次设置 API 创建一次性管理员。
  await requestApi("/api/health", { authenticated: false });
  const setup = await requestApi("/api/auth/setup", {
    method: "POST",
    authenticated: false,
    expectedStatus: 201,
    json: { username: "performance-admin", password: "PerformanceAdmin123!" },
  });
  administratorCookie = cookieFrom(setup.response);
}

function seedScaleFixture() {
  // 服务器停止后使用一个 SQLite IMMEDIATE 事务批量造数；造数耗时不属于 API 性能，
  // 也不会与应用连接竞争。全部 ID 都固定，测试失败时容易定位具体资料。
  const db = new Database(testDatabasePath);
  db.pragma("foreign_keys = ON");
  try {
    const insertTeacher = db.prepare("INSERT INTO teachers (id, name, staff_type) VALUES (?, ?, ?)");
    const insertGroup = db.prepare("INSERT INTO student_groups (id, code, year, program) VALUES (?, ?, ?, ?)");
    const insertRoom = db.prepare("INSERT INTO rooms (id, code, block, capacity, has_multi_projector, is_lab, is_smart_classroom) VALUES (?, ?, ?, ?, ?, ?, ?)");
    const insertCourse = db.prepare("INSERT INTO courses (id, code, catalog, duration_hours, sessions_per_week, primary_year) VALUES (?, ?, ?, ?, 1, ?)");
    const insertAllocation = db.prepare("INSERT INTO teaching_allocations (id, course_id, teacher_id, assigned_group_count) VALUES (?, ?, ?, 1)");
    const insertSection = db.prepare("INSERT INTO course_sections (id, course_id, sequence, teacher_id, revision) VALUES (?, ?, ?, ?, 1)");
    const insertSectionGroup = db.prepare("INSERT INTO section_student_groups (section_id, student_group_id) VALUES (?, ?)");
    const insertLesson = db.prepare("INSERT INTO scheduled_lessons (id, section_id, occurrence, day_of_week, start_hour, duration_hours, room_id, warnings_json, revision) VALUES (?, ?, 1, ?, ?, ?, ?, ?, 1)");
    const insertTeacherWindow = db.prepare("INSERT INTO teacher_unavailable_windows (id, teacher_id, day_of_week, start_hour, end_hour) VALUES (?, ?, ?, ?, ?)");
    const insertYearWindow = db.prepare("INSERT INTO year_blocked_windows (id, year, day_of_week, start_hour, end_hour) VALUES (?, ?, ?, ?, ?)");

    let globalSectionIndex = 0;
    let allocationIndex = 0;
    const populate = db.transaction(() => {
      // 教师、学生班级和教室数量分别对应真实导入规模和三个年级的日常排课资料。
      for (let index = 0; index < scale.teachers; index += 1) {
        insertTeacher.run(`perf-teacher-${String(index + 1).padStart(3, "0")}`, `PERF TEACHER ${String(index + 1).padStart(3, "0")}`, index % 5 === 0 ? "PT" : "FT");
      }
      for (let index = 0; index < scale.studentGroups; index += 1) {
        const year = (index % 3) + 1;
        insertGroup.run(`perf-group-${String(index + 1).padStart(3, "0")}`, `PERF_Y${year}_${String(index + 1).padStart(2, "0")}`, year, `PERF${year}`);
      }
      for (let index = 0; index < scale.rooms; index += 1) {
        const block = String(90 + (index % 3));
        insertRoom.run(`perf-room-${String(index + 1).padStart(3, "0")}`, `${block}-${String(1 + (index % 8)).padStart(2, "0")}-${String(index + 1).padStart(2, "0")}`, block, 60, index % 2, index % 5 === 0 ? 1 : 0, index % 6 === 0 ? 1 : 0);
      }

      // 前十门课程各八班、其余各七班，精确得到 374 个班次；前三百六十班排入总表。
      for (let courseIndex = 0; courseIndex < scale.courses; courseIndex += 1) {
        const courseId = `perf-course-${String(courseIndex + 1).padStart(3, "0")}`;
        const durationHours = 2 + (courseIndex % 3);
        const primaryYear = (courseIndex % 3) + 1;
        insertCourse.run(courseId, `PERF_C${String(courseIndex + 1).padStart(3, "0")}`, "Scale performance fixture", durationHours, primaryYear);

        // 28 门课各四条 allocation、其余各三条，合计 184 条，贴近真实 Excel。
        const allocationCount = courseIndex < 28 ? 4 : 3;
        for (let allocationOffset = 0; allocationOffset < allocationCount; allocationOffset += 1) {
          const teacherIndex = (courseIndex * 4 + allocationOffset) % scale.teachers;
          insertAllocation.run(`perf-allocation-${String(allocationIndex + 1).padStart(3, "0")}`, courseId, `perf-teacher-${String(teacherIndex + 1).padStart(3, "0")}`);
          allocationIndex += 1;
        }

        const sectionCount = courseIndex < 10 ? 8 : 7;
        for (let sequence = 1; sequence <= sectionCount; sequence += 1) {
          const sectionId = `perf-section-${String(globalSectionIndex + 1).padStart(3, "0")}`;
          // 已排课程只使用前 86 位教师和前 53 个班级；最后一位／一个专门留给
          // 14 个待排班次，使 candidate fixture 在满载总表旁仍确定拥有可用时段。
          const teacherIndex = globalSectionIndex < scale.scheduledLessons ? globalSectionIndex % (scale.teachers - 1) : scale.teachers - 1;
          const groupIndex = globalSectionIndex < scale.scheduledLessons ? globalSectionIndex % (scale.studentGroups - 1) : scale.studentGroups - 1;
          insertSection.run(sectionId, courseId, sequence, `perf-teacher-${String(teacherIndex + 1).padStart(3, "0")}`);
          insertSectionGroup.run(sectionId, `perf-group-${String(groupIndex + 1).padStart(3, "0")}`);
          // 每 50 个班次再连接一个不同年级班级，覆盖 cross-level 冲突查询。
          if (globalSectionIndex % 50 === 0) {
            insertSectionGroup.run(sectionId, `perf-group-${String(((groupIndex + 19) % scale.studentGroups) + 1).padStart(3, "0")}`);
          }

          if (globalSectionIndex < scale.scheduledLessons) {
            const dayOfWeek = (globalSectionIndex % 5) + 1;
            const latestStartHour = 18 - durationHours;
            const startHour = 8 + (Math.floor(globalSectionIndex / 5) % (latestStartHour - 8 + 1));
            // 第 30 间教室保持空闲，候选搜索仍会遍历全部 30 间房，但不会因为
            // fixture 偶然把每个时段都占满而把正确的候选结果误判为空。
            const roomIndex = globalSectionIndex % (scale.rooms - 1);
            const warnings = globalSectionIndex % 4 === 0
              ? ["Teacher conflict", "Room conflict"]
              : globalSectionIndex % 4 === 1
                ? ["Student group conflict"]
                : [];
            insertLesson.run(`perf-lesson-${String(globalSectionIndex + 1).padStart(3, "0")}`, sectionId, dayOfWeek, startHour, durationHours, `perf-room-${String(roomIndex + 1).padStart(3, "0")}`, JSON.stringify(warnings));
          }
          globalSectionIndex += 1;
        }
      }

      // 不可用时段让 warning 路径同时覆盖教师和年级索引，而不是只测资源冲突。
      for (let index = 0; index < 30; index += 1) {
        insertTeacherWindow.run(`perf-teacher-window-${String(index + 1).padStart(2, "0")}`, `perf-teacher-${String(index + 1).padStart(3, "0")}`, (index % 5) + 1, 10, 12);
      }
      for (let year = 1; year <= 3; year += 1) {
        insertYearWindow.run(`perf-year-window-${year}`, year, 3, 12, 14);
      }
    });
    populate.immediate();

    // 造数完成后立即用精确数量、SQLite 完整性和外键检查锁定夹具正确性。
    const counts = db.prepare(`SELECT
      (SELECT COUNT(*) FROM teachers WHERE id LIKE 'perf-teacher-%') AS teachers,
      (SELECT COUNT(*) FROM student_groups WHERE id LIKE 'perf-group-%') AS student_groups,
      (SELECT COUNT(*) FROM rooms WHERE id LIKE 'perf-room-%') AS rooms,
      (SELECT COUNT(*) FROM courses WHERE id LIKE 'perf-course-%') AS courses,
      (SELECT COUNT(*) FROM course_sections WHERE id LIKE 'perf-section-%') AS sections,
      (SELECT COUNT(*) FROM scheduled_lessons WHERE id LIKE 'perf-lesson-%') AS lessons,
      (SELECT COUNT(*) FROM teaching_allocations WHERE id LIKE 'perf-allocation-%') AS allocations`).get();
    assert.deepEqual(counts, { teachers: 87, student_groups: 54, rooms: 30, courses: 52, sections: 374, lessons: 360, allocations: 184 });
    assert.deepEqual(db.pragma("integrity_check"), [{ integrity_check: "ok" }]);
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally {
    db.close();
  }
}

function verifyRuntimeIndexes() {
  // 索引名称存在并不代表列顺序正确；逐个读取 index_info，能抓住旧同名短索引
  // 被 IF NOT EXISTS 静默保留的迁移错误。
  const expectedIndexes = new Map([
    ["auth_sessions_user_id_idx", ["user_id"]],
    ["auth_sessions_expires_at_idx", ["expires_at"]],
    ["rooms_is_active_code_idx", ["is_active", "code"]],
    ["courses_primary_year_idx", ["primary_year"]],
    ["teaching_allocations_teacher_id_idx", ["teacher_id"]],
    ["course_sections_teacher_id_idx", ["teacher_id"]],
    ["section_student_groups_student_group_id_section_id_idx", ["student_group_id", "section_id"]],
    ["scheduled_lessons_room_id_day_of_week_start_hour_idx", ["room_id", "day_of_week", "start_hour"]],
    ["scheduled_lessons_day_of_week_start_hour_idx", ["day_of_week", "start_hour"]],
    ["scheduled_lessons_section_id_day_of_week_start_hour_idx", ["section_id", "day_of_week", "start_hour"]],
    ["teacher_unavailable_windows_teacher_id_day_of_week_start_hour_end_hour_idx", ["teacher_id", "day_of_week", "start_hour", "end_hour"]],
    ["year_blocked_windows_year_day_of_week_start_hour_end_hour_idx", ["year", "day_of_week", "start_hour", "end_hour"]],
  ]);
  const db = new Database(testDatabasePath, { readonly: true });
  try {
    for (const [indexName, expectedColumns] of expectedIndexes) {
      const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(indexName);
      assert(exists, `Runtime index ${indexName} was not created.`);
      const actualColumns = db.prepare(`PRAGMA index_info('${indexName}')`).all().map((column) => column.name);
      assert.deepEqual(actualColumns, expectedColumns, `Runtime index ${indexName} has the wrong column order.`);
    }

    // 固定 better-sqlite3／SQLite 版本下，这些单表热点必须由相应索引搜索；
    // 这里不锁定完整计划文字，只确认没有退回资料量线性增长的整表扫描。
    const planUses = (sql, parameters, indexName) => {
      const details = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters).map((row) => row.detail).join("\n");
      assert(details.includes(indexName), `Expected query plan to use ${indexName}; plan=${details}`);
    };
    planUses("SELECT id FROM courses WHERE primary_year = ?", [1], "courses_primary_year_idx");
    planUses("SELECT id FROM course_sections WHERE teacher_id = ?", ["perf-teacher-001"], "course_sections_teacher_id_idx");
    planUses("SELECT section_id FROM section_student_groups WHERE student_group_id = ?", ["perf-group-001"], "section_student_groups_student_group_id_section_id_idx");
    planUses("SELECT lessons.id FROM scheduled_lessons lessons JOIN course_sections sections ON sections.id = lessons.section_id JOIN courses ON courses.id = sections.course_id JOIN section_student_groups personal_links ON personal_links.section_id = sections.id WHERE personal_links.student_group_id = ? ORDER BY lessons.day_of_week, lessons.start_hour, courses.code, sections.sequence", ["perf-group-001"], "section_student_groups_student_group_id_section_id_idx");
    planUses("SELECT id FROM scheduled_lessons WHERE room_id = ? AND day_of_week = ? AND start_hour < ?", ["perf-room-001", 1, 18], "scheduled_lessons_room_id_day_of_week_start_hour_idx");
    planUses("SELECT id FROM scheduled_lessons WHERE day_of_week = ? AND start_hour < ?", [1, 18], "scheduled_lessons_day_of_week_start_hour_idx");
    planUses("SELECT 1 FROM scheduled_lessons WHERE id <> ? AND section_id = ? AND day_of_week = ?", ["none", "perf-section-001", 1], "scheduled_lessons_section_id_day_of_week_start_hour_idx");
    planUses("SELECT 1 FROM teacher_unavailable_windows WHERE teacher_id = ? AND day_of_week = ? AND start_hour < ? AND end_hour > ?", ["perf-teacher-001", 1, 18, 8], "teacher_unavailable_windows_teacher_id_day_of_week_start_hour_end_hour_idx");
    planUses("SELECT 1 FROM year_blocked_windows WHERE year = ? AND day_of_week = ? AND start_hour < ? AND end_hour > ?", [1, 3, 18, 8], "year_blocked_windows_year_day_of_week_start_hour_end_hour_idx");
  } finally {
    db.close();
  }
  report("12 个 runtime 索引的名称与列顺序，以及 8 条热点查询计划");
}

async function createSchedulerCookies() {
  // 三个年级各建立两个独立 scheduler，会话在计时开始前完成，避免密码哈希成本混入读性能。
  const cookies = [];
  for (let index = 0; index < scale.schedulers; index += 1) {
    const username = `performance-scheduler-${index + 1}`;
    const password = `PerformanceScheduler${index + 1}!`;
    await requestApi("/api/auth/accounts", { method: "POST", expectedStatus: 201, json: { username, password } });
    const login = await requestApi("/api/auth/login", { method: "POST", authenticated: false, json: { username, password } });
    assert.equal(login.body.user.username, username);
    cookies.push(cookieFrom(login.response));
  }
  assert.equal(new Set(cookies).size, scale.schedulers, "Scheduler logins did not create six independent sessions.");
  return cookies;
}

function percentile(values, percentage) {
  // 使用 nearest-rank 分位数；样本较少时行为仍确定，不会做可能误导的插值。
  assert(values.length > 0, "A performance sample was empty.");
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * percentage) - 1)];
}

function median(values) {
  // 奇数批次直接取中间一项，避免单轮偶发系统抖动决定整个测试结果。
  return percentile(values, 0.5);
}

function formatMilliseconds(value) {
  // 统一显示一位小数，开发日志容易阅读，但断言仍使用未四舍五入的原始数字。
  return `${value.toFixed(1)} ms`;
}

function lessonReadSnapshot(db) {
  // 纯读阶段比较全部已排课程的稳定字段，任何隐藏 warning／revision 写入都会被发现。
  return db.prepare("SELECT id, day_of_week, start_hour, warnings_json, revision FROM scheduled_lessons ORDER BY id").all();
}

async function verifyReadPerformance(schedulerCookies) {
  // 建立一个会令任何 warning UPDATE 失败的 trigger。若 issues 或普通时间表 GET
  // 又退化为“读取时重算并写回”，请求会立即返回 500，而不是只表现为计时变慢。
  const writer = new Database(testDatabasePath);
  const administratorId = writer.prepare("SELECT id FROM app_users WHERE is_admin = 1").get().id;
  const expiredRawToken = "performance-expired-cookie";
  const expiredTokenHash = createHash("sha256").update(expiredRawToken).digest("hex");
  // 刻意保留一条过期会话，并阻止纯读阶段删除它。这样能证明身份验证也不再执行
  // 空 DELETE／争抢写锁；只比较 data_version 无法观察 changes=0 的写语句。
  writer.prepare("INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES (?, ?, '2000-01-01T00:00:00.000Z')").run(expiredTokenHash, administratorId);
  writer.exec(`
    CREATE TRIGGER zz_performance_reads_must_not_write
    BEFORE UPDATE OF warnings_json ON scheduled_lessons
    BEGIN
      SELECT RAISE(ABORT, 'performance read attempted a warning write');
    END;
    CREATE TRIGGER zz_performance_reads_must_not_delete_sessions
    BEFORE DELETE ON auth_sessions
    BEGIN
      SELECT RAISE(ABORT, 'performance read attempted session cleanup');
    END;
  `);
  const observer = new Database(testDatabasePath, { readonly: true });
  const dataVersionBefore = observer.pragma("data_version", { simple: true });
  const lessonsBefore = lessonReadSnapshot(observer);
  // RESERVED 写锁不会阻止其他连接 SELECT，却会让任何 INSERT／UPDATE／DELETE 失败。
  // 因此这一段不仅能抓到真的提交，也能抓到 changes=0、data_version 看不到的空写语句。
  writer.exec("BEGIN IMMEDIATE");

  try {
    // Cookie 哈希真实对应数据库行，但 expires_at 已过期；代理必须返回 401，
    // 同时不能为了清理它而执行 DELETE 或等待写锁。
    await requestApi("/api/teachers", {
      cookie: `timetable_session=${expiredRawToken}`,
      expectedStatus: 401,
    });
    // 先预热 production 路由和 SQLite statement cache；预热时间不计入门槛。
    for (const cookie of schedulerCookies) {
      const issues = await requestApi("/api/issues", { cookie });
      assert.equal(issues.body.length, scale.initialIssues);
    }
    for (const year of [1, 2, 3]) {
      const timetable = await requestApi(`/api/schedule/lessons?year=${year}`);
      assert.equal(timetable.body.length, scheduledLessonsPerYear[year]);
    }

    // 个人时间表必须与数据库关系精确一致，特别是学生班级分支改为直接 JOIN 后，
    // 不能因为 cross-level 多关联而重复一节课，也不能漏掉属于该班级的课程。
    const expectedPersonalIds = (kind, ownerId) => {
      const conditions = {
        Teacher: ["sections.teacher_id = ?", ""],
        Room: ["lessons.room_id = ?", ""],
        StudentGroup: ["links.student_group_id = ?", "JOIN section_student_groups links ON links.section_id = sections.id"],
      };
      const [condition, extraJoin] = conditions[kind];
      return observer.prepare(`
        SELECT lessons.id
        FROM scheduled_lessons lessons
        JOIN course_sections sections ON sections.id = lessons.section_id
        ${extraJoin}
        WHERE ${condition}
        ORDER BY lessons.id
      `).all(ownerId).map((row) => row.id);
    };
    for (const [kind, ownerId] of [
      ["Teacher", "perf-teacher-001"],
      ["StudentGroup", "perf-group-001"],
      ["Room", "perf-room-001"],
    ]) {
      const personal = await requestApi(`/api/schedule/personal?kind=${kind}&ownerId=${ownerId}`, { cookie: schedulerCookies[0] });
      const actualIds = personal.body.map((lesson) => lesson.id).sort();
      assert.equal(new Set(actualIds).size, actualIds.length, `${kind} personal timetable returned duplicate lessons.`);
      assert.deepEqual(actualIds, expectedPersonalIds(kind, ownerId));
      // 第一条 fixture 课同时连接 Year 1 与 Year 2；三种个人视图都必须返回完整关联标签。
      const crossLevelLesson = personal.body.find((lesson) => lesson.id === "perf-lesson-001");
      assert(crossLevelLesson, `${kind} personal timetable omitted the shared cross-level lesson.`);
      assert.deepEqual([...crossLevelLesson.studentGroupIds].sort(), ["perf-group-001", "perf-group-020"]);
      assert.deepEqual([...crossLevelLesson.studentGroups].sort(), ["PERF_Y1_01", "PERF_Y2_20"]);
    }
    const secondCrossLevelGroup = await requestApi("/api/schedule/personal?kind=StudentGroup&ownerId=perf-group-020", { cookie: schedulerCookies[1] });
    assert(secondCrossLevelGroup.body.some((lesson) => lesson.id === "perf-lesson-001"), "The second cross-level student group omitted its shared lesson.");
    report("教师、学生班级和教室个人时间表关系完整且无重复");

    // 三批、每批六个独立账号同时读取问题清单，记录每批 p95 的中位数。
    const issueBatchP95 = [];
    for (let batch = 0; batch < 3; batch += 1) {
      const results = await Promise.all(schedulerCookies.map((cookie) => requestApi("/api/issues", { cookie })));
      for (const result of results) assert.equal(result.body.length, scale.initialIssues);
      issueBatchP95.push(percentile(results.map((result) => result.durationMilliseconds), 0.95));
    }

    // 三个年级各由两个账号连续读取十次，总共六十个请求，覆盖总表关联和排序。
    const yearDurations = [];
    const assignedYears = [1, 1, 2, 2, 3, 3];
    for (let round = 0; round < 10; round += 1) {
      const results = await Promise.all(schedulerCookies.map((cookie, index) => requestApi(`/api/schedule/lessons?year=${assignedYears[index]}`, { cookie })));
      for (const [index, result] of results.entries()) {
        assert.equal(result.body.length, scheduledLessonsPerYear[assignedYears[index]]);
        yearDurations.push(result.durationMilliseconds);
      }
    }

    const issueP95 = median(issueBatchP95);
    const yearP95 = percentile(yearDurations, 0.95);
    assert(issueP95 <= limits.readP95Milliseconds, `Issues p95 ${formatMilliseconds(issueP95)} exceeded ${limits.readP95Milliseconds} ms.`);
    assert(yearP95 <= limits.readP95Milliseconds, `Year timetable p95 ${formatMilliseconds(yearP95)} exceeded ${limits.readP95Milliseconds} ms.`);
    report(`满载纯读：Issues p95 中位 ${formatMilliseconds(issueP95)}；Year p95 ${formatMilliseconds(yearP95)}`);

    // Candidate 固定使用第 361 班的未排 occurrence；一次计算会遍历 30 间教室和全部合法整点。
    await requestApi("/api/course-sections/perf-section-361/candidates?occurrence=1", { cookie: schedulerCookies[0] });
    const candidateDurations = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = await requestApi("/api/course-sections/perf-section-361/candidates?occurrence=1", { cookie: schedulerCookies[attempt % schedulerCookies.length] });
      assert(Array.isArray(result.body.slots));
      assert(result.body.slots.length > 0, "Candidate calculation returned no usable slots for the fixed complete fixture.");
      assert(result.body.slots.some((slot) => slot.roomId === "perf-room-030"), "Candidate calculation omitted the reserved available room.");
      candidateDurations.push(result.durationMilliseconds);
    }
    const candidateMedian = median(candidateDurations);
    assert(candidateMedian <= limits.candidateMedianMilliseconds, `Candidate median ${formatMilliseconds(candidateMedian)} exceeded ${limits.candidateMedianMilliseconds} ms.`);
    report(`30 间教室候选位置中位 ${formatMilliseconds(candidateMedian)}`);

    // 模拟三个年级页面真实的五秒轮询：每个账号只请求一次聚合工作区；服务端会在
    // 同一个 SQLite 快照中读取总表、待排区、问题、教师和教室，既减少请求也避免混合版本。
    const pollWalls = [];
    const pollRequestDurations = [];
    const runPollBurst = async () => {
      const startedAt = performance.now();
      const requests = schedulerCookies.flatMap((cookie, index) => {
        const year = assignedYears[index];
        return [requestApi(`/api/schedule/workspace?year=${year}`, { cookie })];
      });
      const results = await Promise.all(requests);
      // 每个账号返回一份完整工作区；逐项锁定固定资料量，防止错误空响应因为更快而让性能门槛假绿。
      for (let accountIndex = 0; accountIndex < schedulerCookies.length; accountIndex += 1) {
        const year = assignedYears[accountIndex];
        const workspace = results[accountIndex].body;
        assert.equal(workspace.lessons.length, scheduledLessonsPerYear[year]);
        assert.equal(workspace.unscheduledSections.length, unscheduledSectionsPerYear[year]);
        assert.equal(workspace.issues.length, scale.initialIssues);
        assert.equal(workspace.teachers.length, scale.teachers);
        assert.equal(workspace.rooms.length, scale.rooms);
      }
      return { wall: performance.now() - startedAt, durations: results.map((result) => result.durationMilliseconds) };
    };
    await runPollBurst();
    for (let round = 0; round < 3; round += 1) {
      const result = await runPollBurst();
      pollWalls.push(result.wall);
      pollRequestDurations.push(...result.durations);
    }
    const pollWallMedian = median(pollWalls);
    const pollP95 = percentile(pollRequestDurations, 0.95);
    assert(pollWallMedian <= limits.pollWallMilliseconds, `Poll wall median ${formatMilliseconds(pollWallMedian)} exceeded ${limits.pollWallMilliseconds} ms.`);
    assert(pollP95 <= limits.pollP95Milliseconds, `Poll request p95 ${formatMilliseconds(pollP95)} exceeded ${limits.pollP95Milliseconds} ms.`);
    report(`六账号 6 请求一致快照轮询：整轮中位 ${formatMilliseconds(pollWallMedian)}；请求 p95 ${formatMilliseconds(pollP95)}`);

    // trigger 建立后才记录 data_version；整个纯读阶段不能提交任何数据库变化。
    assert.equal(observer.pragma("data_version", { simple: true }), dataVersionBefore);
    assert.deepEqual(lessonReadSnapshot(observer), lessonsBefore);
    assert.equal(observer.prepare("SELECT COUNT(*) AS count FROM auth_sessions WHERE token_hash = ?").get(expiredTokenHash).count, 1);
    const candidateWasNotScheduled = observer.prepare("SELECT COUNT(*) AS count FROM scheduled_lessons WHERE section_id = 'perf-section-361'").get();
    assert.equal(candidateWasNotScheduled.count, 0);
    report("Issues、总表、候选与六账号轮询保持 SQLite 纯读取");
  } finally {
    observer.close();
    writer.exec("ROLLBACK");
    writer.exec("DROP TRIGGER IF EXISTS zz_performance_reads_must_not_write");
    writer.exec("DROP TRIGGER IF EXISTS zz_performance_reads_must_not_delete_sessions");
    writer.close();
  }

  // 纯读请求不清理过期记录；下一次真实登录建立会话时才低频执行清理。
  // 这同时验证“减少写锁”没有让过期会话永久堆积或重新获得访问资格。
  await requestApi("/api/auth/login", {
    method: "POST",
    authenticated: false,
    json: { username: "performance-scheduler-1", password: "PerformanceScheduler1!" },
  });
  const cleanupCheck = new Database(testDatabasePath, { readonly: true });
  try {
    assert.equal(cleanupCheck.prepare("SELECT COUNT(*) AS count FROM auth_sessions WHERE token_hash = ?").get(expiredTokenHash).count, 0);
  } finally {
    cleanupCheck.close();
  }
  report("已登录 GET 不争写锁，过期会话在下一次登录时低频清理");
}

function readEditableLesson() {
  // PATCH 必须提交当前教师、教室、学生班级和 revision；从同一只读快照取得完整资料，
  // 避免性能脚本因遗漏共享分配而意外改变 fixture。
  const db = new Database(testDatabasePath, { readonly: true });
  try {
    const lesson = db.prepare(`
      SELECT lessons.id, lessons.day_of_week AS dayOfWeek, lessons.start_hour AS startHour,
        lessons.duration_hours AS durationHours, lessons.room_id AS roomId,
        lessons.revision, sections.teacher_id AS teacherId
      FROM scheduled_lessons lessons
      JOIN course_sections sections ON sections.id = lessons.section_id
      WHERE lessons.id = 'perf-lesson-001'
    `).get();
    const studentGroupIds = db.prepare("SELECT student_group_id FROM section_student_groups WHERE section_id = 'perf-section-001' ORDER BY student_group_id").all().map((row) => row.student_group_id);
    return { ...lesson, studentGroupIds };
  } finally {
    db.close();
  }
}

async function verifyWarningWritePerformance(schedulerCookies) {
  let lesson = readEditableLesson();
  const originalStartHour = lesson.startHour;
  const alternateStartHour = lesson.startHour + lesson.durationHours < 18 ? lesson.startHour + 1 : lesson.startHour - 1;

  const moveLesson = async (cookie, startHour) => {
    // 每次都提交上一响应返回的最新 revision，确保测到 warning 全量重算而不是廉价的 409。
    const result = await requestApi(`/api/schedule/lessons/${lesson.id}`, {
      method: "PATCH",
      cookie,
      json: {
        dayOfWeek: lesson.dayOfWeek,
        startHour,
        teacherId: lesson.teacherId,
        roomId: lesson.roomId,
        studentGroupIds: lesson.studentGroupIds,
        revision: lesson.revision,
      },
    });
    assert.equal(result.body.id, lesson.id);
    assert.equal(result.body.revision, lesson.revision + 1);
    lesson = { ...lesson, ...result.body, studentGroupIds: result.body.studentGroupIds };
    return result;
  };

  // 审计 trigger 只覆盖一次不计时的预热保存：每条 warning UPDATE 都登记 lesson ID。
  // 精确 360 个 ID 证明下方计时真的包含满载全量重算，而不是漏掉刷新后反而“变快”。
  const auditDatabase = new Database(testDatabasePath);
  auditDatabase.exec(`
    CREATE TABLE zz_performance_warning_audit (lesson_id TEXT PRIMARY KEY);
    CREATE TRIGGER zz_performance_warning_refresh_audit
    AFTER UPDATE OF warnings_json ON scheduled_lessons
    BEGIN
      INSERT OR IGNORE INTO zz_performance_warning_audit (lesson_id) VALUES (NEW.id);
    END;
  `);
  try {
    await moveLesson(schedulerCookies[0], alternateStartHour);
    assert.equal(auditDatabase.prepare("SELECT COUNT(*) AS count FROM zz_performance_warning_audit").get().count, scale.scheduledLessons);
  } finally {
    auditDatabase.exec("DROP TRIGGER IF EXISTS zz_performance_warning_refresh_audit");
    auditDatabase.exec("DROP TABLE IF EXISTS zz_performance_warning_audit");
    auditDatabase.close();
  }

  // 审计确认全量刷新后再往返五次；计时不包含审计表本身的额外写入成本。
  const writeDurations = [];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const target = lesson.startHour === originalStartHour ? alternateStartHour : originalStartHour;
    const result = await moveLesson(schedulerCookies[attempt % schedulerCookies.length], target);
    writeDurations.push(result.durationMilliseconds);
  }
  const warningRefreshMedian = median(writeDurations);
  assert(warningRefreshMedian <= limits.warningRefreshMedianMilliseconds, `Warning refresh median ${formatMilliseconds(warningRefreshMedian)} exceeded ${limits.warningRefreshMedianMilliseconds} ms.`);
  report(`360 条课次 warning 全量重算中位 ${formatMilliseconds(warningRefreshMedian)}`);

  // 一个账号写入时，其余五个账号各读取真实页面使用的聚合 workspace。每份响应都要
  // 在同一 SQLite 快照内包含总表、待排区、问题、教师和教室，且不能出现锁错误或超时。
  const mixedWalls = [];
  for (let round = 0; round < 3; round += 1) {
    const target = lesson.startHour === originalStartHour ? alternateStartHour : originalStartHour;
    const startedAt = performance.now();
    const writerPromise = moveLesson(schedulerCookies[0], target);
    const readerPromises = schedulerCookies.slice(1).map((cookie, index) => requestApi(
      `/api/schedule/workspace?year=${(index % 3) + 1}`,
      { cookie },
    ));
    const [, ...readers] = await Promise.all([writerPromise, ...readerPromises]);
    for (let readerIndex = 0; readerIndex < schedulerCookies.length - 1; readerIndex += 1) {
      const year = (readerIndex % 3) + 1;
      const workspace = readers[readerIndex].body;
      assert.equal(workspace.lessons.length, scheduledLessonsPerYear[year]);
      assert.equal(workspace.unscheduledSections.length, unscheduledSectionsPerYear[year]);
      assert(workspace.issues.length > 0, "Mixed read/write burst returned an empty issue list.");
      assert.equal(workspace.teachers.length, scale.teachers);
      assert.equal(workspace.rooms.length, scale.rooms);
    }
    mixedWalls.push(performance.now() - startedAt);
  }
  const mixedMedian = median(mixedWalls);
  assert(mixedMedian <= limits.mixedBurstMedianMilliseconds, `Mixed burst median ${formatMilliseconds(mixedMedian)} exceeded ${limits.mixedBurstMedianMilliseconds} ms.`);
  report(`一个 warning 写入 + 五个一致快照读取中位 ${formatMilliseconds(mixedMedian)}`);

  // 最终检查资料仍完整；性能测试只允许改变目标课程的位置和 revision。
  const db = new Database(testDatabasePath, { readonly: true });
  try {
    assert.deepEqual(db.pragma("integrity_check"), [{ integrity_check: "ok" }]);
    assert.deepEqual(db.pragma("foreign_key_check"), []);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM scheduled_lessons").get().count, scale.scheduledLessons);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM course_sections").get().count, scale.sections);
  } finally {
    db.close();
  }
}

async function readStatementAuditReport() {
  // 报告可能尚未由 preload 写出；调用方轮询时把“文件暂不存在”和“JSON 正在被原子替换”都视为继续等待。
  try {
    return JSON.parse(await readFile(statementAuditReportPath, "utf8"));
  } catch {
    return null;
  }
}

async function captureCompletedStatementAudit() {
  // 业务 HTTP 已经完整返回后才向测试进程发送 SIGUSR2。preload 在同一事件循环中同步
  // 写入更高 snapshotSequence，主测试因此不会误读目标请求执行到一半时的旧定时快照。
  const beforeSignal = await readStatementAuditReport();
  const previousSequence = beforeSignal?.runToken === statementAuditToken ? beforeSignal.snapshotSequence : 0;
  assert(serverProcess && serverProcess.kill("SIGUSR2"), "The statement audit server could not receive its snapshot signal.");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const auditReport = await readStatementAuditReport();
    if (auditReport?.runToken === statementAuditToken && auditReport.snapshotSequence > previousSequence) return auditReport;
    await delay(25);
  }
  throw new Error("The statement audit server did not publish a completed request snapshot.");
}

function assertPreparedStatementReuse(auditReport, label) {
  // 报告只统计带 placement-warning marker 的规则 SQL，不会混入登录或页面查询。
  assert.equal(auditReport.version, 1);
  assert.equal(auditReport.runToken, statementAuditToken);
  assert(Array.isArray(auditReport.statements));

  const totalExecutions = auditReport.statements.reduce((total, row) => total + row.executions, 0);
  const totalPrepares = auditReport.statements.reduce((total, row) => total + row.prepares, 0);
  assert(totalExecutions > 0, `${label} did not execute marked warning statements.`);

  // 本轮明确仍使用 rooms × slots 和全表刷新循环，所以至少应出现一条执行 32 次以上的热点 SQL。
  // 每条热点必须达到至少 8 倍编译摊销，从而阻止代码退回“每个位置重新 prepare”。
  const hotStatements = auditReport.statements.filter((row) => row.executions >= 32);
  assert(hotStatements.length > 0, `${label} did not exercise the expected warning loop.`);
  for (const row of hotStatements) {
    const maximumAllowedPrepares = Math.max(2, Math.ceil(row.executions / 8));
    assert(row.prepares <= maximumAllowedPrepares,
      `${label} repeatedly compiled warning SQL: ${row.prepares} prepares for ${row.executions} executions.`);
  }

  const maximumReuse = Math.max(...auditReport.statements
    .filter((row) => row.prepares > 0)
    .map((row) => row.executions / row.prepares));
  assert(maximumReuse >= 8, `${label} did not reach the required prepared statement reuse ratio.`);
  report(`${label}：${totalPrepares} 次 prepare／${totalExecutions} 次执行，最高复用 ${maximumReuse.toFixed(1)} 倍`);
}

async function runStatementAudit(auditName, label, schedulerCookie, auditedRequest) {
  // 每个目标请求使用独立 production 进程、随机 token 和报告文件；候选与全量刷新
  // 不会共享旧计数，也不会把 preload 包装成本混入前面的正式耗时。
  statementAuditToken = randomBytes(32).toString("hex");
  statementAuditReportPath = path.join(temporaryDirectory, `statement-audit-${auditName}.json`);
  await rm(statementAuditReportPath, { force: true });
  await writeFile(path.join(temporaryDirectory, "statement-audit.marker"), statementAuditToken, { mode: 0o600 });
  await startServer({ auditStatements: true });
  try {
    await auditedRequest(schedulerCookie);
    const auditReport = await captureCompletedStatementAudit();
    assertPreparedStatementReuse(auditReport, label);
  } finally {
    await stopServer();
    serverProcess = undefined;
  }
}

async function verifyPreparedStatementReuse(schedulerCookies) {
  // 先停止没有插桩的计时服务；下面两个独立进程只负责结构审计。
  await stopServer();
  serverProcess = undefined;

  await runStatementAudit("candidate", "候选搜索", schedulerCookies[0], async (cookie) => {
    const result = await requestApi("/api/course-sections/perf-section-361/candidates?occurrence=1", { cookie });
    assert(Array.isArray(result.body.slots) && result.body.slots.length > 0);
  });

  await runStatementAudit("warning-refresh", "全量警告刷新", schedulerCookies[1], async (cookie) => {
    const lesson = readEditableLesson();
    const result = await requestApi(`/api/schedule/lessons/${lesson.id}`, {
      method: "PATCH",
      cookie,
      json: {
        dayOfWeek: lesson.dayOfWeek,
        startHour: lesson.startHour,
        teacherId: lesson.teacherId,
        roomId: lesson.roomId,
        studentGroupIds: lesson.studentGroupIds,
        revision: lesson.revision,
      },
    });
    assert.equal(result.body.revision, lesson.revision + 1);
  });

  // TypeScript 强制每次计算显式接收 PlacementWarningStatements；再用一个小型源码守卫
  // 防止未来开发者在 calculatePlacementWarnings 的循环主体中重新加入 db.prepare。
  const databaseSource = await readFile(path.join(projectRoot, "src", "lib", "database.ts"), "utf8");
  const calculationStart = databaseSource.indexOf("function calculatePlacementWarnings(");
  const calculationEnd = databaseSource.indexOf("function refreshAllScheduleWarnings(", calculationStart);
  assert(calculationStart >= 0 && calculationEnd > calculationStart, "Warning calculation source boundary was not found.");
  const calculationSource = databaseSource.slice(calculationStart, calculationEnd);
  assert(!calculationSource.includes(".prepare("), "calculatePlacementWarnings must reuse prepared statements instead of compiling SQL inside its loop.");
}

function cleanupTemporaryResources() {
  // 普通 finally、Ctrl-C 和 CI SIGTERM 共用同一个幂等 Promise，最多清理一次。
  if (!cleanupPromise) {
    cleanupPromise = (async () => {
      await stopServer();
      if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
    })();
  }
  return cleanupPromise;
}

function installTerminationCleanup() {
  // 用户中断或 CI 终止时先清理子服务和临时数据库，再使用标准信号退出码结束。
  for (const [signal, exitCode] of [["SIGINT", 130], ["SIGTERM", 143]]) {
    process.once(signal, () => {
      void cleanupTemporaryResources()
        .then(() => process.exit(exitCode))
        .catch(() => process.exit(exitCode));
    });
  }
}

async function run() {
  // 性能脚本复用刚通过功能测试的 production build；缺失时给出明确命令。
  try {
    await access(standaloneServerPath);
  } catch {
    throw new Error("Standalone build is missing. Run `npm run build` before this performance verification.");
  }

  // 空库先由 production 初始化表和管理员；停止服务后批量造数，再重新启动同一临时库。
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "timetabling-api-performance-"));
  testDatabasePath = path.join(temporaryDirectory, "performance.db");
  assert.equal(path.dirname(testDatabasePath), temporaryDirectory);
  await startServer();
  await initializeAdministrator();
  await stopServer();
  serverProcess = undefined;
  seedScaleFixture();
  verifyRuntimeIndexes();
  await startServer();

  const schedulerCookies = await createSchedulerCookies();
  await verifyReadPerformance(schedulerCookies);
  await verifyWarningWritePerformance(schedulerCookies);
  await verifyPreparedStatementReuse(schedulerCookies);
  console.log("Scale and multi-account performance verification passed.");
}

installTerminationCleanup();

try {
  await run();
} catch (error) {
  // 断言失败时输出简洁原因和有限服务器日志，非零退出码会阻止误判为通过。
  console.error("Performance verification failed:", error);
  if (serverOutput.trim()) console.error("Last standalone server output:\n", serverOutput.trim());
  process.exitCode = 1;
} finally {
  // 成功、超时、异常和断言失败都不会留下临时数据库或 standalone 子进程。
  await cleanupTemporaryResources();
}
