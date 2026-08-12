import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import * as XLSX from "xlsx";
import { candidateSlotRequestMatches } from "../src/lib/candidate-slot-request.mjs";
import { reconcileLessonDraft } from "../src/lib/lesson-draft-reconciliation.mjs";
import {
  maximumTeachingMembersCompressionRatio,
  maximumTeachingMembersUncompressedBytes,
  maximumTeachingMembersZipEntries,
  parseTeachingMembersWorksheet,
} from "../src/lib/teaching-members-workbook.mjs";

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

function verifyCandidateSlotRequestIdentity() {
  const requestA = { requestNumber: 1, sectionId: "section:A", occurrence: 1 };
  const requestB = { requestNumber: 2, sectionId: "section:B", occurrence: 2 };

  // B 已开始后，A 的迟到响应失效而 B 仍可应用；关闭面板把 current 设为 null，
  // 两个响应都必须失效。额外的 occurrence 断言防止同班次另一课次串入当前面板。
  assert.equal(candidateSlotRequestMatches(requestB, requestA), false);
  assert.equal(candidateSlotRequestMatches(requestB, requestB), true);
  assert.equal(candidateSlotRequestMatches(null, requestB), false);
  assert.equal(candidateSlotRequestMatches(requestB, { ...requestB, occurrence: 1 }), false);
  report("候选时段请求按 generation、班次与课次淘汰迟到响应");
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

function readBusinessSnapshotFrom(databasePath) {
  // 超限或故障请求必须证明“全部业务表零变化”，不能只比较课程总数。
  // 独立只读连接可看到服务器已经提交的状态，但不会取得写锁或改变正式资料。
  const db = new Database(databasePath, { readonly: true });
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

function readBusinessSnapshot() {
  assert(testDatabasePath, "The temporary database path is not ready.");
  return readBusinessSnapshotFrom(testDatabasePath);
}

function readPasswordAccountState(accountId) {
  // 密码回归不能只看 HTTP 状态：哈希更新和会话撤销必须一起提交或一起回滚。
  // 每次通过独立短连接取得账号与全部会话，避免复用或改变正式应用连接的事务状态。
  return executeTestDatabase((db) => ({
    account: db.prepare("SELECT password_hash, is_active FROM app_users WHERE id = ?").get(accountId),
    sessions: db.prepare("SELECT * FROM auth_sessions WHERE user_id = ? ORDER BY token_hash").all(accountId),
  }));
}

function fullRestoreForm(contents, filename, expectedCurrentToken) {
  // 所有完整恢复回归都走真实 multipart、双确认和精确短语，不能绕过 Route Handler。
  const form = new FormData();
  form.append("backupFile", new Blob([contents], { type: "application/vnd.sqlite3" }), filename);
  form.append("understandReplace", "on");
  form.append("understandSignOut", "on");
  form.append("confirmation", "RESTORE FULL BACKUP");
  if (expectedCurrentToken !== undefined) form.append("expectedCurrentToken", expectedCurrentToken);
  return form;
}

async function pathExists(filename) {
  try {
    await stat(filename);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
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

function zipDirectoryFixture(workbookBytes) {
  // 这些 offset 只用于构造恶意 ZIP 元数据测试样本；production 的目录检查仍由共用
  // parseTeachingMembersWorksheet 执行，测试不会复制或替代真正的资源判定逻辑。
  const bytes = Buffer.from(workbookBytes);
  let directoryEndOffset = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset -= 1) {
    if (bytes.readUInt32LE(offset) !== 0x06054b50) continue;
    if (offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) {
      directoryEndOffset = offset;
      break;
    }
  }
  assert(directoryEndOffset >= 0, "The test workbook did not contain a normal ZIP directory.");
  const firstEntryOffset = bytes.readUInt32LE(directoryEndOffset + 16);
  assert.equal(bytes.readUInt32LE(firstEntryOffset), 0x02014b50);
  return { bytes, directoryEndOffset, firstEntryOffset };
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

function readTeachingImportFixtureState(courseCodes, teacherNames) {
  // 只截取本组 Excel fixture 的完整行资料；ID、revision、updated_at、allocation 和
  // section 都保留，能够区分真正 no-op 与“删除后用相同表面数量重建”。
  return executeTestDatabase((db) => {
    const courses = courseCodes
      .map((code) => db.prepare("SELECT * FROM courses WHERE code = ?").get(code))
      .filter(Boolean)
      .sort((left, right) => left.code.localeCompare(right.code));
    const teachers = teacherNames
      .map((name) => db.prepare("SELECT * FROM teachers WHERE name = ?").get(name))
      .filter(Boolean)
      .sort((left, right) => left.name.localeCompare(right.name));
    const allocations = courses.flatMap((course) => db.prepare("SELECT * FROM teaching_allocations WHERE course_id = ? ORDER BY teacher_id").all(course.id));
    const sections = courses.flatMap((course) => db.prepare("SELECT * FROM course_sections WHERE course_id = ? ORDER BY sequence").all(course.id));
    return { courses, teachers, allocations, sections };
  });
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

async function verifyOwnPasswordLifecycleAndFailures() {
  // 使用普通 scheduler 而不是全局管理员验证自改密码，避免成功案例撤销后续回归
  // 仍要使用的管理员 Cookie。两个独立登录会话还能证明成功修改会撤销所有浏览器。
  const username = "password-cas-scheduler";
  const originalPassword = "PasswordCasOriginal123!";
  const changedPassword = "PasswordCasChanged456!";
  const account = (await requestApi("/api/auth/accounts", {
    method: "POST",
    expectedStatus: 201,
    json: { username, password: originalPassword },
  })).body;

  async function loginPasswordAccount(password, expectedStatus = 200) {
    const result = await requestApi("/api/auth/login", {
      method: "POST",
      authenticated: false,
      expectedStatus,
      json: { username, password },
    });
    const cookie = result.response.status === 200
      ? (result.response.headers.get("set-cookie") || "").split(";", 1)[0]
      : "";
    if (result.response.status === 200) assert(cookie.includes("="), "Password-test login did not return a usable Cookie.");
    return { ...result, cookie };
  }

  const firstLogin = await loginPasswordAccount(originalPassword);
  const secondLogin = await loginPasswordAccount(originalPassword);
  assert.notEqual(firstLogin.cookie, secondLogin.cookie);
  const initialState = readPasswordAccountState(account.id);
  assert.equal(initialState.account.is_active, 1);
  assert.equal(initialState.sessions.length, 2);

  // 新密码边界和错误旧密码都属于可修正的 400；它们不能重写哈希、撤销 Cookie，
  // 或因为输入错误触发通用 500。
  const invalidLength = await requestApi("/api/auth/password", {
    method: "PATCH",
    cookie: firstLogin.cookie,
    expectedStatus: 400,
    json: { currentPassword: originalPassword, newPassword: "too-short" },
  });
  assert.deepEqual(invalidLength.body, { error: "Password must use 10 to 256 characters." });
  assert.equal(invalidLength.response.headers.get("set-cookie"), null);
  assert.deepEqual(readPasswordAccountState(account.id), initialState);

  const incorrectCurrent = await requestApi("/api/auth/password", {
    method: "PATCH",
    cookie: firstLogin.cookie,
    expectedStatus: 400,
    json: { currentPassword: "IncorrectCurrent123!", newPassword: changedPassword },
  });
  assert.deepEqual(incorrectCurrent.body, { error: "Current password is incorrect." });
  assert.equal(incorrectCurrent.response.headers.get("set-cookie"), null);
  assert.deepEqual(readPasswordAccountState(account.id), initialState);

  // 故障 trigger 在 CAS UPDATE 已经成功后、撤销第一条会话时抛出带敏感哨兵的错误。
  // 500 必须使用固定安全文字，事务则要把新哈希和任何会话删除完整回滚。
  executeTestDatabase((db) => {
    const accountIdLiteral = db.prepare("SELECT quote(?) AS value").get(account.id).value;
    db.exec(`CREATE TRIGGER zz_fail_own_password_session_revoke
      BEFORE DELETE ON auth_sessions WHEN OLD.user_id = ${accountIdLiteral}
      BEGIN SELECT RAISE(ABORT, 'SECRET auth_sessions SQL /private/tmp/password.sqlite'); END;`);
  });
  let internalFailure;
  try {
    internalFailure = await requestApi("/api/auth/password", {
      method: "PATCH",
      cookie: firstLogin.cookie,
      expectedStatus: 500,
      json: { currentPassword: originalPassword, newPassword: changedPassword },
    });
  } finally {
    executeTestDatabase((db) => db.exec("DROP TRIGGER IF EXISTS zz_fail_own_password_session_revoke"));
  }
  assert.deepEqual(internalFailure.body, { error: "The password could not be changed. Try again." });
  assert.equal(internalFailure.response.headers.get("set-cookie"), null);
  assert(!/secret|auth_sessions|sqlite|sql|\/private\/tmp|trigger|stack/i.test(JSON.stringify(internalFailure.body)));
  assert.deepEqual(readPasswordAccountState(account.id), initialState);

  // RESERVED writer 不阻止 proxy 和旧密码 SELECT，但会让目标 BEGIN IMMEDIATE 在
  // 真实五秒 busy timeout 后失败，因而确定性证明 503 来自密码写入路径而非认证代理。
  const blocker = new Database(testDatabasePath);
  let holdsWriteLock = false;
  let busyFailure;
  try {
    assert.equal(blocker.pragma("journal_mode", { simple: true }), "delete");
    blocker.exec("BEGIN IMMEDIATE");
    holdsWriteLock = true;
    const startedAt = Date.now();
    busyFailure = await requestApi("/api/auth/password", {
      method: "PATCH",
      cookie: firstLogin.cookie,
      expectedStatus: 503,
      json: { currentPassword: originalPassword, newPassword: changedPassword },
    });
    const waitedMilliseconds = Date.now() - startedAt;
    assert(waitedMilliseconds >= 4_000 && waitedMilliseconds < 15_000,
      `Own-password BUSY response used an unexpected wait of ${waitedMilliseconds} ms.`);
  } finally {
    if (holdsWriteLock && blocker.inTransaction) blocker.exec("ROLLBACK");
    blocker.close();
  }
  assert.deepEqual(busyFailure.body, { error: "Another scheduler is updating timetable data. Try again in a moment." });
  assert.equal(busyFailure.response.headers.get("retry-after"), "1");
  assert.equal(busyFailure.response.headers.get("set-cookie"), null);
  assert.deepEqual(readPasswordAccountState(account.id), initialState);

  // 成功路径必须让随机盐产生不同哈希、原子删除两个旧会话并让响应 Cookie 过期。
  const changed = await requestApi("/api/auth/password", {
    method: "PATCH",
    cookie: firstLogin.cookie,
    json: { currentPassword: originalPassword, newPassword: changedPassword },
  });
  assert.deepEqual(changed.body, { ok: true });
  const clearedCookie = changed.response.headers.get("set-cookie") || "";
  assert.match(clearedCookie, /timetable_session=;/i);
  assert.match(clearedCookie, /expires=Thu, 01 Jan 1970 00:00:00 GMT/i);
  const changedState = readPasswordAccountState(account.id);
  assert.notEqual(changedState.account.password_hash, initialState.account.password_hash);
  assert.equal(changedState.account.is_active, 1);
  assert.deepEqual(changedState.sessions, []);

  const staleStatus = await requestApi("/api/auth/status", { cookie: secondLogin.cookie });
  assert.equal(staleStatus.body.user, null);
  await requestApi("/api/teachers", { cookie: secondLogin.cookie, expectedStatus: 401 });
  const oldLogin = await loginPasswordAccount(originalPassword, 401);
  assert.deepEqual(oldLogin.body, { error: "Username or password is incorrect." });
  const newLogin = await loginPasswordAccount(changedPassword);
  await requestApi("/api/auth/logout", { method: "POST", cookie: newLogin.cookie });
  report("自改密码 400／500／BUSY 503 原子回滚及成功后的全会话撤销");
}

async function verifyAccountStatusRevisionCasAndFailures() {
  // 账号状态使用独立夹具，避免启停或撤销会话影响后续需要持续使用的管理员与
  // password-CAS 账号。全部断言仍走 production standalone 的真实 route。
  const username = "account-status-cas";
  const password = "AccountStatusCas123!";
  const created = (await requestApi("/api/auth/accounts", {
    method: "POST",
    expectedStatus: 201,
    json: { username, password },
  })).body;
  assert.deepEqual(created, {
    id: created.id,
    username,
    isAdmin: false,
    isActive: true,
    revision: 1,
  });

  const accounts = (await requestApi("/api/auth/accounts")).body;
  assert.deepEqual(accounts.find((account) => account.id === created.id), created);
  const schedulerLogin = await requestApi("/api/auth/login", {
    method: "POST",
    authenticated: false,
    json: { username, password },
  });
  const schedulerCookie = (schedulerLogin.response.headers.get("set-cookie") || "").split(";", 1)[0];
  assert(schedulerCookie.includes("="));
  assert.equal(schedulerLogin.body.user.revision, 1);

  function statusState() {
    // 密码不参与状态 revision，但保留哈希在快照中可发现意外的跨字段更新。
    return executeTestDatabase((db) => ({
      account: db.prepare("SELECT password_hash, is_active, revision FROM app_users WHERE id = ?").get(created.id),
      sessions: db.prepare("SELECT * FROM auth_sessions WHERE user_id = ? ORDER BY token_hash").all(created.id),
    }));
  }

  // 同版本同值是成功 no-op，不提高 revision，也不撤销现有 scheduler 会话。
  const stateBeforeNoOp = statusState();
  // BEFORE UPDATE trigger 是比“最终值没变”更强的证据：错误实现若仍执行一条同值
  // UPDATE，会直接得到500，而不能靠 SQLite changes 或事后快照让测试假绿。
  executeTestDatabase((db) => {
    const accountIdLiteral = db.prepare("SELECT quote(?) AS value").get(created.id).value;
    db.exec(`CREATE TRIGGER zz_reject_account_status_noop_update
      BEFORE UPDATE ON app_users WHEN OLD.id = ${accountIdLiteral}
      BEGIN SELECT RAISE(ABORT, 'no-op must not execute UPDATE'); END;`);
  });
  let noOp;
  try {
    noOp = await requestApi("/api/auth/accounts", {
      method: "PATCH",
      json: { action: "status", userId: created.id, isActive: true, expectedRevision: 1 },
    });
  } finally {
    executeTestDatabase((db) => db.exec("DROP TRIGGER IF EXISTS zz_reject_account_status_noop_update"));
  }
  assert.deepEqual(noOp.body, { ok: true, revision: 1, changed: false });
  assert.deepEqual(statusState(), stateBeforeNoOp);
  assert.equal((await requestApi("/api/auth/status", { cookie: schedulerCookie })).body.user.revision, 1);

  // Route 必须严格要求 positive safe integer，不能把缺少版本、数字字符串或浮点数
  // 转成可写命令。每个400后逐字段比较账号与会话，证明验证发生在事务之前。
  for (const invalidPayload of [
    { action: "status", userId: created.id, isActive: false },
    { action: "status", userId: created.id, isActive: false, expectedRevision: null },
    { action: "status", userId: created.id, isActive: false, expectedRevision: "1" },
    { action: "status", userId: created.id, isActive: false, expectedRevision: 0 },
    { action: "status", userId: created.id, isActive: false, expectedRevision: 1.5 },
    { action: "status", userId: created.id, isActive: false, expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    const rejected = await requestApi("/api/auth/accounts", {
      method: "PATCH",
      expectedStatus: 400,
      json: invalidPayload,
    });
    assert.deepEqual(rejected.body, { error: "Account action is invalid." });
    assert.deepEqual(statusState(), stateBeforeNoOp);
  }

  // DELETE trigger 在条件 UPDATE 已执行后强制失败。由于停用和会话撤销共属一个
  // IMMEDIATE 事务，500 必须同时回滚 is_active、revision 和全部既有会话。
  executeTestDatabase((db) => {
    const accountIdLiteral = db.prepare("SELECT quote(?) AS value").get(created.id).value;
    db.exec(`CREATE TRIGGER zz_fail_account_status_session_revoke
      BEFORE DELETE ON auth_sessions WHEN OLD.user_id = ${accountIdLiteral}
      BEGIN SELECT RAISE(ABORT, 'SECRET account status trigger /private/tmp/status.sqlite'); END;`);
  });
  let failedStatus;
  try {
    failedStatus = await requestApi("/api/auth/accounts", {
      method: "PATCH",
      expectedStatus: 500,
      json: { action: "status", userId: created.id, isActive: false, expectedRevision: 1 },
    });
  } finally {
    executeTestDatabase((db) => db.exec("DROP TRIGGER IF EXISTS zz_fail_account_status_session_revoke"));
  }
  assert.deepEqual(failedStatus.body, { error: "The account could not be updated. Try again." });
  assert(!/secret|trigger|sqlite|sql|\/private\/tmp/i.test(JSON.stringify(failedStatus.body)));
  assert.deepEqual(statusState(), stateBeforeNoOp);

  const disabled = await requestApi("/api/auth/accounts", {
    method: "PATCH",
    json: { action: "status", userId: created.id, isActive: false, expectedRevision: 1 },
  });
  assert.deepEqual(disabled.body, { ok: true, revision: 2, changed: true });
  const disabledState = statusState();
  assert.equal(disabledState.account.is_active, 0);
  assert.equal(disabledState.account.revision, 2);
  assert.deepEqual(disabledState.sessions, []);
  assert.equal((await requestApi("/api/auth/status", { cookie: schedulerCookie })).body.user, null);

  // stale-same 是最容易误写成 no-op 的 ABA 边界：服务器当前也为 Inactive，但旧
  // revision 1 已错过一次真实提交，仍必须409且保持 revision 2。
  for (const isActive of [false, true]) {
    const conflict = await requestApi("/api/auth/accounts", {
      method: "PATCH",
      expectedStatus: 409,
      json: { action: "status", userId: created.id, isActive, expectedRevision: 1 },
    });
    assert.deepEqual(conflict.body, {
      code: "ACCOUNT_CHANGED",
      error: "This account was changed by another administrator. Review the latest account list before trying again.",
    });
    assert.deepEqual(statusState(), disabledState);
  }

  const enabled = await requestApi("/api/auth/accounts", {
    method: "PATCH",
    json: { action: "status", userId: created.id, isActive: true, expectedRevision: 2 },
  });
  assert.deepEqual(enabled.body, { ok: true, revision: 3, changed: true });
  const enabledNoOp = await requestApi("/api/auth/accounts", {
    method: "PATCH",
    json: { action: "status", userId: created.id, isActive: true, expectedRevision: 3 },
  });
  assert.deepEqual(enabledNoOp.body, { ok: true, revision: 3, changed: false });

  // 密码重置有自己的 hash/session CAS，不改变公开状态版本；管理员仍可使用刚刷新
  // 的 revision 3 做下一次启停，而不会收到与状态无关的冲突。
  await requestApi("/api/auth/accounts", {
    method: "PATCH",
    json: { action: "resetPassword", userId: created.id, password: "AccountStatusReset456!" },
  });
  const finalAccount = (await requestApi("/api/auth/accounts")).body
    .find((account) => account.id === created.id);
  assert.equal(finalAccount.revision, 3);
  assert.equal(finalAccount.isActive, true);
  report("账号状态 revision CAS、no-op、输入边界、故障回滚、会话撤销及 stale-same 409");
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
  assert.deepEqual(targetImport.body, { courses: 1, teachers: 1, allocations: 1, sections: 1, zeroAllocationRows: 0, ignoredZeroRows: 0 });

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

  // 课程、Catalog 和教师文字必须在进入数据库前执行原生字符串、长度与控制字符检查。
  // 前两行若被 NUL 复合键拼接会得到相同 key，因而也直接覆盖旧实现的碰撞风险。
  const snapshotBeforeInvalidText = readBusinessSnapshot();
  const invalidTextRows = [
    { Mod: "AUTO\u0000COLLISION", Catalog: "Must not import", Lecturer: "TEXT TEACHER", "Staff Type": "FT", "# of grps teaching": 1 },
    { Mod: "AUTO", Catalog: "Must not import", Lecturer: "COLLISION\u0000TEXT TEACHER", "Staff Type": "FT", "# of grps teaching": 1 },
    { Mod: 12345, Catalog: "Must not import", Lecturer: "NATIVE TEXT TEACHER", "Staff Type": "FT", "# of grps teaching": 1 },
    { Mod: "AUTO_LONG_LECTURER", Catalog: "Must not import", Lecturer: "L".repeat(129), "Staff Type": "FT", "# of grps teaching": 1 },
    { Mod: "AUTO_LONG_CATALOG", Catalog: "C".repeat(257), Lecturer: "CATALOG TEACHER", "Staff Type": "FT", "# of grps teaching": 1 },
    { Mod: "AUTO_CONTROL_CATALOG", Catalog: "LINE\nBREAK", Lecturer: "CATALOG CONTROL TEACHER", "Staff Type": "FT", "# of grps teaching": 1 },
  ];
  const invalidText = await uploadWorkbook(
    workbookBuffer([["Teaching Members", teachingRowsWorksheet(invalidTextRows)]]),
    "invalid-teaching-text.xlsx",
    400,
  );
  assert.match(invalidText.body.error, /plain string|control characters/i);
  assert(!JSON.stringify(invalidText.body).includes("L".repeat(129)));
  assert.deepEqual(readBusinessSnapshot(), snapshotBeforeInvalidText);

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
  assert.equal(exactLimit.body.zeroAllocationRows, 4_999);
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

  // 三份文件只篡改 ZIP 中央目录元数据：压缩内容本身保持很小。若预检被删掉，
  // SheetJS 才会接触彼此矛盾或声明巨量解压内容的条目；当前必须在数据库写入前 400。
  const tooManyEntries = zipDirectoryFixture(targetWorkbook);
  tooManyEntries.bytes.writeUInt16LE(maximumTeachingMembersZipEntries + 1, tooManyEntries.directoryEndOffset + 8);
  tooManyEntries.bytes.writeUInt16LE(maximumTeachingMembersZipEntries + 1, tooManyEntries.directoryEndOffset + 10);
  const rejectedEntryCount = await uploadWorkbook(tooManyEntries.bytes, "too-many-zip-entries.xlsx", 400);
  assert.match(rejectedEntryCount.body.error, /2,048 ZIP entries or fewer/i);

  const excessiveExpansion = zipDirectoryFixture(targetWorkbook);
  excessiveExpansion.bytes.writeUInt32LE(maximumTeachingMembersUncompressedBytes + 1, excessiveExpansion.firstEntryOffset + 24);
  const rejectedExpansion = await uploadWorkbook(excessiveExpansion.bytes, "excessive-uncompressed-size.xlsx", 400);
  assert.match(rejectedExpansion.body.error, /128 MB safety limit/i);

  const excessiveRatio = zipDirectoryFixture(targetWorkbook);
  const firstCompressedBytes = excessiveRatio.bytes.readUInt32LE(excessiveRatio.firstEntryOffset + 20);
  assert(firstCompressedBytes > 0, "The ZIP ratio fixture requires a compressed first entry.");
  const declaredUncompressedBytes = firstCompressedBytes * maximumTeachingMembersCompressionRatio + 1;
  assert(declaredUncompressedBytes < maximumTeachingMembersUncompressedBytes);
  excessiveRatio.bytes.writeUInt32LE(declaredUncompressedBytes, excessiveRatio.firstEntryOffset + 24);
  const rejectedRatio = await uploadWorkbook(excessiveRatio.bytes, "excessive-compression-ratio.xlsx", 400);
  assert.match(rejectedRatio.body.error, /200:1 compression-ratio safety limit/i);

  // 目录和本地 header 一起谎报 1 byte，声明值会通过总量／比率检查；实际 Deflate
  // 验证仍必须在 2 bytes 输出处停止，证明资源门槛不只是相信攻击者提供的数字。
  const understatedExpansion = zipDirectoryFixture(targetWorkbook);
  const localHeaderOffset = understatedExpansion.bytes.readUInt32LE(understatedExpansion.firstEntryOffset + 42);
  understatedExpansion.bytes.writeUInt32LE(1, understatedExpansion.firstEntryOffset + 24);
  understatedExpansion.bytes.writeUInt32LE(1, localHeaderOffset + 22);
  const rejectedUnderstatement = await uploadWorkbook(understatedExpansion.bytes, "understated-uncompressed-size.xlsx", 400);
  assert.match(rejectedUnderstatement.body.error, /could not be decompressed within its safety limits/i);
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
  report("Excel 版本、目标表隔离、文字边界、行数、ZIP 解压资源、multipart、文件大小和原型烟测");
}

async function verifyTeachingGroupCountBoundaries() {
  // 旧实现经 Number() 会把空白、false 和科学记数字符串分别变成 0／0／100。
  // 每个样本都走 production API，并在整组结束后比较完整业务快照证明零写入。
  const snapshotBeforeInvalidCounts = readBusinessSnapshot();
  const invalidCounts = [
    ["blank", null],
    ["whitespace", "   "],
    ["boolean-false", false],
    ["boolean-true", true],
    ["scientific-text", "1e2"],
    ["scientific-zero-text", "0e0"],
    ["fraction", 1.5],
    ["negative", -1],
    ["over-row-limit", 1_000],
    ["unsafe-integer", Number.MAX_SAFE_INTEGER + 1],
  ];
  for (const [label, groupCount] of invalidCounts) {
    const result = await uploadWorkbook(
      workbookBuffer([["Teaching Members", teachingRowsWorksheet([{
        Mod: `AUTO_INVALID_${String(label).toUpperCase().replaceAll("-", "_")}`,
        Catalog: "Must never import",
        Lecturer: "AUTO INVALID COUNT",
        "Staff Type": "FT",
        "# of grps teaching": groupCount,
      }])]]),
      `${label}-group-count.xlsx`,
      400,
    );
    assert.match(result.body.error, /Row 2.*0 to 999/i);
  }

  // 单行都合法仍不代表整门课程或整份工作簿安全。两组聚合边界必须在任何
  // SQLite 写入和班次展开前拒绝，避免少量行制造数千至数百万次循环。
  const courseOverflow = await uploadWorkbook(
    workbookBuffer([["Teaching Members", teachingRowsWorksheet([
      { Mod: "AUTO_COURSE_OVERFLOW", Catalog: "Must never import", Lecturer: "AUTO LIMIT A", "Staff Type": "FT", "# of grps teaching": 500 },
      { Mod: "AUTO_COURSE_OVERFLOW", Catalog: "Must never import", Lecturer: "AUTO LIMIT B", "Staff Type": "PT", "# of grps teaching": 500 },
    ])]]),
    "course-aggregate-overflow.xlsx",
    400,
  );
  assert.match(courseOverflow.body.error, /AUTO_COURSE_OVERFLOW exceeds the 999-group course limit/i);

  const workbookOverflowRows = Array.from({ length: 6 }, (_, index) => ({
    Mod: `AUTO_WORKBOOK_LIMIT_${index + 1}`,
    Catalog: "Must never import",
    Lecturer: `AUTO WORKBOOK LIMIT ${index + 1}`,
    "Staff Type": "FT",
    "# of grps teaching": index < 5 ? 999 : 6,
  }));
  const workbookOverflow = await uploadWorkbook(
    workbookBuffer([["Teaching Members", teachingRowsWorksheet(workbookOverflowRows)]]),
    "workbook-group-overflow.xlsx",
    400,
  );
  assert.match(workbookOverflow.body.error, /5,000-group safety limit/i);

  // 同一自然键不能靠表格行顺序决定最终主资料。Staff Type 或 Catalog 冲突都必须
  // 在打开写事务前 400，不能让 Map 的“最后一行获胜”掩盖输入矛盾。
  const conflictingStaffType = await uploadWorkbook(
    workbookBuffer([["Teaching Members", teachingRowsWorksheet([
      { Mod: "AUTO_CONFLICT_STAFF_A", Catalog: "Consistent A", Lecturer: "AUTO CONFLICT STAFF", "Staff Type": "FT", "# of grps teaching": 0 },
      { Mod: "AUTO_CONFLICT_STAFF_B", Catalog: "Consistent B", Lecturer: "AUTO CONFLICT STAFF", "Staff Type": "PT", "# of grps teaching": 0 },
    ])]]),
    "conflicting-staff-type.xlsx",
    400,
  );
  assert.match(conflictingStaffType.body.error, /AUTO CONFLICT STAFF has conflicting Staff Type/i);
  const conflictingCatalog = await uploadWorkbook(
    workbookBuffer([["Teaching Members", teachingRowsWorksheet([
      { Mod: "AUTO_CONFLICT_CATALOG", Catalog: "First catalog", Lecturer: "AUTO CATALOG A", "Staff Type": "FT", "# of grps teaching": 0 },
      { Mod: "AUTO_CONFLICT_CATALOG", Catalog: "Different catalog", Lecturer: "AUTO CATALOG B", "Staff Type": "FT", "# of grps teaching": 0 },
    ])]]),
    "conflicting-catalog.xlsx",
    400,
  );
  assert.match(conflictingCatalog.body.error, /AUTO_CONFLICT_CATALOG has conflicting Catalog/i);
  assert.deepEqual(readBusinessSnapshot(), snapshotBeforeInvalidCounts);

  // 999 是单行／单课程的合法闭区间上限。随后用数值 0 清空，既验证上限可用，
  // 也避免这 999 个临时班次影响后续 CRUD fixture 的可读性和运行规模。
  const acceptedBoundary = await uploadWorkbook(
    workbookBuffer([["Teaching Members", teachingRowsWorksheet([{
      Mod: "AUTO_COUNT_999",
      Catalog: "Accepted group boundary",
      Lecturer: "AUTO COUNT BOUNDARY",
      "Staff Type": "FT",
      "# of grps teaching": 999,
    }])]]),
    "accepted-999-groups.xlsx",
    200,
  );
  assert.equal(acceptedBoundary.body.sections, 999);
  const maximumState = readTeachingImportFixtureState(["AUTO_COUNT_999"], ["AUTO COUNT BOUNDARY"]);
  assert.equal(maximumState.allocations[0].assigned_group_count, 999);
  assert.equal(maximumState.sections.length, 999);
  const clearedBoundary = await uploadWorkbook(
    workbookBuffer([["Teaching Members", teachingRowsWorksheet([{
      Mod: "AUTO_COUNT_999",
      Catalog: "Accepted group boundary",
      Lecturer: "AUTO COUNT BOUNDARY",
      "Staff Type": "FT",
      "# of grps teaching": 0,
    }])]]),
    "clear-999-with-numeric-zero.xlsx",
    200,
  );
  assert.deepEqual(clearedBoundary.body, { courses: 1, teachers: 1, allocations: 0, sections: 0, zeroAllocationRows: 1, ignoredZeroRows: 1 });
  const clearedMaximumState = readTeachingImportFixtureState(["AUTO_COUNT_999"], ["AUTO COUNT BOUNDARY"]);
  assert.equal(clearedMaximumState.courses[0].id, maximumState.courses[0].id);
  assert.equal(clearedMaximumState.teachers[0].id, maximumState.teachers[0].id);
  assert.deepEqual(clearedMaximumState.allocations, []);
  assert.deepEqual(clearedMaximumState.sections, []);
  report("Teaching group count 严格类型、0–999／课程／工作簿上限与数值零清除");
}

async function verifyTeachingExplicitZeroAndNoOp() {
  // 全零工作簿若没有一个 Mod 命中既有课程，就没有可执行的清除动作；必须 400 且连
  // 教师名单也不写。若同批另有正数新课程，零值未知 Mod 仍不建空课程，但教师行
  // 继续作为完整 roster 维护。
  const snapshotBeforeUnmatchedZero = readBusinessSnapshot();
  const unmatchedZero = await uploadWorkbook(
    workbookBuffer([["Teaching Members", teachingRowsWorksheet([
      { Mod: "AUTO_UNKNOWN_ZERO_A", Catalog: "Must not create", Lecturer: "AUTO UNKNOWN ZERO A", "Staff Type": "FT", "# of grps teaching": 0 },
      { Mod: "AUTO_UNKNOWN_ZERO_B", Catalog: "Must not create", Lecturer: "AUTO UNKNOWN ZERO B", "Staff Type": "PT", "# of grps teaching": "0" },
    ])]]),
    "all-zero-without-existing-course.xlsx",
    400,
  );
  assert.match(unmatchedZero.body.error, /No existing courses matched the zero-allocation rows/i);
  assert.deepEqual(readBusinessSnapshot(), snapshotBeforeUnmatchedZero);

  const mixedZeroResult = await uploadWorkbook(
    workbookBuffer([["Teaching Members", teachingRowsWorksheet([
      { Mod: "AUTO_ZERO_POSITIVE_ACTION", Catalog: "Positive action", Lecturer: "AUTO ZERO ACTION", "Staff Type": "FT", "# of grps teaching": 1 },
      { Mod: "AUTO_ZERO_NEW_MUST_NOT_EXIST", Catalog: "Must not create", Lecturer: "AUTO ZERO ROSTER ONLY", "Staff Type": "PT", "# of grps teaching": 0 },
    ])]]),
    "positive-with-unknown-zero.xlsx",
    200,
  );
  assert.deepEqual(mixedZeroResult.body, { courses: 1, teachers: 2, allocations: 1, sections: 1, zeroAllocationRows: 1, ignoredZeroRows: 1 });
  executeTestDatabase((db) => {
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM courses WHERE code = ?").get("AUTO_ZERO_NEW_MUST_NOT_EXIST").count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM teachers WHERE name = ?").get("AUTO ZERO ROSTER ONLY").count, 1);
  });

  // 三门课程先由同一位教师建立；其中两门稍后用 0 清除，Companion 故意不在
  // 第二份工作簿出现，用来证明“未提课程不变”而不是全库替换。
  const baselineRows = [
    { Mod: "AUTO_ZERO_TEXT", Catalog: "Text zero clear", Lecturer: "AUTO ZERO TEACHER", "Staff Type": "FT", "# of grps teaching": 2 },
    { Mod: "AUTO_ZERO_NUMBER", Catalog: "Numeric zero clear", Lecturer: "AUTO ZERO TEACHER", "Staff Type": "FT", "# of grps teaching": 1 },
    { Mod: "AUTO_ZERO_COMPANION", Catalog: "Must stay untouched", Lecturer: "AUTO ZERO TEACHER", "Staff Type": "FT", "# of grps teaching": 1 },
  ];
  const baselineWorkbook = workbookBuffer([["Teaching Members", teachingRowsWorksheet(baselineRows)]]);
  await uploadWorkbook(baselineWorkbook, "zero-and-noop-baseline.xlsx", 200);
  const baselineCourses = (await requestApi("/api/courses")).body;
  const configuredCourse = baselineCourses.find((course) => course.code === "AUTO_ZERO_TEXT");
  assert(configuredCourse, "The explicit-zero fixture course was not created.");
  await requestApi(`/api/courses/${configuredCourse.id}`, {
    method: "PATCH",
    json: {
      revision: configuredCourse.revision,
      durationHours: 3,
      sessionsPerWeek: 2,
      primaryYear: 2,
      minimumRoomCapacity: 40,
      requiresLab: true,
      requiresMultiProjector: true,
      requiresSmartClassroom: false,
      separateSectionsAcrossDays: true,
      weekStart: 2,
      weekEnd: 8,
    },
  });

  const fixtureCourses = ["AUTO_ZERO_TEXT", "AUTO_ZERO_NUMBER", "AUTO_ZERO_COMPANION"];
  const stateBeforeSameImport = readTeachingImportFixtureState(fixtureCourses, ["AUTO ZERO TEACHER"]);
  // SQLite 的 CURRENT_TIMESTAMP 精确到秒；跨过一秒后仍逐字段相同，才能证明教师、
  // 课程和 allocation 没有执行一次表面无害但实际写入的 UPDATE／重建。
  await delay(1_100);
  await uploadWorkbook(baselineWorkbook, "zero-and-noop-identical.xlsx", 200);
  const stateAfterSameImport = readTeachingImportFixtureState(fixtureCourses, ["AUTO ZERO TEACHER"]);
  assert.deepEqual(stateAfterSameImport, stateBeforeSameImport);

  // 在表头后加入真实物理空行，再同时使用文字 "0" 和数值 0。空行必须跳过，
  // 两个明确零值必须生效；全零工作簿本身也是合法的清除操作。
  const zeroWorksheet = XLSX.utils.aoa_to_sheet([
    ["Mod", "Catalog", "Lecturer", "Staff Type", "# of grps teaching"],
    [null, null, null, null, null],
    ["AUTO_ZERO_TEXT", "Text zero clear", "AUTO ZERO TEACHER", "FT", "0"],
    ["AUTO_ZERO_NUMBER", "Numeric zero clear", "AUTO ZERO TEACHER", "FT", 0],
  ]);
  const zeroResult = await uploadWorkbook(
    workbookBuffer([["Teaching Members", zeroWorksheet]]),
    "explicit-text-and-number-zero.xlsx",
    200,
  );
  assert.deepEqual(zeroResult.body, { courses: 2, teachers: 1, allocations: 0, sections: 0, zeroAllocationRows: 2, ignoredZeroRows: 2 });

  const stateAfterZero = readTeachingImportFixtureState(fixtureCourses, ["AUTO ZERO TEACHER"]);
  const beforeByCode = new Map(stateBeforeSameImport.courses.map((course) => [course.code, course]));
  const afterByCode = new Map(stateAfterZero.courses.map((course) => [course.code, course]));
  for (const courseCode of fixtureCourses) assert.equal(afterByCode.get(courseCode).id, beforeByCode.get(courseCode).id);
  assert.equal(stateAfterZero.teachers[0].id, stateBeforeSameImport.teachers[0].id);
  // 清除 allocation 和自动班次是真实课程拓扑变化；每门被清除课程整批只提高一次
  // revision。未出现在工作簿中的 Companion 必须连 revision 也保持原值。
  assert.equal(afterByCode.get("AUTO_ZERO_TEXT").revision, beforeByCode.get("AUTO_ZERO_TEXT").revision + 1);
  assert.equal(afterByCode.get("AUTO_ZERO_NUMBER").revision, beforeByCode.get("AUTO_ZERO_NUMBER").revision + 1);
  assert.equal(afterByCode.get("AUTO_ZERO_COMPANION").revision, beforeByCode.get("AUTO_ZERO_COMPANION").revision);
  const configuredAfterZero = afterByCode.get("AUTO_ZERO_TEXT");
  assert.equal(configuredAfterZero.duration_hours, 3);
  assert.equal(configuredAfterZero.sessions_per_week, 2);
  assert.equal(configuredAfterZero.primary_year, 2);
  assert.equal(configuredAfterZero.minimum_room_capacity, 40);
  assert.equal(configuredAfterZero.requires_lab, 1);
  assert.equal(configuredAfterZero.requires_multi_projector, 1);
  assert.equal(configuredAfterZero.separate_sections_across_days, 1);
  assert.equal(configuredAfterZero.week_start, 2);
  assert.equal(configuredAfterZero.week_end, 8);

  const companionId = afterByCode.get("AUTO_ZERO_COMPANION").id;
  assert.deepEqual(
    stateAfterZero.allocations.filter((allocation) => allocation.course_id !== companionId),
    [],
  );
  assert.deepEqual(
    stateAfterZero.sections.filter((section) => section.course_id !== companionId),
    [],
  );
  assert.deepEqual(
    stateAfterZero.allocations.filter((allocation) => allocation.course_id === companionId),
    stateBeforeSameImport.allocations.filter((allocation) => allocation.course_id === companionId),
  );
  assert.deepEqual(
    stateAfterZero.sections.filter((section) => section.course_id === companionId),
    stateBeforeSameImport.sections.filter((section) => section.course_id === companionId),
  );
  report("显式文字／数值零、整行空白、稳定 ID、单次 revision 与未提课程保持");
}

async function verifyTeachingImportRevisionsAndSourceKeys() {
  // 新课程从 revision 1 开始。后续一次导入即使同时改变 Catalog、allocation 和班次
  // 拓扑，也只能提高一次；完全相同的重导则不写任何版本或 timestamp。
  const baselineRows = [{
    Mod: "AUTO_IMPORT_REVISION",
    Catalog: "Revision baseline",
    Lecturer: "AUTO REVISION SOURCE A",
    "Staff Type": "FT",
    "# of grps teaching": 1,
  }];
  const baselineWorkbook = workbookBuffer([["Teaching Members", teachingRowsWorksheet(baselineRows)]]);
  await uploadWorkbook(baselineWorkbook, "import-revision-baseline.xlsx", 200);
  let course = (await requestApi("/api/courses")).body.find((item) => item.code === "AUTO_IMPORT_REVISION");
  assert(course, "The import revision fixture course was not created.");
  assert.equal(course.revision, 1);
  const stateBeforeSameImport = readBusinessSnapshot();
  await delay(1_100);
  await uploadWorkbook(baselineWorkbook, "import-revision-noop.xlsx", 200);
  assert.deepEqual(readBusinessSnapshot(), stateBeforeSameImport);

  const expandedRows = [{ ...baselineRows[0], Catalog: "Revision change", "# of grps teaching": 2 }];
  await uploadWorkbook(
    workbookBuffer([["Teaching Members", teachingRowsWorksheet(expandedRows)]]),
    "import-revision-expanded.xlsx",
    200,
  );
  course = (await requestApi("/api/courses")).body.find((item) => item.id === course.id);
  assert.equal(course.revision, 2, "Catalog + allocation + section growth must consume one course revision.");
  assert.equal(course.catalog, "Revision change", "Catalog display case should be preserved.");
  const expandedSections = (await requestApi(`/api/courses/${course.id}/sections`)).body;
  assert.equal(expandedSections.length, 2);

  // 把相同数量改给另一位 Excel 教师会同时替换 allocation 并自动改派两个班次；
  // 课程仍只提高一次，低编号 section ID 保持稳定，各 section 自己提高一次 revision。
  const reassignedRows = [{
    ...expandedRows[0],
    Lecturer: "AUTO REVISION SOURCE B",
    "Staff Type": "PT",
  }];
  const reassignedWorkbook = workbookBuffer([["Teaching Members", teachingRowsWorksheet(reassignedRows)]]);
  await uploadWorkbook(reassignedWorkbook, "import-revision-reassigned.xlsx", 200);
  course = (await requestApi("/api/courses")).body.find((item) => item.id === course.id);
  assert.equal(course.revision, 3, "Allocation replacement and automatic reassignment must consume one course revision.");
  const reassignedTeacher = (await requestApi("/api/teachers")).body.find((teacher) => teacher.name === "AUTO REVISION SOURCE B");
  const reassignedSections = (await requestApi(`/api/courses/${course.id}/sections`)).body;
  assert(reassignedTeacher, "The reassigned source teacher was not created.");
  assert.deepEqual(reassignedSections.map((section) => section.id), expandedSections.map((section) => section.id));
  for (let index = 0; index < reassignedSections.length; index += 1) {
    assert.equal(reassignedSections[index].teacherId, reassignedTeacher.id);
    assert.equal(reassignedSections[index].revision, expandedSections[index].revision + 1);
  }

  // 人工改显示名后，隐藏来源键仍应让同一 Lecturer 命中原 ID；Excel 不得改回姓名或
  // Active 状态。人工新增占用该来源名必须409，避免下一次导入产生双重身份。
  const renamedTeacher = await requestApi(`/api/teachers/${reassignedTeacher.id}`, {
    method: "PATCH",
    json: { name: "AUTO REVISION DISPLAY NAME", staffType: "PT", revision: reassignedTeacher.revision },
  });
  assert.equal(renamedTeacher.body.revision, reassignedTeacher.revision + 1);
  await requestApi("/api/teachers", {
    method: "POST",
    expectedStatus: 409,
    json: { name: "AUTO REVISION SOURCE B", staffType: "FT" },
  });
  const courseRevisionBeforeSourceNoOp = course.revision;
  await uploadWorkbook(reassignedWorkbook, "import-stable-source-after-rename.xlsx", 200);
  let sourceTeacher = (await requestApi("/api/teachers")).body.find((teacher) => teacher.id === reassignedTeacher.id);
  course = (await requestApi("/api/courses")).body.find((item) => item.id === course.id);
  assert.equal(sourceTeacher.name, "AUTO REVISION DISPLAY NAME");
  assert.equal(sourceTeacher.revision, renamedTeacher.body.revision);
  assert.equal(course.revision, courseRevisionBeforeSourceNoOp);
  const sourceKey = executeTestDatabase((db) => db.prepare("SELECT teaching_members_key FROM teachers WHERE id = ?").get(sourceTeacher.id).teaching_members_key);
  assert.equal(sourceKey, "AUTO REVISION SOURCE B");

  // Staff Type 仍由 Excel 权威维护；它的真实变化只提高教师 revision，不改变课程
  // allocation 或拓扑，因此课程 revision 保持不变，人工显示名称也继续保留。
  const staffChangedRows = [{ ...reassignedRows[0], "Staff Type": "FT" }];
  await uploadWorkbook(
    workbookBuffer([["Teaching Members", teachingRowsWorksheet(staffChangedRows)]]),
    "import-source-staff-change.xlsx",
    200,
  );
  sourceTeacher = (await requestApi("/api/teachers")).body.find((teacher) => teacher.id === sourceTeacher.id);
  const courseAfterStaffChange = (await requestApi("/api/courses")).body.find((item) => item.id === course.id);
  assert.equal(sourceTeacher.name, "AUTO REVISION DISPLAY NAME");
  assert.equal(sourceTeacher.staffType, "FT");
  assert.equal(sourceTeacher.revision, renamedTeacher.body.revision + 1);
  assert.equal(courseAfterStaffChange.revision, courseRevisionBeforeSourceNoOp);

  // 旧数据库首次遇到同名人工教师时只认领隐藏来源键，不改变网页资料，也不消耗 revision。
  const claimTeacher = (await requestApi("/api/teachers", {
    method: "POST",
    expectedStatus: 201,
    json: { name: "AUTO SOURCE CLAIM", staffType: "FT" },
  })).body;
  await uploadWorkbook(
    workbookBuffer([["Teaching Members", teachingRowsWorksheet([{
      Mod: "AUTO_SOURCE_CLAIM_COURSE",
      Catalog: "Source claim",
      Lecturer: "AUTO SOURCE CLAIM",
      "Staff Type": "FT",
      "# of grps teaching": 1,
    }])]]),
    "import-source-claim.xlsx",
    200,
  );
  const claimedTeacher = (await requestApi("/api/teachers")).body.find((teacher) => teacher.id === claimTeacher.id);
  assert.equal(claimedTeacher.revision, claimTeacher.revision);
  assert.equal(executeTestDatabase((db) => db.prepare("SELECT teaching_members_key FROM teachers WHERE id = ?").get(claimTeacher.id).teaching_members_key), "AUTO SOURCE CLAIM");

  // 模拟历史损坏库中“来源键指向 A、当前姓名指向 B”的歧义。导入必须整批409且零写入；
  // 测完立即删除故意异常夹具，避免污染后续完整备份不变量检查。
  const conflictingTeacherId = randomUUID();
  executeTestDatabase((db) => db.prepare("INSERT INTO teachers (id, name, staff_type) VALUES (?, ?, ?)").run(conflictingTeacherId, "AUTO REVISION SOURCE B", "FT"));
  try {
    const beforeAmbiguousImport = readBusinessSnapshot();
    const ambiguous = await uploadWorkbook(reassignedWorkbook, "import-ambiguous-source.xlsx", 409);
    assert.match(ambiguous.body.error, /source.*current name|matches one teacher/i);
    assert.deepEqual(readBusinessSnapshot(), beforeAmbiguousImport);
  } finally {
    executeTestDatabase((db) => db.prepare("DELETE FROM teachers WHERE id = ?").run(conflictingTeacherId));
  }
  report("Teaching import 单次课程 revision、稳定教师来源键、Staff Type 与歧义保护");
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
  const initialAllocation = executeTestDatabase((db) => db.prepare("SELECT * FROM teaching_allocations WHERE course_id = ? AND teacher_id = ?").get(importedCourse.id, allocationTeacher.id));
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
  const stableAllocation = executeTestDatabase((db) => db.prepare("SELECT * FROM teaching_allocations WHERE course_id = ? AND teacher_id = ?").get(importedCourse.id, allocationTeacher.id));
  assert.equal(stableCourse.id, importedCourse.id);
  assert.equal(stableCourse.revision, importedCourse.revision);
  assert.deepEqual(stableAllocation, initialAllocation);
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
  const protectedZeroWorkbook = workbookBuffer([["Teaching Members", teachingRowsWorksheet([
    { ...allocationRows[0], "# of grps teaching": "0" },
    {
      Mod: "AUTO_ZERO_PROTECTED_COMPANION",
      Catalog: "Must roll back with protected zero",
      Lecturer: "AUTO ZERO PROTECTED COMPANION",
      "Staff Type": "FT",
      "# of grps teaching": 1,
    },
  ])]]);
  const protectedZero = await uploadWorkbook(protectedZeroWorkbook, "reimport-protected-zero.xlsx", 409);
  assert.match(protectedZero.body.error, /manually maintained teacher or student group/i);
  assert.deepEqual(readBusinessSnapshot(), snapshotBeforeProtectedShrink);

  // 旧版／异常资料可能同时保留非空 allocation source，却已有不同 teacher。它不能因
  // source 非 null 被误认成自动尾班并删除；只读快照和 companion 证明整批 409 回滚。
  const legacyRows = [{
    Mod: "AUTO_LEGACY_SOURCE",
    Catalog: "Legacy source mismatch",
    Lecturer: "AUTO LEGACY SOURCE",
    "Staff Type": "FT",
    "# of grps teaching": 2,
  }];
  await uploadWorkbook(
    workbookBuffer([["Teaching Members", teachingRowsWorksheet(legacyRows)]]),
    "legacy-source-baseline.xlsx",
    200,
  );
  const legacyCourse = (await requestApi("/api/courses")).body.find((course) => course.code === "AUTO_LEGACY_SOURCE");
  assert(legacyCourse, "The legacy source fixture course was not created.");
  const legacySections = (await requestApi(`/api/courses/${legacyCourse.id}/sections`)).body;
  assert.equal(legacySections.length, 2);
  executeTestDatabase((db) => db.prepare("UPDATE course_sections SET teacher_id = ?, revision = revision + 1 WHERE id = ?").run(manualTeacher.id, legacySections[1].id));
  const snapshotBeforeLegacyShrink = readBusinessSnapshot();
  const legacyShrink = await uploadWorkbook(
    workbookBuffer([["Teaching Members", teachingRowsWorksheet([
      { ...legacyRows[0], "# of grps teaching": 1 },
      { Mod: "AUTO_LEGACY_COMPANION", Catalog: "Must roll back", Lecturer: "AUTO LEGACY COMPANION", "Staff Type": "PT", "# of grps teaching": 1 },
    ])]]),
    "legacy-source-protected-shrink.xlsx",
    409,
  );
  assert.match(legacyShrink.body.error, /manually maintained teacher or student group/i);
  assert.deepEqual(readBusinessSnapshot(), snapshotBeforeLegacyShrink);
  // 这条不一致只为覆盖旧资料保护分支；验证完恢复成合法自动来源，避免故意异常的
  // fixture 污染后续完整备份业务不变量检查。
  executeTestDatabase((db) => db.prepare("UPDATE course_sections SET teacher_id = allocation_teacher_id, revision = revision + 1 WHERE id = ?").run(legacySections[1].id));

  // 停用 Excel 原教师后，原第一班仍可 grandfather 并保持相同 ID/revision；但把数量
  // 增加到三班会建立新分配，因此必须 409 且整次回滚。
  const inactiveAllocationTeacher = await requestApi(`/api/teachers/${allocationTeacher.id}`, {
    method: "PATCH",
    json: { isActive: false, revision: allocationTeacher.revision },
  });
  allocationTeacher.revision = inactiveAllocationTeacher.body.revision;
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
  const scheduledZeroWorkbook = workbookBuffer([["Teaching Members", teachingRowsWorksheet([
    { ...allocationRows[0], "# of grps teaching": 0 },
    {
      Mod: "AUTO_SCHEDULED_ZERO_COMPANION",
      Catalog: "Must roll back with scheduled zero",
      Lecturer: "AUTO SCHEDULED ZERO COMPANION",
      "Staff Type": "PT",
      "# of grps teaching": 1,
    },
  ])]]);
  const scheduledZero = await uploadWorkbook(scheduledZeroWorkbook, "reimport-scheduled-zero.xlsx", 409);
  assert.match(scheduledZero.body.error, /has been scheduled/i);
  assert.deepEqual(readBusinessSnapshot(), snapshotBeforeScheduledReimport);
  report("Teaching allocation 稳定 ID、手工分配、缩减／零值、停用教师和已排课程重导保护");
}

async function verifyTeachingImportFailureBoundaries() {
  const failureWorkbook = workbookBuffer([["Teaching Members", teachingRowsWorksheet([{
    Mod: "AUTO_IMPORT_FAILURE",
    Catalog: "Must never partially commit",
    Lecturer: "AUTO IMPORT FAILURE",
    "Staff Type": "FT",
    "# of grps teaching": 1,
  }])]]);

  // 真实 BEFORE INSERT trigger 让教师和课程 SQL 已执行后才失败。Route 必须返回固定
  // 500，事务则撤销全部前序写入；浏览器不能看到 trigger、表名、SQL 或私有路径。
  const snapshotBeforeInternalFailure = readBusinessSnapshot();
  executeTestDatabase((db) => db.exec(`
    CREATE TRIGGER teaching_import_test_failure
    BEFORE INSERT ON teaching_allocations
    BEGIN
      SELECT RAISE(ABORT, 'SECRET teaching_allocations SQL /private/tmp/import.db');
    END;
  `));
  let internalFailure;
  try {
    internalFailure = await uploadWorkbook(failureWorkbook, "triggered-import-failure.xlsx", 500);
  } finally {
    executeTestDatabase((db) => db.exec("DROP TRIGGER IF EXISTS teaching_import_test_failure"));
  }
  assert.deepEqual(internalFailure.body, { error: "Teaching allocations could not be saved. Please try again." });
  assert(!/secret|teaching_allocations|sqlite|sql|\/private\/tmp|trigger|stack/i.test(JSON.stringify(internalFailure.body)));
  assert.deepEqual(readBusinessSnapshot(), snapshotBeforeInternalFailure);

  // RESERVED writer 允许认证 proxy 正常读取 session，但会让 Route 自己的 BEGIN IMMEDIATE
  // 在真实 busy timeout 后失败。503／Retry-After 与零变化由 production HTTP 直接证明。
  const snapshotBeforeBusyFailure = readBusinessSnapshot();
  const lockDatabase = new Database(testDatabasePath);
  let busyFailure;
  try {
    lockDatabase.exec("BEGIN IMMEDIATE");
    busyFailure = await uploadWorkbook(failureWorkbook, "busy-import.xlsx", 503);
  } finally {
    if (lockDatabase.inTransaction) lockDatabase.exec("ROLLBACK");
    lockDatabase.close();
  }
  assert.deepEqual(busyFailure.body, { error: "Another scheduler is updating timetable data. Try again in a moment." });
  assert.equal(busyFailure.response.headers.get("retry-after"), "1");
  assert.deepEqual(readBusinessSnapshot(), snapshotBeforeBusyFailure);
  report("Teaching allocation 真实 500／BUSY 503 安全 JSON 与事务回滚");
}

async function verifyCourseDeletionAndAutomaticSectionResize() {
  // 删除协议先用一门完全独立的手工课程覆盖严格输入、body 上限、stale CAS、未知
  // trigger 回滚、成功级联和重复删除。所有断言只连接本轮 mkdtemp 数据库。
  const deletableCourse = (await requestApi("/api/courses", {
    method: "POST",
    expectedStatus: 201,
    json: { code: "COURSE_DELETE_SAFE", catalog: "Safe deletion regression", sectionCount: 2 },
  })).body;
  const beforeInvalidDelete = readBusinessSnapshot();
  await requestApi(`/api/courses/${deletableCourse.id}`, {
    method: "DELETE",
    expectedStatus: 400,
    headers: { "Content-Type": "application/json" },
    body: "null",
  });
  await requestApi(`/api/courses/${deletableCourse.id}`, {
    method: "DELETE",
    expectedStatus: 400,
    headers: { "Content-Type": "application/json" },
    body: "{",
  });
  await requestApi(`/api/courses/${deletableCourse.id}`, {
    method: "DELETE",
    expectedStatus: 400,
    json: { revision: "1" },
  });
  await requestApi(`/api/courses/${deletableCourse.id}`, {
    method: "DELETE",
    expectedStatus: 413,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ revision: 1, padding: "x".repeat(70 * 1_024) }),
  });
  assert.deepEqual(readBusinessSnapshot(), beforeInvalidDelete);

  const grownDeletableCourse = await requestApi(`/api/courses/${deletableCourse.id}/sections`, {
    method: "PATCH",
    json: { sectionCount: 3, revision: deletableCourse.revision },
  });
  const beforeStaleDelete = readBusinessSnapshot();
  const staleDelete = await requestApi(`/api/courses/${deletableCourse.id}`, {
    method: "DELETE",
    expectedStatus: 409,
    json: { revision: deletableCourse.revision },
  });
  assert.equal(staleDelete.body.code, "COURSE_CHANGED");
  assert.deepEqual(readBusinessSnapshot(), beforeStaleDelete);

  executeTestDatabase((db) => {
    const courseIdLiteral = db.prepare("SELECT quote(?) AS value").get(deletableCourse.id).value;
    db.exec(`CREATE TRIGGER zz_fail_course_delete BEFORE DELETE ON courses
      WHEN OLD.id = ${courseIdLiteral}
      BEGIN SELECT RAISE(ABORT, 'SECRET course delete trigger /private/tmp/live.sqlite'); END;`);
  });
  try {
    const failedDelete = await requestApi(`/api/courses/${deletableCourse.id}`, {
      method: "DELETE",
      expectedStatus: 500,
      json: { revision: grownDeletableCourse.body.revision },
    });
    assert.deepEqual(failedDelete.body, { error: "The course could not be deleted. Try again." });
    assert(!/secret|trigger|sqlite|database|course_sections|\/private\/tmp|stack/i.test(JSON.stringify(failedDelete.body)));
    assert.deepEqual(readBusinessSnapshot(), beforeStaleDelete);
  } finally {
    executeTestDatabase((db) => db.exec("DROP TRIGGER IF EXISTS zz_fail_course_delete"));
  }

  // 独立 RESERVED writer 不影响认证 SELECT，但会让 Course DELETE 自己的
  // BEGIN IMMEDIATE 在 production busy timeout 后受控失败；原课程和全部关系必须不变。
  const snapshotBeforeDeleteBusy = readBusinessSnapshot();
  const deleteLockDatabase = new Database(testDatabasePath);
  let deleteBusyFailure;
  try {
    deleteLockDatabase.exec("BEGIN IMMEDIATE");
    deleteBusyFailure = await requestApi(`/api/courses/${deletableCourse.id}`, {
      method: "DELETE",
      expectedStatus: 503,
      json: { revision: grownDeletableCourse.body.revision },
    });
  } finally {
    if (deleteLockDatabase.inTransaction) deleteLockDatabase.exec("ROLLBACK");
    deleteLockDatabase.close();
  }
  assert.deepEqual(deleteBusyFailure.body, { error: "Another scheduler is updating course data. Try again in a moment." });
  assert.equal(deleteBusyFailure.response.headers.get("retry-after"), "1");
  assert.deepEqual(readBusinessSnapshot(), snapshotBeforeDeleteBusy);

  assert.deepEqual((await requestApi(`/api/courses/${deletableCourse.id}`, {
    method: "DELETE",
    json: { revision: grownDeletableCourse.body.revision },
  })).body, { ok: true });
  await requestApi(`/api/courses/${deletableCourse.id}`, {
    method: "DELETE",
    expectedStatus: 404,
    json: { revision: grownDeletableCourse.body.revision },
  });
  assert.equal(executeTestDatabase((db) => db.prepare("SELECT COUNT(*) AS count FROM course_sections WHERE course_id = ?").get(deletableCourse.id).count), 0);

  // Teaching Members 自动教师属于可再生成的来源资料。手工缩小数量时允许删除自动
  // 尾班，但 allocation baseline 保持原样并形成明确 mismatch；随后整课删除原子清除
  // course、剩余自动 section 和 baseline，教师主资料继续保留。
  const autoRows = [{
    Mod: "COURSE_AUTO_RESIZE",
    Catalog: "Automatic section lifecycle",
    Lecturer: "COURSE AUTO RESIZE TEACHER",
    "Staff Type": "FT",
    "# of grps teaching": 3,
  }];
  const autoWorkbook = workbookBuffer([["Teaching Members", teachingRowsWorksheet(autoRows)]]);
  await uploadWorkbook(autoWorkbook, "course-auto-resize.xlsx", 200);
  const autoCourse = (await requestApi("/api/courses")).body.find((course) => course.code === "COURSE_AUTO_RESIZE");
  const autoTeacher = (await requestApi("/api/teachers")).body.find((teacher) => teacher.name === "COURSE AUTO RESIZE TEACHER");
  assert(autoCourse && autoTeacher, "The automatic resize fixture was not created.");
  const autoSectionsBefore = executeTestDatabase((db) => db.prepare(`SELECT id, sequence, teacher_id, allocation_teacher_id
    FROM course_sections WHERE course_id = ? ORDER BY sequence`).all(autoCourse.id));
  assert.equal(autoSectionsBefore.length, 3);
  assert(autoSectionsBefore.every((section) => section.teacher_id === autoTeacher.id && section.allocation_teacher_id === autoTeacher.id));

  const autoShrink = await requestApi(`/api/courses/${autoCourse.id}/sections`, {
    method: "PATCH",
    json: { sectionCount: 1, revision: autoCourse.revision },
  });
  assert.equal(autoShrink.body.revision, autoCourse.revision + 1);
  assert.equal((await requestApi(`/api/courses/${autoCourse.id}/sections`)).body.length, 1);
  const baselineAfterShrink = executeTestDatabase((db) => db.prepare("SELECT assigned_group_count FROM teaching_allocations WHERE course_id = ? AND teacher_id = ?").get(autoCourse.id, autoTeacher.id));
  assert.deepEqual(baselineAfterShrink, { assigned_group_count: 3 });
  const summaryAfterShrink = (await requestApi("/api/courses")).body.find((course) => course.id === autoCourse.id);
  assert.equal(summaryAfterShrink.configuredSections, 1);
  assert.equal(summaryAfterShrink.allocatedSections, 3);
  assert.equal(summaryAfterShrink.allocationVarianceCount, 1);

  await requestApi(`/api/courses/${autoCourse.id}`, {
    method: "DELETE",
    json: { revision: autoShrink.body.revision },
  });
  const autoOwnedRowsAfterDelete = executeTestDatabase((db) => ({
    course: db.prepare("SELECT COUNT(*) AS count FROM courses WHERE id = ?").get(autoCourse.id).count,
    allocations: db.prepare("SELECT COUNT(*) AS count FROM teaching_allocations WHERE course_id = ?").get(autoCourse.id).count,
    sections: db.prepare("SELECT COUNT(*) AS count FROM course_sections WHERE course_id = ?").get(autoCourse.id).count,
    teacher: db.prepare("SELECT COUNT(*) AS count FROM teachers WHERE id = ?").get(autoTeacher.id).count,
  }));
  assert.deepEqual(autoOwnedRowsAfterDelete, { course: 0, allocations: 0, sections: 0, teacher: 1 });

  // 同一来源文件以后会按产品契约重新建立新 course ID 与自动班次；这不是删除失败，
  // 而是用户明确再次导入来源资料的结果。清理重建夹具后继续其他回归。
  await uploadWorkbook(autoWorkbook, "course-auto-recreate.xlsx", 200);
  const recreatedAutoCourse = (await requestApi("/api/courses")).body.find((course) => course.code === "COURSE_AUTO_RESIZE");
  assert(recreatedAutoCourse && recreatedAutoCourse.id !== autoCourse.id);
  assert.equal(recreatedAutoCourse.configuredSections, 3);
  await requestApi(`/api/courses/${recreatedAutoCourse.id}`, {
    method: "DELETE",
    json: { revision: recreatedAutoCourse.revision },
  });

  // 已排课、学生班级和人工教师按优先次序分别阻止整课删除；每个409都必须保持
  // 完整业务快照。老师逐步显式清理后，同一课程才可安全删除。
  const protectedTeacher = (await requestApi("/api/teachers", {
    method: "POST",
    expectedStatus: 201,
    json: { name: "COURSE DELETE MANUAL TEACHER", staffType: "PT" },
  })).body;
  const protectedGroup = (await requestApi("/api/student-groups", {
    method: "POST",
    expectedStatus: 201,
    json: { code: "COURSE_DELETE_GROUP", year: 1, program: "DELETE" },
  })).body;
  const protectedCourse = (await requestApi("/api/courses", {
    method: "POST",
    expectedStatus: 201,
    json: { code: "COURSE_DELETE_PROTECTED", catalog: null, sectionCount: 1 },
  })).body;
  const protectedSetup = await requestApi(`/api/courses/${protectedCourse.id}`, {
    method: "PATCH",
    json: {
      revision: protectedCourse.revision,
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
  const protectedSection = (await requestApi(`/api/courses/${protectedCourse.id}/sections`)).body[0];
  let protectedAssignment = await requestApi(`/api/course-sections/${protectedSection.id}`, {
    method: "PATCH",
    json: { teacherId: protectedTeacher.id, studentGroupIds: [protectedGroup.id], revision: protectedSection.revision },
  });
  const protectedLesson = (await requestApi("/api/schedule/lessons", {
    method: "POST",
    expectedStatus: 201,
    json: { sectionId: protectedSection.id, occurrence: 1, dayOfWeek: 5, startHour: 8, roomId: null },
  })).body;

  let protectedSnapshot = readBusinessSnapshot();
  const scheduledDelete = await requestApi(`/api/courses/${protectedCourse.id}`, {
    method: "DELETE",
    expectedStatus: 409,
    json: { revision: protectedSetup.body.revision },
  });
  assert.equal(scheduledDelete.body.code, "COURSE_IN_USE");
  assert.match(scheduledDelete.body.error, /scheduled/i);
  assert.deepEqual(readBusinessSnapshot(), protectedSnapshot);
  await requestApi(`/api/schedule/lessons/${protectedLesson.id}?revision=${protectedLesson.revision}`, { method: "DELETE" });

  protectedSnapshot = readBusinessSnapshot();
  const groupedDelete = await requestApi(`/api/courses/${protectedCourse.id}`, {
    method: "DELETE",
    expectedStatus: 409,
    json: { revision: protectedSetup.body.revision },
  });
  assert.equal(groupedDelete.body.code, "COURSE_IN_USE");
  assert.match(groupedDelete.body.error, /student groups/i);
  assert.deepEqual(readBusinessSnapshot(), protectedSnapshot);
  protectedAssignment = await requestApi(`/api/course-sections/${protectedSection.id}`, {
    method: "PATCH",
    json: { teacherId: protectedTeacher.id, studentGroupIds: [], revision: protectedAssignment.body.revision },
  });

  protectedSnapshot = readBusinessSnapshot();
  const manualTeacherDelete = await requestApi(`/api/courses/${protectedCourse.id}`, {
    method: "DELETE",
    expectedStatus: 409,
    json: { revision: protectedSetup.body.revision },
  });
  assert.equal(manualTeacherDelete.body.code, "COURSE_IN_USE");
  assert.match(manualTeacherDelete.body.error, /manually maintained teacher/i);
  assert.deepEqual(readBusinessSnapshot(), protectedSnapshot);
  protectedAssignment = await requestApi(`/api/course-sections/${protectedSection.id}`, {
    method: "PATCH",
    json: { teacherId: null, studentGroupIds: [], revision: protectedAssignment.body.revision },
  });
  assert.equal(protectedAssignment.body.changed, true);
  await requestApi(`/api/courses/${protectedCourse.id}`, {
    method: "DELETE",
    json: { revision: protectedSetup.body.revision },
  });
  report("Course 删除 CAS／关系保护／自动子资料级联，以及 section 自动教师安全缩减");
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
  assert.equal(teacherA.revision, 1);
  assert.equal(teacherB.revision, 1);
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
  assert.equal(studentGroup.revision, 1);
  await requestApi("/api/student-groups", {
    method: "POST",
    expectedStatus: 409,
    json: { code: "AAA_2", year: 2, program: "AAA" },
  });
  // 班级编号只在同一年级内唯一：三个年级都能拥有 AAA_2，且每一条都有独立
  // 稳定 ID。后续筛选和班次关联必须使用这些 ID，不能再用 code 猜是哪一年级。
  const sameCodeYearOne = (await requestApi("/api/student-groups", {
    method: "POST",
    expectedStatus: 201,
    json: { code: "AAA_2", year: 1, program: "AAA" },
  })).body;
  const sameCodeYearThree = (await requestApi("/api/student-groups", {
    method: "POST",
    expectedStatus: 201,
    json: { code: "AAA_2", year: 3, program: "AAA" },
  })).body;
  assert.notEqual(sameCodeYearOne.id, studentGroup.id);
  assert.notEqual(sameCodeYearThree.id, studentGroup.id);
  assert.notEqual(sameCodeYearOne.id, sameCodeYearThree.id);
  const sameCodeGroups = (await requestApi("/api/student-groups")).body
    .filter((group) => group.code === "AAA_2");
  assert.deepEqual(sameCodeGroups.map((group) => group.year), [1, 2, 3]);

  // 完全未被使用的误建班级允许管理员删除。删除同样消费 revision：旧页面即使
  // 想删除的最终状态相同，也必须先刷新；未知数据库故障则固定500且零写入。
  const deletableGroup = (await requestApi("/api/student-groups", {
    method: "POST",
    expectedStatus: 201,
    json: { code: "DELETE_ME", year: 3, program: "TEST" },
  })).body;
  const stateBeforeInvalidGroupDelete = readBusinessSnapshot();
  await requestApi(`/api/student-groups/${deletableGroup.id}`, {
    method: "DELETE",
    expectedStatus: 400,
    json: { revision: "1" },
  });
  assert.deepEqual(readBusinessSnapshot(), stateBeforeInvalidGroupDelete);
  const updatedDeletableGroup = await requestApi(`/api/student-groups/${deletableGroup.id}`, {
    method: "PATCH",
    json: { code: deletableGroup.code, year: deletableGroup.year, program: "TEST2", revision: deletableGroup.revision },
  });
  const stateBeforeStaleGroupDelete = readBusinessSnapshot();
  const staleGroupDelete = await requestApi(`/api/student-groups/${deletableGroup.id}`, {
    method: "DELETE",
    expectedStatus: 409,
    json: { revision: deletableGroup.revision },
  });
  assert.equal(staleGroupDelete.body.code, "MASTER_DATA_CHANGED");
  assert.deepEqual(readBusinessSnapshot(), stateBeforeStaleGroupDelete);
  executeTestDatabase((db) => {
    const groupIdLiteral = db.prepare("SELECT quote(?) AS value").get(deletableGroup.id).value;
    db.exec(`CREATE TRIGGER zz_fail_student_group_delete BEFORE DELETE ON student_groups WHEN OLD.id = ${groupIdLiteral} BEGIN SELECT RAISE(ABORT, 'forced student-group delete failure'); END;`);
  });
  try {
    const failedGroupDelete = await requestApi(`/api/student-groups/${deletableGroup.id}`, {
      method: "DELETE",
      expectedStatus: 500,
      json: { revision: updatedDeletableGroup.body.revision },
    });
    assert.deepEqual(failedGroupDelete.body, { error: "The student group could not be deleted. Try again." });
    assert.deepEqual(readBusinessSnapshot(), stateBeforeStaleGroupDelete);
  } finally {
    executeTestDatabase((db) => db.exec("DROP TRIGGER IF EXISTS zz_fail_student_group_delete"));
  }
  assert.deepEqual((await requestApi(`/api/student-groups/${deletableGroup.id}`, {
    method: "DELETE",
    json: { revision: updatedDeletableGroup.body.revision },
  })).body, { ok: true });
  await requestApi(`/api/student-groups/${deletableGroup.id}`, {
    method: "DELETE",
    expectedStatus: 404,
    json: { revision: updatedDeletableGroup.body.revision },
  });
  assert(!(await requestApi("/api/student-groups")).body.some((group) => group.id === deletableGroup.id));
  const room = (await requestApi("/api/rooms", {
    method: "POST",
    expectedStatus: 201,
    json: { code: "31-05-10", capacity: 20, hasLab: false, hasMultiProjector: false, isSmartClassroom: true },
  })).body;
  assert(room.features.includes("Multi projector"), "Smart classroom did not imply multi projector.");
  assert.equal(room.revision, 1);
  await requestApi("/api/rooms", {
    method: "POST",
    expectedStatus: 409,
    json: { code: "31-05-10", capacity: 20, hasLab: false, hasMultiProjector: false, isSmartClassroom: false },
  });

  // 三类基础资料都只接受 JSON 原生类型和统一上限；同值 PATCH 是真正 no-op，
  // 不改变 updated_at、warning 或 revision，也不会让其他账号的表单无故失效。
  const masterSnapshotBeforeNoOp = readBusinessSnapshot();
  const teacherNoOp = await requestApi(`/api/teachers/${teacherA.id}`, {
    method: "PATCH",
    json: { name: teacherA.name, staffType: teacherA.staffType, revision: teacherA.revision },
  });
  const groupNoOp = await requestApi(`/api/student-groups/${studentGroup.id}`, {
    method: "PATCH",
    json: { code: studentGroup.code, year: studentGroup.year, program: studentGroup.program, revision: studentGroup.revision },
  });
  const roomNoOp = await requestApi(`/api/rooms/${room.id}`, {
    method: "PATCH",
    json: {
      code: room.code,
      capacity: room.capacity,
      hasLab: room.features.includes("Lab"),
      hasMultiProjector: room.features.includes("Multi projector"),
      isSmartClassroom: room.features.includes("Smart classroom"),
      revision: room.revision,
    },
  });
  assert.deepEqual(teacherNoOp.body, { ok: true, revision: teacherA.revision, changed: false });
  assert.deepEqual(groupNoOp.body, { ok: true, revision: studentGroup.revision, changed: false });
  assert.deepEqual(roomNoOp.body, { ok: true, revision: room.revision, changed: false });
  assert.deepEqual(readBusinessSnapshot(), masterSnapshotBeforeNoOp);
  await requestApi("/api/teachers", { method: "POST", expectedStatus: 400, json: { name: 123, staffType: "FT" } });
  await requestApi("/api/teachers", { method: "POST", expectedStatus: 400, json: { name: "T".repeat(129), staffType: "FT" } });
  await requestApi("/api/student-groups", { method: "POST", expectedStatus: 400, json: { code: "NATIVE", year: "2", program: "TEST" } });
  await requestApi("/api/rooms", { method: "POST", expectedStatus: 400, json: { code: "99-99-99", capacity: 1_000_000, hasLab: false, hasMultiProjector: false, isSmartClassroom: false } });
  await requestApi(`/api/teachers/${teacherA.id}`, {
    method: "PATCH",
    expectedStatus: 400,
    json: { isActive: false, name: teacherA.name, staffType: teacherA.staffType, revision: teacherA.revision },
  });
  await requestApi(`/api/rooms/${room.id}`, {
    method: "PATCH",
    expectedStatus: 400,
    json: { isActive: false, code: room.code, capacity: room.capacity, hasLab: false, hasMultiProjector: true, isSmartClassroom: true, revision: room.revision },
  });
  const snapshotBeforeInvalidManualCourses = readBusinessSnapshot();
  const invalidManualCourses = [
    { code: 123, catalog: null, sectionCount: 1 },
    { code: "A".repeat(65), catalog: null, sectionCount: 1 },
    { code: "AUTO\nCONTROL", catalog: null, sectionCount: 1 },
    { code: "AUTO_BAD_CATALOG", catalog: 123, sectionCount: 1 },
    { code: "AUTO_LONG_CATALOG", catalog: "C".repeat(257), sectionCount: 1 },
    { code: "AUTO_CONTROL_CATALOG", catalog: "Bad\nCatalog", sectionCount: 1 },
    { code: "AUTO_STRING_COUNT", catalog: null, sectionCount: "2" },
    { code: "AUTO_FRACTION_COUNT", catalog: null, sectionCount: 1.5 },
    { code: "AUTO_LARGE_COUNT", catalog: null, sectionCount: 1_000 },
    { code: "AUTO_UNSAFE_COUNT", catalog: null, sectionCount: Number.MAX_SAFE_INTEGER + 1 },
  ];
  for (const json of invalidManualCourses) {
    await requestApi("/api/courses", { method: "POST", expectedStatus: 400, json });
  }
  assert.deepEqual(readBusinessSnapshot(), snapshotBeforeInvalidManualCourses);
  const course = (await requestApi("/api/courses", {
    method: "POST",
    expectedStatus: 201,
    json: { code: "auto_crud", catalog: "  CRUD regression  ", sectionCount: 2 },
  })).body;
  assert.equal(course.code, "AUTO_CRUD");
  assert.equal(course.catalog, "CRUD regression");
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
  assert.equal(firstAssignment.body.changed, true);

  // 当前班次仍引用的班级绝不能级联删除；409 必须保留关联和所有业务资料。
  const stateBeforeProtectedGroupDelete = readBusinessSnapshot();
  const protectedGroupDelete = await requestApi(`/api/student-groups/${studentGroup.id}`, {
    method: "DELETE",
    expectedStatus: 409,
    json: { revision: studentGroup.revision },
  });
  assert.equal(protectedGroupDelete.body.code, "STUDENT_GROUP_IN_USE");
  assert.match(protectedGroupDelete.body.error, /course section/i);
  assert.deepEqual(readBusinessSnapshot(), stateBeforeProtectedGroupDelete);

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
  const assignmentSnapshotBeforeStrictInput = readBusinessSnapshot();
  const invalidAssignments = [
    { teacherId: "", studentGroupIds: [studentGroup.id], revision: firstAssignment.body.revision },
    { teacherId: `${teacherA.id}\n`, studentGroupIds: [studentGroup.id], revision: firstAssignment.body.revision },
    { teacherId: teacherA.id, studentGroupIds: [studentGroup.id, studentGroup.id], revision: firstAssignment.body.revision },
    { teacherId: teacherA.id, studentGroupIds: [""], revision: firstAssignment.body.revision },
    { teacherId: teacherA.id, studentGroupIds: ["G".repeat(129)], revision: firstAssignment.body.revision },
    { teacherId: teacherA.id, studentGroupIds: [studentGroup.id], revision: Number.MAX_SAFE_INTEGER + 1 },
  ];
  for (const json of invalidAssignments) {
    await requestApi(`/api/course-sections/${section.id}`, { method: "PATCH", expectedStatus: 400, json });
  }
  await requestApi(`/api/course-sections/${section.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      teacherId: teacherA.id,
      studentGroupIds: [studentGroup.id],
      revision: firstAssignment.body.revision,
      padding: "x".repeat(70 * 1_024),
    }),
    expectedStatus: 413,
  });
  assert.deepEqual(readBusinessSnapshot(), assignmentSnapshotBeforeStrictInput);
  let sectionAfterRejectedAssignments = (await requestApi(`/api/courses/${course.id}/sections`)).body[0];
  assert.equal(sectionAfterRejectedAssignments.teacherId, teacherA.id);
  assert.deepEqual(sectionAfterRejectedAssignments.studentGroupIds, [studentGroup.id]);
  assert.equal(sectionAfterRejectedAssignments.revision, firstAssignment.body.revision);

  const winningAssignment = await requestApi(`/api/course-sections/${section.id}`, {
    method: "PATCH",
    json: { teacherId: teacherB.id, studentGroupIds: [studentGroup.id], revision: firstAssignment.body.revision },
  });
  assert.equal(winningAssignment.body.revision, 3);
  assert.equal(winningAssignment.body.changed, true);
  await requestApi(`/api/course-sections/${section.id}`, {
    method: "PATCH",
    expectedStatus: 409,
    json: { teacherId: teacherA.id, studentGroupIds: [], revision: firstAssignment.body.revision },
  });
  sections = (await requestApi(`/api/courses/${course.id}/sections`)).body;
  assert.equal(sections[0].teacherId, teacherB.id);
  assert.deepEqual(sections[0].studentGroupIds, [studentGroup.id]);
  assert.equal(sections[0].revision, winningAssignment.body.revision);
  const sameCodeTray = (await requestApi("/api/schedule/unscheduled?year=1")).body
    .find((item) => item.sectionId === section.id && item.occurrence === 1);
  assert(sameCodeTray, "The configured section did not enter the Year 1 unscheduled tray.");
  assert.deepEqual(sameCodeTray.studentGroupIds, [studentGroup.id]);
  assert(!sameCodeTray.studentGroupIds.includes(sameCodeYearOne.id));
  assert(!sameCodeTray.studentGroupIds.includes(sameCodeYearThree.id));

  // 班次数量增加后会建立新尾部班次；未分配、未排课的尾部班次可以安全删除，
  // 低编号班次 ID、教师和学生班级必须保持不变。
  const revisionBeforeGrowth = courseRevision;
  const grownCourse = await requestApi(`/api/courses/${course.id}/sections`, {
    method: "PATCH",
    json: { sectionCount: 3, revision: courseRevision },
  });
  courseRevision = grownCourse.body.revision;
  assert.deepEqual(grownCourse.body, { ok: true, revision: revisionBeforeGrowth + 1, changed: true });
  const staleGrowth = await requestApi(`/api/courses/${course.id}/sections`, {
    method: "PATCH",
    expectedStatus: 409,
    json: { sectionCount: 4, revision: revisionBeforeGrowth },
  });
  assert.equal(staleGrowth.body.code, "COURSE_SETUP_CHANGED");
  const resizeNoOpSnapshot = readBusinessSnapshot();
  const resizeNoOp = await requestApi(`/api/courses/${course.id}/sections`, {
    method: "PATCH",
    json: { sectionCount: 3, revision: courseRevision },
  });
  assert.deepEqual(resizeNoOp.body, { ok: true, revision: courseRevision, changed: false });
  assert.deepEqual(readBusinessSnapshot(), resizeNoOpSnapshot);
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
    json: { sectionCount: 2, revision: courseRevision },
  });
  assert.equal(protectedResize.body.code, "COURSE_SECTION_IN_USE");
  assert.match(protectedResize.body.error, /manually maintained teacher/i);
  const sectionsAfterProtectedResize = (await requestApi(`/api/courses/${course.id}/sections`)).body;
  assert.equal(sectionsAfterProtectedResize.length, 3);
  assert.equal(sectionsAfterProtectedResize[2].id, tailSection.id);
  assert.equal(sectionsAfterProtectedResize[2].teacherId, teacherA.id);
  assert.equal(sectionsAfterProtectedResize[2].revision, protectedTail.body.revision);

  let tailAssignment = await requestApi(`/api/course-sections/${tailSection.id}`, {
    method: "PATCH",
    json: { teacherId: null, studentGroupIds: [], revision: protectedTail.body.revision },
  });
  tailAssignment = await requestApi(`/api/course-sections/${tailSection.id}`, {
    method: "PATCH",
    json: { teacherId: null, studentGroupIds: [sameCodeYearOne.id], revision: tailAssignment.body.revision },
  });
  const stateBeforeGroupedTailResize = readBusinessSnapshot();
  const groupedTailResize = await requestApi(`/api/courses/${course.id}/sections`, {
    method: "PATCH",
    expectedStatus: 409,
    json: { sectionCount: 2, revision: courseRevision },
  });
  assert.equal(groupedTailResize.body.code, "COURSE_SECTION_IN_USE");
  assert.match(groupedTailResize.body.error, /student groups/i);
  assert.deepEqual(readBusinessSnapshot(), stateBeforeGroupedTailResize);
  tailAssignment = await requestApi(`/api/course-sections/${tailSection.id}`, {
    method: "PATCH",
    json: { teacherId: null, studentGroupIds: [], revision: tailAssignment.body.revision },
  });

  // 尾班一旦进入总表，即使它来自本次手工增长也不能被数量修正级联移除。
  // Return to tray 后仍须清除人工教师，最后一次 shrink 才能提交。
  tailAssignment = await requestApi(`/api/course-sections/${tailSection.id}`, {
    method: "PATCH",
    json: { teacherId: teacherA.id, studentGroupIds: [], revision: tailAssignment.body.revision },
  });
  const scheduledTailLesson = (await requestApi("/api/schedule/lessons", {
    method: "POST",
    expectedStatus: 201,
    json: { sectionId: tailSection.id, occurrence: 1, dayOfWeek: 5, startHour: 8, roomId: null },
  })).body;
  const stateBeforeScheduledTailResize = readBusinessSnapshot();
  const scheduledTailResize = await requestApi(`/api/courses/${course.id}/sections`, {
    method: "PATCH",
    expectedStatus: 409,
    json: { sectionCount: 2, revision: courseRevision },
  });
  assert.equal(scheduledTailResize.body.code, "COURSE_SECTION_IN_USE");
  assert.match(scheduledTailResize.body.error, /scheduled/i);
  assert.deepEqual(readBusinessSnapshot(), stateBeforeScheduledTailResize);
  await requestApi(`/api/schedule/lessons/${scheduledTailLesson.id}?revision=${scheduledTailLesson.revision}`, { method: "DELETE" });
  tailAssignment = await requestApi(`/api/course-sections/${tailSection.id}`, {
    method: "PATCH",
    json: { teacherId: null, studentGroupIds: [], revision: tailAssignment.body.revision },
  });
  assert.equal(tailAssignment.body.changed, true);
  const shrunkCourse = await requestApi(`/api/courses/${course.id}/sections`, {
    method: "PATCH",
    json: { sectionCount: 2, revision: courseRevision },
  });
  courseRevision = shrunkCourse.body.revision;
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
  const snapshotBeforeInvalidPlacements = readBusinessSnapshot();
  const invalidPlacements = [
    { sectionId: "", occurrence: 1, dayOfWeek: 1, startHour: 9, roomId: room.id },
    { sectionId: section.id, occurrence: "1", dayOfWeek: 1, startHour: 9, roomId: room.id },
    { sectionId: section.id, occurrence: 1, dayOfWeek: 1.5, startHour: 9, roomId: room.id },
    { sectionId: section.id, occurrence: 1, dayOfWeek: 1, startHour: 9.5, roomId: room.id },
    { sectionId: section.id, occurrence: 1, dayOfWeek: 1, startHour: 9, roomId: "" },
    { sectionId: section.id, occurrence: 1, dayOfWeek: 1, startHour: 9, roomId: "R".repeat(129) },
  ];
  for (const json of invalidPlacements) {
    await requestApi("/api/schedule/lessons", { method: "POST", expectedStatus: 400, json });
  }
  assert.deepEqual(readBusinessSnapshot(), snapshotBeforeInvalidPlacements);
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
  assert.equal(movedLesson.changed, true);

  // 同值请求也必须先执行 CAS：班次和课程位置分别携带旧 revision、但 desired
  // 完全等于当前数据库内容时，仍返回 409，不能被 no-op 分支错误地当成成功。
  const sectionAfterLessonMove = (await requestApi(`/api/courses/${course.id}/sections`)).body
    .find((item) => item.id === section.id);
  assert(sectionAfterLessonMove, "The moved lesson section could not be reloaded.");
  const beforeStaleSameValueUpdates = readBusinessSnapshot();
  const staleSameSection = await requestApi(`/api/course-sections/${section.id}`, {
    method: "PATCH",
    expectedStatus: 409,
    json: {
      teacherId: sectionAfterLessonMove.teacherId,
      studentGroupIds: sectionAfterLessonMove.studentGroupIds,
      revision: winningAssignment.body.revision,
    },
  });
  assert.match(staleSameSection.body.error, /changed by another scheduler/i);
  const staleSameLesson = await requestApi(`/api/schedule/lessons/${lessonOne.id}`, {
    method: "PATCH",
    expectedStatus: 409,
    json: {
      dayOfWeek: movedLesson.dayOfWeek,
      startHour: movedLesson.startHour,
      roomId: movedLesson.roomId,
      teacherId: movedLesson.teacherId,
      studentGroupIds: movedLesson.studentGroupIds,
      revision: lessonOne.revision,
    },
  });
  assert.equal(staleSameLesson.body.code, "SCHEDULED_LESSON_CHANGED");
  assert.deepEqual(readBusinessSnapshot(), beforeStaleSameValueUpdates);

  // 班次同值保存不得执行 section UPDATE，也不得刷新任何现有 lesson warning。
  // 两个数据库 trigger 会让任一隐藏写入直接 500；完整快照再覆盖 revision、关联和 warning。
  const beforeSectionNoOp = readBusinessSnapshot();
  executeTestDatabase((db) => db.exec(`
    CREATE TRIGGER zz_course_section_no_op_must_not_update
    BEFORE UPDATE ON course_sections
    BEGIN
      SELECT RAISE(ABORT, 'course-section no-op unexpectedly executed UPDATE');
    END;
    CREATE TRIGGER zz_course_section_no_op_must_not_refresh_warning
    BEFORE UPDATE OF warnings_json ON scheduled_lessons
    BEGIN
      SELECT RAISE(ABORT, 'course-section no-op unexpectedly refreshed warnings');
    END;
  `));
  try {
    const sectionNoOp = await requestApi(`/api/course-sections/${section.id}`, {
      method: "PATCH",
      json: {
        teacherId: sectionAfterLessonMove.teacherId,
        studentGroupIds: sectionAfterLessonMove.studentGroupIds,
        revision: sectionAfterLessonMove.revision,
      },
    });
    assert.equal(sectionNoOp.body.ok, true);
    assert.equal(sectionNoOp.body.revision, sectionAfterLessonMove.revision);
    assert.equal(sectionNoOp.body.changed, false);
    assert(Array.isArray(sectionNoOp.body.allocationVariances));
    assert.deepEqual(readBusinessSnapshot(), beforeSectionNoOp);
  } finally {
    executeTestDatabase((db) => db.exec(`
      DROP TRIGGER IF EXISTS zz_course_section_no_op_must_not_update;
      DROP TRIGGER IF EXISTS zz_course_section_no_op_must_not_refresh_warning;
    `));
  }

  // Inspector 同值保存还需证明不会触碰共享班次、班级关联、目标／其他课次，或运行
  // warning 刷新。四类 abort trigger 配合完整快照，比只观察 revision 更严格。
  const beforeLessonNoOp = readBusinessSnapshot();
  executeTestDatabase((db) => db.exec(`
    CREATE TRIGGER zz_lesson_no_op_must_not_update_lesson
    BEFORE UPDATE ON scheduled_lessons
    BEGIN
      SELECT RAISE(ABORT, 'lesson no-op unexpectedly updated a lesson or warning');
    END;
    CREATE TRIGGER zz_lesson_no_op_must_not_update_section
    BEFORE UPDATE ON course_sections
    BEGIN
      SELECT RAISE(ABORT, 'lesson no-op unexpectedly updated its section');
    END;
    CREATE TRIGGER zz_lesson_no_op_must_not_delete_group
    BEFORE DELETE ON section_student_groups
    BEGIN
      SELECT RAISE(ABORT, 'lesson no-op unexpectedly deleted a student group');
    END;
    CREATE TRIGGER zz_lesson_no_op_must_not_insert_group
    BEFORE INSERT ON section_student_groups
    BEGIN
      SELECT RAISE(ABORT, 'lesson no-op unexpectedly inserted a student group');
    END;
  `));
  try {
    const lessonNoOp = await requestApi(`/api/schedule/lessons/${lessonOne.id}`, {
      method: "PATCH",
      json: {
        dayOfWeek: movedLesson.dayOfWeek,
        startHour: movedLesson.startHour,
        roomId: movedLesson.roomId,
        teacherId: movedLesson.teacherId,
        studentGroupIds: movedLesson.studentGroupIds,
        revision: movedLesson.revision,
      },
    });
    const { changed: originalChanged, ...movedLessonRecord } = movedLesson;
    const { changed: noOpChanged, ...noOpLessonRecord } = lessonNoOp.body;
    assert.equal(originalChanged, true);
    assert.equal(noOpChanged, false);
    assert.deepEqual(noOpLessonRecord, movedLessonRecord);
    assert.deepEqual(readBusinessSnapshot(), beforeLessonNoOp);
  } finally {
    executeTestDatabase((db) => db.exec(`
      DROP TRIGGER IF EXISTS zz_lesson_no_op_must_not_update_lesson;
      DROP TRIGGER IF EXISTS zz_lesson_no_op_must_not_update_section;
      DROP TRIGGER IF EXISTS zz_lesson_no_op_must_not_delete_group;
      DROP TRIGGER IF EXISTS zz_lesson_no_op_must_not_insert_group;
    `));
  }

  const snapshotBeforeInvalidLessonUpdates = readBusinessSnapshot();
  const invalidLessonUpdates = [
    { dayOfWeek: 2.5, startHour: 10, roomId: room.id, teacherId: teacherA.id, studentGroupIds: [studentGroup.id], revision: movedLesson.revision },
    { dayOfWeek: 2, startHour: 10.5, roomId: room.id, teacherId: teacherA.id, studentGroupIds: [studentGroup.id], revision: movedLesson.revision },
    { dayOfWeek: 2, startHour: 10, roomId: "", teacherId: teacherA.id, studentGroupIds: [studentGroup.id], revision: movedLesson.revision },
    { dayOfWeek: 2, startHour: 10, roomId: room.id, teacherId: "", studentGroupIds: [studentGroup.id], revision: movedLesson.revision },
    { dayOfWeek: 2, startHour: 10, roomId: room.id, teacherId: teacherA.id, studentGroupIds: [studentGroup.id, studentGroup.id], revision: movedLesson.revision },
    { dayOfWeek: 2, startHour: 10, roomId: room.id, teacherId: teacherA.id, studentGroupIds: [studentGroup.id], revision: Number.MAX_SAFE_INTEGER + 1 },
  ];
  for (const json of invalidLessonUpdates) {
    await requestApi(`/api/schedule/lessons/${lessonOne.id}`, { method: "PATCH", expectedStatus: 400, json });
  }
  assert.deepEqual(readBusinessSnapshot(), snapshotBeforeInvalidLessonUpdates);
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
  const inactiveRoomStatus = await requestApi(`/api/rooms/${inactiveRoom.id}`, {
    method: "PATCH",
    json: { isActive: false, revision: inactiveRoom.revision },
  });
  inactiveRoom.revision = inactiveRoomStatus.body.revision;
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
  const teacherRevisionBeforeRename = teacherA.revision;
  const renamedTeacher = await requestApi(`/api/teachers/${teacherA.id}`, {
    method: "PATCH",
    json: { name: "auto teacher renamed", staffType: "PT", revision: teacherA.revision },
  });
  teacherA.revision = renamedTeacher.body.revision;
  const staleTeacher = await requestApi(`/api/teachers/${teacherA.id}`, {
    method: "PATCH",
    expectedStatus: 409,
    json: { name: "AUTO STALE TEACHER", staffType: "FT", revision: teacherRevisionBeforeRename },
  });
  assert.equal(staleTeacher.body.code, "MASTER_DATA_CHANGED");

  const groupRevisionBeforeRename = studentGroup.revision;
  const renamedGroup = await requestApi(`/api/student-groups/${studentGroup.id}`, {
    method: "PATCH",
    json: { code: "aaa_02", year: 1, program: "aaa", revision: studentGroup.revision },
  });
  studentGroup.revision = renamedGroup.body.revision;
  const staleGroup = await requestApi(`/api/student-groups/${studentGroup.id}`, {
    method: "PATCH",
    expectedStatus: 409,
    json: { code: "AAA_STALE", year: 3, program: "STALE", revision: groupRevisionBeforeRename },
  });
  assert.equal(staleGroup.body.code, "MASTER_DATA_CHANGED");

  const roomRevisionBeforeRename = room.revision;
  const renamedRoom = await requestApi(`/api/rooms/${room.id}`, {
    method: "PATCH",
    json: { code: "32-06-20", capacity: 50, hasLab: true, hasMultiProjector: true, isSmartClassroom: false, revision: room.revision },
  });
  room.revision = renamedRoom.body.revision;
  const staleRoom = await requestApi(`/api/rooms/${room.id}`, {
    method: "PATCH",
    expectedStatus: 409,
    json: { code: "98-98-98", capacity: 20, hasLab: false, hasMultiProjector: false, isSmartClassroom: false, revision: roomRevisionBeforeRename },
  });
  assert.equal(staleRoom.body.code, "MASTER_DATA_CHANGED");
  let timetable = (await requestApi("/api/schedule/lessons?year=1")).body;
  let currentLessonOne = timetable.find((lesson) => lesson.id === lessonOne.id);
  assert.equal(currentLessonOne.teacherName, "AUTO TEACHER RENAMED");
  assert.deepEqual(currentLessonOne.studentGroups, ["AAA_02"]);
  assert.equal(currentLessonOne.roomCode, "32-06-20");

  // 停用教师和教室不能清空既有引用；warning 必须出现，重新启用后精确消失。
  const teacherDisabled = await requestApi(`/api/teachers/${teacherA.id}`, { method: "PATCH", json: { isActive: false, revision: teacherA.revision } });
  teacherA.revision = teacherDisabled.body.revision;
  timetable = (await requestApi("/api/schedule/lessons?year=1")).body;
  assert(timetable.find((lesson) => lesson.id === lessonOne.id).warnings.includes("Teacher is inactive"));
  const teacherEnabled = await requestApi(`/api/teachers/${teacherA.id}`, { method: "PATCH", json: { isActive: true, revision: teacherA.revision } });
  teacherA.revision = teacherEnabled.body.revision;
  const roomDisabled = await requestApi(`/api/rooms/${room.id}`, { method: "PATCH", json: { isActive: false, revision: room.revision } });
  room.revision = roomDisabled.body.revision;
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
  const roomEnabled = await requestApi(`/api/rooms/${room.id}`, { method: "PATCH", json: { isActive: true, revision: room.revision } });
  room.revision = roomEnabled.body.revision;
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
  await requestApi(`/api/courses/${course.id}`, { method: "PATCH", json: { ...baselineCourseSetup, minimumRoomCapacity: 1_000_000 }, expectedStatus: 400 });
  await requestApi(`/api/courses/${course.id}`, { method: "PATCH", json: { ...baselineCourseSetup, weekStart: 1, weekEnd: 53 }, expectedStatus: 400 });
  await requestApi(`/api/courses/${course.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...baselineCourseSetup, padding: "x".repeat(70 * 1_024) }),
    expectedStatus: 413,
  });
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
    json: { sectionCount: 1, revision: courseRevision },
  });
  await requestApi(`/api/schedule/lessons/${concurrentWinner.id}?revision=${concurrentWinner.revision}`, { method: "DELETE" });

  // 稳定 ID 是 opaque TEXT，不能假设其中没有冒号、空格、#、? 或 /。直接改成这类合法
  // fixture 后，用 encodeURIComponent 请求动态路径，并确认待排 payload 另带原始 sectionId。
  const opaqueSectionId = `${secondSection.id}:route id #?/`;
  executeTestDatabase((db) => {
    const updated = db.prepare("UPDATE course_sections SET id = ? WHERE id = ?").run(opaqueSectionId, secondSection.id);
    assert.equal(updated.changes, 1);
  });
  const opaqueCandidate = await requestApi(`/api/course-sections/${encodeURIComponent(opaqueSectionId)}/candidates?occurrence=1`, {
    expectedStatus: 400,
  });
  assert.match(opaqueCandidate.body.error, /active teacher/i);
  const unscheduled = (await requestApi("/api/schedule/unscheduled?year=1")).body;
  assert(unscheduled.some((item) => item.sectionId === opaqueSectionId && item.occurrence === 1));

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
  assert(workspace.unscheduledSections.every((section) => !workspace.lessons.some((lesson) => (
    lesson.sectionId === section.sectionId && lesson.occurrence === section.occurrence
  ))));
  await requestApi("/api/schedule/workspace?year=4", { expectedStatus: 400 });
  for (const pathname of ["/api/schedule/lessons", "/api/schedule/unscheduled", "/api/schedule/workspace"]) {
    for (const invalidYear of ["", "01", "1e0", "%2B1"]) {
      await requestApi(`${pathname}?year=${invalidYear}`, { expectedStatus: 400 });
    }
  }

  const finalResize = await requestApi(`/api/courses/${course.id}/sections`, {
    method: "PATCH",
    json: { sectionCount: 1, revision: courseRevision },
  });
  courseRevision = finalResize.body.revision;
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

async function verifyTeachingWeekRuleIsolation() {
  // 这个 fixture 专门保护“课程日期相同，但教学周不相同”的规则语义。
  // 所有资料都经 production CRUD API 建立；finally 只从本次临时数据库清理这些专用 ID。
  const fixtureIds = { courses: [], teacher: null, group: null, rooms: [] };

  const createConfiguredCourse = async ({ code, durationHours, weekStart, weekEnd }) => {
    const course = (await requestApi("/api/courses", {
      method: "POST",
      expectedStatus: 201,
      json: { code, catalog: "Teaching-week rule regression", sectionCount: 1 },
    })).body;
    fixtureIds.courses.push(course.id);
    await requestApi(`/api/courses/${course.id}`, {
      method: "PATCH",
      json: {
        revision: course.revision,
        durationHours,
        sessionsPerWeek: 1,
        primaryYear: 1,
        minimumRoomCapacity: 1,
        requiresLab: false,
        requiresMultiProjector: false,
        requiresSmartClassroom: false,
        separateSectionsAcrossDays: false,
        weekStart,
        weekEnd,
      },
    });
    const section = (await requestApi(`/api/courses/${course.id}/sections`)).body[0];
    const assignment = await requestApi(`/api/course-sections/${section.id}`, {
      method: "PATCH",
      json: {
        teacherId: fixtureIds.teacher.id,
        studentGroupIds: [fixtureIds.group.id],
        revision: section.revision,
      },
    });
    assert.equal(assignment.body.changed, true);
    return { course, section };
  };

  const placeFixtureLesson = async (sectionId, startHour, roomId, { dayOfWeek = 1, expectedStatus = 201 } = {}) => (
    await requestApi("/api/schedule/lessons", {
      method: "POST",
      expectedStatus,
      json: { sectionId, occurrence: 1, dayOfWeek, startHour, roomId },
    })
  ).body;

  try {
    fixtureIds.teacher = (await requestApi("/api/teachers", {
      method: "POST",
      expectedStatus: 201,
      json: { name: "auto teaching week teacher", staffType: "FT" },
    })).body;
    fixtureIds.group = (await requestApi("/api/student-groups", {
      method: "POST",
      expectedStatus: 201,
      json: { code: "WEEK_RULE_1", year: 1, program: "WEEK RULES" },
    })).body;
    const sameBlockRoom = (await requestApi("/api/rooms", {
      method: "POST",
      expectedStatus: 201,
      json: { code: "91-01-01", capacity: 50, hasLab: false, hasMultiProjector: false, isSmartClassroom: false },
    })).body;
    const otherBlockRoom = (await requestApi("/api/rooms", {
      method: "POST",
      expectedStatus: 201,
      json: { code: "92-01-01", capacity: 50, hasLab: false, hasMultiProjector: false, isSmartClassroom: false },
    })).body;
    fixtureIds.rooms.push(sameBlockRoom.id, otherBlockRoom.id);

    // W1–4 的 9:00–13:00 加 16:00–18:00，以及 W5–8 的 9:00–11:00、
    // 13:00–15:00、16:00–18:00，各自在真实周内都保留午餐且不超过规则上限。
    // 旧算法把两段互斥课程合起来，会错误得到连续六小时、十小时总量和无午餐。
    const earlyAdjacent = await createConfiguredCourse({ code: "AUTO_WEEK_A1", durationHours: 2, weekStart: 1, weekEnd: 4 });
    const earlyLate = await createConfiguredCourse({ code: "AUTO_WEEK_A2", durationHours: 2, weekStart: 1, weekEnd: 4 });
    const lateLunch = await createConfiguredCourse({ code: "AUTO_WEEK_B1", durationHours: 2, weekStart: 5, weekEnd: 8 });
    const lateLate = await createConfiguredCourse({ code: "AUTO_WEEK_B2", durationHours: 2, weekStart: 5, weekEnd: 8 });
    await placeFixtureLesson(earlyAdjacent.section.id, 11, sameBlockRoom.id);
    await placeFixtureLesson(earlyLate.section.id, 16, sameBlockRoom.id);
    await placeFixtureLesson(lateLunch.section.id, 13, sameBlockRoom.id);
    await placeFixtureLesson(lateLate.section.id, 16, sameBlockRoom.id);

    const proposed = await createConfiguredCourse({ code: "AUTO_WEEK_ALL", durationHours: 2, weekStart: null, weekEnd: null });
    const legalCandidates = (await requestApi(`/api/course-sections/${proposed.section.id}/candidates?occurrence=1`)).body;
    const exactLegalCandidate = legalCandidates.slots.find((slot) => (
      slot.dayOfWeek === 1 && slot.startHour === 9 && slot.roomId === sameBlockRoom.id
    ));
    assert(exactLegalCandidate, "W1–4 and W5–8 loads were incorrectly merged in candidate search.");

    // null/null 是 W1–52；每一个实际周都合法，所以 production POST 与随后全表刷新
    // 都必须保存完全相同的空 warning 清单。
    const proposedLesson = await placeFixtureLesson(proposed.section.id, 9, sameBlockRoom.id);
    assert.deepEqual(proposedLesson.warnings, []);
    const persistedLegalLesson = (await requestApi("/api/schedule/lessons?year=1")).body
      .find((lesson) => lesson.id === proposedLesson.id);
    assert(persistedLegalLesson, "The all-weeks regression lesson was not returned by the timetable API.");
    assert.deepEqual(persistedLegalLesson.warnings, []);

    // W4–4 与 W1–4 在端点 W4 同时生效。13:00–16:00 补齐连续时段与午餐，
    // 另一栋的 11:00–13:00 又与 proposed 背靠背；四类教师/班级规则都是真实违规。
    const weekFourLoad = await createConfiguredCourse({ code: "AUTO_WEEK_W4_LOAD", durationHours: 3, weekStart: 4, weekEnd: 4 });
    const weekFourTravel = await createConfiguredCourse({ code: "AUTO_WEEK_W4_TRAVEL", durationHours: 2, weekStart: 4, weekEnd: 4 });
    await placeFixtureLesson(weekFourLoad.section.id, 13, sameBlockRoom.id);
    await placeFixtureLesson(weekFourTravel.section.id, 11, otherBlockRoom.id);

    const persistedViolation = (await requestApi("/api/schedule/lessons?year=1")).body
      .find((lesson) => lesson.id === proposedLesson.id);
    const expectedWarnings = [
      "Teacher has no free lunch hour between 12:00 and 14:00",
      "Teacher has more than 4 continuous hours",
      "Teacher exceeds 7 teaching hours in one day",
      "Teacher has back-to-back lessons in different blocks",
      "WEEK_RULE_1 has no free lunch hour between 12:00 and 14:00",
      "WEEK_RULE_1 has more than 4 continuous hours",
      "WEEK_RULE_1 exceeds 6 class hours in one day",
      "WEEK_RULE_1 has back-to-back lessons in different blocks",
    ];
    assert.deepEqual([...persistedViolation.warnings].sort(), [...expectedWarnings].sort());
    for (const warning of expectedWarnings) {
      assert.equal(persistedViolation.warnings.filter((item) => item === warning).length, 1,
        `Teaching-week warning was not emitted exactly once: ${warning}`);
    }

    // Return to tray is the real DELETE path. The now-unscheduled section uses the same
    // calculatePlacementWarnings function, so its formerly legal exact slot must disappear while W4 violates.
    await requestApi(`/api/schedule/lessons/${proposedLesson.id}?revision=${persistedViolation.revision}`, { method: "DELETE" });
    const violatingCandidates = (await requestApi(`/api/course-sections/${proposed.section.id}/candidates?occurrence=1`)).body;
    assert(violatingCandidates.slots.length > 0, "The W4 fixture unexpectedly removed every candidate on all five days.");
    assert(!violatingCandidates.slots.some((slot) => (
      slot.dayOfWeek === 1 && slot.startHour === 9 && slot.roomId === sameBlockRoom.id
    )), "Candidate search did not apply the same W4 warning rules as persisted lessons.");

    // same_block 是成对规则，也必须明确保护周次边界：周二 W1–4 的 09:00 课程
    // 与 W5–8 另一栋的 11:00 课程互斥，W4–4 的同一位置则在端点真实相邻。
    const futureTravel = await createConfiguredCourse({ code: "AUTO_WEEK_TRAVEL_B", durationHours: 2, weekStart: 5, weekEnd: 8 });
    await placeFixtureLesson(futureTravel.section.id, 11, otherBlockRoom.id, { dayOfWeek: 2 });
    const proposedTravel = await createConfiguredCourse({ code: "AUTO_WEEK_TRAVEL_A", durationHours: 2, weekStart: 1, weekEnd: 4 });
    const legalTravelCandidates = (await requestApi(`/api/course-sections/${proposedTravel.section.id}/candidates?occurrence=1`)).body;
    assert(legalTravelCandidates.slots.some((slot) => (
      slot.dayOfWeek === 2 && slot.startHour === 9 && slot.roomId === sameBlockRoom.id
    )), "Mutually exclusive W1–4/W5–8 block changes were incorrectly treated as travel warnings.");
    const proposedTravelLesson = await placeFixtureLesson(proposedTravel.section.id, 9, sameBlockRoom.id, { dayOfWeek: 2 });
    assert.deepEqual(proposedTravelLesson.warnings, []);

    const endpointTravel = await createConfiguredCourse({ code: "AUTO_WEEK_TRAVEL_W4", durationHours: 2, weekStart: 4, weekEnd: 4 });
    await placeFixtureLesson(endpointTravel.section.id, 11, otherBlockRoom.id, { dayOfWeek: 2 });
    const persistedTravelViolation = (await requestApi("/api/schedule/lessons?year=1")).body
      .find((lesson) => lesson.id === proposedTravelLesson.id);
    assert.deepEqual(persistedTravelViolation.warnings.sort(), [
      "Teacher has back-to-back lessons in different blocks",
      "WEEK_RULE_1 has back-to-back lessons in different blocks",
    ].sort());
    await requestApi(`/api/schedule/lessons/${proposedTravelLesson.id}?revision=${persistedTravelViolation.revision}`, { method: "DELETE" });
    const violatingTravelCandidates = (await requestApi(`/api/course-sections/${proposedTravel.section.id}/candidates?occurrence=1`)).body;
    assert(!violatingTravelCandidates.slots.some((slot) => (
      slot.dayOfWeek === 2 && slot.startHour === 9 && slot.roomId === sameBlockRoom.id
    )), "Candidate search omitted the real W4 persisted same-block warning.");

    report("教学周 W1–4/W5–8 隔离、W4 包含端点及候选/持久 warning 一致性");
  } finally {
    // Courses own sections, links and lessons through ON DELETE CASCADE. Removing them first
    // lets the dedicated teacher/group/rooms be deleted without touching any earlier CRUD fixture.
    executeTestDatabase((db) => {
      const cleanup = db.transaction(() => {
        const deleteCourse = db.prepare("DELETE FROM courses WHERE id = ?");
        for (const courseId of fixtureIds.courses) deleteCourse.run(courseId);
        if (fixtureIds.teacher?.id) db.prepare("DELETE FROM teachers WHERE id = ?").run(fixtureIds.teacher.id);
        if (fixtureIds.group?.id) db.prepare("DELETE FROM student_groups WHERE id = ?").run(fixtureIds.group.id);
        const deleteRoom = db.prepare("DELETE FROM rooms WHERE id = ?");
        for (const roomId of fixtureIds.rooms) deleteRoom.run(roomId);
      });
      cleanup.immediate();
    });
  }
}

async function verifyManagementSnapshots(ids) {
  // Management 页面会同时消费四组基础资料；一次 workspace 请求必须与四个既有
  // 清单接口表达完全相同的已提交版本。先验证身份边界，避免新聚合路由意外绕过
  // 全站 proxy，让未登录访客读取教师、班级、教室或课程资料。
  await requestApi("/api/data-management/workspace", { authenticated: false, expectedStatus: 401 });
  await requestApi(`/api/courses/${ids.courseId}/workspace`, { authenticated: false, expectedStatus: 401 });

  const snapshotBeforeSuccessfulReads = readBusinessSnapshot();
  const managementWorkspace = await requestApi("/api/data-management/workspace");
  assert.deepEqual(Object.keys(managementWorkspace.body).sort(), ["courses", "groups", "rooms", "teachers"]);
  const [teachers, groups, rooms, courses] = await Promise.all([
    requestApi("/api/teachers"),
    requestApi("/api/student-groups"),
    requestApi("/api/rooms"),
    requestApi("/api/courses"),
  ]);
  assert.deepEqual(managementWorkspace.body.teachers, teachers.body);
  assert.deepEqual(managementWorkspace.body.groups, groups.body);
  assert.deepEqual(managementWorkspace.body.rooms, rooms.body);
  assert.deepEqual(managementWorkspace.body.courses, courses.body);

  async function assertCourseWorkspaceMatchesExistingApis(course) {
    const workspace = await requestApi(`/api/courses/${course.id}/workspace`);
    assert.deepEqual(Object.keys(workspace.body).sort(), ["allocationVariances", "currentCourse", "sections"]);
    const [sections, allocationVariances] = await Promise.all([
      requestApi(`/api/courses/${course.id}/sections`),
      requestApi(`/api/courses/${course.id}/allocation`),
    ]);
    assert.deepEqual(workspace.body.currentCourse, course);
    assert.deepEqual(workspace.body.sections, sections.body);
    assert.deepEqual(workspace.body.allocationVariances, allocationVariances.body);
    return workspace.body;
  }

  // AUTO_CRUD 是纯人工课程：它已有教师、学生班级和排课关系，却从未建立
  // teaching_allocations。聚合接口必须沿用既有 variance 语义并返回空数组，不能把
  // 人工指派误报成“超出 Excel baseline”。
  const manualCourse = courses.body.find((course) => course.id === ids.courseId);
  assert(manualCourse, "The manual course fixture was not present in the management snapshot.");
  const manualWorkspace = await assertCourseWorkspaceMatchesExistingApis(manualCourse);
  assert(manualWorkspace.sections.some((section) => section.teacherId !== null));
  assert.deepEqual(manualWorkspace.allocationVariances, []);

  // 稳定来源键回归中的课程已把 Excel baseline 从 Source A 换成 Source B，之后只
  // 人工修改了教师显示名。两节自动班仍必须关联同一稳定教师 ID，且 baseline 与
  // actual 相等，因此 workspace 不应产生虚假 variance。
  const sourceCourse = courses.body.find((course) => course.code === "AUTO_IMPORT_REVISION");
  const sourceTeacher = teachers.body.find((teacher) => teacher.name === "AUTO REVISION DISPLAY NAME");
  assert(sourceCourse && sourceTeacher, "The imported source-key workspace fixtures were not found.");
  const sourceWorkspace = await assertCourseWorkspaceMatchesExistingApis(sourceCourse);
  assert.equal(sourceWorkspace.sections.length, 2);
  assert(sourceWorkspace.sections.every((section) => section.teacherId === sourceTeacher.id));
  assert.deepEqual(sourceWorkspace.allocationVariances, []);

  // AUTO_REIMPORT 刻意保留一班 Excel baseline 教师，并把另一班人工换给替代教师。
  // 聚合结果必须同时呈现“baseline 少一班”和“替代教师多一班”，且 section 关联与
  // variance 中的教师 ID 一致，不能在多个 SELECT 之间拼出不可能的组合。
  const substitutedCourse = courses.body.find((course) => course.code === "AUTO_REIMPORT");
  const baselineTeacher = teachers.body.find((teacher) => teacher.name === "AUTO ALLOCATION TEACHER");
  const substituteTeacher = teachers.body.find((teacher) => teacher.name === "AUTO MANUAL TEACHER");
  assert(substitutedCourse && baselineTeacher && substituteTeacher, "The imported substitution workspace fixtures were not found.");
  const substitutedWorkspace = await assertCourseWorkspaceMatchesExistingApis(substitutedCourse);
  assert.equal(substitutedWorkspace.sections.length, 2);
  assert(substitutedWorkspace.sections.some((section) => section.teacherId === baselineTeacher.id));
  assert(substitutedWorkspace.sections.some((section) => section.teacherId === substituteTeacher.id));
  assert.deepEqual(
    substitutedWorkspace.allocationVariances.find((variance) => variance.teacherId === baselineTeacher.id),
    {
      teacherId: baselineTeacher.id,
      teacherName: baselineTeacher.name,
      expectedSections: 2,
      actualSections: 1,
    },
  );
  assert.deepEqual(
    substitutedWorkspace.allocationVariances.find((variance) => variance.teacherId === substituteTeacher.id),
    {
      teacherId: substituteTeacher.id,
      teacherName: substituteTeacher.name,
      expectedSections: 0,
      actualSections: 1,
    },
  );

  // 不存在的课程是稳定404，而不是 currentCourse:null 的半对象；精确 JSON 合同让
  // 页面能区分“用户选择已过期”与服务器内部故障。
  const missingCourse = await requestApi(`/api/courses/${randomUUID()}/workspace`, { expectedStatus: 404 });
  assert.deepEqual(missingCourse.body, { error: "Course not found." });
  assert.deepEqual(readBusinessSnapshot(), snapshotBeforeSuccessfulReads);

  async function expectSafeWorkspaceReadFailure(pathname, hideSql, restoreSql) {
    const beforeFailure = readBusinessSnapshot();
    executeTestDatabase((db) => db.exec(hideSql));
    let failed;
    try {
      failed = await requestApi(pathname, { expectedStatus: 500 });
    } finally {
      executeTestDatabase((db) => db.exec(restoreSql));
    }
    assert.deepEqual(Object.keys(failed.body), ["error"]);
    assert.equal(typeof failed.body.error, "string");
    assert(failed.body.error.length > 0 && failed.body.error.length <= 200);
    assert(
      !/sqlite|database|select\b|from\b|join\b|pragma|no such|table|column|constraint|trigger|\.db\b|\/(?:api|users|private|tmp)\//i
        .test(JSON.stringify(failed.body)),
      `${pathname} leaked SQL, schema or filesystem details.`,
    );
    assert.deepEqual(readBusinessSnapshot(), beforeFailure, `${pathname} changed business data after a read failure.`);
  }

  // 临时隐藏聚合查询必需的表，制造真实、未知 SQLite 故障。路由只能返回固定安全
  // 500；恢复表名后的完整业务快照必须逐字段相同，证明 GET 没有夹带初始化或修复写入。
  await expectSafeWorkspaceReadFailure(
    "/api/data-management/workspace",
    "ALTER TABLE rooms RENAME TO rooms_management_workspace_hidden",
    "ALTER TABLE rooms_management_workspace_hidden RENAME TO rooms",
  );
  await expectSafeWorkspaceReadFailure(
    `/api/courses/${substitutedCourse.id}/workspace`,
    "ALTER TABLE teaching_allocations RENAME TO teaching_allocations_course_workspace_hidden",
    "ALTER TABLE teaching_allocations_course_workspace_hidden RENAME TO teaching_allocations",
  );
  report("Management／Course workspace 聚合一致性、导入关联、身份边界与安全500");
}

async function verifyRulesWorkspaceContracts(ids) {
  const workspacePath = "/api/rules/workspace";
  await requestApi(workspacePath, { authenticated: false, expectedStatus: 401 });

  // Rules 页面只接受这一个四数组聚合。静止状态下它必须逐字段等于四条旧清单接口，
  // 并且受保护 GET 不能更新 warning、revision、timestamp、账号或会话。
  const snapshotBeforeAggregateReads = readBusinessSnapshot();
  const sessionsBeforeAggregateReads = executeTestDatabase((db) => (
    db.prepare("SELECT * FROM auth_sessions ORDER BY token_hash").all()
  ));
  const workspace = await requestApi(workspacePath);
  assert.deepEqual(Object.keys(workspace.body).sort(), ["issues", "ruleSettings", "teachers", "unavailableWindows"]);
  for (const key of ["issues", "ruleSettings", "teachers", "unavailableWindows"]) {
    assert(Array.isArray(workspace.body[key]), `Rules workspace ${key} must be an array.`);
  }
  const [unavailableWindows, issues, ruleSettings, teachers] = await Promise.all([
    requestApi("/api/unavailability"),
    requestApi("/api/issues"),
    requestApi("/api/rule-settings"),
    requestApi("/api/teachers"),
  ]);
  assert.deepEqual(workspace.body.unavailableWindows, unavailableWindows.body);
  assert.deepEqual(workspace.body.issues, issues.body);
  assert.deepEqual(workspace.body.ruleSettings, ruleSettings.body);
  assert.deepEqual(workspace.body.teachers, teachers.body);
  assert.deepEqual(readBusinessSnapshot(), snapshotBeforeAggregateReads);
  assert.deepEqual(
    executeTestDatabase((db) => db.prepare("SELECT * FROM auth_sessions ORDER BY token_hash").all()),
    sessionsBeforeAggregateReads,
  );

  // route 必须使用与 database export 相同的严格 parser：只接受原生安全整数、封闭
  // Year 键和 opaque Teacher ID。整组400前后比较完整快照，防止验证发生在 INSERT 后。
  const validWindow = { kind: "Teacher", ownerId: ids.teacherId, dayOfWeek: 2, startHour: 9, endHour: 11 };
  const invalidWindowPosts = [
    { ...validWindow, dayOfWeek: "2" },
    { ...validWindow, dayOfWeek: Number.MAX_SAFE_INTEGER + 1 },
    { ...validWindow, startHour: 7 },
    { ...validWindow, endHour: 19 },
    { ...validWindow, endHour: validWindow.startHour },
    { ...validWindow, ownerId: "  " },
    { ...validWindow, ownerId: "TEACHER\nCONTROL" },
    { ...validWindow, ownerId: "T".repeat(129) },
    { ...validWindow, kind: "Year", ownerId: "01" },
    { ...validWindow, kind: "Year", ownerId: 1 },
  ];
  const beforeStrictWindowInputs = readBusinessSnapshot();
  for (const invalidInput of invalidWindowPosts) {
    const rejected = await requestApi("/api/unavailability", {
      method: "POST",
      expectedStatus: 400,
      json: invalidInput,
    });
    assert.deepEqual(rejected.body, { error: "Choose a valid owner, weekday and time range." });
  }
  for (const query of [
    "id=&kind=Teacher",
    "id=%20%20&kind=Teacher",
    "id=WINDOW%0ACONTROL&kind=Teacher",
    `id=${encodeURIComponent("W".repeat(129))}&kind=Year`,
    "id=valid-window-id&kind=Unknown",
    "id=valid-window-id",
  ]) {
    const rejected = await requestApi(`/api/unavailability?${query}`, {
      method: "DELETE",
      expectedStatus: 400,
    });
    assert.deepEqual(rejected.body, { error: "Rule id and kind are required." });
  }
  assert.deepEqual(readBusinessSnapshot(), beforeStrictWindowInputs);

  // 两张 window 表各自的自然键都由数据库 unique 最终保护。第一次创建成功后，精确
  // 重试必须是 typed 409，且包含 warning 的完整业务快照逐字段不变。
  const duplicateInputs = [
    { kind: "Teacher", ownerId: ids.teacherId, dayOfWeek: 1, startHour: 8, endHour: 9 },
    { kind: "Year", ownerId: "3", dayOfWeek: 5, startHour: 16, endHour: 18 },
  ];
  const createdWindows = [];
  try {
    for (const input of duplicateInputs) {
      const created = await requestApi("/api/unavailability", {
        method: "POST",
        expectedStatus: 201,
        json: input,
      });
      assert.equal(typeof created.body.id, "string");
      createdWindows.push({ id: created.body.id, kind: input.kind });
      const beforeConflict = readBusinessSnapshot();
      const conflict = await requestApi("/api/unavailability", {
        method: "POST",
        expectedStatus: 409,
        json: input,
      });
      assert.deepEqual(Object.keys(conflict.body).sort(), ["code", "error"]);
      assert.equal(conflict.body.code, "UNAVAILABLE_WINDOW_EXISTS");
      assert(!/sqlite|unique|constraint|teacher_unavailable|year_blocked|index/i.test(JSON.stringify(conflict.body)));
      assert.deepEqual(readBusinessSnapshot(), beforeConflict);
    }
  } finally {
    for (const window of createdWindows.reverse()) {
      await requestApi(`/api/unavailability?id=${encodeURIComponent(window.id)}&kind=${window.kind}`, {
        method: "DELETE",
      }).catch(() => undefined);
    }
  }

  const rule = ruleSettings.body.find((candidate) => candidate.key === "prefer_9am");
  assert(rule, "The prefer_9am Rules CAS fixture was not found.");

  // expectedEnabled 必须是 JSON 原生 boolean 且不可省略；所有400均在进入事务前零写入。
  const beforeInvalidExpected = readBusinessSnapshot();
  for (const invalidPatch of [
    { key: rule.key, enabled: !rule.enabled },
    { key: rule.key, expectedEnabled: null, enabled: !rule.enabled },
    { key: rule.key, expectedEnabled: String(rule.enabled), enabled: !rule.enabled },
    { key: rule.key, expectedEnabled: Number(rule.enabled), enabled: !rule.enabled },
  ]) {
    const rejected = await requestApi("/api/rule-settings", {
      method: "PATCH",
      expectedStatus: 400,
      json: invalidPatch,
    });
    assert.deepEqual(rejected.body, { error: "Rule key and enabled state are invalid." });
  }
  assert.deepEqual(readBusinessSnapshot(), beforeInvalidExpected);

  // expected 与 current 相符且 desired 未改变时是真 no-op：不执行 UPDATE，也不刷新
  // warning。这里临时安装一个拒绝 rule_settings UPDATE 的 trigger：只比较前后快照
  // 不能排除“写入了相同值”，trigger 则能证明这条路径真正在 UPDATE 之前返回。
  const beforeNoOp = readBusinessSnapshot();
  const noOpGuardDatabase = new Database(testDatabasePath);
  noOpGuardDatabase.exec(`
    CREATE TRIGGER zz_rule_setting_no_op_must_not_update
    BEFORE UPDATE ON rule_settings
    BEGIN
      SELECT RAISE(ABORT, 'rule-setting no-op unexpectedly executed UPDATE');
    END;
    CREATE TRIGGER zz_rule_setting_no_op_must_not_refresh_warning
    BEFORE UPDATE OF warnings_json ON scheduled_lessons
    BEGIN
      SELECT RAISE(ABORT, 'rule-setting no-op unexpectedly refreshed warnings');
    END;
  `);
  try {
    const noOp = await requestApi("/api/rule-settings", {
      method: "PATCH",
      json: { key: rule.key, expectedEnabled: rule.enabled, enabled: rule.enabled },
    });
    assert.deepEqual(noOp.body, { ok: true, enabled: rule.enabled, changed: false });
    assert.deepEqual(readBusinessSnapshot(), beforeNoOp);
  } finally {
    noOpGuardDatabase.exec(`
      DROP TRIGGER IF EXISTS zz_rule_setting_no_op_must_not_update;
      DROP TRIGGER IF EXISTS zz_rule_setting_no_op_must_not_refresh_warning;
    `);
    noOpGuardDatabase.close();
  }

  const toggled = await requestApi("/api/rule-settings", {
    method: "PATCH",
    json: { key: rule.key, expectedEnabled: rule.enabled, enabled: !rule.enabled },
  });
  assert.deepEqual(toggled.body, { ok: true, enabled: !rule.enabled, changed: true });
  const afterToggle = await requestApi(workspacePath);
  assert.equal(afterToggle.body.ruleSettings.find((candidate) => candidate.key === rule.key).enabled, !rule.enabled);

  // 比较 expected 必须发生在 no-op 判定之前。另一个浏览器已改成 desired 后，旧页面
  // 即使提交的 desired 看似等于旧 expected，仍必须 typed 409 且零写入。
  const beforeStale = readBusinessSnapshot();
  const stale = await requestApi("/api/rule-settings", {
    method: "PATCH",
    expectedStatus: 409,
    json: { key: rule.key, expectedEnabled: rule.enabled, enabled: rule.enabled },
  });
  assert.deepEqual(Object.keys(stale.body).sort(), ["code", "error"]);
  assert.equal(stale.body.code, "RULE_SETTING_CHANGED");
  assert(!/sqlite|database|rule_settings|is_enabled|update /i.test(JSON.stringify(stale.body)));
  assert.deepEqual(readBusinessSnapshot(), beforeStale);

  const beforeUnknown = readBusinessSnapshot();
  const unknown = await requestApi("/api/rule-settings", {
    method: "PATCH",
    expectedStatus: 404,
    json: { key: "unknown_rule", expectedEnabled: true, enabled: false },
  });
  assert.deepEqual(unknown.body, { error: "Rule setting not found." });
  assert.deepEqual(readBusinessSnapshot(), beforeUnknown);

  const restored = await requestApi("/api/rule-settings", {
    method: "PATCH",
    json: { key: rule.key, expectedEnabled: !rule.enabled, enabled: rule.enabled },
  });
  assert.deepEqual(restored.body, { ok: true, enabled: rule.enabled, changed: true });
  report("Rules 聚合等价且零写入，window unique 409 与 rule expectedEnabled CAS 合同完整");
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
  // 故障请求必须带当前 revision，才能真正进入 warning 重算阶段；若省略版本，
  // 只会在路由验证处400，无法证明主资料和 warning 的事务回滚边界。
  const atomicTeacher = (await requestApi("/api/teachers")).body.find((record) => record.id === ids.teacherId);
  const atomicGroup = (await requestApi("/api/student-groups")).body.find((record) => record.id === ids.studentGroupId);
  const atomicRoom = (await requestApi("/api/rooms")).body.find((record) => record.id === ids.roomId);
  const atomicCourse = (await requestApi("/api/courses")).body.find((record) => record.id === ids.courseId);
  assert(atomicTeacher && atomicGroup && atomicRoom && atomicCourse, "Atomic master-data fixtures could not be loaded.");

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
    await expectAtomicFailure(`/api/teachers/${ids.teacherId}`, "The teacher could not be updated. Try again.", {
      method: "PATCH",
      json: { name: "AUTO TEACHER ATOMIC FAIL", staffType: atomicTeacher.staffType, revision: atomicTeacher.revision },
    });
    await expectAtomicFailure(`/api/teachers/${ids.teacherId}`, "Teacher status could not be updated. Try again.", {
      method: "PATCH",
      json: { isActive: false, revision: atomicTeacher.revision },
    });
    await expectAtomicFailure(`/api/student-groups/${ids.studentGroupId}`, "The student group could not be updated. Try again.", {
      method: "PATCH",
      json: { code: "AAA_ATOMIC_FAIL", year: 3, program: "ATOMIC", revision: atomicGroup.revision },
    });
    await expectAtomicFailure(`/api/rooms/${ids.roomId}`, "The room could not be updated. Try again.", {
      method: "PATCH",
      json: { code: "34-08-40", capacity: 60, hasLab: false, hasMultiProjector: false, isSmartClassroom: false, revision: atomicRoom.revision },
    });
    await expectAtomicFailure(`/api/rooms/${ids.roomId}`, "The room status could not be updated. Try again.", {
      method: "PATCH",
      json: { isActive: false, revision: atomicRoom.revision },
    });
    await expectAtomicFailure("/api/rule-settings", "The rule setting could not be updated. Try again.", {
      method: "PATCH",
      json: { key: lunchBreakRule.key, expectedEnabled: lunchBreakRule.enabled, enabled: !lunchBreakRule.enabled },
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
    json: { key: lunchBreakRule.key, expectedEnabled: lunchBreakRule.enabled, enabled: !lunchBreakRule.enabled },
  });
  await requestApi("/api/rule-settings", {
    method: "PATCH",
    json: { key: lunchBreakRule.key, expectedEnabled: !lunchBreakRule.enabled, enabled: lunchBreakRule.enabled },
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
      json: { sectionCount: 2, revision: atomicCourse.revision },
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
    [`/api/teachers/${ids.teacherId}`, "PATCH"],
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

  const stateBeforeRestore = readBusinessSnapshot();
  const sessionsBeforeRejectedRestore = executeTestDatabase((db) => db.prepare("SELECT * FROM auth_sessions ORDER BY token_hash").all());
  const safetyDirectory = path.join(path.dirname(testDatabasePath), "integration-restore-safety");
  assert.equal(await pathExists(safetyDirectory), false);
  const statusBeforeMarker = await requestApi("/api/system-backup/status");
  assert.match(statusBeforeMarker.body.currentToken, /^[0-9a-f]{64}$/);

  // 下载副本和 restore safety 都会删除会话；人工 trigger 若同时把业务字段改成另一个
  // 合法值，普通 invariants 发现不了。脱敏前后的规范 token 必须拒绝这两条路径，且
  // 不得改变 live、会话或建立任何 safety 文件。
  executeTestDatabase((db) => db.exec(`
    CREATE TRIGGER zz_mutate_backup_while_stripping_sessions
    AFTER DELETE ON auth_sessions
    BEGIN
      UPDATE teachers SET name = name || ' BACKUP MUTATION'
      WHERE id = (SELECT id FROM teachers ORDER BY id LIMIT 1);
    END;
  `));
  try {
    const mutatedDownload = await requestApi("/api/system-backup", { expectedStatus: 500 });
    assert.deepEqual(mutatedDownload.body, {
      error: "The database backup failed its safety checks. No backup was downloaded.",
    });
    const mutatedSafetyRestore = await requestApi("/api/system-backup", {
      method: "POST",
      body: fullRestoreForm(await readFile(reorderedBackupPath), "mutated-safety.sqlite", statusBeforeMarker.body.currentToken),
      expectedStatus: 500,
    });
    assert.deepEqual(mutatedSafetyRestore.body, {
      error: "The system restore failed. Sign in again and verify the current data before retrying.",
    });
  } finally {
    executeTestDatabase((db) => db.exec("DROP TRIGGER IF EXISTS zz_mutate_backup_while_stripping_sessions"));
  }
  assert.deepEqual(readBusinessSnapshot(), stateBeforeRestore);
  assert.deepEqual(executeTestDatabase((db) => db.prepare("SELECT * FROM auth_sessions ORDER BY token_hash").all()), sessionsBeforeRejectedRestore);
  assert.equal(await pathExists(safetyDirectory), false);

  // current token 是恢复确认不可缺少的一部分。缺失／伪造格式必须在任何数据库变化或
  // safety 文件出现前得到 400；合法旧 token 则在 BEGIN IMMEDIATE 内得到稳定 409。
  for (const invalidToken of [undefined, "not-a-token", "A".repeat(64)]) {
    await requestApi("/api/system-backup", {
      method: "POST",
      body: fullRestoreForm(await readFile(reorderedBackupPath), "invalid-token.sqlite", invalidToken),
      expectedStatus: 400,
    });
    assert.deepEqual(readBusinessSnapshot(), stateBeforeRestore);
    assert.equal(await pathExists(safetyDirectory), false);
  }

  const restoreMarker = (await requestApi("/api/teachers", {
    method: "POST",
    expectedStatus: 201,
    json: { name: "FULL RESTORE TOKEN MARKER", staffType: "FT" },
  })).body;
  const stateAfterMarker = readBusinessSnapshot();
  const staleRestore = await requestApi("/api/system-backup", {
    method: "POST",
    body: fullRestoreForm(await readFile(reorderedBackupPath), "stale-token.sqlite", statusBeforeMarker.body.currentToken),
    expectedStatus: 409,
  });
  assert.equal(staleRestore.body.code, "SYSTEM_STATE_CHANGED");
  assert.match(staleRestore.body.error, /changed/i);
  assert.deepEqual(readBusinessSnapshot(), stateAfterMarker);
  assert.deepEqual(executeTestDatabase((db) => db.prepare("SELECT * FROM auth_sessions ORDER BY token_hash").all()), sessionsBeforeRejectedRestore);
  assert.equal(await pathExists(safetyDirectory), false);
  const currentRestoreStatus = await requestApi("/api/system-backup/status");
  assert.match(currentRestoreStatus.body.currentToken, /^[0-9a-f]{64}$/);
  assert.notEqual(currentRestoreStatus.body.currentToken, statusBeforeMarker.body.currentToken);
  const expectedCurrentToken = currentRestoreStatus.body.currentToken;

  // 缺少一条固定规则的 SQLite 仍会通过 schema、integrity 和 FK。旧实现会先提交
  // 六条规则，再在提交后的 initialize 补第七条；下面的 trigger 会令它报告 500，
  // 此时资料其实已经被替换。新实现必须在任何 live 写入前以 400 拒绝并保持会话。
  const missingRulePath = path.join(temporaryDirectory, "missing-required-rule.sqlite");
  await writeFile(missingRulePath, await readFile(reorderedBackupPath), { mode: 0o600 });
  const missingRuleDatabase = new Database(missingRulePath);
  try {
    missingRuleDatabase.prepare("DELETE FROM rule_settings WHERE rule_key = 'prefer_9am'").run();
    assert.deepEqual(missingRuleDatabase.pragma("integrity_check"), [{ integrity_check: "ok" }]);
    assert.deepEqual(missingRuleDatabase.pragma("foreign_key_check"), []);
  } finally {
    missingRuleDatabase.close();
  }
  executeTestDatabase((db) => db.exec(`
    CREATE TRIGGER zz_fail_post_restore_rule_initialization
    BEFORE INSERT ON rule_settings WHEN NEW.rule_key = 'prefer_9am'
    BEGIN SELECT RAISE(ABORT, 'forced post-restore rule initialization failure'); END;
  `));
  try {
    await requestApi("/api/system-backup", {
      method: "POST",
      body: fullRestoreForm(await readFile(missingRulePath), "missing-required-rule.sqlite", expectedCurrentToken),
      expectedStatus: 400,
    });
  } finally {
    executeTestDatabase((db) => db.exec("DROP TRIGGER IF EXISTS zz_fail_post_restore_rule_initialization"));
  }
  assert.deepEqual(readBusinessSnapshot(), stateAfterMarker);
  assert.deepEqual(executeTestDatabase((db) => db.prepare("SELECT * FROM auth_sessions ORDER BY token_hash").all()), sessionsBeforeRejectedRestore);

  // 上传文件不一定保留 production 的 UNIQUE 索引，所以不能只靠 live schema 推断来源键
  // 唯一。另一个跨行危险形状是 A 的当前姓名等于 B 的来源键：文件本身可通过所有
  // 单行 CHECK，却会令下一次 Teaching Members 导入同时命中两位教师。两种文件都必须
  // 在复制任何 live 资料前稳定 400，并保持当前会话与业务快照不变。
  const invalidTeacherSourceFixtures = [
    {
      filename: "duplicate-teacher-source.sqlite",
      mutate(db) {
        db.exec("DROP INDEX IF EXISTS teachers_teaching_members_key_key");
        db.prepare("INSERT INTO teachers (id, name, staff_type, teaching_members_key) VALUES (?, ?, 'FT', ?)")
          .run(randomUUID(), "BACKUP DUPLICATE OWNER A", "BACKUP DUPLICATE SOURCE");
        db.prepare("INSERT INTO teachers (id, name, staff_type, teaching_members_key) VALUES (?, ?, 'PT', ?)")
          .run(randomUUID(), "BACKUP DUPLICATE OWNER B", "BACKUP DUPLICATE SOURCE");
      },
    },
    {
      filename: "split-teacher-source.sqlite",
      mutate(db) {
        db.prepare("INSERT INTO teachers (id, name, staff_type, teaching_members_key) VALUES (?, ?, 'FT', ?)")
          .run(randomUUID(), "BACKUP SOURCE OWNER", "BACKUP CURRENT NAME");
        db.prepare("INSERT INTO teachers (id, name, staff_type) VALUES (?, ?, 'PT')")
          .run(randomUUID(), "BACKUP CURRENT NAME");
      },
    },
  ];
  for (const fixture of invalidTeacherSourceFixtures) {
    const fixturePath = path.join(temporaryDirectory, fixture.filename);
    await writeFile(fixturePath, await readFile(reorderedBackupPath), { mode: 0o600 });
    const fixtureDatabase = new Database(fixturePath);
    try {
      fixture.mutate(fixtureDatabase);
      assert.deepEqual(fixtureDatabase.pragma("integrity_check"), [{ integrity_check: "ok" }]);
      assert.deepEqual(fixtureDatabase.pragma("foreign_key_check"), []);
    } finally {
      fixtureDatabase.close();
    }
    await requestApi("/api/system-backup", {
      method: "POST",
      body: fullRestoreForm(await readFile(fixturePath), fixture.filename, expectedCurrentToken),
      expectedStatus: 400,
    });
    assert.deepEqual(readBusinessSnapshot(), stateAfterMarker);
    assert.deepEqual(executeTestDatabase((db) => db.prepare("SELECT * FROM auth_sessions ORDER BY token_hash").all()), sessionsBeforeRejectedRestore);
  }

  // 不同年级同 code 是合法资料，但同一年级的重复仍必须由完整恢复的业务校验拒绝。
  // 上传库可以没有 production unique key，所以先重建一张无组合约束的同形表，再
  // 插入相同 Year + code；若只依赖 live 索引，这个文件会到复制阶段才错误地返回500。
  const duplicateStudentGroupPath = path.join(temporaryDirectory, "duplicate-student-group-year-code.sqlite");
  await writeFile(duplicateStudentGroupPath, await readFile(reorderedBackupPath), { mode: 0o600 });
  const duplicateStudentGroupDatabase = new Database(duplicateStudentGroupPath);
  try {
    duplicateStudentGroupDatabase.pragma("foreign_keys = OFF");
    const removeStudentGroupKey = duplicateStudentGroupDatabase.transaction(() => {
      duplicateStudentGroupDatabase.exec(`
        CREATE TABLE student_groups_without_year_code_key (
          id TEXT PRIMARY KEY,
          code TEXT NOT NULL,
          year INTEGER NOT NULL CHECK (year IN (1, 2, 3)),
          program TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
        );
        INSERT INTO student_groups_without_year_code_key
          (id, code, year, program, created_at, updated_at, revision)
        SELECT id, code, year, program, created_at, updated_at, revision FROM student_groups;
        DROP TABLE student_groups;
        ALTER TABLE student_groups_without_year_code_key RENAME TO student_groups;
      `);
      const existing = duplicateStudentGroupDatabase.prepare(
        "SELECT code, year, program FROM student_groups ORDER BY year, code LIMIT 1",
      ).get();
      assert(existing, "The duplicate student-group backup fixture needs one group.");
      duplicateStudentGroupDatabase.prepare(
        "INSERT INTO student_groups (id, code, year, program) VALUES (?, ?, ?, ?)",
      ).run(randomUUID(), existing.code, existing.year, existing.program);
    });
    removeStudentGroupKey.immediate();
    duplicateStudentGroupDatabase.pragma("foreign_keys = ON");
    assert.deepEqual(duplicateStudentGroupDatabase.pragma("integrity_check"), [{ integrity_check: "ok" }]);
    assert.deepEqual(duplicateStudentGroupDatabase.pragma("foreign_key_check"), []);
  } finally {
    duplicateStudentGroupDatabase.close();
  }
  await requestApi("/api/system-backup", {
    method: "POST",
    body: fullRestoreForm(await readFile(duplicateStudentGroupPath), "duplicate-student-group-year-code.sqlite", expectedCurrentToken),
    expectedStatus: 400,
  });
  assert.deepEqual(readBusinessSnapshot(), stateAfterMarker);
  assert.deepEqual(executeTestDatabase((db) => db.prepare("SELECT * FROM auth_sessions ORDER BY token_hash").all()), sessionsBeforeRejectedRestore);

  // 上传库的表/列形状比较刻意不依赖索引，因此攻击者可以删除 window unique key 后
  // 保存重复自然键，同时仍通过 integrity 与 FK。两张表都必须由 business invariant
  // 在复制 live 数据前拒绝；不能等到 live INSERT 碰 unique 才变成误导性的500。
  const duplicateWindowBackupFixtures = [
    {
      filename: "duplicate-teacher-unavailable-window.sqlite",
      mutate(db) {
        db.exec("DROP INDEX IF EXISTS teacher_unavailable_windows_teacher_id_day_of_week_start_hour_end_hour_key");
        const teacher = db.prepare("SELECT id FROM teachers ORDER BY id LIMIT 1").get();
        assert(teacher, "The teacher-window backup fixture needs one teacher.");
        const insert = db.prepare(`INSERT INTO teacher_unavailable_windows
          (id, teacher_id, day_of_week, start_hour, end_hour) VALUES (?, ?, 4, 9, 11)`);
        insert.run(randomUUID(), teacher.id);
        insert.run(randomUUID(), teacher.id);
        assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM teacher_unavailable_windows
          WHERE teacher_id = ? AND day_of_week = 4 AND start_hour = 9 AND end_hour = 11`).get(teacher.id).count, 2);
      },
    },
    {
      filename: "duplicate-year-blocked-window.sqlite",
      mutate(db) {
        db.exec("DROP INDEX IF EXISTS year_blocked_windows_year_day_of_week_start_hour_end_hour_key");
        const insert = db.prepare(`INSERT INTO year_blocked_windows
          (id, year, day_of_week, start_hour, end_hour) VALUES (?, 2, 5, 14, 16)`);
        insert.run(randomUUID());
        insert.run(randomUUID());
        assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM year_blocked_windows
          WHERE year = 2 AND day_of_week = 5 AND start_hour = 14 AND end_hour = 16`).get().count, 2);
      },
    },
  ];
  for (const fixture of duplicateWindowBackupFixtures) {
    const fixturePath = path.join(temporaryDirectory, fixture.filename);
    await writeFile(fixturePath, await readFile(reorderedBackupPath), { mode: 0o600 });
    const fixtureDatabase = new Database(fixturePath);
    try {
      fixture.mutate(fixtureDatabase);
      assert.deepEqual(fixtureDatabase.pragma("integrity_check"), [{ integrity_check: "ok" }]);
      assert.deepEqual(fixtureDatabase.pragma("foreign_key_check"), []);
    } finally {
      fixtureDatabase.close();
    }
    await requestApi("/api/system-backup", {
      method: "POST",
      body: fullRestoreForm(await readFile(fixturePath), fixture.filename, expectedCurrentToken),
      expectedStatus: 400,
    });
    assert.deepEqual(readBusinessSnapshot(), stateAfterMarker);
    assert.deepEqual(
      executeTestDatabase((db) => db.prepare("SELECT * FROM auth_sessions ORDER BY token_hash").all()),
      sessionsBeforeRejectedRestore,
    );
  }

  // 每条 allocation 单独都是合法的600，但同一课程两条合计1200，超过课程最多999班。
  // 上传库可以绕过 route 的工作簿合计检查，因此完整备份 invariant 必须按 course 再求和；
  // 此夹具不建立 section，确保拒绝原因不会被 section 连续性或引用错误提前掩盖。
  const aggregateAllocationPath = path.join(temporaryDirectory, "oversized-course-allocation-sum.sqlite");
  await writeFile(aggregateAllocationPath, await readFile(reorderedBackupPath), { mode: 0o600 });
  const aggregateAllocationDatabase = new Database(aggregateAllocationPath);
  try {
    aggregateAllocationDatabase.pragma("foreign_keys = ON");
    const teacherIds = aggregateAllocationDatabase.prepare("SELECT id FROM teachers ORDER BY id LIMIT 2").all();
    assert.equal(teacherIds.length, 2, "The full-backup allocation-sum fixture needs two valid teachers.");
    const oversizedCourseId = randomUUID();
    aggregateAllocationDatabase.prepare("INSERT INTO courses (id, code, catalog) VALUES (?, 'BACKUP_SUM_1200', 'Aggregate allocation boundary')")
      .run(oversizedCourseId);
    const insertAllocation = aggregateAllocationDatabase.prepare(`INSERT INTO teaching_allocations
      (id, course_id, teacher_id, assigned_group_count) VALUES (?, ?, ?, 600)`);
    insertAllocation.run(randomUUID(), oversizedCourseId, teacherIds[0].id);
    insertAllocation.run(randomUUID(), oversizedCourseId, teacherIds[1].id);
    assert.deepEqual(aggregateAllocationDatabase.pragma("integrity_check"), [{ integrity_check: "ok" }]);
    assert.deepEqual(aggregateAllocationDatabase.pragma("foreign_key_check"), []);
  } finally {
    aggregateAllocationDatabase.close();
  }
  await requestApi("/api/system-backup", {
    method: "POST",
    body: fullRestoreForm(await readFile(aggregateAllocationPath), "oversized-course-allocation-sum.sqlite", expectedCurrentToken),
    expectedStatus: 400,
  });
  assert.deepEqual(readBusinessSnapshot(), stateAfterMarker);
  assert.deepEqual(executeTestDatabase((db) => db.prepare("SELECT * FROM auth_sessions ORDER BY token_hash").all()), sessionsBeforeRejectedRestore);

  // teaching_allocations.id 没有任何外键引用，129字符仍能通过 SQLite integrity/FK，
  // 因而可精确证明完整备份使用 JS opaque-resource-id 契约，而非只检查非空 TEXT。
  // 上传拒绝后 live 14表与当前管理员会话必须逐字段不变。
  const oversizedAllocationIdPath = path.join(temporaryDirectory, "oversized-allocation-id.sqlite");
  await writeFile(oversizedAllocationIdPath, await readFile(reorderedBackupPath), { mode: 0o600 });
  const oversizedAllocationIdDatabase = new Database(oversizedAllocationIdPath);
  try {
    const allocation = oversizedAllocationIdDatabase.prepare("SELECT id FROM teaching_allocations ORDER BY id LIMIT 1").get();
    assert(allocation, "The full-backup opaque allocation-ID fixture needs one allocation.");
    oversizedAllocationIdDatabase.prepare("UPDATE teaching_allocations SET id = ? WHERE id = ?")
      .run("X".repeat(129), allocation.id);
    assert.deepEqual(oversizedAllocationIdDatabase.pragma("integrity_check"), [{ integrity_check: "ok" }]);
    assert.deepEqual(oversizedAllocationIdDatabase.pragma("foreign_key_check"), []);
  } finally {
    oversizedAllocationIdDatabase.close();
  }
  await requestApi("/api/system-backup", {
    method: "POST",
    body: fullRestoreForm(await readFile(oversizedAllocationIdPath), "oversized-allocation-id.sqlite", expectedCurrentToken),
    expectedStatus: 400,
  });
  assert.deepEqual(readBusinessSnapshot(), stateAfterMarker);
  assert.deepEqual(executeTestDatabase((db) => db.prepare("SELECT * FROM auth_sessions ORDER BY token_hash").all()), sessionsBeforeRejectedRestore);

  // 紧急周期 JSON 也属于完整系统备份的一部分。五个空数组在 SQLite 看来是合法 TEXT，
  // 但绝不是 Start 可能生成的可恢复周期；必须在上传校验阶段拒绝。
  const invalidCyclePath = path.join(temporaryDirectory, "invalid-cycle-snapshot.sqlite");
  await writeFile(invalidCyclePath, await readFile(reorderedBackupPath), { mode: 0o600 });
  const invalidCycleDatabase = new Database(invalidCyclePath);
  try {
    invalidCycleDatabase.prepare("INSERT INTO schedule_backups (id, snapshot_json) VALUES (?, ?)")
      .run(randomUUID(), JSON.stringify({ courses: [], allocations: [], sections: [], sectionGroups: [], lessons: [] }));
  } finally {
    invalidCycleDatabase.close();
  }
  await requestApi("/api/system-backup", {
    method: "POST",
    body: fullRestoreForm(await readFile(invalidCyclePath), "invalid-cycle-snapshot.sqlite", expectedCurrentToken),
    expectedStatus: 400,
  });
  assert.deepEqual(readBusinessSnapshot(), stateAfterMarker);

  // 快照内的课程文字也必须使用生产 API 的长度与控制字符规则。SQLite TEXT 本身会
  // 接受换行；完整恢复必须在复制 live 资料前把这份恶意周期 JSON 当成 400。
  const unsafeCyclePath = path.join(temporaryDirectory, "unsafe-cycle-text.sqlite");
  await writeFile(unsafeCyclePath, await readFile(reorderedBackupPath), { mode: 0o600 });
  const unsafeCycleDatabase = new Database(unsafeCyclePath);
  try {
    const unsafeCycleSnapshot = structuredClone(cyclePayloadFromSnapshot(stateAfterMarker));
    assert(unsafeCycleSnapshot.courses.length > 0, "The strict cycle-text fixture needs a course.");
    unsafeCycleSnapshot.courses[0].code = `${unsafeCycleSnapshot.courses[0].code}\nCONTROL`;
    unsafeCycleDatabase.prepare("DELETE FROM schedule_backups").run();
    unsafeCycleDatabase.prepare("INSERT INTO schedule_backups (id, snapshot_json) VALUES (?, ?)")
      .run(randomUUID(), JSON.stringify(unsafeCycleSnapshot));
  } finally {
    unsafeCycleDatabase.close();
  }
  await requestApi("/api/system-backup", {
    method: "POST",
    body: fullRestoreForm(await readFile(unsafeCyclePath), "unsafe-cycle-text.sqlite", expectedCurrentToken),
    expectedStatus: 400,
  });
  assert.deepEqual(readBusinessSnapshot(), stateAfterMarker);
  assert.deepEqual(executeTestDatabase((db) => db.prepare("SELECT * FROM auth_sessions ORDER BY token_hash").all()), sessionsBeforeRejectedRestore);

  // auth_sessions 不参与 current/target token，因为正常登录退出不应让确认过期；因此还要
  // 防止人工 AFTER DELETE trigger 重插一个格式、FK 都合法的会话并绕过“退出所有人”。
  executeTestDatabase((db) => db.exec(`
    CREATE TRIGGER zz_retain_session_during_full_system_restore
    AFTER DELETE ON auth_sessions
    WHEN (SELECT file FROM pragma_database_list WHERE name = 'main') <> ''
    BEGIN
      INSERT OR REPLACE INTO auth_sessions (token_hash, user_id, expires_at, created_at)
      VALUES ('${"e".repeat(64)}', OLD.user_id, '2099-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    END;
  `));
  try {
    const retainedSessionRestore = await requestApi("/api/system-backup", {
      method: "POST",
      body: fullRestoreForm(await readFile(reorderedBackupPath), "retained-session-rollback.sqlite", expectedCurrentToken),
      expectedStatus: 500,
    });
    assert.deepEqual(retainedSessionRestore.body, {
      error: "The system restore failed. Sign in again and verify the current data before retrying.",
    });
  } finally {
    executeTestDatabase((db) => db.exec("DROP TRIGGER IF EXISTS zz_retain_session_during_full_system_restore"));
  }
  assert.deepEqual(readBusinessSnapshot(), stateAfterMarker);
  assert.deepEqual(executeTestDatabase((db) => db.prepare("SELECT * FROM auth_sessions ORDER BY token_hash").all()), sessionsBeforeRejectedRestore);

  // 合法值也可能被 live 中的人工 AFTER trigger 静默改写，普通 business/FK/integrity
  // 全部仍会通过。提交前的规范逐字段 token 必须发现目标不等值并回滚完整替换。
  executeTestDatabase((db) => db.exec(`
    CREATE TRIGGER zz_silently_change_full_system_restore
    AFTER INSERT ON teachers
    BEGIN UPDATE teachers SET name = name || ' RESTORE MUTATION' WHERE id = NEW.id; END;
  `));
  try {
    const silentlyChangedRestore = await requestApi("/api/system-backup", {
      method: "POST",
      body: fullRestoreForm(await readFile(reorderedBackupPath), "silent-trigger-rollback.sqlite", expectedCurrentToken),
      expectedStatus: 500,
    });
    assert.deepEqual(silentlyChangedRestore.body, {
      error: "The system restore failed. Sign in again and verify the current data before retrying.",
    });
  } finally {
    executeTestDatabase((db) => db.exec("DROP TRIGGER IF EXISTS zz_silently_change_full_system_restore"));
  }
  assert.deepEqual(readBusinessSnapshot(), stateAfterMarker);
  assert.deepEqual(executeTestDatabase((db) => db.prepare("SELECT * FROM auth_sessions ORDER BY token_hash").all()), sessionsBeforeRejectedRestore);

  // 即使安全副本已经可靠落盘，真正复制时的任意 trigger/磁盘故障仍必须回滚所有
  // DELETE/INSERT，并保留当前登录。这里强制在第一张 master 表 INSERT 时失败。
  executeTestDatabase((db) => db.exec(`
    CREATE TRIGGER zz_fail_full_system_restore
    BEFORE INSERT ON teachers BEGIN SELECT RAISE(ABORT, 'forced full restore failure'); END;
  `));
  try {
    const failedRestore = await requestApi("/api/system-backup", {
      method: "POST",
      body: fullRestoreForm(await readFile(reorderedBackupPath), "forced-rollback.sqlite", expectedCurrentToken),
      expectedStatus: 500,
    });
    assert.deepEqual(failedRestore.body, {
      error: "The system restore failed. Sign in again and verify the current data before retrying.",
    });
    assert(!/sqlite|trigger|table|column|private|stack/i.test(JSON.stringify(failedRestore.body)));
  } finally {
    executeTestDatabase((db) => db.exec("DROP TRIGGER IF EXISTS zz_fail_full_system_restore"));
  }
  assert.deepEqual(readBusinessSnapshot(), stateAfterMarker);
  assert.deepEqual(executeTestDatabase((db) => db.prepare("SELECT * FROM auth_sessions ORDER BY token_hash").all()), sessionsBeforeRejectedRestore);
  await requestApi("/api/teachers");

  // Production 恢复接口必须按列名验证与复制，而不是因 cid 顺序不同拒绝，或用
  // SELECT * 把某列写进错误字段。恢复完成会按产品设计注销全部旧会话。
  const restored = await requestApi("/api/system-backup", {
    method: "POST",
    body: fullRestoreForm(await readFile(reorderedBackupPath), "legacy-column-order.sqlite", expectedCurrentToken),
  });
  assert.equal(restored.body.restored, true);
  assert.deepEqual(readBusinessSnapshot(), stateBeforeRestore);
  assert.equal(executeTestDatabase((db) => db.prepare("SELECT COUNT(*) AS count FROM teachers WHERE id = ?").get(restoreMarker.id).count), 0);

  // 返回的安全副本必须是同卷上的耐久原子文件、权限收紧、会话脱敏，并逐字段等于
  // 恢复前状态。响应只给 basename，不能允许路径跳出固定安全目录。
  assert.equal(path.basename(restored.body.safetyBackupFilename), restored.body.safetyBackupFilename);
  const safetyPath = path.join(safetyDirectory, restored.body.safetyBackupFilename);
  assert.equal((await stat(safetyDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(safetyPath)).mode & 0o777, 0o600);
  assert.deepEqual(readBusinessSnapshotFrom(safetyPath), stateAfterMarker);
  const safetyDatabase = new Database(safetyPath, { readonly: true });
  try {
    assert.deepEqual(safetyDatabase.pragma("integrity_check"), [{ integrity_check: "ok" }]);
    assert.deepEqual(safetyDatabase.pragma("foreign_key_check"), []);
    assert.equal(safetyDatabase.prepare("SELECT COUNT(*) AS count FROM auth_sessions").get().count, 0);
  } finally {
    safetyDatabase.close();
  }
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
  report("完整系统备份业务校验、失败回滚、耐久安全副本及跨列顺序恢复");
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
  await requestApi("/api/system-backup/status", { cookie: schedulerCookie, expectedStatus: 403 });

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

  // Start 会保留基础资料，但应急快照只保存稳定 student-group ID。此时公开删除若
  // 放行，未来 Restore 才会失败；因此必须在删除当下返回保护性409且全库零变化。
  const retainedStudentGroup = (await requestApi("/api/student-groups", { cookie: schedulerCookie })).body
    .find((group) => group.id === ids.studentGroupId);
  assert(retainedStudentGroup, "The student group retained after Start was not available for delete protection.");
  const stateBeforeBackupProtectedDelete = readBusinessSnapshot();
  const backupProtectedDelete = await requestApi(`/api/student-groups/${ids.studentGroupId}`, {
    method: "DELETE",
    cookie: schedulerCookie,
    expectedStatus: 409,
    json: { revision: retainedStudentGroup.revision },
  });
  assert.equal(backupProtectedDelete.body.code, "STUDENT_GROUP_IN_USE");
  assert.match(backupProtectedDelete.body.error, /emergency cycle backup/i);
  assert.deepEqual(readBusinessSnapshot(), stateBeforeBackupProtectedDelete);

  // Course 与 student group 的备份语义不同：课程及其子树完整包含在 cycle JSON 中，
  // 当前周期删除不需要也不允许改写旧快照。用空的新周期建立并删除一门课程，逐字段
  // 比较 backup row 与 snapshot_json 字节，证明 Restore 仍保留原来的完整历史周期。
  const backupBeforeLiveCourseDelete = stateBeforeBackupProtectedDelete.scheduleBackups[0];
  const liveCourseWithBackup = (await requestApi("/api/courses", {
    method: "POST",
    cookie: schedulerCookie,
    expectedStatus: 201,
    json: { code: "DELETE_WITH_CYCLE_BACKUP", catalog: "Backup remains immutable", sectionCount: 2 },
  })).body;
  await requestApi(`/api/courses/${liveCourseWithBackup.id}`, {
    method: "DELETE",
    cookie: schedulerCookie,
    json: { revision: liveCourseWithBackup.revision },
  });
  const backupAfterLiveCourseDelete = readBusinessSnapshot().scheduleBackups[0];
  assert.deepEqual(backupAfterLiveCourseDelete, backupBeforeLiveCourseDelete);
  assert.equal(Buffer.from(backupAfterLiveCourseDelete.snapshot_json).equals(Buffer.from(backupBeforeLiveCourseDelete.snapshot_json)), true);
  assert.equal((await requestApi("/api/cycle", { cookie: schedulerCookie })).body.currentToken, started.body.currentToken);

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

  async function expectIndependentlyInvalidCycleSnapshot(snapshot, fixtureName) {
    // 每个恶意字段都从同一份合法 JSON 独立派生，并在断言后恢复原文；这样新增的
    // guard 若被删除，测试不会因上一个仍损坏的字段继续409而产生假绿。
    executeTestDatabase((db) => db.prepare("UPDATE schedule_backups SET snapshot_json = ? WHERE id = ?")
      .run(JSON.stringify(snapshot), backupId));
    const stateWithInvalidSnapshot = readBusinessSnapshot();
    const rejected = await requestApi("/api/cycle", {
      method: "POST",
      cookie: schedulerCookie,
      expectedStatus: 409,
      json: { action: "restore", confirmation: "RESTORE LAST BACKUP", currentToken: started.body.currentToken, backupId },
    });
    assert.deepEqual(rejected.body, { error: "The emergency backup is not valid." }, fixtureName);
    assert.deepEqual(readBusinessSnapshot(), stateWithInvalidSnapshot, `${fixtureName} changed the current cycle.`);
    executeTestDatabase((db) => db.prepare("UPDATE schedule_backups SET snapshot_json = ? WHERE id = ?")
      .run(validBackupJson, backupId));
  }

  // Catalog 是保留大小写的说明文字，但仍不允许换行等控制字符。只改一个 catalog，
  // 其余课程和全部引用保持合法，精确证明 Cycle parser 复用文本控制字符边界。
  const controlCatalogSnapshot = JSON.parse(validBackupJson);
  assert(controlCatalogSnapshot.courses.length > 0, "The cycle catalog fixture needs one course.");
  controlCatalogSnapshot.courses[0].catalog = "Unsafe\nCatalog";
  await expectIndependentlyInvalidCycleSnapshot(controlCatalogSnapshot, "Cycle catalog control-character fixture");

  // allocation.id 不被其他数组引用，改成129字符不会制造 dangling FK；因此409只能来自
  // opaque resource ID 自身的长度校验，而不是引用完整性 guard 的副作用。
  const invalidOpaqueIdSnapshot = JSON.parse(validBackupJson);
  assert(invalidOpaqueIdSnapshot.allocations.length > 0, "The cycle opaque-ID fixture needs one allocation.");
  invalidOpaqueIdSnapshot.allocations[0].id = "X".repeat(129);
  await expectIndependentlyInvalidCycleSnapshot(invalidOpaqueIdSnapshot, "Cycle opaque resource-ID fixture");

  // 不能只把现有 section 改成1000，否则连续性缺口也会拒绝并掩盖999上限。这里为
  // 同一课程构造从1到1000连续、唯一且无额外引用的 sections；若移除数量／sequence
  // 上限而保留连续性检查，这份夹具就会错误通过，从而让回归准确失败。
  const oversizedSectionSnapshot = JSON.parse(validBackupJson);
  const sectionCourse = oversizedSectionSnapshot.courses
    .map((course) => ({
      course,
      sections: oversizedSectionSnapshot.sections
        .filter((section) => section.course_id === course.id)
        .sort((left, right) => left.sequence - right.sequence),
    }))
    .find(({ sections }) => sections.length > 0);
  assert(sectionCourse, "The cycle section-limit fixture needs one course with existing sections.");
  assert(sectionCourse.sections.every((section, index) => section.sequence === index + 1));
  for (let sequence = sectionCourse.sections.length + 1; sequence <= 1_000; sequence += 1) {
    oversizedSectionSnapshot.sections.push({
      id: `cycle-overflow-section-${sequence}`,
      course_id: sectionCourse.course.id,
      sequence,
      teacher_id: null,
      allocation_teacher_id: null,
      revision: 1,
    });
  }
  await expectIndependentlyInvalidCycleSnapshot(oversizedSectionSnapshot, "Cycle 1,000-section fixture");

  // 每条 allocation 即使各自不超过 999，同一课程合计也不能超过课程可建立的班次上限。
  // 人工写入的旧库 JSON 绕过 schema CHECK 后，Cycle Restore 仍须在删除当前周期前拒绝。
  const oversizedAllocationSnapshot = JSON.parse(validBackupJson);
  const baseAllocation = oversizedAllocationSnapshot.allocations[0];
  assert(baseAllocation, "The aggregate-allocation fixture needs at least one teaching allocation.");
  const alternateTeacher = stateAfterStart.teachers.find((teacher) => teacher.id !== baseAllocation.teacher_id);
  assert(alternateTeacher, "The aggregate-allocation fixture needs a second teacher.");
  baseAllocation.assigned_group_count = 600;
  oversizedAllocationSnapshot.allocations.push({
    ...baseAllocation,
    id: randomUUID(),
    teacher_id: alternateTeacher.id,
    assigned_group_count: 600,
  });
  executeTestDatabase((db) => db.prepare("UPDATE schedule_backups SET snapshot_json = ? WHERE id = ?")
    .run(JSON.stringify(oversizedAllocationSnapshot), backupId));
  const stateWithOversizedAllocationBackup = readBusinessSnapshot();
  const oversizedAllocationBackup = await requestApi("/api/cycle", {
    method: "POST",
    cookie: schedulerCookie,
    expectedStatus: 409,
    json: { action: "restore", confirmation: "RESTORE LAST BACKUP", currentToken: started.body.currentToken, backupId },
  });
  assert.deepEqual(oversizedAllocationBackup.body, { error: "The emergency backup is not valid." });
  assert.deepEqual(readBusinessSnapshot(), stateWithOversizedAllocationBackup);
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

  // Start 后 master data 可以只被紧急 JSON 引用。删除这种教室不会破坏 live FK；完整
  // 备份仍必须可下载及恢复，因为 Cycle Restore 已有专门的 FK 409 和完整事务回滚。
  const orphanedMasterCycle = await requestApi("/api/cycle", {
    method: "POST",
    cookie: schedulerCookie,
    json: { action: "start", confirmation: "START NEW CYCLE", currentToken: finalCycleStatus.body.currentToken },
  });
  const orphanedBackupId = orphanedMasterCycle.body.backup.id;
  const orphanedSnapshot = executeTestDatabase((db) => JSON.parse(db.prepare("SELECT snapshot_json FROM schedule_backups WHERE id = ?").get(orphanedBackupId).snapshot_json));
  const deletedRoomId = orphanedSnapshot.lessons.find((lesson) => lesson.room_id !== null)?.room_id;
  assert(deletedRoomId, "The historical-master full-backup fixture needs a scheduled room.");
  const deletedRoom = executeTestDatabase((db) => {
    const room = db.prepare("SELECT * FROM rooms WHERE id = ?").get(deletedRoomId);
    assert(room, "The historical-master room disappeared before the deletion fixture ran.");
    db.prepare("DELETE FROM rooms WHERE id = ?").run(deletedRoomId);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM rooms WHERE id = ?").get(deletedRoomId).count, 0);
    return room;
  });
  const stateWithHistoricalMasterReference = readBusinessSnapshot();
  const historicalRestoreStatus = await requestApi("/api/system-backup/status");
  const historicalDownload = await fetch(new URL("/api/system-backup", baseUrl), {
    headers: { Cookie: sessionCookie },
    signal: AbortSignal.timeout(requestTimeoutMilliseconds),
  });
  assert.equal(historicalDownload.status, 200);
  const historicalBackup = Buffer.from(await historicalDownload.arrayBuffer());
  const historicalRestore = await requestApi("/api/system-backup", {
    method: "POST",
    body: fullRestoreForm(historicalBackup, "historical-master-reference.sqlite", historicalRestoreStatus.body.currentToken),
  });
  assert.equal(historicalRestore.body.restored, true);
  assert.deepEqual(readBusinessSnapshot(), stateWithHistoricalMasterReference);

  // 完整恢复按设计撤销全部旧会话；重新登录后，Cycle Restore 必须把缺 master 转成
  // 可解释的 409，同时逐表证明空 current cycle 和紧急备份都没有发生变化。
  await requestApi("/api/cycle", { cookie: schedulerCookie, expectedStatus: 401 });
  const administratorLogin = await requestApi("/api/auth/login", {
    method: "POST",
    authenticated: false,
    json: { username: "integration-admin", password: "IntegrationTest123!" },
  });
  sessionCookie = (administratorLogin.response.headers.get("set-cookie") || "").split(";", 1)[0];
  assert(sessionCookie.includes("="));
  const orphanedCycleStatus = await requestApi("/api/cycle");
  const stateBeforeMissingMasterRestore = readBusinessSnapshot();
  const missingMasterRestore = await requestApi("/api/cycle", {
    method: "POST",
    expectedStatus: 409,
    json: {
      action: "restore",
      confirmation: "RESTORE LAST BACKUP",
      currentToken: orphanedCycleStatus.body.currentToken,
      backupId: orphanedBackupId,
    },
  });
  assert.deepEqual(missingMasterRestore.body, { error: "The emergency backup depends on master data that no longer exists." });
  assert.deepEqual(readBusinessSnapshot(), stateBeforeMissingMasterRestore);

  // 后续原有 FK 验收仍需要初始 course fixture。把专门删除的 master 精确放回后再正常
  // Restore，证明前一个 409 没有损坏快照，且测试不会把空周期泄漏给无关断言。
  executeTestDatabase((db) => db.prepare(`INSERT INTO rooms (
    id, code, block, capacity, has_multi_projector, is_lab, is_smart_classroom,
    is_active, created_at, updated_at, revision
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    deletedRoom.id,
    deletedRoom.code,
    deletedRoom.block,
    deletedRoom.capacity,
    deletedRoom.has_multi_projector,
    deletedRoom.is_lab,
    deletedRoom.is_smart_classroom,
    deletedRoom.is_active,
    deletedRoom.created_at,
    deletedRoom.updated_at,
    deletedRoom.revision,
  ));
  const repairedCycleStatus = await requestApi("/api/cycle");
  const repairedCycle = await requestApi("/api/cycle", {
    method: "POST",
    json: {
      action: "restore",
      confirmation: "RESTORE LAST BACKUP",
      currentToken: repairedCycleStatus.body.currentToken,
      backupId: orphanedBackupId,
    },
  });
  assert.equal(repairedCycle.body.courses, orphanedSnapshot.courses.length);
  assert.deepEqual(cyclePayloadFromSnapshot(readBusinessSnapshot()), orphanedSnapshot);
  report("Cycle 原子回滚及历史快照缺 master 时的完整系统备份／恢复兼容");
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
  verifyCandidateSlotRequestIdentity();

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
  await verifyOwnPasswordLifecycleAndFailures();
  await verifyAccountStatusRevisionCasAndFailures();
  await verifyWorkbookBoundaries();
  await verifyTeachingGroupCountBoundaries();
  await verifyTeachingExplicitZeroAndNoOp();
  await verifyTeachingImportRevisionsAndSourceKeys();
  await verifyTeachingAllocationReimport();
  await verifyTeachingImportFailureBoundaries();
  await verifyCourseDeletionAndAutomaticSectionResize();
  const relationshipIds = await verifyCrudAndRevisions();
  await verifyTeachingWeekRuleIsolation();
  await verifyManagementSnapshots(relationshipIds);
  await verifyRulesWorkspaceContracts(relationshipIds);
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
