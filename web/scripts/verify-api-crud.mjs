import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import * as XLSX from "xlsx";
import { reconcileLessonDraft } from "../src/lib/lesson-draft-reconciliation.mjs";
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
let administratorSetupToken = "";
let serverOutput = "";
let serverProcessError;
let cleanupPromise;

function report(message) {
  // 每完成一组业务保证就输出一行，方便基础开发人员快速知道失败发生在哪一层。
  console.log(`✓ ${message}`);
}

function verifyLessonDraftReconciliation() {
  // 这组纯函数断言直接保护页面轮询使用的协调规则：远端同 revision 可同步派生资料，
  // 远端改版或删除则必须原样保留当前对象。strictEqual 会在有人复制／替换草稿对象时失败。
  const currentDraft = { id: "lesson-draft", revision: 4, warning: "local draft marker" };
  const sameRevision = { id: "lesson-draft", revision: 4, warning: "latest warning" };
  const changedRevision = { id: "lesson-draft", revision: 5, warning: "another scheduler" };

  const synchronized = reconcileLessonDraft(currentDraft, [sameRevision]);
  assert.equal(synchronized.stale, false);
  assert.strictEqual(synchronized.lesson, sameRevision);

  const changed = reconcileLessonDraft(currentDraft, [changedRevision]);
  assert.equal(changed.stale, true);
  assert.strictEqual(changed.lesson, currentDraft);

  const removed = reconcileLessonDraft(currentDraft, []);
  assert.equal(removed.stale, true);
  assert.strictEqual(removed.lesson, currentDraft);
  assert.deepEqual(reconcileLessonDraft(null, [sameRevision]), { lesson: null, stale: false });
  report("Inspector 轮询保留未保存课程草稿");
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

async function waitForServer(acceptedHealthStatuses = [200]) {
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
      if (acceptedHealthStatuses.includes(response.status)) return;
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

async function startServer(databasePath, {
  acceptedHealthStatuses = [200],
  setupToken = administratorSetupToken,
} = {}) {
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
    for (const name of ["RAILWAY_ENVIRONMENT", "RAILWAY_SERVICE_ID", "RAILWAY_VOLUME_MOUNT_PATH", "TIMETABLING_DATABASE_PATH", "TIMETABLING_SETUP_TOKEN", "PORT", "HOSTNAME"]) {
      delete serverEnvironment[name];
    }
    Object.assign(serverEnvironment, {
      NODE_ENV: "production",
      HOSTNAME: "127.0.0.1",
      PORT: String(port),
      TIMETABLING_DATABASE_PATH: databasePath,
    });
    // setup 完成后的重启回归刻意不提供 token；已有管理员的数据库仍必须健康可用。
    if (setupToken) serverEnvironment.TIMETABLING_SETUP_TOKEN = setupToken;

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
      await waitForServer(acceptedHealthStatuses);
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
    cookie = sessionCookie,
  } = options;
  const requestHeaders = new Headers(headers);
  // 默认使用管理员 Cookie；多人回归可传入普通 scheduler 的独立 Cookie，
  // 仍由同一个请求器验证状态码和 JSON，不需要改写全局管理员会话。
  if (authenticated && cookie) requestHeaders.set("Cookie", cookie);
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
    const readSnapshot = db.transaction(() => ({
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
      scheduleBackups: db.prepare("SELECT * FROM schedule_backups ORDER BY created_at, id").all(),
      appUsers: db.prepare("SELECT * FROM app_users ORDER BY id").all(),
    }));
    // 多表断言也必须来自同一个 SQLite 读快照，否则并发请求可能让测试自身比较混合版本。
    return readSnapshot.deferred();
  } finally {
    db.close();
  }
}

function cyclePayloadFromSnapshot(snapshot) {
  // 紧急备份只允许包含这五组周期资料；共用转换器让测试与数据库 JSON 按同一字段名比较，
  // 不会把教师、教室、账号等应跨周期保留的资料误算进快照。
  return {
    courses: snapshot.courses,
    allocations: snapshot.allocations,
    sections: snapshot.sections,
    sectionGroups: snapshot.sectionGroups,
    lessons: snapshot.lessons,
  };
}

function retainedPayloadFromSnapshot(snapshot) {
  // Start／Restore 之外的基础资料必须逐字段保持；backup 独立比较，因为 Start 会有意替换它。
  return {
    teachers: snapshot.teachers,
    studentGroups: snapshot.studentGroups,
    rooms: snapshot.rooms,
    teacherUnavailableWindows: snapshot.teacherUnavailableWindows,
    yearBlockedWindows: snapshot.yearBlockedWindows,
    ruleSettings: snapshot.ruleSettings,
    appUsers: snapshot.appUsers,
  };
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
  await requestApi("/api/auth/accounts", { authenticated: false, expectedStatus: 401 });
  await requestApi("/api/auth/password", { method: "PATCH", authenticated: false, json: {}, expectedStatus: 401 });
  const initialStatus = await requestApi("/api/auth/status", { authenticated: false });
  assert.equal(initialStatus.body.setupRequired, true);
  assert.equal(initialStatus.body.user, null);

  // 公开 setup／login 必须在 JSON.parse、限流和 Scrypt 之前拒绝超过 64 KiB 的 body。
  // 连续六次超限登录使用同一个正常长度用户名；管理员建立后该用户名的第一次普通
  // 错误密码仍应是 401 而非 429，从而证明超限请求没有污染限流桶。
  const oversizedAuthenticationBody = JSON.stringify({
    username: "bounded-body-user",
    password: "x".repeat(70 * 1024),
    setupToken: administratorSetupToken,
  });
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const oversizedLogin = await requestApi("/api/auth/login", {
      method: "POST",
      authenticated: false,
      expectedStatus: 413,
      headers: { "Content-Type": "application/json" },
      body: oversizedAuthenticationBody,
    });
    assert.deepEqual(oversizedLogin.body, { error: "JSON request is too large." });
  }
  const oversizedSetup = await requestApi("/api/auth/setup", {
    method: "POST",
    authenticated: false,
    expectedStatus: 413,
    headers: { "Content-Type": "application/json" },
    body: oversizedAuthenticationBody,
  });
  assert.deepEqual(oversizedSetup.body, { error: "JSON request is too large." });
  assert.equal(executeTestDatabase((db) => db.prepare("SELECT COUNT(*) AS count FROM app_users").get().count), 0);

  // production 空数据库先拒绝错误 token，而且不能在响应中回显候选值；随后只有部署时
  // 显式传入的随机 token 才能创建第一位管理员。
  const wrongSetupToken = `${administratorSetupToken.slice(0, -1)}x`;
  const unauthorizedSetup = await requestApi("/api/auth/setup", {
    method: "POST",
    authenticated: false,
    expectedStatus: 403,
    json: { username: "attacker-admin", password: "IntegrationTest123!", setupToken: wrongSetupToken },
  });
  assert(!JSON.stringify(unauthorizedSetup.body).includes(administratorSetupToken));
  assert.equal(executeTestDatabase((db) => db.prepare("SELECT COUNT(*) AS count FROM app_users").get().count), 0);

  // 空数据库只允许创建第一位管理员；保存响应中的 Cookie 对后续所有 API 请求认证。
  const setup = await requestApi("/api/auth/setup", {
    method: "POST",
    authenticated: false,
    expectedStatus: 201,
    json: { username: "integration-admin", password: "IntegrationTest123!", setupToken: administratorSetupToken },
  });
  const setCookie = setup.response.headers.get("set-cookie") || "";
  sessionCookie = setCookie.split(";", 1)[0];
  assert(sessionCookie.includes("="), "Administrator setup did not return a usable session cookie.");
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /Secure/i);
  assert.match(setCookie, /SameSite=Strict/i);
  await requestApi("/api/auth/login", {
    method: "POST",
    authenticated: false,
    expectedStatus: 401,
    json: { username: "bounded-body-user", password: "WrongPassword123!" },
  });

  // token 即使仍然正确，也不能在管理员已存在后重复使用；数据库用户数必须保持一。
  await requestApi("/api/auth/setup", {
    method: "POST",
    authenticated: false,
    expectedStatus: 409,
    json: { username: "second-admin", password: "IntegrationTest123!", setupToken: administratorSetupToken },
  });
  assert.equal(executeTestDatabase((db) => db.prepare("SELECT COUNT(*) AS count FROM app_users").get().count), 1);

  // 用户名和密码分别超过字段上限时都必须在限流 Map 与 Scrypt 之前被拒绝；
  // 不能只用“两项同时错误”的样本，否则其中一个边界被删除后测试仍会假绿。
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await requestApi("/api/auth/login", {
      method: "POST",
      authenticated: false,
      expectedStatus: 400,
      json: { username: "u".repeat(65), password: "ValidLength123!" },
    });
    await requestApi("/api/auth/login", {
      method: "POST",
      authenticated: false,
      expectedStatus: 400,
      json: { username: "bounded-password-user", password: "x".repeat(257) },
    });
  }
  await requestApi("/api/auth/login", {
    method: "POST",
    authenticated: false,
    expectedStatus: 401,
    json: { username: "u".repeat(64), password: "WrongPassword123!" },
  });
  await requestApi("/api/auth/login", {
    method: "POST",
    authenticated: false,
    expectedStatus: 401,
    json: { username: "bounded-password-user", password: "WrongPassword123!" },
  });

  // 旧数据库使用 ALTER TABLE 时 revision 一定追加在 courses 表尾；全新数据库必须
  // 保持相同物理列顺序，否则同版本完整 SQLite 备份会因表形状不同而无法恢复。
  const courseColumns = executeTestDatabase((db) => db.prepare("PRAGMA table_info(courses)").all());
  assert.equal(courseColumns.at(-1).name, "revision");
  assert.equal(courseColumns.at(-1).dflt_value, "1");
  report("身份保护、首次管理员和安全 Cookie");
}

