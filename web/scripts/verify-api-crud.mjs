import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import * as XLSX from "xlsx";
import { parseTeachingMembersWorksheet } from "../src/lib/teaching-members-workbook.mjs";

// 这项回归使用刚生成的 standalone production build，而不是开发服务器。
// 因此测试结果同时覆盖 Next.js 路由编译、身份代理和真实 SQLite 写入路径。
const projectRoot = process.cwd();
const standaloneServerPath = path.join(projectRoot, ".next", "standalone", "server.js");
const maximumWorkbookBytes = 20 * 1024 * 1024;
const requestTimeoutMilliseconds = 60_000;

// 测试过程中动态填写这些运行资料。它们只属于一次性本机服务，绝不会读取
// 或修改项目 data 目录中的老师正式数据库。
let baseUrl;
let sessionCookie = "";
let serverProcess;
let temporaryDirectory;
let testDatabasePath;
let serverOutput = "";
let serverProcessError;
let cleanupPromise;

function report(message) {
  // 每完成一组业务保证就输出一行，方便基础开发人员快速知道失败发生在哪一层。
  console.log(`✓ ${message}`);
}

function keepRecentServerOutput(chunk) {
  // 正常测试不重复打印 Next.js 日志；发生失败时只保留最后 12,000 个字符，
  // 既能帮助定位问题，也避免长时间运行后把终端输出撑得过大。
  serverOutput = `${serverOutput}${String(chunk)}`.slice(-12_000);
}