async function verifyProductionSetupConfigurationFailsClosed(databasePath, configuredToken) {
  // 使用独立空库和真实 production standalone 分别覆盖“未配置”和“配置过短”。
  // 两种部署错误都必须拒绝 setup，不能因为方便首次使用而退回匿名管理员抢注。
  administratorSetupToken = configuredToken;
  await startServer(databasePath, { acceptedHealthStatuses: [503] });
  try {
    const unhealthy = await requestApi("/api/health", { authenticated: false, expectedStatus: 503 });
    assert.deepEqual(unhealthy.body, { status: "error" });
    const rejected = await requestApi("/api/auth/setup", {
      method: "POST",
      authenticated: false,
      expectedStatus: 503,
      json: {
        username: "must-not-exist",
        password: "IntegrationTest123!",
        setupToken: configuredToken || "attacker-supplied-token",
      },
    });
    assert.deepEqual(rejected.body, {
      error: "Administrator setup is unavailable. Contact the deployment administrator.",
    });
    assert(!JSON.stringify(rejected.body).includes(configuredToken || "attacker-supplied-token"));
    const db = new Database(databasePath, { readonly: true });
    try {
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM app_users").get().count, 0);
    } finally {
      db.close();
    }
  } finally {
    await stopServer();
    serverProcess = undefined;
  }
}

async function verifyPostSetupRestartWithoutToken(databasePath) {
  // setup token 只保护 production 空库。首位管理员建立后，部署者应能删除一次性 Secret；
  // 同一持久数据库重启后 health、旧会话和正常密码登录都必须继续工作。
  await stopServer();
  await startServer(databasePath, { setupToken: "" });
  const health = await requestApi("/api/health", { authenticated: false });
  assert.deepEqual(health.body, { status: "ok" });
  await requestApi("/api/teachers");
  const login = await requestApi("/api/auth/login", {
    method: "POST",
    authenticated: false,
    json: { username: "integration-admin", password: "IntegrationTest123!" },
  });
  sessionCookie = (login.response.headers.get("set-cookie") || "").split(";", 1)[0];
  assert(sessionCookie.includes("="));
  report("首位管理员建立后移除一次性 setup token，重启仍保持 health 与登录可用");
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
      revision: stableCourse.revision,
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
  const configuredCourse = await requestApi(`/api/courses/${course.id}`, {
    method: "PATCH",
    json: {
      revision: course.revision,
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
  let courseRevision = configuredCourse.body.revision;
  assert.equal(courseRevision, course.revision + 1);
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

  // Candidate GET 的路径、query 和业务状态必须使用稳定状态码；内部异常不能再被一律当成400原样返回。
  const missingCandidateSection = await requestApi(`/api/course-sections/${randomUUID()}/candidates?occurrence=1`, {
    expectedStatus: 404,
  });
  assert.deepEqual(missingCandidateSection.body, { error: "Course section not found." });
  for (const invalidOccurrence of ["", "0", "3", "1e0", "%2B1"]) {
    const invalidCandidate = await requestApi(`/api/course-sections/${section.id}/candidates?occurrence=${invalidOccurrence}`, {
      expectedStatus: 400,
    });
    assert.deepEqual(invalidCandidate.body, { error: "Choose weekly session 1 or 2." });
  }
  const unassignedCandidate = await requestApi(`/api/course-sections/${secondSection.id}/candidates?occurrence=1`, {
    expectedStatus: 400,
  });
  assert.match(unassignedCandidate.body.error, /active teacher/i);
  const validCandidate = await requestApi(`/api/course-sections/${section.id}/candidates?occurrence=1`);
  assert(Array.isArray(validCandidate.body.slots) && validCandidate.body.slots.length > 0);

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
  const staleCandidate = await requestApi(`/api/course-sections/${section.id}/candidates?occurrence=1`, {
    expectedStatus: 409,
  });
  assert.equal(staleCandidate.body.code, "CANDIDATE_REQUEST_STALE");
  assert(!/sqlite|constraint|scheduled_lessons|section_id|stack/i.test(JSON.stringify(staleCandidate.body)));
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
  const beforeStaleLessonMutations = readBusinessSnapshot();
  const staleLessonPatch = await requestApi(`/api/schedule/lessons/${lessonOne.id}`, {
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
  assert.equal(staleLessonPatch.body.code, "SCHEDULED_LESSON_CHANGED");
  assert(!/sqlite|database|constraint|scheduled_lessons|section_id|stack/i.test(JSON.stringify(staleLessonPatch.body)));
  const staleLessonDelete = await requestApi(`/api/schedule/lessons/${lessonTwo.id}?revision=${lessonTwo.revision}`, {
    method: "DELETE",
    expectedStatus: 409,
  });
  assert.equal(staleLessonDelete.body.code, "SCHEDULED_LESSON_CHANGED");
  assert(!/sqlite|database|constraint|scheduled_lessons|section_id|stack/i.test(JSON.stringify(staleLessonDelete.body)));
  assert.deepEqual(readBusinessSnapshot(), beforeStaleLessonMutations);

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

  // Course Setup 现在使用课程自己的 revision。先锁定同一份合法表单，验证损坏 JSON、
  // null 和可被 JavaScript 强制转换的数组／布尔数字都只能返回 400，且不能写入任何资料。
  const baselineCourseSetup = {
    revision: courseRevision,
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
  };
  const stateBeforeInvalidCourseSetup = readBusinessSnapshot();
  await requestApi(`/api/courses/${course.id}`, { method: "PATCH", json: null, expectedStatus: 400 });
  await requestApi(`/api/courses/${course.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: "{broken",
    expectedStatus: 400,
  });
  await requestApi(`/api/courses/${course.id}`, { method: "PATCH", json: { ...baselineCourseSetup, durationHours: [3] }, expectedStatus: 400 });
  await requestApi(`/api/courses/${course.id}`, { method: "PATCH", json: { ...baselineCourseSetup, sessionsPerWeek: true }, expectedStatus: 400 });
  assert.deepEqual(readBusinessSnapshot(), stateBeforeInvalidCourseSetup);

  // 相同设置重复保存属于真正的 no-op：课程、课次、warning、updated_at 和所有 revision
  // 都必须逐字段不变，避免老师只是按了一次 Save 就让其他打开中的 Inspector 失效。
  const noChangeSetup = await requestApi(`/api/courses/${course.id}`, { method: "PATCH", json: baselineCourseSetup });
  assert.deepEqual(noChangeSetup.body, { ok: true, revision: courseRevision, changed: false });
  assert.deepEqual(readBusinessSnapshot(), stateBeforeInvalidCourseSetup);

  // occurrence 2 仍在总表时，不能把每周次数降为 1。409 前后完整快照相等，
  // 证明这类当前状态冲突不会消耗课程或课次 revision。
  const sessionsConflict = await requestApi(`/api/courses/${course.id}`, {
    method: "PATCH",
    expectedStatus: 409,
    json: { ...baselineCourseSetup, sessionsPerWeek: 1 },
  });
  assert.match(sessionsConflict.body.error, /extra weekly sessions/i);
  assert.deepEqual(readBusinessSnapshot(), stateBeforeInvalidCourseSetup);

  // 故意让 warning 刷新在最后一条排课记录上失败。Course Setup 的字段、课程 revision、
  // 两个 occurrence 的冗余时长／revision 和已经写过的 warning 必须作为一个整体回滚。
  const beforeAtomicCourseSetup = readBusinessSnapshot();
  const targetSectionIds = new Set(beforeAtomicCourseSetup.sections.filter((row) => row.course_id === course.id).map((row) => row.id));
  const targetLessonsBeforeSetup = beforeAtomicCourseSetup.lessons.filter((row) => targetSectionIds.has(row.section_id));
  assert.equal(targetLessonsBeforeSetup.length, 2, "The course setup rollback fixture needs both weekly occurrences.");
  const warningFailureLesson = beforeAtomicCourseSetup.lessons.at(-1);
  assert(warningFailureLesson, "The course setup rollback fixture needs a scheduled lesson.");
  executeTestDatabase((db) => {
    const lessonIdLiteral = db.prepare("SELECT quote(?) AS value").get(warningFailureLesson.id).value;
    db.exec(`CREATE TRIGGER zz_fail_course_setup_warning BEFORE UPDATE OF warnings_json ON scheduled_lessons WHEN NEW.id = ${lessonIdLiteral} BEGIN SELECT RAISE(ABORT, 'forced course setup warning failure'); END;`);
  });
  const changedCourseSetup = { ...baselineCourseSetup, durationHours: 4, minimumRoomCapacity: 51 };
  try {
    const failedCourseSetup = await requestApi(`/api/courses/${course.id}`, {
      method: "PATCH",
      expectedStatus: 500,
      json: changedCourseSetup,
    });
    assert.deepEqual(failedCourseSetup.body, { error: "The course setup could not be saved. Try again." });
    assert(!/forced|sqlite|database|trigger|constraint|table|column|stack/i.test(JSON.stringify(failedCourseSetup.body)));
    assert.deepEqual(readBusinessSnapshot(), beforeAtomicCourseSetup);

    // trigger 仍存在时读取问题清单必须正常成功且零写入；若 GET 又开始重算 warning，
    // 这里会立即触发 500，从而防止轮询用旧课时覆盖刚保存结果的回归。
    const issuesWhileWarningWritesFail = await requestApi("/api/issues");
    assert(Array.isArray(issuesWhileWarningWritesFail.body));
    assert.deepEqual(readBusinessSnapshot(), beforeAtomicCourseSetup);
  } finally {
    executeTestDatabase((db) => db.exec("DROP TRIGGER IF EXISTS zz_fail_course_setup_warning"));
  }

  // 移除 trigger 后用同一 revision 重试必须成功：课程 revision 和两个课次 revision
  // 各只增加一次，时长同步为 4 小时，容量规则产生可预测的 warning；班次 revision 不变。
  const savedCourseSetup = await requestApi(`/api/courses/${course.id}`, { method: "PATCH", json: changedCourseSetup });
  assert.deepEqual(savedCourseSetup.body, { ok: true, revision: courseRevision + 1, changed: true });
  const afterAtomicCourseSetup = readBusinessSnapshot();
  const courseAfterSetup = afterAtomicCourseSetup.courses.find((row) => row.id === course.id);
  assert.equal(courseAfterSetup.revision, courseRevision + 1);
  assert.equal(courseAfterSetup.duration_hours, 4);
  assert.equal(courseAfterSetup.minimum_room_capacity, 51);
  const targetLessonsAfterSetup = afterAtomicCourseSetup.lessons.filter((row) => targetSectionIds.has(row.section_id));
  for (const lessonBefore of targetLessonsBeforeSetup) {
    const lessonAfter = targetLessonsAfterSetup.find((row) => row.id === lessonBefore.id);
    assert.equal(lessonAfter.duration_hours, 4);
    assert.equal(lessonAfter.revision, lessonBefore.revision + 1);
    assert(JSON.parse(lessonAfter.warnings_json).some((warning) => /Room capacity too small/.test(warning)));
  }
  for (const sectionBefore of beforeAtomicCourseSetup.sections.filter((row) => row.course_id === course.id)) {
    assert.equal(afterAtomicCourseSetup.sections.find((row) => row.id === sectionBefore.id).revision, sectionBefore.revision);
  }
  for (const otherLessonBefore of beforeAtomicCourseSetup.lessons.filter((row) => !targetSectionIds.has(row.section_id))) {
    const otherLessonAfter = afterAtomicCourseSetup.lessons.find((row) => row.id === otherLessonBefore.id);
    assert.equal(otherLessonAfter.duration_hours, otherLessonBefore.duration_hours);
    assert.equal(otherLessonAfter.revision, otherLessonBefore.revision);
  }

  // 依次模拟两个旧页面：旧 Course Configure 表单和课程规则改变前打开的 Inspector。
  // 两者都必须得到 409，并且赢家设置及所有关系保持不变。
  const beforeStaleEditors = readBusinessSnapshot();
  const staleCourseSetup = await requestApi(`/api/courses/${course.id}`, {
    method: "PATCH",
    expectedStatus: 409,
    json: { ...baselineCourseSetup, minimumRoomCapacity: 60 },
  });
  assert.equal(staleCourseSetup.body.code, "COURSE_SETUP_CHANGED");
  assert(!/sqlite|database|constraint/i.test(JSON.stringify(staleCourseSetup.body)));
  const staleInspectorAfterCourseSetup = await requestApi(`/api/schedule/lessons/${lessonOne.id}`, {
    method: "PATCH",
    expectedStatus: 409,
    json: {
      dayOfWeek: currentLessonOne.dayOfWeek,
      startHour: currentLessonOne.startHour,
      roomId: currentLessonOne.roomId,
      teacherId: currentLessonOne.teacherId,
      studentGroupIds: currentLessonOne.studentGroupIds,
      revision: currentLessonOne.revision,
    },
  });
  assert.equal(staleInspectorAfterCourseSetup.body.code, "SCHEDULED_LESSON_CHANGED");
  assert(!/sqlite|database|constraint|scheduled_lessons|section_id|stack/i.test(JSON.stringify(staleInspectorAfterCourseSetup.body)));
  assert.deepEqual(readBusinessSnapshot(), beforeStaleEditors);

  // 恢复原配置，避免改变后面 CRUD 场景的课程长度；恢复本身也是一次真实变化，
  // 因此课程及两个课次 revision 再各加 1，并重新载入 timetable 的最新 revision。
  courseRevision = savedCourseSetup.body.revision;
  const restoredCourseSetup = await requestApi(`/api/courses/${course.id}`, {
    method: "PATCH",
    json: { ...baselineCourseSetup, revision: courseRevision },
  });
  courseRevision = restoredCourseSetup.body.revision;
  assert.equal(courseRevision, baselineCourseSetup.revision + 2);
  timetable = (await requestApi("/api/schedule/lessons?year=1")).body;
  currentLessonOne = timetable.find((lesson) => lesson.id === lessonOne.id);
  assert.equal(currentLessonOne.durationHours, 3);
  assert(!currentLessonOne.warnings.some((warning) => /Room capacity too small/.test(warning)));

  // 两个同时送达的旧 Configure 表单使用同一个 revision，只能恰好一个保存成功；
  // 这项 HTTP 回归不冒充跨进程锁测试，只验证 production API 的课程 CAS 契约。
  const concurrentCourseSetups = await Promise.all([
    requestApi(`/api/courses/${course.id}`, {
      method: "PATCH",
      expectedStatus: [200, 409],
      json: { ...baselineCourseSetup, revision: courseRevision, minimumRoomCapacity: 21 },
    }),
    requestApi(`/api/courses/${course.id}`, {
      method: "PATCH",
      expectedStatus: [200, 409],
      json: { ...baselineCourseSetup, revision: courseRevision, minimumRoomCapacity: 22 },
    }),
  ]);
  assert.deepEqual(concurrentCourseSetups.map((result) => result.response.status).sort(), [200, 409]);
  const concurrentCourseWinner = concurrentCourseSetups.find((result) => result.response.status === 200);
  const concurrentCourseLoser = concurrentCourseSetups.find((result) => result.response.status === 409);
  assert.equal(concurrentCourseWinner.body.revision, courseRevision + 1);
  assert.equal(concurrentCourseLoser.body.code, "COURSE_SETUP_CHANGED");
  assert(!/sqlite|database|constraint/i.test(JSON.stringify(concurrentCourseLoser.body)));
  const courseAfterConcurrentSetup = (await requestApi("/api/courses")).body.find((item) => item.id === course.id);
  assert.equal(courseAfterConcurrentSetup.revision, courseRevision + 1);
  assert([21, 22].includes(courseAfterConcurrentSetup.minimumRoomCapacity));

  // 把并发赢家的容量恢复为原值，并再次刷新 timetable，确保后续 DELETE 使用最新 lesson revision。
  courseRevision = concurrentCourseWinner.body.revision;
  const afterConcurrentRestore = await requestApi(`/api/courses/${course.id}`, {
    method: "PATCH",
    json: { ...baselineCourseSetup, revision: courseRevision },
  });
  courseRevision = afterConcurrentRestore.body.revision;
  timetable = (await requestApi("/api/schedule/lessons?year=1")).body;
  currentLessonOne = timetable.find((lesson) => lesson.id === lessonOne.id);

  // 已有排课课程不能清空主要年级，否则会从三张年级总表消失。
  const missingYear = await requestApi(`/api/courses/${course.id}`, {
    method: "PATCH",
    expectedStatus: 409,
    json: {
      revision: courseRevision,
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

  // 反向入口也必须保护相同不变量：一门尚未选主年级但已设置时长的课程，
  // 即使旧页面仍握有班次 ID，也不能建立一条从三张总表全部消失的隐藏 lesson。
  const noYearCourse = (await requestApi("/api/courses", {
    method: "POST",
    expectedStatus: 201,
    json: { code: "AUTO_NO_YEAR", catalog: "Primary year placement guard", sectionCount: 1 },
  })).body;
  await requestApi(`/api/courses/${noYearCourse.id}`, {
    method: "PATCH",
    json: {
      revision: noYearCourse.revision,
      durationHours: 2,
      sessionsPerWeek: 1,
      primaryYear: null,
      minimumRoomCapacity: null,
      requiresLab: false,
      requiresMultiProjector: false,
      requiresSmartClassroom: false,
      separateSectionsAcrossDays: false,
      weekStart: null,
      weekEnd: null,
    },
  });
  const noYearSection = (await requestApi(`/api/courses/${noYearCourse.id}/sections`)).body[0];
  const beforeRejectedHiddenPlacement = readBusinessSnapshot();
  const hiddenPlacement = await requestApi("/api/schedule/lessons", {
    method: "POST",
    expectedStatus: 400,
    json: { sectionId: noYearSection.id, occurrence: 1, dayOfWeek: 1, startHour: 9, roomId: null },
  });
  assert.match(hiddenPlacement.body.error, /primary year/i);
  assert.deepEqual(readBusinessSnapshot(), beforeRejectedHiddenPlacement);
  const hiddenLessonCount = executeTestDatabase((db) => db.prepare(`
    SELECT COUNT(*) AS count FROM scheduled_lessons lessons
    JOIN course_sections sections ON sections.id = lessons.section_id
    JOIN courses ON courses.id = sections.course_id
    WHERE courses.primary_year IS NULL
  `).get().count);
  assert.equal(hiddenLessonCount, 0);

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

  // 年级页面现在一次读取完整 workspace。生产接口必须返回与各只读接口相同的五份资料，
  // 并且同一个 section + occurrence 不能同时出现在总表和待排区；否则多人 Return／重排
  // 正好夹在两个请求之间时，浏览器会依据不存在的混合状态给出错误提示。
  const workspace = (await requestApi("/api/schedule/workspace?year=1")).body;
  const [workspaceLessons, workspaceUnscheduled, workspaceIssues, workspaceTeachers, workspaceRooms] = await Promise.all([
    requestApi("/api/schedule/lessons?year=1"),
    requestApi("/api/schedule/unscheduled?year=1"),
    requestApi("/api/issues"),
    requestApi("/api/teachers"),
    requestApi("/api/rooms"),
  ]);
  assert.deepEqual(workspace.lessons, workspaceLessons.body);
  assert.deepEqual(workspace.unscheduledSections, workspaceUnscheduled.body);
  assert.deepEqual(workspace.issues, workspaceIssues.body);
  assert.deepEqual(workspace.teachers, workspaceTeachers.body);
  assert.deepEqual(workspace.rooms, workspaceRooms.body);
  const scheduledOccurrenceKeys = new Set(workspace.lessons.map((lesson) => `${lesson.sectionId}:${lesson.occurrence}`));
  assert(workspace.unscheduledSections.every((section) => !scheduledOccurrenceKeys.has(section.id)));
  await requestApi("/api/schedule/workspace?year=4", { expectedStatus: 400 });

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
    CREATE TRIGGER zz_fail_teacher_creation BEFORE INSERT ON teachers
    WHEN NEW.name = 'ATOMIC TEACHER FAIL' BEGIN SELECT RAISE(ABORT, 'forced teacher creation failure'); END;
    CREATE TRIGGER zz_fail_course_creation BEFORE INSERT ON courses
    WHEN NEW.code = 'ATOMIC_COURSE_FAIL' BEGIN SELECT RAISE(ABORT, 'forced course creation failure'); END;
    CREATE TRIGGER zz_fail_account_creation BEFORE INSERT ON app_users
    WHEN NEW.username = 'atomic-account-fail' BEGIN SELECT RAISE(ABORT, 'forced account creation failure'); END;
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
    await expectAtomicFailure("/api/teachers", "The teacher could not be created. Try again.", {
      method: "POST",
      json: { name: "ATOMIC TEACHER FAIL", staffType: "FT" },
    });
    await expectAtomicFailure("/api/courses", "The course could not be created. Try again.", {
      method: "POST",
      json: { code: "ATOMIC_COURSE_FAIL", catalog: "Must roll back", sectionCount: 1 },
    });
    await expectAtomicFailure("/api/auth/accounts", "The account could not be created. Try again.", {
      method: "POST",
      json: { username: "atomic-account-fail", password: "AtomicAccount123!" },
    });
  } finally {
    executeTestDatabase((db) => db.exec(`
      DROP TRIGGER IF EXISTS zz_fail_student_group_creation;
      DROP TRIGGER IF EXISTS zz_fail_room_creation;
      DROP TRIGGER IF EXISTS zz_fail_teacher_creation;
      DROP TRIGGER IF EXISTS zz_fail_course_creation;
      DROP TRIGGER IF EXISTS zz_fail_account_creation;
    `));
  }

  // 缩放班次的安全业务冲突仍返回 409；任意 SQLite/trigger 故障则必须是固定 500，
  // 并由事务回滚刚建立的尾部班次。
  executeTestDatabase((db) => {
    const courseIdLiteral = db.prepare("SELECT quote(?) AS value").get(ids.courseId).value;
    db.exec(`CREATE TRIGGER zz_fail_section_resize BEFORE INSERT ON course_sections WHEN NEW.course_id = ${courseIdLiteral} AND NEW.sequence = 2 BEGIN SELECT RAISE(ABORT, 'forced section resize failure'); END;`);
  });
  try {
    await expectAtomicFailure(`/api/courses/${ids.courseId}/sections`, "Section count could not be changed. Try again.", {
      method: "PATCH",
      json: { sectionCount: 2 },
    });
  } finally {
    executeTestDatabase((db) => db.exec("DROP TRIGGER IF EXISTS zz_fail_section_resize"));
  }

  // 临时改名 allocation 表，使 section 的保存 SQL 可以先执行、但事务末尾的 variance
  // 查询真实失败。接口必须返回固定 500；恢复表名后完整快照应证明 section revision、
  // 关联和 warning 全部随同一事务回滚，没有“保存成功却报告失败”的半完成状态。
  const sectionBeforeVarianceFailure = (await requestApi(`/api/courses/${ids.courseId}/sections`)).body
    .find((section) => section.id === ids.sectionId);
  assert(sectionBeforeVarianceFailure, "The allocation variance rollback fixture section was not found.");
  const varianceFailureGroup = (await requestApi("/api/student-groups", {
    method: "POST",
    expectedStatus: 201,
    json: { code: "ATOMIC_VARIANCE_GROUP", year: 1, program: "ATOMIC" },
  })).body;
  const snapshotBeforeVarianceFailure = readBusinessSnapshot();
  executeTestDatabase((db) => db.exec("ALTER TABLE teaching_allocations RENAME TO teaching_allocations_hidden"));
  try {
    const failedVarianceRead = await requestApi(`/api/course-sections/${ids.sectionId}`, {
      method: "PATCH",
      expectedStatus: 500,
      json: {
        teacherId: sectionBeforeVarianceFailure.teacherId,
        // 改成另一班级会先真实重写关联、提高 lesson revision 并刷新 warning；
        // 末尾 variance 查询失败后，完整快照必须证明三者都随事务回滚。
        studentGroupIds: [varianceFailureGroup.id],
        revision: sectionBeforeVarianceFailure.revision,
      },
    });
    assert.deepEqual(failedVarianceRead.body, { error: "The section could not be saved. Try again." });
    assert(!/teaching_allocations|sqlite|database|table|column|stack/i.test(JSON.stringify(failedVarianceRead.body)));
  } finally {
    executeTestDatabase((db) => db.exec("ALTER TABLE teaching_allocations_hidden RENAME TO teaching_allocations"));
  }
  assert.deepEqual(readBusinessSnapshot(), snapshotBeforeVarianceFailure);

  // 所有 JSON 写入路由都必须把 null 和损坏 JSON 转换成 400 JSON，不能让
  // request.json() 的语法异常穿过 Next.js 形成 HTML 或未受控 500。
  const jsonRoutes = [
    ["/api/teachers", "POST"],
    ["/api/courses", "POST"],
    [`/api/courses/${ids.courseId}/sections`, "PATCH"],
    ["/api/auth/accounts", "POST"],
    ["/api/auth/accounts", "PATCH"],
    ["/api/auth/password", "PATCH"],
    ["/api/auth/setup", "POST"],
    ["/api/auth/login", "POST"],
    ["/api/student-groups", "POST"],
    [`/api/student-groups/${ids.studentGroupId}`, "PATCH"],
    ["/api/rooms", "POST"],
    [`/api/rooms/${ids.roomId}`, "PATCH"],
    ["/api/rule-settings", "PATCH"],
    ["/api/unavailability", "POST"],
  ];
  const snapshotBeforeMalformedJson = readBusinessSnapshot();
  for (const [pathname, method] of jsonRoutes) {
    await requestApi(pathname, { method, json: null, expectedStatus: 400 });
    await requestApi(pathname, {
      method,
      headers: { "Content-Type": "application/json" },
      body: "{broken",
      expectedStatus: 400,
    });
  }
  assert.deepEqual(readBusinessSnapshot(), snapshotBeforeMalformedJson);
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

async function verifySystemBackupAcrossColumnOrders() {
  // 先通过真实管理员下载接口取得已脱敏的完整 SQLite 备份。接着只在临时副本中
  // 把 courses 重建成历史升级库的物理列顺序，模拟“旧库升级后备份 → 全新库恢复”。
  const downloadResponse = await fetch(new URL("/api/system-backup", baseUrl), {
    headers: { Cookie: sessionCookie },
    signal: AbortSignal.timeout(requestTimeoutMilliseconds),
  });
  assert.equal(downloadResponse.status, 200);
  assert.match(downloadResponse.headers.get("content-type") || "", /sqlite/i);
  const reorderedBackupPath = path.join(temporaryDirectory, "legacy-column-order.sqlite");
  await writeFile(reorderedBackupPath, Buffer.from(await downloadResponse.arrayBuffer()), { mode: 0o600 });

  const backupDatabase = new Database(reorderedBackupPath);
  try {
    const freshColumnOrder = backupDatabase.prepare("PRAGMA table_info(courses)").all().map((column) => column.name);
    backupDatabase.pragma("foreign_keys = OFF");
    backupDatabase.pragma("legacy_alter_table = ON");
    const reorderCourses = backupDatabase.transaction(() => {
      // foreign_keys 关闭且 legacy_alter_table 开启时，重命名父表不会把子表外键
      // 改指向临时名称；新 courses 建立后，所有原外键继续引用正确表名。
      backupDatabase.exec(`
        ALTER TABLE courses RENAME TO courses_fresh_order;
        CREATE TABLE courses (
          id TEXT PRIMARY KEY,
          code TEXT NOT NULL UNIQUE,
          catalog TEXT,
          duration_hours INTEGER,
          sessions_per_week INTEGER NOT NULL DEFAULT 1 CHECK (sessions_per_week > 0),
          minimum_room_capacity INTEGER,
          requires_lab INTEGER NOT NULL DEFAULT 0,
          requires_multi_projector INTEGER NOT NULL DEFAULT 0,
          requires_smart_classroom INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          primary_year INTEGER CHECK (primary_year IN (1, 2, 3)),
          separate_sections_across_days INTEGER NOT NULL DEFAULT 0,
          week_pattern TEXT NOT NULL DEFAULT 'ALL' CHECK (week_pattern IN ('ALL', 'W1_4', 'W5_8')),
          week_start INTEGER CHECK (week_start IS NULL OR week_start >= 1),
          week_end INTEGER CHECK (week_end IS NULL OR week_end >= 1),
          revision INTEGER NOT NULL DEFAULT 1
        );
        INSERT INTO courses (
          id, code, catalog, duration_hours, sessions_per_week, minimum_room_capacity,
          requires_lab, requires_multi_projector, requires_smart_classroom, created_at,
          updated_at, primary_year, separate_sections_across_days, week_pattern,
          week_start, week_end, revision
        ) SELECT
          id, code, catalog, duration_hours, sessions_per_week, minimum_room_capacity,
          requires_lab, requires_multi_projector, requires_smart_classroom, created_at,
          updated_at, primary_year, separate_sections_across_days, week_pattern,
          week_start, week_end, revision
        FROM courses_fresh_order;
        DROP TABLE courses_fresh_order;
      `);
    });
    reorderCourses.immediate();
    backupDatabase.pragma("foreign_keys = ON");
    const legacyColumnOrder = backupDatabase.prepare("PRAGMA table_info(courses)").all().map((column) => column.name);
    assert.notDeepEqual(legacyColumnOrder, freshColumnOrder);
    assert.deepEqual(backupDatabase.pragma("integrity_check"), [{ integrity_check: "ok" }]);
    assert.deepEqual(backupDatabase.pragma("foreign_key_check"), []);
  } finally {
    backupDatabase.close();
  }

  // Production 恢复接口必须按列名验证与复制，而不是因 cid 顺序不同拒绝，或用
  // SELECT * 把某列写进错误字段。恢复完成会按产品设计注销全部旧会话。
  const stateBeforeRestore = readBusinessSnapshot();
  const restoreForm = new FormData();
  restoreForm.append("backupFile", new Blob([await readFile(reorderedBackupPath)], { type: "application/vnd.sqlite3" }), "legacy-column-order.sqlite");
  restoreForm.append("understandReplace", "on");
  restoreForm.append("understandSignOut", "on");
  restoreForm.append("confirmation", "RESTORE FULL BACKUP");
  const restored = await requestApi("/api/system-backup", { method: "POST", body: restoreForm });
  assert.equal(restored.body.restored, true);
  assert.deepEqual(readBusinessSnapshot(), stateBeforeRestore);
  await requestApi("/api/auth/status", { expectedStatus: 200, authenticated: false });
  await requestApi("/api/teachers", { expectedStatus: 401 });

  // 备份保留同一管理员密码；重新登录后更新全局测试 Cookie，让后续 Cycle 回归继续运行。
  const login = await requestApi("/api/auth/login", {
    method: "POST",
    authenticated: false,
    json: { username: "integration-admin", password: "IntegrationTest123!" },
  });
  sessionCookie = (login.response.headers.get("set-cookie") || "").split(";", 1)[0];
  assert(sessionCookie.includes("="));
  report("完整系统备份按列名跨 fresh／历史迁移列顺序恢复");
}

async function verifyAtomicCycleActions(ids) {
  // 新周期功能按产品要求允许所有排课账号使用。先由管理员建立一个普通账号，
  // 后面的 GET、Start 和 Restore 全部使用独立 Cookie 走真实 production proxy。
  const schedulerPassword = "CycleScheduler123!";
  await requestApi("/api/auth/accounts", {
    method: "POST",
    expectedStatus: 201,
    json: { username: "cycle-scheduler", password: schedulerPassword },
  });
  const schedulerLogin = await requestApi("/api/auth/login", {
    method: "POST",
    authenticated: false,
    json: { username: "cycle-scheduler", password: schedulerPassword },
  });
  const schedulerCookie = (schedulerLogin.response.headers.get("set-cookie") || "").split(";", 1)[0];
  assert(schedulerCookie.includes("="), "The normal scheduler login did not return a session cookie.");

  await requestApi("/api/cycle", { authenticated: false, expectedStatus: 401 });
  await requestApi("/api/cycle", {
    method: "POST",
    authenticated: false,
    expectedStatus: 401,
    json: { action: "start", confirmation: "START NEW CYCLE", currentToken: "0".repeat(64) },
  });
  const initialStatus = await requestApi("/api/cycle", { cookie: schedulerCookie });
  assert.match(initialStatus.body.currentToken, /^[0-9a-f]{64}$/);
  assert.equal(initialStatus.body.backup, null);

  // 损坏 JSON、非对象、错误 action／短语以及缺少绑定字段都必须在任何写入前返回 400。
  const stateBeforeInputErrors = readBusinessSnapshot();
  const invalidRequests = [
    { json: null },
    { json: [] },
    { json: { action: "unknown" } },
    { json: { action: "start", confirmation: "WRONG", currentToken: initialStatus.body.currentToken } },
    { json: { action: "restore", confirmation: "WRONG", currentToken: initialStatus.body.currentToken, backupId: randomUUID() } },
    { json: { action: "start", confirmation: "START NEW CYCLE" } },
    { json: { action: "restore", confirmation: "RESTORE LAST BACKUP", currentToken: initialStatus.body.currentToken } },
  ];
  for (const request of invalidRequests) {
    await requestApi("/api/cycle", { method: "POST", cookie: schedulerCookie, expectedStatus: 400, ...request });
    assert.deepEqual(readBusinessSnapshot(), stateBeforeInputErrors);
  }
  await requestApi("/api/cycle", {
    method: "POST",
    cookie: schedulerCookie,
    expectedStatus: 400,
    headers: { "Content-Type": "application/json" },
    body: "{broken",
  });
  assert.deepEqual(readBusinessSnapshot(), stateBeforeInputErrors);

  // 尚未开始过新周期时没有应急备份；这是当前资料状态冲突，而不是服务器故障。
  const noBackup = await requestApi("/api/cycle", {
    method: "POST",
    cookie: schedulerCookie,
    expectedStatus: 409,
    json: { action: "restore", confirmation: "RESTORE LAST BACKUP", currentToken: initialStatus.body.currentToken, backupId: randomUUID() },
  });
  assert.deepEqual(noBackup.body, { error: "No emergency cycle backup is available." });
  assert.deepEqual(readBusinessSnapshot(), stateBeforeInputErrors);

  // 页面取得 T0 后，另一请求新增课程。旧 T0 的 Start 必须被拒绝，不能清空老师
  // 从未在确认页面看过的 marker；重新 GET 才得到新的稳定 T1。
  const tokenBeforeMarker = initialStatus.body.currentToken;
  await requestApi("/api/courses", {
    method: "POST",
    cookie: schedulerCookie,
    expectedStatus: 201,
    json: { code: "CYCLE_TOKEN_MARKER", catalog: "Cycle stale-token marker", sectionCount: 1 },
  });
  const stateAfterMarker = readBusinessSnapshot();
  const staleStart = await requestApi("/api/cycle", {
    method: "POST",
    cookie: schedulerCookie,
    expectedStatus: 409,
    json: { action: "start", confirmation: "START NEW CYCLE", currentToken: tokenBeforeMarker },
  });
  assert.deepEqual(staleStart.body, { error: "The current cycle changed. Refresh this page and review the latest contents before starting a new cycle." });
  assert.deepEqual(readBusinessSnapshot(), stateAfterMarker);
  const statusBeforeStart = await requestApi("/api/cycle", { cookie: schedulerCookie });
  assert.match(statusBeforeStart.body.currentToken, /^[0-9a-f]{64}$/);
  assert.notEqual(statusBeforeStart.body.currentToken, tokenBeforeMarker);
  assert.equal((await requestApi("/api/cycle", { cookie: schedulerCookie })).body.currentToken, statusBeforeStart.body.currentToken);

  // 先直接加入一份合法旧 backup 夹具；若 Start 将删除旧备份放在事务外，后面的
  // courses DELETE 故障就会让这份 sentinel 丢失，完整快照断言会立即失败。
  const expectedCyclePayload = cyclePayloadFromSnapshot(stateAfterMarker);
  const oldBackupId = randomUUID();
  executeTestDatabase((db) => {
    db.prepare("INSERT INTO schedule_backups (id, snapshot_json, created_at) VALUES (?, ?, ?)")
      .run(oldBackupId, JSON.stringify(expectedCyclePayload), "2000-01-01T00:00:00.000Z");
    const courseIdLiteral = db.prepare("SELECT quote(?) AS value").get(ids.courseId).value;
    db.exec(`CREATE TRIGGER zz_fail_cycle_clear BEFORE DELETE ON courses WHEN OLD.id = ${courseIdLiteral} BEGIN SELECT RAISE(ABORT, 'forced cycle clear failure'); END;`);
  });
  const stateBeforeFailedStart = readBusinessSnapshot();
  try {
    const failedStart = await requestApi("/api/cycle", {
      method: "POST",
      cookie: schedulerCookie,
      expectedStatus: 500,
      json: { action: "start", confirmation: "START NEW CYCLE", currentToken: statusBeforeStart.body.currentToken },
    });
    assert.deepEqual(failedStart.body, { error: "The cycle action could not be completed. Try again." });
    assert.deepEqual(readBusinessSnapshot(), stateBeforeFailedStart);
  } finally {
    executeTestDatabase((db) => db.exec("DROP TRIGGER IF EXISTS zz_fail_cycle_clear"));
  }

  // 同一个 token 正常 Start 后，活动周期五表必须全空，新 backup 必须逐字段等于
  // 清空前资料并原子替换旧 sentinel；教师、教室、规则和账号完全保留。
  const retainedBeforeStart = retainedPayloadFromSnapshot(stateBeforeFailedStart);
  const started = await requestApi("/api/cycle", {
    method: "POST",
    cookie: schedulerCookie,
    json: { action: "start", confirmation: "START NEW CYCLE", currentToken: statusBeforeStart.body.currentToken },
  });
  assert.equal(started.body.courses, 0);
  assert.equal(started.body.sections, 0);
  assert.equal(started.body.lessons, 0);
  assert.match(started.body.currentToken, /^[0-9a-f]{64}$/);
  const stateAfterStart = readBusinessSnapshot();
  for (const rows of Object.values(cyclePayloadFromSnapshot(stateAfterStart))) assert.equal(rows.length, 0);
  assert.deepEqual(retainedPayloadFromSnapshot(stateAfterStart), retainedBeforeStart);
  assert.equal(stateAfterStart.scheduleBackups.length, 1);
  assert.notEqual(stateAfterStart.scheduleBackups[0].id, oldBackupId);
  assert.equal(stateAfterStart.scheduleBackups[0].id, started.body.backup.id);
  assert.deepEqual(JSON.parse(stateAfterStart.scheduleBackups[0].snapshot_json), expectedCyclePayload);
  assert.deepEqual(
    { courses: started.body.backup.courses, sections: started.body.backup.sections, lessons: started.body.backup.lessons },
    { courses: expectedCyclePayload.courses.length, sections: expectedCyclePayload.sections.length, lessons: expectedCyclePayload.lessons.length },
  );

  const stateBeforeEmptyStart = readBusinessSnapshot();
  const emptyStart = await requestApi("/api/cycle", {
    method: "POST",
    cookie: schedulerCookie,
    expectedStatus: 409,
    json: { action: "start", confirmation: "START NEW CYCLE", currentToken: started.body.currentToken },
  });
  assert.deepEqual(emptyStart.body, { error: "There is no current course cycle to clear." });
  assert.deepEqual(readBusinessSnapshot(), stateBeforeEmptyStart);

  // Restore 必须绑定页面显示的 backup ID。错误 ID 即使配合正确 current token，
  // 也只能得到 409，不能恢复或替换任何课程。
  const wrongBackup = await requestApi("/api/cycle", {
    method: "POST",
    cookie: schedulerCookie,
    expectedStatus: 409,
    json: { action: "restore", confirmation: "RESTORE LAST BACKUP", currentToken: started.body.currentToken, backupId: randomUUID() },
  });
  assert.deepEqual(wrongBackup.body, { error: "The emergency backup changed. Refresh this page and review the latest backup before restoring." });
  assert.deepEqual(readBusinessSnapshot(), stateBeforeEmptyStart);

  // 零课程 JSON 不可能来自合法 Start。即使五个字段都是数组，也必须视为损坏备份，
  // 不能成功 DELETE 当前周期。测试后原样还原正式夹具 JSON。
  const backupId = stateAfterStart.scheduleBackups[0].id;
  const validBackupJson = stateAfterStart.scheduleBackups[0].snapshot_json;
  executeTestDatabase((db) => db.prepare("UPDATE schedule_backups SET snapshot_json = ? WHERE id = ?").run(JSON.stringify({ courses: [], allocations: [], sections: [], sectionGroups: [], lessons: [] }), backupId));
  const stateWithInvalidBackup = readBusinessSnapshot();
  const invalidBackup = await requestApi("/api/cycle", {
    method: "POST",
    cookie: schedulerCookie,
    expectedStatus: 409,
    json: { action: "restore", confirmation: "RESTORE LAST BACKUP", currentToken: started.body.currentToken, backupId },
  });
  assert.deepEqual(invalidBackup.body, { error: "The emergency backup is not valid." });
  assert.deepEqual(readBusinessSnapshot(), stateWithInvalidBackup);
  executeTestDatabase((db) => db.prepare("UPDATE schedule_backups SET snapshot_json = ? WHERE id = ?").run(validBackupJson, backupId));

  // 五个数组齐全仍不代表资料可见。模拟旧版／损坏备份把一条已排课程的主年级
  // 清空；Restore 必须在删除当前周期前拒绝，不能绕过首次排课入口的新保护。
  const hiddenLessonSnapshot = JSON.parse(validBackupJson);
  const hiddenSnapshotLesson = hiddenLessonSnapshot.lessons[0];
  const hiddenSnapshotSection = hiddenLessonSnapshot.sections.find((section) => section.id === hiddenSnapshotLesson.section_id);
  const hiddenSnapshotCourse = hiddenLessonSnapshot.courses.find((course) => course.id === hiddenSnapshotSection.course_id);
  hiddenSnapshotCourse.primary_year = null;
  executeTestDatabase((db) => db.prepare("UPDATE schedule_backups SET snapshot_json = ? WHERE id = ?").run(JSON.stringify(hiddenLessonSnapshot), backupId));
  const stateWithHiddenLessonBackup = readBusinessSnapshot();
  const hiddenLessonBackup = await requestApi("/api/cycle", {
    method: "POST",
    cookie: schedulerCookie,
    expectedStatus: 409,
    json: { action: "restore", confirmation: "RESTORE LAST BACKUP", currentToken: started.body.currentToken, backupId },
  });
  assert.deepEqual(hiddenLessonBackup.body, { error: "The emergency backup is not valid." });
  assert.deepEqual(readBusinessSnapshot(), stateWithHiddenLessonBackup);
  executeTestDatabase((db) => db.prepare("UPDATE schedule_backups SET snapshot_json = ? WHERE id = ?").run(validBackupJson, backupId));

  // 在空活动区建立两门替换课程；R0 之后新增第二门，旧 R0 Restore 必须保留两门，
  // 防止旧页面无提示覆盖另一位老师刚保存的周期工作。
  await requestApi("/api/courses", {
    method: "POST",
    cookie: schedulerCookie,
    expectedStatus: 201,
    json: { code: "RESTORE_CURRENT", catalog: "Current work before restore", sectionCount: 1 },
  });
  const statusBeforeSecondCurrentCourse = await requestApi("/api/cycle", { cookie: schedulerCookie });
  await requestApi("/api/courses", {
    method: "POST",
    cookie: schedulerCookie,
    expectedStatus: 201,
    json: { code: "RESTORE_STALE_MARKER", catalog: "Must survive stale restore", sectionCount: 1 },
  });
  const stateBeforeStaleRestore = readBusinessSnapshot();
  const staleRestore = await requestApi("/api/cycle", {
    method: "POST",
    cookie: schedulerCookie,
    expectedStatus: 409,
    json: { action: "restore", confirmation: "RESTORE LAST BACKUP", currentToken: statusBeforeSecondCurrentCourse.body.currentToken, backupId },
  });
  assert.deepEqual(staleRestore.body, { error: "The current cycle changed. Refresh this page and review the latest contents before restoring." });
  assert.deepEqual(readBusinessSnapshot(), stateBeforeStaleRestore);
  const statusBeforeRestore = await requestApi("/api/cycle", { cookie: schedulerCookie });

  // 让 warning 重算在排序最后一条备份课程上失败，可证明前面已执行的 warning UPDATE、
  // 全部恢复 INSERT 和原活动周期 DELETE 会被同一个外层事务一起回滚。
  const lastBackupLesson = expectedCyclePayload.lessons.at(-1);
  assert(lastBackupLesson, "The cycle backup needs at least one scheduled lesson for warning rollback verification.");
  executeTestDatabase((db) => {
    const lessonIdLiteral = db.prepare("SELECT quote(?) AS value").get(lastBackupLesson.id).value;
    db.exec(`CREATE TRIGGER zz_fail_cycle_restore_warning BEFORE UPDATE OF warnings_json ON scheduled_lessons WHEN NEW.id = ${lessonIdLiteral} BEGIN SELECT RAISE(ABORT, 'forced cycle restore warning failure'); END;`);
  });
  const stateBeforeFailedRestore = readBusinessSnapshot();
  try {
    const failedRestore = await requestApi("/api/cycle", {
      method: "POST",
      cookie: schedulerCookie,
      expectedStatus: 500,
      json: { action: "restore", confirmation: "RESTORE LAST BACKUP", currentToken: statusBeforeRestore.body.currentToken, backupId },
    });
    assert.deepEqual(failedRestore.body, { error: "The cycle action could not be completed. Try again." });
    assert.deepEqual(readBusinessSnapshot(), stateBeforeFailedRestore);
  } finally {
    executeTestDatabase((db) => db.exec("DROP TRIGGER IF EXISTS zz_fail_cycle_restore_warning"));
  }

  // 故障回滚后同一 current token 仍然有效。正常 Restore 必须移除两门替换课程，
  // 精确恢复 backup 中的 ID、revision、关联与 warning，并继续保留同一备份。
  const restored = await requestApi("/api/cycle", {
    method: "POST",
    cookie: schedulerCookie,
    json: { action: "restore", confirmation: "RESTORE LAST BACKUP", currentToken: statusBeforeRestore.body.currentToken, backupId },
  });
  const stateAfterRestore = readBusinessSnapshot();
  assert.deepEqual(cyclePayloadFromSnapshot(stateAfterRestore), expectedCyclePayload);
  assert.deepEqual(retainedPayloadFromSnapshot(stateAfterRestore), retainedBeforeStart);
  assert.deepEqual(stateAfterRestore.scheduleBackups, stateAfterStart.scheduleBackups);
  assert.equal(restored.body.courses, expectedCyclePayload.courses.length);
  assert.equal(restored.body.sections, expectedCyclePayload.sections.length);
  assert.equal(restored.body.lessons, expectedCyclePayload.lessons.length);
  assert.equal(restored.body.backup.id, backupId);
  assert.match(restored.body.currentToken, /^[0-9a-f]{64}$/);
  const finalCycleStatus = await requestApi("/api/cycle", { cookie: schedulerCookie });
  assert.deepEqual(finalCycleStatus.body, restored.body);

  // 注销普通排课账号，避免它的测试会话影响最终 auth_sessions=0 外键验收。
  await requestApi("/api/auth/logout", { method: "POST", cookie: schedulerCookie });
  await requestApi("/api/cycle", { cookie: schedulerCookie, expectedStatus: 401 });
  report("普通账号的新周期快照、旧页面绑定、Start／Restore 原子回滚和完整恢复");
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
  verifyLessonDraftReconciliation();

  // 每次执行都创建全新临时数据库和随机端口，确保测试结果不依赖上一次状态。
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "timetabling-api-crud-"));
  await verifyProductionSetupConfigurationFailsClosed(path.join(temporaryDirectory, "setup-missing-token.db"), "");
  await verifyProductionSetupConfigurationFailsClosed(path.join(temporaryDirectory, "setup-short-token.db"), "short-token");
  await verifyProductionSetupConfigurationFailsClosed(path.join(temporaryDirectory, "setup-oversized-token.db"), "x".repeat(513));
  administratorSetupToken = randomUUID();
  const databasePath = path.join(temporaryDirectory, "integration.db");
  testDatabasePath = databasePath;
  assert.equal(path.dirname(databasePath), temporaryDirectory);
  await startServer(databasePath);
  await verifyAuthentication();
  await verifyPostSetupRestartWithoutToken(databasePath);
  await verifyWorkbookBoundaries();
  await verifyTeachingAllocationReimport();
  const relationshipIds = await verifyCrudAndRevisions();
  await verifyAtomicMasterDataWarnings(relationshipIds);
  await verifySystemBackupAcrossColumnOrders();
  await verifyAtomicCycleActions(relationshipIds);
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