function delay(milliseconds) {
  // 使用短暂异步等待轮询服务状态，不阻塞 Node.js 处理子进程输出。
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function chooseAvailablePort() {
  // 先让操作系统分配一个空闲端口，再马上释放给 standalone 服务。
  // 测试不固定使用 3000，避免影响老师正在打开的本地开发页面。
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  assert(address && typeof address === "object", "The test server could not obtain a local port.");
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitForServer() {
  // standalone 进程启动后反复请求公开健康接口。较短单次超时配合总时限，
  // 可以区分“仍在启动”和“已经退出”，不会让测试无限等待。
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (serverProcessError) throw new Error(`The standalone test server could not start: ${serverProcessError.message}`);
    if (serverProcess.exitCode !== null || serverProcess.signalCode !== null) {
      throw new Error("The standalone test server exited before becoming ready.");
    }
    try {
      const response = await fetch(new URL("/api/health", baseUrl), { signal: AbortSignal.timeout(1_000) });
      if (response.status === 200) return;
    } catch {
      // 连接尚未建立是启动过程中的正常状态，稍后重试即可。
    }
    await delay(100);
  }
  throw new Error("The standalone test server did not become ready within 15 seconds.");
}

async function stopServer() {
  // 正常退出先发送 SIGTERM，让 Node.js 有机会关闭监听端口；若三秒内仍未退出，
  // 再使用 SIGKILL，保证失败的测试不会在后台留下占用端口的进程。
  const child = serverProcess;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exitPromise = new Promise((resolve) => child.once("exit", () => resolve(true)));
  // 监听器注册后再检查一次，覆盖进程恰好在前一行之前退出的极短竞态。
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const stoppedNormally = await Promise.race([
    exitPromise,
    delay(3_000).then(() => false),
  ]);
  if (!stoppedNormally && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exitPromise;
  }
}

async function startServer(databasePath) {
  // 释放端口与 standalone 真正监听之间存在很短的竞争窗口。如果刚好被其他程序抢走，
  // 只在明确看到 EADDRINUSE 时重新选择端口；其他启动错误必须立即报告。
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const port = await chooseAvailablePort();
    baseUrl = new URL(`http://127.0.0.1:${port}`);
    serverOutput = "";
    serverProcessError = undefined;

    // 先删除可能继承自开发终端或 Railway 的位置变量，再设置唯一的临时数据库和端口。
    // 这样即使开发人员本机已经配置正式路径，测试子进程也绝不会打开它。
    const serverEnvironment = { ...process.env };
    for (const name of ["RAILWAY_ENVIRONMENT", "RAILWAY_SERVICE_ID", "RAILWAY_VOLUME_MOUNT_PATH", "TIMETABLING_DATABASE_PATH", "PORT", "HOSTNAME"]) {
      delete serverEnvironment[name];
    }
    Object.assign(serverEnvironment, {
      NODE_ENV: "production",
      HOSTNAME: "127.0.0.1",
      PORT: String(port),
      TIMETABLING_DATABASE_PATH: databasePath,
    });

    serverProcess = spawn(process.execPath, [standaloneServerPath], {
      cwd: projectRoot,
      env: serverEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    serverProcess.stdout.on("data", keepRecentServerOutput);
    serverProcess.stderr.on("data", keepRecentServerOutput);
    serverProcess.once("error", (error) => {
      // spawn 本身失败时未必还会出现普通 exit 事件；保存原始错误可让启动轮询立即停止。
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
  // 共用请求器负责 Cookie、JSON 编码、响应格式和 HTTP 状态断言。
  // 每个测试只需要写清楚业务输入与期望状态，不必重复底层网络处理。
  const {
    method = "GET",
    json,
    body,
    headers = {},
    expectedStatus = 200,
    authenticated = true,
  } = options;
  const requestHeaders = new Headers(headers);
  if (authenticated && sessionCookie) requestHeaders.set("Cookie", sessionCookie);
  if (json !== undefined) requestHeaders.set("Content-Type", "application/json");

  const response = await fetch(new URL(pathname, baseUrl), {
    method,
    headers: requestHeaders,
    body: json === undefined ? body : JSON.stringify(json),
    redirect: "error",
    signal: AbortSignal.timeout(requestTimeoutMilliseconds),
  });
  const responseText = await response.text();
  const contentType = response.headers.get("content-type") || "";
  assert(contentType.includes("application/json"), `${method} ${pathname} returned a non-JSON response.`);

  let responseBody;
  try {
    responseBody = responseText ? JSON.parse(responseText) : null;
  } catch {
    throw new Error(`${method} ${pathname} returned invalid JSON: ${responseText.slice(0, 200)}`);
  }
  const acceptedStatuses = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
  assert(
    acceptedStatuses.includes(response.status),
    `${method} ${pathname} returned HTTP ${response.status}; expected ${acceptedStatuses.join(" or ")}; body=${responseText.slice(0, 500)}`,
  );
  return { response, body: responseBody };
}

function readBusinessSnapshot() {
  // 超限或故障请求必须证明“全部业务表零变化”，不能只比较课程总数。
  // 独立只读连接可看到服务器已经提交的状态，但不会取得写锁或改变正式资料。
  assert(testDatabasePath, "The temporary database path is not ready.");
  const db = new Database(testDatabasePath, { readonly: true });
  try {
    return {
      teachers: db.prepare("SELECT * FROM teachers ORDER BY id").all(),
      studentGroups: db.prepare("SELECT * FROM student_groups ORDER BY id").all(),
      rooms: db.prepare("SELECT * FROM rooms ORDER BY id").all(),
      courses: db.prepare("SELECT * FROM courses ORDER BY id").all(),
      allocations: db.prepare("SELECT * FROM teaching_allocations ORDER BY id").all(),
      sections: db.prepare("SELECT * FROM course_sections ORDER BY id").all(),
      sectionGroups: db.prepare("SELECT * FROM section_student_groups ORDER BY section_id, student_group_id").all(),
      lessons: db.prepare("SELECT * FROM scheduled_lessons ORDER BY id").all(),
      teacherUnavailableWindows: db.prepare("SELECT * FROM teacher_unavailable_windows ORDER BY id").all(),
      yearBlockedWindows: db.prepare("SELECT * FROM year_blocked_windows ORDER BY id").all(),
      ruleSettings: db.prepare("SELECT * FROM rule_settings ORDER BY rule_key").all(),
    };
  } finally {
    db.close();
  }
}

function executeTestDatabase(callback) {
  // 故障注入只连接本次 mkdtemp 数据库，用于建立或删除测试 trigger。
  // callback 结束后立即关闭连接，避免干扰 standalone 后续请求。
  assert(testDatabasePath, "The temporary database path is not ready.");
  const db = new Database(testDatabasePath);
  try {
    return callback(db);
  } finally {
    db.close();
  }
}

function workbookBuffer(sheetEntries) {
  // 每个条目已经是 SheetJS 工作表对象。这个小工具只负责建立工作簿并输出
  // 与浏览器真实上传相同的 XLSX 二进制资料。
  const workbook = XLSX.utils.book_new();
  for (const [sheetName, worksheet] of sheetEntries) {
    XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
  }
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx", compression: true });
}

function teachingRowsWorksheet(rows) {
  // 固定表头顺序与 Teaching Allocation 导出保持一致；即使某一列全部为空，
  // 测试工作簿仍会真实包含该必填表头。
  return XLSX.utils.json_to_sheet(rows, {
    header: ["Mod", "Catalog", "Lecturer", "Staff Type", "# of grps teaching"],
  });
}

async function uploadWorkbook(bytes, filename, expectedStatus) {
  // Node.js 的 FormData 会生成真实 multipart 边界，走过与 Courses 页面上传相同的接口。
  const formData = new FormData();
  formData.append("file", new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), filename);
  return requestApi("/api/imports/teaching-members", { method: "POST", body: formData, expectedStatus });
}

async function verifyAuthentication() {
  // 业务 API 在没有会话时必须拒绝访问，公开健康接口则负责证明临时 SQLite 可用。
  const health = await requestApi("/api/health", { authenticated: false });
  assert.equal(health.body.status, "ok");
  await requestApi("/api/teachers", { authenticated: false, expectedStatus: 401 });
  const initialStatus = await requestApi("/api/auth/status", { authenticated: false });
  assert.equal(initialStatus.body.setupRequired, true);
  assert.equal(initialStatus.body.user, null);

  // 空数据库只允许创建第一位管理员；保存响应中的 Cookie 对后续所有 API 请求认证。
  const setup = await requestApi("/api/auth/setup", {
    method: "POST",
    authenticated: false,
    expectedStatus: 201,
    json: { username: "integration-admin", password: "IntegrationTest123!" },
  });
  const setCookie = setup.response.headers.get("set-cookie") || "";
  sessionCookie = setCookie.split(";", 1)[0];
  assert(sessionCookie.includes("="), "Administrator setup did not return a usable session cookie.");
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /Secure/i);
  assert.match(setCookie, /SameSite=Strict/i);
  report("身份保护、首次管理员和安全 Cookie");
}

async function verifyWorkbookBoundaries() {
  // 固定版本是两个已知 SheetJS 漏洞的主要修复保证，不能只依赖 npm audit
  // 对本地 file dependency 的有限识别能力。
  assert.equal(XLSX.version, "0.20.3", "The integration test must run with SheetJS 0.20.3.");

  // Decoy 工作表刻意放在目标表之前；解析选项必须只建立 Teaching Members 对象，
  // 这里直接调用 production route 使用的共用解析器，而不是在测试中复制 SheetJS 选项，
  // 因此未来若生产解析边界被移除，这条断言会真实失败。
  const targetRow = { Mod: "AUTO_TARGET", Catalog: "Target only", Lecturer: "AUTO EXCEL", "Staff Type": "FT", "# of grps teaching": 1 };
  const decoyRows = Array.from({ length: 500 }, (_, index) => ({
    Mod: `DECOY_${index}`,
    Catalog: "Must not import",
    Lecturer: "DECOY TEACHER",
    "Staff Type": "FT",
    "# of grps teaching": 1,
  }));
  const targetWorkbook = workbookBuffer([
    ["Decoy", teachingRowsWorksheet(decoyRows)],
    ["Teaching Members", teachingRowsWorksheet([targetRow])],
  ]);
  const parsedTargetWorkbook = parseTeachingMembersWorksheet(targetWorkbook);
  assert.deepEqual(parsedTargetWorkbook.parsedWorksheetNames, ["Teaching Members"]);
  const targetImport = await uploadWorkbook(targetWorkbook, "target-only.xlsx", 200);
  assert.deepEqual(targetImport.body, { courses: 1, teachers: 1, allocations: 1, sections: 1, ignoredZeroRows: 0 });

  // 合法 XLSX 若缺少约定工作表或缺少必要表头，也必须在写数据库前清楚拒绝。
  // 两个请求共用完整业务快照，证明解析器重构没有把格式错误变成半完成导入。
  const snapshotBeforeInvalidTemplates = readBusinessSnapshot();
  const missingSheet = await uploadWorkbook(
    workbookBuffer([["Wrong Name", teachingRowsWorksheet([targetRow])]]),
    "missing-teaching-members.xlsx",
    400,
  );
  assert.match(missingSheet.body.error, /was not found/i);
  const missingColumnsSheet = XLSX.utils.aoa_to_sheet([
    ["Mod", "Lecturer", "Staff Type"],
    ["AUTO_BAD_HEADER", "AUTO BAD HEADER", "FT"],
  ]);
  const missingColumns = await uploadWorkbook(
    workbookBuffer([["Teaching Members", missingColumnsSheet]]),
    "missing-columns.xlsx",
    400,
  );
  assert.match(missingColumns.body.error, /missing required columns/i);
  assert.deepEqual(readBusinessSnapshot(), snapshotBeforeInvalidTemplates);

  // 5,000 条资料是允许边界。只让第一行产生一项分配，其余使用合法的零分配，
  // 可以覆盖全部行数而不会建立数千门无意义测试课程。
  const boundaryRows = Array.from({ length: 5_000 }, (_, index) => ({
    Mod: "AUTO_LIMIT",
    Catalog: "Row boundary",
    Lecturer: "AUTO LIMIT TEACHER",
    "Staff Type": "FT",
    "# of grps teaching": index === 0 ? 1 : 0,
  }));
  const exactLimit = await uploadWorkbook(
    workbookBuffer([["Teaching Members", teachingRowsWorksheet(boundaryRows)]]),
    "exactly-5000.xlsx",
    200,
  );
  assert.equal(exactLimit.body.ignoredZeroRows, 4_999);
  assert.equal(exactLimit.body.sections, 1);

  // 再增加一条资料必须在任何数据库写入前返回 400；之后读取课程数量确认
  // 被拒绝的工作簿没有留下半完成课程。
  const snapshotBeforeRejectedWorkbook = readBusinessSnapshot();
  const tooManyRows = [...boundaryRows, {
    Mod: "AUTO_OVERFLOW_MARKER",
    Catalog: "Must never import",
    Lecturer: "AUTO OVERFLOW TEACHER",
    "Staff Type": "PT",
    "# of grps teaching": 1,
  }];
  const overLimit = await uploadWorkbook(
    workbookBuffer([["Teaching Members", teachingRowsWorksheet(tooManyRows)]]),
    "over-5000.xlsx",
    400,
  );
  assert.match(overLimit.body.error, /5,000 rows or fewer/);
  assert.deepEqual(readBusinessSnapshot(), snapshotBeforeRejectedWorkbook);

  // 稀疏文件只在第 5,003 个物理行出现尾部资料。sheet_to_json 本身可能只返回
  // 第一条资料，所以必须依靠 !fullref 判断原工作表已被解析上限截断。
  const sparseSheet = XLSX.utils.aoa_to_sheet([
    ["Mod", "Catalog", "Lecturer", "Staff Type", "# of grps teaching"],
    ["AUTO_SPARSE_HEAD", "", "AUTO SPARSE", "FT", 1],
  ]);
  XLSX.utils.sheet_add_aoa(sparseSheet, [["AUTO_SPARSE_TAIL", "", "AUTO SPARSE", "FT", 1]], { origin: "A5003" });
  const snapshotBeforeSparseWorkbook = readBusinessSnapshot();
  const sparseResult = await uploadWorkbook(
    workbookBuffer([["Teaching Members", sparseSheet]]),
    "sparse-tail.xlsx",
    400,
  );
  assert.match(sparseResult.body.error, /5,000 rows or fewer/);
  assert.deepEqual(readBusinessSnapshot(), snapshotBeforeSparseWorkbook);

  // 扩展名正确但内容损坏的工作簿、损坏 multipart 都要得到受控 JSON 400；
  // 超过 20 MB 一字节的文件要在进入 Excel 解析器前得到 413。
  const snapshotBeforeTransportErrors = readBusinessSnapshot();
  const damagedWorkbook = await uploadWorkbook(
    // PK 开头会进入 XLSX ZIP 读取路径，但截断内容必定触发受控解析异常；普通文字
    // 可能被 SheetJS 当成合法 CSV，因此不能稳定覆盖这个分支。
    Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02, 0x03]),
    "damaged-workbook.xlsx",
    400,
  );
  assert.match(damagedWorkbook.body.error, /file could not be read/i);
  assert(!/sheetjs|zip|xml|stack|xlsx\.read/i.test(JSON.stringify(damagedWorkbook.body)));
  const malformed = await requestApi("/api/imports/teaching-members", {
    method: "POST",
    headers: { "Content-Type": "multipart/form-data" },
    body: "broken",
    expectedStatus: 400,
  });
  assert.match(malformed.body.error, /upload request could not be read/i);
  const oversizedForm = new FormData();
  oversizedForm.append("file", new Blob([new Uint8Array(maximumWorkbookBytes + 1)]), "oversized.xlsx");
  const oversized = await requestApi("/api/imports/teaching-members", {
    method: "POST",
    body: oversizedForm,
    expectedStatus: 413,
  });
  assert.match(oversized.body.error, /20 MB or smaller/);
  assert.deepEqual(readBusinessSnapshot(), snapshotBeforeTransportErrors);

  // 原型字段烟测确认应用路径不会修改 Object.prototype。它是纵深回归，
  // 已知漏洞的正式版本保证仍来自前面的 0.20.3 精确断言。
  const prototypeSheet = XLSX.utils.aoa_to_sheet([
    ["Mod", "Catalog", "Lecturer", "Staff Type", "# of grps teaching", "__proto__", "constructor", "prototype"],
    ["AUTO_PROTOTYPE", "", "AUTO SAFE", "FT", 1, "polluted", "safe", "safe"],
  ]);
  const prototypeRow = parseTeachingMembersWorksheet(
    workbookBuffer([["Teaching Members", prototypeSheet]]),
  ).sheetRows[0];
  assert.equal(Object.getPrototypeOf(prototypeRow), Object.prototype);
  assert.equal(Object.prototype.polluted, undefined);
  report("Excel 版本、目标表隔离、行数、multipart、文件大小和原型烟测");
}

async function verifyTeachingAllocationReimport() {
  // 单独建立两班的导入课程。后面的重导会依次验证稳定 ID、手工覆盖、缩减保护、
  // Inactive 教师继承和已排课程保护，避免这些关系只存在于一次性手工验收日志。
  const allocationRows = [{
    Mod: "AUTO_REIMPORT",
    Catalog: "Re-import relationships",
    Lecturer: "AUTO ALLOCATION TEACHER",
    "Staff Type": "FT",
    "# of grps teaching": 2,
  }];
  const allocationWorkbook = workbookBuffer([["Teaching Members", teachingRowsWorksheet(allocationRows)]]);
  await uploadWorkbook(allocationWorkbook, "reimport-baseline.xlsx", 200);

  const importedCourse = (await requestApi("/api/courses")).body.find((course) => course.code === "AUTO_REIMPORT");
  const allocationTeacher = (await requestApi("/api/teachers")).body.find((teacher) => teacher.name === "AUTO ALLOCATION TEACHER");
  assert(importedCourse && allocationTeacher, "The re-import fixture course or teacher was not created.");
  const initialSections = (await requestApi(`/api/courses/${importedCourse.id}/sections`)).body;
  assert.equal(initialSections.length, 2);

  // 第二班改为人工教师并加入学生班级；这会清除其 Excel 来源标记。相同工作簿重导
  // 必须保留两个 section ID、revision 和这份人工分配，不能按 Excel 覆盖回来。
  const manualTeacher = (await requestApi("/api/teachers", {
    method: "POST",
    expectedStatus: 201,
    json: { name: "auto manual teacher", staffType: "PT" },
  })).body;
  const manualGroup = (await requestApi("/api/student-groups", {
    method: "POST",
    expectedStatus: 201,
    json: { code: "auto_reimport_01", year: 1, program: "auto" },
  })).body;
  const manuallyMaintainedSection = (await requestApi(`/api/course-sections/${initialSections[1].id}`, {
    method: "PATCH",
    json: { teacherId: manualTeacher.id, studentGroupIds: [manualGroup.id], revision: initialSections[1].revision },
  })).body;
  await uploadWorkbook(allocationWorkbook, "reimport-same.xlsx", 200);
  const stableCourse = (await requestApi("/api/courses")).body.find((course) => course.code === "AUTO_REIMPORT");
  const stableSections = (await requestApi(`/api/courses/${importedCourse.id}/sections`)).body;
  assert.equal(stableCourse.id, importedCourse.id);
  assert.deepEqual(stableSections.map((section) => section.id), initialSections.map((section) => section.id));
  assert.equal(stableSections[0].revision, initialSections[0].revision);
  assert.equal(stableSections[1].revision, manuallyMaintainedSection.revision);
  assert.equal(stableSections[1].teacherId, manualTeacher.id);
  assert.deepEqual(stableSections[1].studentGroupIds, [manualGroup.id]);

  // Excel 尝试从两班缩成一班时，人工维护的第二班必须让整次导入返回 409。
  // 完整业务表快照证明先删除／重建的 allocation 和其他前序写入也全部回滚。
  const shrinkWorkbook = workbookBuffer([["Teaching Members", teachingRowsWorksheet([{ ...allocationRows[0], "# of grps teaching": 1 }])]]);
  const snapshotBeforeProtectedShrink = readBusinessSnapshot();
  const protectedShrink = await uploadWorkbook(shrinkWorkbook, "reimport-protected-shrink.xlsx", 409);
  assert.match(protectedShrink.body.error, /manually maintained teacher or student group/i);
  assert.deepEqual(readBusinessSnapshot(), snapshotBeforeProtectedShrink);

  // 停用 Excel 原教师后，原第一班仍可 grandfather 并保持相同 ID/revision；但把数量
  // 增加到三班会建立新分配，因此必须 409 且整次回滚。
  await requestApi(`/api/teachers/${allocationTeacher.id}`, { method: "PATCH", json: { isActive: false } });
  await uploadWorkbook(allocationWorkbook, "reimport-inactive-grandfather.xlsx", 200);
  const inactiveTeacherAfterImport = (await requestApi("/api/teachers")).body.find((teacher) => teacher.id === allocationTeacher.id);
  const sectionsAfterInactiveGrandfather = (await requestApi(`/api/courses/${importedCourse.id}/sections`)).body;
  assert.equal(inactiveTeacherAfterImport.status, "Inactive");
  assert.equal(sectionsAfterInactiveGrandfather[0].id, initialSections[0].id);
  assert.equal(sectionsAfterInactiveGrandfather[0].revision, initialSections[0].revision);
  assert.equal(sectionsAfterInactiveGrandfather[0].teacherId, allocationTeacher.id);
  const growWorkbook = workbookBuffer([["Teaching Members", teachingRowsWorksheet([{ ...allocationRows[0], "# of grps teaching": 3 }])]]);
  const snapshotBeforeInactiveGrowth = readBusinessSnapshot();
  const inactiveGrowth = await uploadWorkbook(growWorkbook, "reimport-inactive-growth.xlsx", 409);
  assert.match(inactiveGrowth.body.error, /inactive/i);
  assert.deepEqual(readBusinessSnapshot(), snapshotBeforeInactiveGrowth);

  // 一旦其中一个班次进入总表，同课程任何 Teaching allocation 重导都必须停止；
  // 课程配置、排课和导入全部走正式 API，并以完整快照确认 409 后零变化。
  await requestApi(`/api/courses/${importedCourse.id}`, {
    method: "PATCH",
    json: {
      durationHours: 2,
      sessionsPerWeek: 1,
      primaryYear: 1,
      minimumRoomCapacity: null,
      requiresLab: false,
      requiresMultiProjector: false,
      requiresSmartClassroom: false,
      separateSectionsAcrossDays: false,
      weekStart: null,
      weekEnd: null,
    },
  });
  await requestApi("/api/schedule/lessons", {
    method: "POST",
    expectedStatus: 201,
    json: { sectionId: initialSections[0].id, occurrence: 1, dayOfWeek: 1, startHour: 8, roomId: null },
  });
  const snapshotBeforeScheduledReimport = readBusinessSnapshot();
  // 冲突工作簿同时尝试修改已排课程目录，并新增另一门未排课程及教师；如果事务
  // 边界退化为“先提交前序写入再检查排课”，完整快照一定会观察到这些变化。
  const scheduledConflictWorkbook = workbookBuffer([["Teaching Members", teachingRowsWorksheet([
    { ...allocationRows[0], Catalog: "MUST ROLLBACK SCHEDULED CHANGE" },
    {
      Mod: "AUTO_REIMPORT_COMPANION",
      Catalog: "MUST NEVER COMMIT",
      Lecturer: "AUTO COMPANION TEACHER",
      "Staff Type": "PT",
      "# of grps teaching": 1,
    },
  ])]]);
  const scheduledReimport = await uploadWorkbook(scheduledConflictWorkbook, "reimport-scheduled-course.xlsx", 409);
  assert.match(scheduledReimport.body.error, /has been scheduled/i);
  assert.deepEqual(readBusinessSnapshot(), snapshotBeforeScheduledReimport);
  report("Teaching allocation 稳定 ID、手工分配、缩减、停用教师和已排课程重导保护");
}

async function verifyCrudAndRevisions() {
  // 教师新增会统一大写，重复姓名由唯一键转换成 409；两个稳定 ID 将用于
  // 后面的班次 revision 和排课共享分配测试。
  const teacherA = (await requestApi("/api/teachers", {
    method: "POST",
    expectedStatus: 201,
    json: { name: "auto teacher a", staffType: "FT" },
  })).body;
  const teacherB = (await requestApi("/api/teachers", {
    method: "POST",
    expectedStatus: 201,
    json: { name: "auto teacher b", staffType: "PT" },
  })).body;
  assert.equal(teacherA.name, "AUTO TEACHER A");
  await requestApi("/api/teachers", {
    method: "POST",
    expectedStatus: 409,
    json: { name: "AUTO TEACHER A", staffType: "FT" },
  });

  // 学生班级、教室与课程都先以最小资料建立，再通过 PATCH 验证稳定 ID
  // 和标准化后的关联会继续被排课记录读取。
  const studentGroup = (await requestApi("/api/student-groups", {
    method: "POST",
    expectedStatus: 201,
    json: { code: "aaa_2", year: 2, program: "aaa" },
  })).body;
  assert.equal(studentGroup.code, "AAA_2");
  await requestApi("/api/student-groups", {
    method: "POST",
    expectedStatus: 409,
    json: { code: "AAA_2", year: 2, program: "AAA" },
  });
  const room = (await requestApi("/api/rooms", {
    method: "POST",
    expectedStatus: 201,
    json: { code: "31-05-10", capacity: 20, hasLab: false, hasMultiProjector: false, isSmartClassroom: true },
  })).body;
  assert(room.features.includes("Multi projector"), "Smart classroom did not imply multi projector.");
  await requestApi("/api/rooms", {
    method: "POST",
    expectedStatus: 409,
    json: { code: "31-05-10", capacity: 20, hasLab: false, hasMultiProjector: false, isSmartClassroom: false },
  });
  const course = (await requestApi("/api/courses", {
    method: "POST",
    expectedStatus: 201,
    json: { code: "auto_crud", catalog: "CRUD regression", sectionCount: 2 },
  })).body;
  assert.equal(course.code, "AUTO_CRUD");
  await requestApi("/api/courses", {
    method: "POST",
    expectedStatus: 409,
    json: { code: "AUTO_CRUD", catalog: "Duplicate", sectionCount: 1 },
  });

  // 课程必须配置时长、每周课次和主要年级后才能进入排课流程。
  await requestApi(`/api/courses/${course.id}`, {
    method: "PATCH",
    json: {
      durationHours: 3,
      sessionsPerWeek: 2,
      primaryYear: 1,
      minimumRoomCapacity: 20,
      requiresLab: false,
      requiresMultiProjector: false,
      requiresSmartClassroom: false,
      separateSectionsAcrossDays: true,
      weekStart: null,
      weekEnd: null,
    },
  });
  let sections = (await requestApi(`/api/courses/${course.id}/sections`)).body;
  assert.equal(sections.length, 2);

  // 新班次 revision 为 1。第一位老师保存得到 revision 2；随后模拟另一位老师
  // 用同一个旧 revision 保存，必须得到 409且不能覆盖最新教师。
  const section = sections[0];
  const firstAssignment = await requestApi(`/api/course-sections/${section.id}`, {
    method: "PATCH",
    json: { teacherId: teacherA.id, studentGroupIds: [studentGroup.id], revision: section.revision },
  });
  assert.equal(firstAssignment.body.revision, 2);

  // 无效教师或学生班级必须在事务内被拒绝，且不能消耗当前 revision。
  await requestApi(`/api/course-sections/${section.id}`, {
    method: "PATCH",
    expectedStatus: 400,
    json: { teacherId: randomUUID(), studentGroupIds: [studentGroup.id], revision: firstAssignment.body.revision },
  });
  await requestApi(`/api/course-sections/${section.id}`, {
    method: "PATCH",
    expectedStatus: 400,
    json: { teacherId: teacherA.id, studentGroupIds: [randomUUID()], revision: firstAssignment.body.revision },
  });
  let sectionAfterRejectedAssignments = (await requestApi(`/api/courses/${course.id}/sections`)).body[0];
  assert.equal(sectionAfterRejectedAssignments.teacherId, teacherA.id);
  assert.deepEqual(sectionAfterRejectedAssignments.studentGroupIds, [studentGroup.id]);
  assert.equal(sectionAfterRejectedAssignments.revision, firstAssignment.body.revision);

  const winningAssignment = await requestApi(`/api/course-sections/${section.id}`, {
    method: "PATCH",
    json: { teacherId: teacherB.id, studentGroupIds: [studentGroup.id], revision: firstAssignment.body.revision },
  });
  assert.equal(winningAssignment.body.revision, 3);
  await requestApi(`/api/course-sections/${section.id}`, {
    method: "PATCH",
    expectedStatus: 409,
    json: { teacherId: teacherA.id, studentGroupIds: [], revision: firstAssignment.body.revision },
  });
  sections = (await requestApi(`/api/courses/${course.id}/sections`)).body;
  assert.equal(sections[0].teacherId, teacherB.id);
  assert.deepEqual(sections[0].studentGroupIds, [studentGroup.id]);
  assert.equal(sections[0].revision, winningAssignment.body.revision);

  // 班次数量增加后会建立新尾部班次；未分配、未排课的尾部班次可以安全删除，
  // 低编号班次 ID、教师和学生班级必须保持不变。
  await requestApi(`/api/courses/${course.id}/sections`, { method: "PATCH", json: { sectionCount: 3 } });
  const grownSections = (await requestApi(`/api/courses/${course.id}/sections`)).body;
  assert.equal(grownSections.length, 3);
  const tailSection = grownSections[2];
  const protectedTail = await requestApi(`/api/course-sections/${tailSection.id}`, {
    method: "PATCH",
    json: { teacherId: teacherA.id, studentGroupIds: [], revision: tailSection.revision },
  });
  const protectedResize = await requestApi(`/api/courses/${course.id}/sections`, {
    method: "PATCH",
    expectedStatus: 409,
    json: { sectionCount: 2 },
  });
  assert.match(protectedResize.body.error, /has a teacher/i);
  const sectionsAfterProtectedResize = (await requestApi(`/api/courses/${course.id}/sections`)).body;
  assert.equal(sectionsAfterProtectedResize.length, 3);
  assert.equal(sectionsAfterProtectedResize[2].id, tailSection.id);
  assert.equal(sectionsAfterProtectedResize[2].teacherId, teacherA.id);
  assert.equal(sectionsAfterProtectedResize[2].revision, protectedTail.body.revision);
  await requestApi(`/api/course-sections/${tailSection.id}`, {
    method: "PATCH",
    json: { teacherId: null, studentGroupIds: [], revision: protectedTail.body.revision },
  });
  await requestApi(`/api/courses/${course.id}/sections`, { method: "PATCH", json: { sectionCount: 2 } });
  sections = (await requestApi(`/api/courses/${course.id}/sections`)).body;
  assert.equal(sections.length, 2);
  assert.equal(sections[0].id, section.id);
  const secondSection = sections[1];

  // 同一每周课次首次放置只能成功一次；重复请求要返回稳定业务 code，
  // 不能泄露 SQLite UNIQUE 约束文字。
  const lessonOne = (await requestApi("/api/schedule/lessons", {
    method: "POST",
    expectedStatus: 201,
    json: { sectionId: section.id, occurrence: 1, dayOfWeek: 1, startHour: 9, roomId: room.id },
  })).body;
  const duplicatePlacement = await requestApi("/api/schedule/lessons", {
    method: "POST",
    expectedStatus: 409,
    json: { sectionId: section.id, occurrence: 1, dayOfWeek: 2, startHour: 10, roomId: room.id },
  });
  assert.equal(duplicatePlacement.body.code, "LESSON_ALREADY_SCHEDULED");
  assert(!/sqlite|unique|constraint/i.test(JSON.stringify(duplicatePlacement.body)));
  const lessonTwo = (await requestApi("/api/schedule/lessons", {
    method: "POST",
    expectedStatus: 201,
    json: { sectionId: section.id, occurrence: 2, dayOfWeek: 3, startHour: 13, roomId: room.id },
  })).body;

  // 编辑 occurrence 1 时同时把共享教师改回 A。当前课次和 occurrence 2 的
  // revision 都会失效；旧 revision 的 PATCH 与 DELETE 必须分别返回 409。
  const movedLesson = (await requestApi(`/api/schedule/lessons/${lessonOne.id}`, {
    method: "PATCH",
    json: {
      dayOfWeek: 2,
      startHour: 10,
      roomId: room.id,
      teacherId: teacherA.id,
      studentGroupIds: [studentGroup.id],
      revision: lessonOne.revision,
    },
  })).body;
  assert.equal(movedLesson.revision, lessonOne.revision + 1);
  await requestApi(`/api/schedule/lessons/${lessonOne.id}`, {
    method: "PATCH",
    expectedStatus: 409,
    json: {
      dayOfWeek: 4,
      startHour: 8,
      roomId: room.id,
      teacherId: teacherB.id,
      studentGroupIds: [],
      revision: lessonOne.revision,
    },
  });
  await requestApi(`/api/schedule/lessons/${lessonTwo.id}?revision=${lessonTwo.revision}`, {
    method: "DELETE",
    expectedStatus: 409,
  });

  // 不存在的教室与新改派的停用教室都必须在写入前被拒绝；两次失败不能改变
  // 原教室、时间或 revision，也不能把 SQLite 外键文字发送到浏览器。
  const inactiveRoom = (await requestApi("/api/rooms", {
    method: "POST",
    expectedStatus: 201,
    json: { code: "33-07-30", capacity: 40, hasLab: false, hasMultiProjector: false, isSmartClassroom: false },
  })).body;
  await requestApi(`/api/rooms/${inactiveRoom.id}`, { method: "PATCH", json: { isActive: false } });
  const missingRoom = await requestApi(`/api/schedule/lessons/${lessonOne.id}`, {
    method: "PATCH",
    expectedStatus: 400,
    json: { dayOfWeek: 4, startHour: 8, roomId: randomUUID(), teacherId: teacherA.id, studentGroupIds: [studentGroup.id], revision: movedLesson.revision },
  });
  assert.match(missingRoom.body.error, /valid room/i);
  assert(!/foreign key|sqlite|constraint/i.test(JSON.stringify(missingRoom.body)));
  const inactiveRoomResult = await requestApi(`/api/schedule/lessons/${lessonOne.id}`, {
    method: "PATCH",
    expectedStatus: 400,
    json: { dayOfWeek: 2, startHour: 10, roomId: inactiveRoom.id, teacherId: teacherA.id, studentGroupIds: [studentGroup.id], revision: movedLesson.revision },
  });
  assert.match(inactiveRoomResult.body.error, /active room/i);
  const lessonAfterRejectedRooms = (await requestApi("/api/schedule/lessons?year=1")).body.find((lesson) => lesson.id === lessonOne.id);
  assert.equal(lessonAfterRejectedRooms.dayOfWeek, movedLesson.dayOfWeek);
  assert.equal(lessonAfterRejectedRooms.startHour, movedLesson.startHour);
  assert.equal(lessonAfterRejectedRooms.roomId, room.id);
  assert.equal(lessonAfterRejectedRooms.revision, movedLesson.revision);

  // 基础资料改名仍保留 ID；时间表必须立即读取新教师、班级和教室名称。
  await requestApi(`/api/teachers/${teacherA.id}`, {
    method: "PATCH",
    json: { name: "auto teacher renamed", staffType: "PT" },
  });
  await requestApi(`/api/student-groups/${studentGroup.id}`, {
    method: "PATCH",
    json: { code: "aaa_02", year: 1, program: "aaa" },
  });
  await requestApi(`/api/rooms/${room.id}`, {
    method: "PATCH",
    json: { code: "32-06-20", capacity: 50, hasLab: true, hasMultiProjector: true, isSmartClassroom: false },
  });
  let timetable = (await requestApi("/api/schedule/lessons?year=1")).body;
  let currentLessonOne = timetable.find((lesson) => lesson.id === lessonOne.id);
  assert.equal(currentLessonOne.teacherName, "AUTO TEACHER RENAMED");
  assert.deepEqual(currentLessonOne.studentGroups, ["AAA_02"]);
  assert.equal(currentLessonOne.roomCode, "32-06-20");

  // 停用教师和教室不能清空既有引用；warning 必须出现，重新启用后精确消失。
  await requestApi(`/api/teachers/${teacherA.id}`, { method: "PATCH", json: { isActive: false } });
  timetable = (await requestApi("/api/schedule/lessons?year=1")).body;
  assert(timetable.find((lesson) => lesson.id === lessonOne.id).warnings.includes("Teacher is inactive"));
  await requestApi(`/api/teachers/${teacherA.id}`, { method: "PATCH", json: { isActive: true } });
  await requestApi(`/api/rooms/${room.id}`, { method: "PATCH", json: { isActive: false } });
  timetable = (await requestApi("/api/schedule/lessons?year=1")).body;
  currentLessonOne = timetable.find((lesson) => lesson.id === lessonOne.id);
  assert(currentLessonOne.warnings.includes("Room is unavailable"));

  // 原本已经引用的教室停用后，老师只改时间仍可保留该教室并继续看到严重警告；
  // 这证明 grandfather 只保护既有引用，不会把 Inactive 教室开放给新分配。
  const movedWithInactiveRoom = (await requestApi(`/api/schedule/lessons/${lessonOne.id}`, {
    method: "PATCH",
    json: { dayOfWeek: 2, startHour: 11, roomId: room.id, teacherId: teacherA.id, studentGroupIds: [studentGroup.id], revision: currentLessonOne.revision },
  })).body;
  assert.equal(movedWithInactiveRoom.roomId, room.id);
  assert.equal(movedWithInactiveRoom.roomCode, "32-06-20");
  assert.equal(movedWithInactiveRoom.startHour, 11);
  assert(movedWithInactiveRoom.warnings.includes("Room is unavailable"));
  await requestApi(`/api/rooms/${room.id}`, { method: "PATCH", json: { isActive: true } });
  timetable = (await requestApi("/api/schedule/lessons?year=1")).body;
  currentLessonOne = timetable.find((lesson) => lesson.id === lessonOne.id);
  assert(!currentLessonOne.warnings.includes("Teacher is inactive"));
  assert(!currentLessonOne.warnings.includes("Room is unavailable"));

  // 已有排课课程不能清空主要年级，否则会从三张年级总表消失。
  const missingYear = await requestApi(`/api/courses/${course.id}`, {
    method: "PATCH",
    expectedStatus: 409,
    json: {
      durationHours: 3,
      sessionsPerWeek: 2,
      primaryYear: null,
      minimumRoomCapacity: 20,
      requiresLab: false,
      requiresMultiProjector: false,
      requiresSmartClassroom: false,
      separateSectionsAcrossDays: true,
      weekStart: null,
      weekEnd: null,
    },
  });
  assert.match(missingYear.body.error, /primary year/i);

  // occurrence 2 的最新 revision 从重新读取的总表取得；正确 revision 删除后，
  // occurrence 1 和课程班次仍必须保留。
  const currentLessonTwo = timetable.find((lesson) => lesson.id === lessonTwo.id);

  // 人为让删除后的 warning 重算失败：接口应返回通用 500，而且 DELETE 必须随事务
  // 一起回滚。移除 trigger 后用同一 revision 才能真正退回待排区。
  executeTestDatabase((db) => {
    const lessonIdLiteral = db.prepare("SELECT quote(?) AS value").get(lessonOne.id).value;
    db.exec(`CREATE TRIGGER zz_fail_lesson_removal_warning BEFORE UPDATE OF warnings_json ON scheduled_lessons WHEN NEW.id = ${lessonIdLiteral} BEGIN SELECT RAISE(ABORT, 'forced lesson removal warning failure'); END;`);
  });
  const failedRemoval = await requestApi(`/api/schedule/lessons/${lessonTwo.id}?revision=${currentLessonTwo.revision}`, {
    method: "DELETE",
    expectedStatus: 500,
  });
  assert(!/forced|sqlite|trigger|constraint/i.test(JSON.stringify(failedRemoval.body)));
  const timetableAfterFailedRemoval = (await requestApi("/api/schedule/lessons?year=1")).body;
  const lessonTwoAfterFailedRemoval = timetableAfterFailedRemoval.find((lesson) => lesson.id === lessonTwo.id);
  assert.equal(lessonTwoAfterFailedRemoval.dayOfWeek, currentLessonTwo.dayOfWeek);
  assert.equal(lessonTwoAfterFailedRemoval.startHour, currentLessonTwo.startHour);
  assert.equal(lessonTwoAfterFailedRemoval.roomId, currentLessonTwo.roomId);
  assert.equal(lessonTwoAfterFailedRemoval.revision, currentLessonTwo.revision);
  executeTestDatabase((db) => db.exec("DROP TRIGGER zz_fail_lesson_removal_warning"));
  await requestApi(`/api/schedule/lessons/${lessonTwo.id}?revision=${currentLessonTwo.revision}`, { method: "DELETE" });
  timetable = (await requestApi("/api/schedule/lessons?year=1")).body;
  assert(timetable.some((lesson) => lesson.id === lessonOne.id));
  assert(!timetable.some((lesson) => lesson.id === lessonTwo.id));

  // 两个 HTTP 请求同时首次放置 Section 2，只能恰好一个成功；赢家退回待排区后，
  // 未分配的第二班次才允许从课程数量中安全删除。
  const concurrentPlacements = await Promise.all([
    requestApi("/api/schedule/lessons", {
      method: "POST",
      expectedStatus: [201, 409],
      json: { sectionId: secondSection.id, occurrence: 1, dayOfWeek: 4, startHour: 14, roomId: room.id },
    }),
    requestApi("/api/schedule/lessons", {
      method: "POST",
      expectedStatus: [201, 409],
      json: { sectionId: secondSection.id, occurrence: 1, dayOfWeek: 5, startHour: 15, roomId: room.id },
    }),
  ]);
  assert.deepEqual(concurrentPlacements.map((result) => result.response.status).sort(), [201, 409]);
  const concurrentWinner = concurrentPlacements.find((result) => result.response.status === 201).body;
  const concurrentLoser = concurrentPlacements.find((result) => result.response.status === 409).body;
  assert.equal(concurrentLoser.code, "LESSON_ALREADY_SCHEDULED");
  assert(!/sqlite|unique|constraint/i.test(JSON.stringify(concurrentLoser)));
  const concurrentTimetable = (await requestApi("/api/schedule/lessons?year=1")).body;
  const concurrentRows = concurrentTimetable.filter((lesson) => lesson.sectionId === secondSection.id && lesson.occurrence === 1);
  assert.equal(concurrentRows.length, 1);
  assert.equal(concurrentRows[0].id, concurrentWinner.id);
  await requestApi(`/api/courses/${course.id}/sections`, {
    method: "PATCH",
    expectedStatus: 409,
    json: { sectionCount: 1 },
  });
  await requestApi(`/api/schedule/lessons/${concurrentWinner.id}?revision=${concurrentWinner.revision}`, { method: "DELETE" });
  const unscheduled = (await requestApi("/api/schedule/unscheduled?year=1")).body;
  assert(unscheduled.some((item) => item.id === `${secondSection.id}:1`));
  await requestApi(`/api/courses/${course.id}/sections`, { method: "PATCH", json: { sectionCount: 1 } });
  assert.equal((await requestApi(`/api/courses/${course.id}/sections`)).body.length, 1);
  report("教师、班级、教室、课程、班次、排课和多人 revision CRUD");

  // 返回外键阶段需要的稳定 ID；服务器停止后会直接检查 SQLite 的级联语义。
  return {
    teacherId: teacherA.id,
    studentGroupId: studentGroup.id,
    roomId: room.id,
    courseId: course.id,
    sectionId: section.id,
    lessonId: lessonOne.id,
  };
}

async function verifyAtomicMasterDataWarnings(ids) {
  // 先正常建立一条年级不可用时段。稍后故意让删除后的 warning 重算失败，
  // 便能确认 DELETE 不是先提交、再在重算时才报告一个误导性的失败。
  const yearWindow = (await requestApi("/api/unavailability", {
    method: "POST",
    expectedStatus: 201,
    // 现有课程位于 Year 1、Tuesday 11:00–14:00；这个时段会真实改变该课 warning，
    // 因此未来即使刷新逻辑改成增量计算，本测试仍会触发目标 lesson 的更新。
    json: { kind: "Year", ownerId: "1", dayOfWeek: 2, startHour: 10, endHour: 12 },
  })).body;
  assert.equal(typeof yearWindow.id, "string");

  const rules = (await requestApi("/api/rule-settings")).body;
  const lunchBreakRule = rules.find((rule) => rule.key === "lunch_break");
  assert(lunchBreakRule, "The lunch_break rule fixture was not found.");

  // 每条失败请求都使用完整业务快照验证“零变化”，并检查浏览器响应只包含安全业务文字。
  // 若未来有人把事务拆开，这些断言会直接看到编号、状态、时段或 warning 的半完成写入。
  async function expectAtomicFailure(pathname, expectedError, options) {
    const before = readBusinessSnapshot();
    const failed = await requestApi(pathname, { ...options, expectedStatus: 500 });
    // 完整对象相等既锁定业务分类，也禁止未来意外追加 SQL、error code、query、stack 或路径字段。
    assert.deepEqual(failed.body, { error: expectedError });
    assert(
      !/forced|sqlite|database|trigger|constraint|scheduled_lessons|warnings_json|update |insert |delete |table|column|stack/i.test(JSON.stringify(failed.body)),
      `${options.method} ${pathname} leaked database implementation details.`,
    );
    assert.deepEqual(readBusinessSnapshot(), before, `${options.method} ${pathname} left a partial business write.`);
  }

  // Trigger 只作用于本次隔离库的一节课；每次 refreshAllScheduleWarnings 更新该课时
  // 都会抛错。六个 API 必须把主资料更新与全部 warning 一起回滚。
  executeTestDatabase((db) => {
    const lessonIdLiteral = db.prepare("SELECT quote(?) AS value").get(ids.lessonId).value;
    db.exec(`CREATE TRIGGER zz_fail_master_warning_refresh BEFORE UPDATE OF warnings_json ON scheduled_lessons WHEN NEW.id = ${lessonIdLiteral} BEGIN SELECT RAISE(ABORT, 'forced master warning refresh failure'); END;`);
  });
  try {
    await expectAtomicFailure(`/api/student-groups/${ids.studentGroupId}`, "The student group could not be updated. Try again.", {
      method: "PATCH",
      json: { code: "AAA_ATOMIC_FAIL", year: 3, program: "ATOMIC" },
    });
    await expectAtomicFailure(`/api/rooms/${ids.roomId}`, "The room could not be updated. Try again.", {
      method: "PATCH",
      json: { code: "34-08-40", capacity: 60, hasLab: false, hasMultiProjector: false, isSmartClassroom: false },
    });
    await expectAtomicFailure(`/api/rooms/${ids.roomId}`, "The room status could not be updated. Try again.", {
      method: "PATCH",
      json: { isActive: false },
    });
    await expectAtomicFailure("/api/rule-settings", "The rule setting could not be updated. Try again.", {
      method: "PATCH",
      json: { key: lunchBreakRule.key, enabled: !lunchBreakRule.enabled },
    });
    await expectAtomicFailure("/api/unavailability", "The unavailable window could not be saved. Try again.", {
      method: "POST",
      json: { kind: "Teacher", ownerId: ids.teacherId, dayOfWeek: 2, startHour: 10, endHour: 12 },
    });
    await expectAtomicFailure(`/api/unavailability?id=${yearWindow.id}&kind=Year`, "The unavailable window could not be removed. Try again.", {
      method: "DELETE",
    });
  } finally {
    // 即使中间断言失败也删除故障 trigger，避免后续清理请求被测试夹具继续阻挡。
    executeTestDatabase((db) => db.exec("DROP TRIGGER IF EXISTS zz_fail_master_warning_refresh"));
  }

  // Trigger 移除后，规则可以正常切换并恢复原值，预建时段也能正常删除；
  // 这证明前面的 500 来自故障注入，而不是接口本身永久不可用。
  await requestApi("/api/rule-settings", {
    method: "PATCH",
    json: { key: lunchBreakRule.key, enabled: !lunchBreakRule.enabled },
  });
  await requestApi("/api/rule-settings", {
    method: "PATCH",
    json: { key: lunchBreakRule.key, enabled: lunchBreakRule.enabled },
  });
  await requestApi(`/api/unavailability?id=${yearWindow.id}&kind=Year`, { method: "DELETE" });

  // 不存在的教师是可修正输入错误，应得到安全 400，并且不能建立悬空不可用时段。
  const beforeInvalidOwner = readBusinessSnapshot();
  const invalidOwner = await requestApi("/api/unavailability", {
    method: "POST",
    expectedStatus: 400,
    json: { kind: "Teacher", ownerId: randomUUID(), dayOfWeek: 1, startHour: 8, endHour: 9 },
  });
  assert.match(invalidOwner.body.error, /valid teacher/i);
  assert.deepEqual(readBusinessSnapshot(), beforeInvalidOwner);

  // 新增接口也不能把任意 trigger 故障误报成“编号重复”。分别注入非 UNIQUE
  // 约束错误，确认返回通用 500、隐藏表结构，且没有插入半条基础资料。
  executeTestDatabase((db) => db.exec(`
    CREATE TRIGGER zz_fail_student_group_creation BEFORE INSERT ON student_groups
    WHEN NEW.code = 'ATOMIC_CREATE_FAIL' BEGIN SELECT RAISE(ABORT, 'forced student group creation failure'); END;
    CREATE TRIGGER zz_fail_room_creation BEFORE INSERT ON rooms
    WHEN NEW.code = '39-09-90' BEGIN SELECT RAISE(ABORT, 'forced room creation failure'); END;
  `));
  try {
    await expectAtomicFailure("/api/student-groups", "The student group could not be created. Try again.", {
      method: "POST",
      json: { code: "ATOMIC_CREATE_FAIL", year: 1, program: "ATOMIC" },
    });
    await expectAtomicFailure("/api/rooms", "The room could not be created. Try again.", {
      method: "POST",
      json: { code: "39-09-90", capacity: 20, hasLab: false, hasMultiProjector: false, isSmartClassroom: false },
    });
  } finally {
    executeTestDatabase((db) => db.exec(`
      DROP TRIGGER IF EXISTS zz_fail_student_group_creation;
      DROP TRIGGER IF EXISTS zz_fail_room_creation;
    `));
  }

  // 所有 JSON 写入路由都必须把 null 和损坏 JSON 转换成 400 JSON，不能让
  // request.json() 的语法异常穿过 Next.js 形成 HTML 或未受控 500。
  const jsonRoutes = [
    ["/api/student-groups", "POST"],
    [`/api/student-groups/${ids.studentGroupId}`, "PATCH"],
    ["/api/rooms", "POST"],
    [`/api/rooms/${ids.roomId}`, "PATCH"],
    ["/api/rule-settings", "PATCH"],
    ["/api/unavailability", "POST"],
  ];
  for (const [pathname, method] of jsonRoutes) {
    await requestApi(pathname, { method, json: null, expectedStatus: 400 });
    await requestApi(pathname, {
      method,
      headers: { "Content-Type": "application/json" },
      body: "{broken",
      expectedStatus: 400,
    });
  }
  await requestApi("/api/rooms", {
    method: "POST",
    expectedStatus: 400,
    json: { code: "38-08-80", capacity: 20, hasLab: "false", hasMultiProjector: false, isSmartClassroom: false },
  });
  await requestApi(`/api/rooms/${ids.roomId}`, {
    method: "PATCH",
    expectedStatus: 400,
    json: { code: "38-08-81", capacity: 20, hasLab: false, hasMultiProjector: "false", isSmartClassroom: false },
  });
  report("主资料、规则和不可用时段 warning 重算原子回滚及安全 JSON 错误");
}

async function verifyLogout() {
  // 测试结束时删除服务器会话，再使用旧 Cookie 访问业务 API；401 证明注销不仅
  // 清除了浏览器 Cookie 响应，也确实删除了 SQLite 中的会话记录。
  await requestApi("/api/auth/logout", { method: "POST" });
  await requestApi("/api/teachers", { expectedStatus: 401 });
  report("注销会话和旧 Cookie 失效");
}

function verifyForeignKeys(databasePath, ids) {
  // 使用独立连接前明确启用 foreign_keys；SQLite 每条连接默认值可能不同，
  // 不启用就无法真实验证 RESTRICT、SET NULL 和 CASCADE。
  const db = new Database(databasePath);
  db.pragma("foreign_keys = ON");
  try {
    // Teaching allocation 对教师使用 RESTRICT，防止仍承担分配的教师被物理删除。
    db.prepare("INSERT INTO teaching_allocations (id, course_id, teacher_id, assigned_group_count) VALUES (?, ?, ?, ?)")
      .run(randomUUID(), ids.courseId, ids.teacherId, 1);
    assert.throws(
      () => db.prepare("DELETE FROM teachers WHERE id = ?").run(ids.teacherId),
      // SQLite 的 RESTRICT 在不同驱动版本中可能报告 FOREIGNKEY 或 TRIGGER 扩展码；
      // 两者都必须属于稳定的 SQLITE_CONSTRAINT 错误家族。
      (error) => error instanceof Database.SqliteError && /^SQLITE_CONSTRAINT/.test(error.code),
      "A teacher with a teaching allocation was deleted instead of being restricted.",
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM teachers WHERE id = ?").get(ids.teacherId).count, 1);

    // 移除分配后允许删除教师，但课程班次应 SET NULL，而不是跟着消失。
    db.prepare("DELETE FROM teaching_allocations WHERE course_id = ? AND teacher_id = ?").run(ids.courseId, ids.teacherId);
    db.prepare("DELETE FROM teachers WHERE id = ?").run(ids.teacherId);
    assert.equal(db.prepare("SELECT teacher_id FROM course_sections WHERE id = ?").get(ids.sectionId).teacher_id, null);

    // 删除班级只级联删除连接表；课程班次和已排课程仍然存在。
    db.prepare("DELETE FROM student_groups WHERE id = ?").run(ids.studentGroupId);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM section_student_groups WHERE section_id = ?").get(ids.sectionId).count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM scheduled_lessons WHERE id = ?").get(ids.lessonId).count, 1);

    // 删除教室时已排课程保留，room_id 自动变成 NULL；删除课程才会级联清除
    // 它的班次、班级连接和已排课记录。
    db.prepare("DELETE FROM rooms WHERE id = ?").run(ids.roomId);
    assert.equal(db.prepare("SELECT room_id FROM scheduled_lessons WHERE id = ?").get(ids.lessonId).room_id, null);
    db.prepare("DELETE FROM courses WHERE id = ?").run(ids.courseId);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM course_sections WHERE id = ?").get(ids.sectionId).count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM scheduled_lessons WHERE id = ?").get(ids.lessonId).count, 0);

    // 最后用 SQLite 自带检查确认没有悬空外键或文件结构损坏。
    assert.deepEqual(db.pragma("integrity_check"), [{ integrity_check: "ok" }]);
    assert.deepEqual(db.pragma("foreign_key_check"), []);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM auth_sessions").get().count, 0);
    report("SQLite RESTRICT、SET NULL、CASCADE、完整性与外键检查");
  } finally {
    db.close();
  }
}

function cleanupTemporaryTestResources() {
  // 普通 finally、Ctrl-C 和 CI 的 SIGTERM 共用同一个幂等清理 Promise；即使两个路径
  // 几乎同时触发，也只会停止一次服务并删除一次临时目录。
  if (!cleanupPromise) {
    cleanupPromise = (async () => {
      await stopServer();
      if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
    })();
  }
  return cleanupPromise;
}

function installTerminationCleanup() {
  // 开发人员按 Ctrl-C 或 CI 请求终止时，先等待子服务和 SQLite 临时目录清理完成，
  // 再使用标准信号退出码结束；这样不会留下后台 Node 进程或数据库锁。
  for (const [signal, exitCode] of [["SIGINT", 130], ["SIGTERM", 143]]) {
    process.once(signal, () => {
      void cleanupTemporaryTestResources()
        .then(() => process.exit(exitCode))
        .catch((error) => {
          console.error(`Integration cleanup after ${signal} failed:`, error);
          process.exit(exitCode);
        });
    });
  }
}

async function run() {
  // 没有 production build 时立即给出可执行提示，不让开发人员面对难懂的 ENOENT。
  try {
    await access(standaloneServerPath);
  } catch {
    throw new Error("Standalone build is missing. Run `npm run build` before this verification script.");
  }

  // 每次执行都创建全新临时数据库和随机端口，确保测试结果不依赖上一次状态。
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "timetabling-api-crud-"));
  const databasePath = path.join(temporaryDirectory, "integration.db");
  testDatabasePath = databasePath;
  assert.equal(path.dirname(databasePath), temporaryDirectory);
  await startServer(databasePath);
  await verifyAuthentication();
  await verifyWorkbookBoundaries();
  await verifyTeachingAllocationReimport();
  const relationshipIds = await verifyCrudAndRevisions();
  await verifyAtomicMasterDataWarnings(relationshipIds);
  await verifyLogout();

  // 关闭应用连接后再直接验证数据库外键，避免后台请求或连接缓存干扰断言。
  await stopServer();
  verifyForeignKeys(databasePath, relationshipIds);
  console.log("API, CRUD, revision, Excel and SQLite integration verification passed.");
}

installTerminationCleanup();

try {
  await run();
} catch (error) {
  // 失败时打印简洁断言以及服务器最后一段日志，再由非零退出码阻止提交或部署继续。
  console.error("Integration verification failed:", error);
  if (serverOutput.trim()) console.error("Last standalone server output:\n", serverOutput.trim());
  process.exitCode = 1;
} finally {
  // 无论成功、断言失败或网络超时，都停止子进程并删除一次性数据库与工作簿资料。
  await cleanupTemporaryTestResources();
}
