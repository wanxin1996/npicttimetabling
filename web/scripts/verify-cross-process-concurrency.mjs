import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

// 这项回归会启动两个真正的 production standalone 进程。两个进程使用不同端口，
// 但明确指向同一个操作系统临时 SQLite；任何请求都不会连接老师的正式数据库。
const projectRoot = process.cwd();
const standaloneServerPath = path.join(projectRoot, ".next", "standalone", "server.js");
const authRacePreloadPath = path.join(projectRoot, "scripts", "support", "auth-race-preload.cjs");
const requestTimeoutMilliseconds = 60_000;
const overlapHoldMilliseconds = 400;

let temporaryDirectory;
let testDatabasePath;
let authRaceControlDirectory;
let authRaceRunToken;
let administratorCookie = "";
let cleanupPromise;
const serverHandles = [];
const activeAuthRaceReleases = new Map();

function report(message) {
  // 每组业务保证完成后只输出一行，便于基础开发人员快速定位失败阶段。
  console.log(`✓ ${message}`);
}

function delay(milliseconds) {
  // 短暂异步等待只用于服务启动、并发锁和测试标记轮询，不会阻塞子进程输出。
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function chooseAvailablePort() {
  // 让操作系统分配当前空闲端口，避免占用老师可能正在使用的 3000 开发端口。
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  assert(address && typeof address === "object", "A test server could not obtain a local port.");
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function keepRecentServerOutput(handle, chunk) {
  // A、B 两个服务器分别保留最后 12,000 个字符；成功时保持安静，失败时才显示。
  handle.output = `${handle.output}${String(chunk)}`.slice(-12_000);
}

async function waitForServer(handle) {
  // 每个进程都必须通过自己的公开健康接口，才能证明两条独立 SQLite 连接已经打开。
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (handle.processError) throw new Error(`Server ${handle.label} could not start: ${handle.processError.message}`);
    if (handle.child.exitCode !== null || handle.child.signalCode !== null) {
      throw new Error(`Server ${handle.label} exited before becoming ready.`);
    }
    try {
      const response = await fetch(new URL("/api/health", handle.baseUrl), {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.status === 200) return;
    } catch {
      // 端口尚未监听属于正常启动过程，稍后再次检查。
    }
    await delay(100);
  }
  throw new Error(`Server ${handle.label} did not become ready within 15 seconds.`);
}

async function stopServer(handle) {
  // 先发送 SIGTERM；三秒后仍未退出才 SIGKILL，避免临时 SQLite 保持打开或端口残留。
  const child = handle?.child;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  // spawn 在建立系统进程前失败时没有 pid，也不保证继续发送 exit；此时没有可终止对象。
  if (!child.pid) return;
  const exitPromise = new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      resolve(true);
    };
    child.once("exit", finish);
    child.once("close", finish);
    child.once("error", finish);
  });
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const stoppedNormally = await Promise.race([exitPromise, delay(3_000).then(() => false)]);
  if (!stoppedNormally && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    // 极端系统错误下 SIGKILL 也可能没有回调；再给三秒后返回，清理不能永久挂起。
    await Promise.race([exitPromise, delay(3_000)]);
  }
}

async function startServer(label) {
  // 启动 A、B 时分别选择端口；只有明确的 EADDRINUSE 才重试，其他错误立即报告。
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const port = await chooseAvailablePort();
    const handle = {
      label,
      baseUrl: new URL(`http://127.0.0.1:${port}`),
      child: undefined,
      output: "",
      processError: undefined,
    };

    // 清除可能继承的 Railway 或正式数据库变量，再显式设置唯一临时数据库。
    const environment = { ...process.env };
    for (const name of [
      "RAILWAY_ENVIRONMENT",
      "RAILWAY_SERVICE_ID",
      "RAILWAY_VOLUME_MOUNT_PATH",
      "TIMETABLING_DATABASE_PATH",
      "TIMETABLING_AUTH_RACE_TEST_MODE",
      "TIMETABLING_AUTH_RACE_RUN_TOKEN",
      "TIMETABLING_AUTH_RACE_CONTROL_DIR",
      "TIMETABLING_CONCURRENCY_PROCESS_LABEL",
      "PORT",
      "HOSTNAME",
    ]) {
      delete environment[name];
    }
    Object.assign(environment, {
      NODE_ENV: "production",
      HOSTNAME: "127.0.0.1",
      PORT: String(port),
      TIMETABLING_DATABASE_PATH: testDatabasePath,
    });
    Object.assign(environment, {
      TIMETABLING_AUTH_RACE_TEST_MODE: "timetabling-cross-process-race-v1",
      TIMETABLING_AUTH_RACE_RUN_TOKEN: authRaceRunToken,
      TIMETABLING_AUTH_RACE_CONTROL_DIR: authRaceControlDirectory,
      TIMETABLING_CONCURRENCY_PROCESS_LABEL: label,
    });

    // A、B 都加载 test-only preload，才能分别报告自己到达 `.immediate()`；
    // 正常 development／production 命令没有 `--require`，完全不会加载这段测试逻辑。
    const nodeArguments = ["--require", authRacePreloadPath, standaloneServerPath];
    handle.child = spawn(process.execPath, nodeArguments, {
      cwd: projectRoot,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    handle.child.stdout.on("data", (chunk) => keepRecentServerOutput(handle, chunk));
    handle.child.stderr.on("data", (chunk) => keepRecentServerOutput(handle, chunk));
    handle.child.once("error", (error) => {
      handle.processError = error;
      keepRecentServerOutput(handle, `\nServer process error: ${error.message}\n`);
    });
    // spawn 后立即登记；即使 Ctrl-C 恰好发生在 health ready 之前，统一清理仍能找到它。
    serverHandles.push(handle);

    try {
      await waitForServer(handle);
      return handle;
    } catch (error) {
      const portWasTaken = /EADDRINUSE/.test(handle.output);
      await stopServer(handle);
      const handleIndex = serverHandles.indexOf(handle);
      if (handleIndex >= 0) serverHandles.splice(handleIndex, 1);
      if (!portWasTaken || attempt === 3) throw error;
    }
  }
  throw new Error(`Server ${label} could not obtain a usable port.`);
}

async function requestApi(server, pathname, options = {}) {
  // 请求器强制显式传入目标服务器和 Cookie，防止两个端口意外共用全局登录状态。
  const {
    method = "GET",
    json,
    expectedStatus = 200,
    authenticated = true,
    cookie = "",
  } = options;
  const headers = new Headers();
  if (authenticated && cookie) headers.set("Cookie", cookie);
  if (json !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(new URL(pathname, server.baseUrl), {
    method,
    headers,
    body: json === undefined ? undefined : JSON.stringify(json),
    redirect: "error",
    signal: AbortSignal.timeout(requestTimeoutMilliseconds),
  });
  const responseText = await response.text();
  assert(
    (response.headers.get("content-type") || "").includes("application/json"),
    `${server.label} ${method} ${pathname} returned a non-JSON response.`,
  );
  let body;
  try {
    body = responseText ? JSON.parse(responseText) : null;
  } catch {
    throw new Error(`${server.label} ${method} ${pathname} returned invalid JSON: ${responseText.slice(0, 200)}`);
  }
  const acceptedStatuses = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
  assert(
    acceptedStatuses.includes(response.status),
    `${server.label} ${method} ${pathname} returned ${response.status}; expected ${acceptedStatuses.join(" or ")}; body=${responseText.slice(0, 500)}`,
  );
  return { response, body };
}

function cookieFrom(response, description) {
  // 只在内存保存 Set-Cookie 第一段，不输出随机会话令牌或其他安全属性。
  const setCookie = response.headers.get("set-cookie") || "";
  const cookie = setCookie.split(";", 1)[0];
  assert(cookie.includes("="), `${description} did not return a usable session cookie.`);
  return cookie;
}

async function login(server, username, password, expectedStatus = 200) {
  // 登录接口公开访问；成功时提取 Cookie，失败时仍返回完整受控 JSON 供竞态断言。
  const result = await requestApi(server, "/api/auth/login", {
    method: "POST",
    authenticated: false,
    expectedStatus,
    json: { username, password },
  });
  return {
    ...result,
    cookie: result.response.status === 200 ? cookieFrom(result.response, `${username} login`) : "",
  };
}

async function waitForWriterReady(server, readyFile, expectedControl, requestSettled, description) {
  // Preload 会在该进程调用真实 `.immediate()` 前把 arm 原子改名为 ready；
  // 因此读到完整 control 就能确定请求已经到达写事务，而不是仍在网络队列中。
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    assert.equal(requestSettled(), false, `${description} completed before reaching its SQLite lock wait.`);
    try {
      const readyControl = JSON.parse(await readFile(readyFile, "utf8"));
      assert.deepEqual(readyControl, expectedControl);
      return;
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
    }
    await delay(25);
  }
  throw new Error(`${description} never reached the writer marker in server ${server.label}.`);
}

async function runWhileBothWritersAreBlocked(description, serverA, serverB, leftRequest, rightRequest) {
  // 第三个 SQLite 连接先取得 IMMEDIATE 写锁。两个 HTTP 请求随后可以完成认证读取，
  // 但各自的写事务都必须等待；这样不会依赖操作系统恰好如何调度两个进程。
  const blocker = new Database(testDatabasePath);
  let holdsWriteLock = false;
  const writerControls = ["A", "B"].map((label) => ({
    version: 1,
    runToken: authRaceRunToken,
    nonce: randomBytes(16).toString("hex"),
    label,
  }));
  const writerFiles = writerControls.map((control) => ({
    arm: path.join(authRaceControlDirectory, `writer-arm-${control.label}.json`),
    temporaryArm: path.join(authRaceControlDirectory, `writer-arm-${control.label}-${control.nonce}.tmp`),
    ready: path.join(authRaceControlDirectory, `writer-ready-${control.label}-${control.nonce}.json`),
  }));
  try {
    blocker.exec("BEGIN IMMEDIATE");
    holdsWriteLock = true;
    // 每份 arm 先完整写入独立临时文件，再在同一目录原子改名到进程固定入口。
    await Promise.all(writerControls.map(async (control, index) => {
      await writeFile(writerFiles[index].temporaryArm, JSON.stringify(control), { flag: "wx", mode: 0o600 });
      await rename(writerFiles[index].temporaryArm, writerFiles[index].arm);
    }));
    const requests = [
      Promise.resolve().then(leftRequest),
      Promise.resolve().then(rightRequest),
    ];
    const settled = [false, false];
    requests.forEach((request, index) => {
      // 同时注册成功和失败处理，避免提前失败的 Promise 产生未处理拒绝。
      request.then(
        () => { settled[index] = true; },
        () => { settled[index] = true; },
      );
    });

    // 至少持锁 400ms，并且必须取得 A/B 各自在 `.immediate()` 前写出的 ready。
    await Promise.all([
      delay(overlapHoldMilliseconds),
      waitForWriterReady(serverA, writerFiles[0].ready, writerControls[0], () => settled[0], description),
      waitForWriterReady(serverB, writerFiles[1].ready, writerControls[1], () => settled[1], description),
    ]);
    assert.deepEqual(
      settled,
      [false, false],
      `${description} did not keep both server requests waiting behind the third SQLite writer.`,
    );
    blocker.exec("COMMIT");
    holdsWriteLock = false;
    return await Promise.all(requests);
  } finally {
    if (holdsWriteLock) {
      try { blocker.exec("ROLLBACK"); } catch { /* 清理阶段只需确保连接随后关闭。 */ }
    }
    blocker.close();
    await Promise.all(writerFiles.flatMap((files) => [files.arm, files.temporaryArm, files.ready])
      .map((filename) => rm(filename, { force: true }).catch(() => undefined)));
  }
}

function readCycleSnapshot() {
  // 五张周期表在同一个只读事务中读取，避免断言把两个已提交版本拼在一起。
  const db = new Database(testDatabasePath, { readonly: true });
  try {
    const snapshot = db.transaction(() => ({
      courses: db.prepare("SELECT * FROM courses ORDER BY id").all(),
      allocations: db.prepare("SELECT * FROM teaching_allocations ORDER BY id").all(),
      sections: db.prepare("SELECT * FROM course_sections ORDER BY id").all(),
      sectionGroups: db.prepare("SELECT * FROM section_student_groups ORDER BY section_id, student_group_id").all(),
      lessons: db.prepare("SELECT * FROM scheduled_lessons ORDER BY id").all(),
    }));
    return snapshot.deferred();
  } finally {
    db.close();
  }
}

function readRetainedSnapshot() {
  // Cycle 只能替换课程相关五表和紧急备份；基础资料、规则、账号及全部登录会话
  // 必须在 Start／Restore 竞争前后逐字段不变。
  const db = new Database(testDatabasePath, { readonly: true });
  try {
    const snapshot = db.transaction(() => ({
      teachers: db.prepare("SELECT * FROM teachers ORDER BY id").all(),
      studentGroups: db.prepare("SELECT * FROM student_groups ORDER BY id").all(),
      rooms: db.prepare("SELECT * FROM rooms ORDER BY id").all(),
      teacherWindows: db.prepare("SELECT * FROM teacher_unavailable_windows ORDER BY id").all(),
      yearWindows: db.prepare("SELECT * FROM year_blocked_windows ORDER BY id").all(),
      rules: db.prepare("SELECT * FROM rule_settings ORDER BY rule_key").all(),
      users: db.prepare("SELECT * FROM app_users ORDER BY id").all(),
      sessions: db.prepare("SELECT * FROM auth_sessions ORDER BY token_hash").all(),
    }));
    return snapshot.deferred();
  } finally {
    db.close();
  }
}

function readDatabaseValue(sql, ...parameters) {
  // 简短精确断言使用独立只读连接；调用结束立即关闭，不与后续写入争抢资源。
  const db = new Database(testDatabasePath, { readonly: true });
  try {
    return db.prepare(sql).get(...parameters);
  } finally {
    db.close();
  }
}

async function verifyConcurrentFirstPlacement(serverA, serverB, fixture) {
  // 两个进程为同一个班次、同一个 weekly occurrence 选择不同位置；数据库唯一键
  // 和 IMMEDIATE 顺序必须产生一个明确赢家，而不是两条记录或通用 500。
  const placementInputs = [
    { sectionId: fixture.sections[0].id, occurrence: 1, dayOfWeek: 1, startHour: 9, roomId: null },
    { sectionId: fixture.sections[0].id, occurrence: 1, dayOfWeek: 2, startHour: 10, roomId: null },
  ];
  const results = await runWhileBothWritersAreBlocked(
    "Concurrent first placement",
    serverA,
    serverB,
    () => requestApi(serverA, "/api/schedule/lessons", {
      method: "POST",
      cookie: fixture.schedulerACookie,
      expectedStatus: [201, 409],
      json: placementInputs[0],
    }),
    () => requestApi(serverB, "/api/schedule/lessons", {
      method: "POST",
      cookie: fixture.schedulerBCookie,
      expectedStatus: [201, 409],
      json: placementInputs[1],
    }),
  );
  assert.deepEqual(results.map((result) => result.response.status).sort(), [201, 409]);
  const winnerIndex = results.findIndex((result) => result.response.status === 201);
  const loserIndex = 1 - winnerIndex;
  const loser = results[1 - winnerIndex];
  assert.equal(loser.body.code, "LESSON_ALREADY_SCHEDULED");
  assert(!/sqlite|unique|constraint|scheduled_lessons|section_id|occurrence/i.test(JSON.stringify(loser.body)));

  // 直接数据库断言以赢家索引为准，不能只相信两个 HTTP 响应自己声称的结果。
  const saved = readDatabaseValue(
    "SELECT * FROM scheduled_lessons WHERE section_id = ? AND occurrence = 1",
    fixture.sections[0].id,
  );
  assert(saved);
  assert.equal(saved.id, results[winnerIndex].body.id);
  assert.equal(saved.day_of_week, placementInputs[winnerIndex].dayOfWeek);
  assert.equal(saved.start_hour, placementInputs[winnerIndex].startHour);
  assert.equal(saved.duration_hours, 2);
  assert.equal(saved.revision, 1);
  assert(Array.isArray(JSON.parse(saved.warnings_json)));
  const count = readDatabaseValue(
    "SELECT COUNT(*) AS count FROM scheduled_lessons WHERE section_id = ? AND occurrence = 1",
    fixture.sections[0].id,
  );
  assert.equal(count.count, 1);

  // 锁已释放后用败方位置顺序重试，必须稳定得到相同 409，且赢家完整数据库行零变化。
  const retryServer = loserIndex === 0 ? serverA : serverB;
  const retryCookie = loserIndex === 0 ? fixture.schedulerACookie : fixture.schedulerBCookie;
  const sequentialRetry = await requestApi(retryServer, "/api/schedule/lessons", {
    method: "POST",
    cookie: retryCookie,
    expectedStatus: 409,
    json: placementInputs[loserIndex],
  });
  assert.equal(sequentialRetry.body.code, "LESSON_ALREADY_SCHEDULED");
  assert(!/sqlite|unique|constraint|scheduled_lessons|section_id|occurrence/i.test(JSON.stringify(sequentialRetry.body)));
  assert.deepEqual(
    readDatabaseValue("SELECT * FROM scheduled_lessons WHERE id = ?", saved.id),
    saved,
  );

  // 两个服务随后必须读取到完全相同的赢家 ID，证明没有进程级缓存遮住最新提交。
  const [timetableA, timetableB] = await Promise.all([
    requestApi(serverA, "/api/schedule/lessons?year=1", { cookie: fixture.schedulerACookie }),
    requestApi(serverB, "/api/schedule/lessons?year=1", { cookie: fixture.schedulerBCookie }),
  ]);
  assert.deepEqual(timetableA.body.map((lesson) => lesson.id), timetableB.body.map((lesson) => lesson.id));
  assert(timetableA.body.some((lesson) => lesson.id === saved.id));
  report("跨进程首次排课严格得到一个 201 和一个 409");
}

async function verifyConcurrentCourseSetup(serverA, serverB, fixture) {
  // 两个旧 Configure 表单提交同一个 revision。时长、容量、年级、设施和周次都不同，
  // 因而可证明最终整组设置来自同一个赢家，而不是两次请求的字段混合。
  const setupCandidates = [
    {
      revision: fixture.setupRevision,
      durationHours: 3,
      sessionsPerWeek: 1,
      primaryYear: 2,
      minimumRoomCapacity: 31,
      requiresLab: true,
      requiresMultiProjector: false,
      requiresSmartClassroom: false,
      separateSectionsAcrossDays: false,
      weekStart: 1,
      weekEnd: 4,
    },
    {
      revision: fixture.setupRevision,
      durationHours: 4,
      sessionsPerWeek: 2,
      primaryYear: 3,
      minimumRoomCapacity: 32,
      requiresLab: false,
      requiresMultiProjector: true,
      requiresSmartClassroom: false,
      separateSectionsAcrossDays: true,
      weekStart: 5,
      weekEnd: 8,
    },
  ];
  const lessonBeforeSetup = readDatabaseValue("SELECT * FROM scheduled_lessons WHERE section_id = ?", fixture.sections[0].id);
  assert.equal(lessonBeforeSetup.duration_hours, 2);
  assert.equal(lessonBeforeSetup.revision, 1);
  const results = await runWhileBothWritersAreBlocked(
    "Concurrent Course Setup",
    serverA,
    serverB,
    () => requestApi(serverA, `/api/courses/${fixture.courseId}`, {
      method: "PATCH",
      cookie: fixture.schedulerACookie,
      expectedStatus: [200, 409],
      json: setupCandidates[0],
    }),
    () => requestApi(serverB, `/api/courses/${fixture.courseId}`, {
      method: "PATCH",
      cookie: fixture.schedulerBCookie,
      expectedStatus: [200, 409],
      json: setupCandidates[1],
    }),
  );
  assert.deepEqual(results.map((result) => result.response.status).sort(), [200, 409]);
  const winnerIndex = results.findIndex((result) => result.response.status === 200);
  const loser = results[1 - winnerIndex];
  assert.equal(results[winnerIndex].body.ok, true);
  assert.equal(results[winnerIndex].body.changed, true);
  assert.equal(loser.body.code, "COURSE_SETUP_CHANGED");
  assert(!/sqlite|database|constraint|courses|scheduled_lessons|revision\s*=/i.test(JSON.stringify(loser.body)));

  // 课程 revision 只增加一次，并逐字段核对全部设置；week_pattern 是数字周次的兼容投影。
  const savedCourse = readDatabaseValue(
    `SELECT revision, duration_hours, sessions_per_week, primary_year, minimum_room_capacity,
      requires_lab, requires_multi_projector, requires_smart_classroom,
      separate_sections_across_days, week_pattern, week_start, week_end
    FROM courses WHERE id = ?`,
    fixture.courseId,
  );
  const winnerSetup = setupCandidates[winnerIndex];
  assert.equal(savedCourse.revision, fixture.setupRevision + 1);
  assert.deepEqual(savedCourse, {
    revision: fixture.setupRevision + 1,
    duration_hours: winnerSetup.durationHours,
    sessions_per_week: winnerSetup.sessionsPerWeek,
    primary_year: winnerSetup.primaryYear,
    minimum_room_capacity: winnerSetup.minimumRoomCapacity,
    requires_lab: Number(winnerSetup.requiresLab),
    requires_multi_projector: Number(winnerSetup.requiresMultiProjector),
    requires_smart_classroom: Number(winnerSetup.requiresSmartClassroom),
    separate_sections_across_days: Number(winnerSetup.separateSectionsAcrossDays),
    week_pattern: winnerSetup.weekStart === 1 ? "W1_4" : "W5_8",
    week_start: winnerSetup.weekStart,
    week_end: winnerSetup.weekEnd,
  });
  assert.equal(results[winnerIndex].body.revision, fixture.setupRevision + 1);

  // 关联 lesson 的冗余时长和 revision 必须与课程同事务更新，且只增加一次。
  const lessonAfterSetup = readDatabaseValue("SELECT * FROM scheduled_lessons WHERE id = ?", lessonBeforeSetup.id);
  assert.equal(lessonAfterSetup.duration_hours, winnerSetup.durationHours);
  assert.equal(lessonAfterSetup.revision, lessonBeforeSetup.revision + 1);
  assert(Array.isArray(JSON.parse(lessonAfterSetup.warnings_json)));
  assert.equal(
    readDatabaseValue("SELECT revision FROM course_sections WHERE id = ?", fixture.sections[0].id).revision,
    fixture.sections[0].revision,
  );

  // 败方旧 revision 在赢家提交后顺序重试，仍应 409，五张周期表逐字段保持。
  const snapshotBeforeStaleRetry = readCycleSnapshot();
  const loserIndex = 1 - winnerIndex;
  const staleRetry = await requestApi(loserIndex === 0 ? serverA : serverB, `/api/courses/${fixture.courseId}`, {
    method: "PATCH",
    cookie: loserIndex === 0 ? fixture.schedulerACookie : fixture.schedulerBCookie,
    expectedStatus: 409,
    json: setupCandidates[loserIndex],
  });
  assert.equal(staleRetry.body.code, "COURSE_SETUP_CHANGED");
  assert.deepEqual(readCycleSnapshot(), snapshotBeforeStaleRetry);
  fixture.setupRevision = savedCourse.revision;
  report("跨进程 Course Setup 严格得到一个 200 和一个 409");
}

async function verifyConcurrentCycleStartAndRestore(serverA, serverB, fixture) {
  // Start 前保存五张周期表的完整资料；最后 Restore 必须逐字段回到同一版本。
  const snapshotBeforeStart = readCycleSnapshot();
  const retainedBeforeStart = readRetainedSnapshot();
  const [statusA, statusB] = await Promise.all([
    requestApi(serverA, "/api/cycle", { cookie: fixture.schedulerACookie }),
    requestApi(serverB, "/api/cycle", { cookie: fixture.schedulerBCookie }),
  ]);
  assert.equal(statusA.body.currentToken, statusB.body.currentToken);
  assert.equal(statusA.body.courses, 1);

  const startResults = await runWhileBothWritersAreBlocked(
    "Concurrent Cycle Start",
    serverA,
    serverB,
    () => requestApi(serverA, "/api/cycle", {
      method: "POST",
      cookie: fixture.schedulerACookie,
      expectedStatus: [200, 409],
      json: { action: "start", confirmation: "START NEW CYCLE", currentToken: statusA.body.currentToken },
    }),
    () => requestApi(serverB, "/api/cycle", {
      method: "POST",
      cookie: fixture.schedulerBCookie,
      expectedStatus: [200, 409],
      json: { action: "start", confirmation: "START NEW CYCLE", currentToken: statusB.body.currentToken },
    }),
  );
  assert.deepEqual(startResults.map((result) => result.response.status).sort(), [200, 409]);
  const startWinner = startResults.find((result) => result.response.status === 200);
  const startLoser = startResults.find((result) => result.response.status === 409);
  assert.equal(
    startLoser.body.error,
    "The current cycle changed. Refresh this page and review the latest contents before starting a new cycle.",
  );
  assert.deepEqual(
    {
      courses: startWinner.body.courses,
      sections: startWinner.body.sections,
      lessons: startWinner.body.lessons,
    },
    { courses: 0, sections: 0, lessons: 0 },
  );
  const clearedCounts = readDatabaseValue(`SELECT
    (SELECT COUNT(*) FROM courses) AS courses,
    (SELECT COUNT(*) FROM teaching_allocations) AS allocations,
    (SELECT COUNT(*) FROM course_sections) AS sections,
    (SELECT COUNT(*) FROM section_student_groups) AS section_groups,
    (SELECT COUNT(*) FROM scheduled_lessons) AS lessons`);
  assert.deepEqual(clearedCounts, { courses: 0, allocations: 0, sections: 0, section_groups: 0, lessons: 0 });
  assert.equal(readDatabaseValue("SELECT COUNT(*) AS count FROM schedule_backups").count, 1);
  assert.deepEqual(readRetainedSnapshot(), retainedBeforeStart);

  // 数据库中的 backup JSON 必须就是竞争前五张表，而不是赢家清空一半后的混合快照。
  const backupAfterStart = readDatabaseValue("SELECT * FROM schedule_backups");
  assert.deepEqual(JSON.parse(backupAfterStart.snapshot_json), snapshotBeforeStart);

  // 清空后的 token 和 backup ID 必须由两个进程一致读取，再用相同旧页面资料竞争 Restore。
  const [clearedA, clearedB] = await Promise.all([
    requestApi(serverA, "/api/cycle", { cookie: fixture.schedulerACookie }),
    requestApi(serverB, "/api/cycle", { cookie: fixture.schedulerBCookie }),
  ]);
  assert.equal(clearedA.body.currentToken, clearedB.body.currentToken);
  assert.equal(startWinner.body.currentToken, clearedA.body.currentToken);
  assert.equal(clearedA.body.backup.id, clearedB.body.backup.id);
  assert.equal(clearedA.body.backup.id, startWinner.body.backup.id);

  const restoreResults = await runWhileBothWritersAreBlocked(
    "Concurrent Cycle Restore",
    serverA,
    serverB,
    () => requestApi(serverA, "/api/cycle", {
      method: "POST",
      cookie: fixture.schedulerACookie,
      expectedStatus: [200, 409],
      json: {
        action: "restore",
        confirmation: "RESTORE LAST BACKUP",
        currentToken: clearedA.body.currentToken,
        backupId: clearedA.body.backup.id,
      },
    }),
    () => requestApi(serverB, "/api/cycle", {
      method: "POST",
      cookie: fixture.schedulerBCookie,
      expectedStatus: [200, 409],
      json: {
        action: "restore",
        confirmation: "RESTORE LAST BACKUP",
        currentToken: clearedB.body.currentToken,
        backupId: clearedB.body.backup.id,
      },
    }),
  );
  assert.deepEqual(restoreResults.map((result) => result.response.status).sort(), [200, 409]);
  const restoreWinner = restoreResults.find((result) => result.response.status === 200);
  const restoreLoser = restoreResults.find((result) => result.response.status === 409);
  assert.equal(
    restoreLoser.body.error,
    "The current cycle changed. Refresh this page and review the latest contents before restoring.",
  );
  assert.deepEqual(readCycleSnapshot(), snapshotBeforeStart);
  assert.deepEqual(readRetainedSnapshot(), retainedBeforeStart);
  assert.equal(readDatabaseValue("SELECT COUNT(*) AS count FROM schedule_backups").count, 1);
  assert.deepEqual(readDatabaseValue("SELECT * FROM schedule_backups"), backupAfterStart);

  // Restore 赢家返回的 token 必须等于两个进程随后共同看到的最新 token。
  const [restoredA, restoredB] = await Promise.all([
    requestApi(serverA, "/api/cycle", { cookie: fixture.schedulerACookie }),
    requestApi(serverB, "/api/cycle", { cookie: fixture.schedulerBCookie }),
  ]);
  assert.equal(restoredA.body.currentToken, restoredB.body.currentToken);
  assert.equal(restoreWinner.body.currentToken, restoredA.body.currentToken);
  assert.equal(restoreWinner.body.currentToken, statusA.body.currentToken);
  report("跨进程 Cycle Start／Restore 各严格得到一个 200 和一个 409");
}

async function waitForAuthRaceReady(server, readyFile, expectedControl) {
  // ready 文件只会在 B 已经用真实 Scrypt 和 timingSafeEqual 验证旧密码后建立。
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null || server.child.signalCode !== null) {
      throw new Error("Server B exited before reaching the authentication race barrier.");
    }
    try {
      await access(readyFile);
      const readyControl = JSON.parse(await readFile(readyFile, "utf8"));
      assert.deepEqual(readyControl, expectedControl);
      return;
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
    }
    await delay(25);
  }
  throw new Error("Authentication did not reach the post-password-verification barrier within 15 seconds.");
}

function storedPasswordFingerprint(accountId) {
  // arm 只保存数据库密码摘要的二次 SHA-256 指纹，绝不把测试账号明文密码写入文件。
  const row = readDatabaseValue("SELECT password_hash FROM app_users WHERE id = ?", accountId);
  const expectedHex = row?.password_hash?.split(":")[1] || "";
  assert.match(expectedHex, /^[a-f0-9]{128}$/i);
  return createHash("sha256").update(Buffer.from(expectedHex, "hex")).digest("hex");
}

async function releaseAuthenticationRace(releaseFile, nonce) {
  // release 内容必须精确等于本次 nonce；EEXIST 表示正常路径已经释放，不应追加第二份内容。
  try {
    await writeFile(releaseFile, `${nonce}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (!error || error.code !== "EEXIST") throw error;
    assert.equal((await readFile(releaseFile, "utf8")).trim(), nonce);
  }
}

async function verifyAuthenticationRevocationRace(serverA, serverB, options) {
  const { username, oldPassword, accountId, administratorAction, description } = options;
  const accountBeforeAction = readDatabaseValue(
    "SELECT password_hash, is_active FROM app_users WHERE id = ?",
    accountId,
  );
  assert.equal(accountBeforeAction.is_active, 1);
  const nonce = randomBytes(16).toString("hex");
  const expectedControl = {
    version: 1,
    runToken: authRaceRunToken,
    label: "B",
    nonce,
    expectedFingerprint: storedPasswordFingerprint(accountId),
  };
  const armFile = path.join(authRaceControlDirectory, "arm.json");
  const temporaryArmFile = path.join(authRaceControlDirectory, `arm-${nonce}.tmp`);
  const readyFile = path.join(authRaceControlDirectory, `ready-${nonce}.json`);
  const releaseFile = path.join(authRaceControlDirectory, `release-${nonce}.txt`);
  activeAuthRaceReleases.set(releaseFile, nonce);
  // 先完整写好临时文件再原子改名，B 不会读到半截 JSON。
  await writeFile(temporaryArmFile, JSON.stringify(expectedControl), { flag: "wx", mode: 0o600 });
  await rename(temporaryArmFile, armFile);

  // B 开始登录后会在旧密码已经确认正确、但 IMMEDIATE 会话事务尚未开始时暂停。
  // A 必须先完成 reset/deactivate，主测试才写 release 让 B 继续。
  let loginSettled = false;
  const pendingLogin = login(serverB, username, oldPassword, 401);
  pendingLogin.then(
    () => { loginSettled = true; },
    () => { loginSettled = true; },
  );
  try {
    await waitForAuthRaceReady(serverB, readyFile, expectedControl);
    assert.equal(loginSettled, false, `${description} login completed before the administrator action.`);
    await requestApi(serverA, "/api/auth/accounts", {
      method: "PATCH",
      cookie: administratorCookie,
      json: { userId: accountId, ...administratorAction },
    });
    // release 前直接读取管理员已提交状态，明确建立“撤销提交发生在登录继续之前”的顺序。
    const accountAfterAction = readDatabaseValue(
      "SELECT password_hash, is_active FROM app_users WHERE id = ?",
      accountId,
    );
    if (administratorAction.action === "resetPassword") {
      assert.notEqual(accountAfterAction.password_hash, accountBeforeAction.password_hash);
      assert.equal(accountAfterAction.is_active, 1);
    } else {
      assert.equal(accountAfterAction.password_hash, accountBeforeAction.password_hash);
      assert.equal(accountAfterAction.is_active, 0);
    }
    assert.equal(
      readDatabaseValue("SELECT COUNT(*) AS count FROM auth_sessions WHERE user_id = ?", accountId).count,
      0,
    );
    await releaseAuthenticationRace(releaseFile, nonce);
    const rejectedLogin = await pendingLogin;
    assert.deepEqual(rejectedLogin.body, { error: "Username or password is incorrect." });
    assert.equal(rejectedLogin.response.headers.get("set-cookie"), null);
    assert.equal(
      readDatabaseValue("SELECT COUNT(*) AS count FROM auth_sessions WHERE user_id = ?", accountId).count,
      0,
    );
  } finally {
    // 任一断言失败也必须释放 B；否则同步 preload 会一直等到自己的超时上限。
    await releaseAuthenticationRace(releaseFile, nonce).catch(() => undefined);
    activeAuthRaceReleases.delete(releaseFile);
    await rm(armFile, { force: true }).catch(() => undefined);
    await pendingLogin.catch(() => undefined);
  }

  // 竞态结束后再次使用旧密码仍必须失败，证明没有在撤销之后补回新会话。
  const sequentialOldLogin = await login(serverB, username, oldPassword, 401);
  assert.deepEqual(sequentialOldLogin.body, { error: "Username or password is incorrect." });
  assert.equal(sequentialOldLogin.response.headers.get("set-cookie"), null);
  report(description);
}

async function verifyAuthenticationRaces(serverA, serverB, fixture) {
  const resetAccount = fixture.accounts.get("cross-reset-race");
  await verifyAuthenticationRevocationRace(serverA, serverB, {
    username: "cross-reset-race",
    oldPassword: resetAccount.password,
    accountId: resetAccount.id,
    administratorAction: { action: "resetPassword", password: "ResetRaceNew456!" },
    description: "旧密码验证后管理员重置密码仍阻止会话建立",
  });

  // 新密码必须可以正常登录，说明上一组失败来自旧凭证被撤销，而不是账号损坏。
  const newPasswordLogin = await login(serverB, "cross-reset-race", "ResetRaceNew456!");
  await requestApi(serverB, "/api/auth/logout", {
    method: "POST",
    cookie: newPasswordLogin.cookie,
  });

  const disabledAccount = fixture.accounts.get("cross-disable-race");
  await verifyAuthenticationRevocationRace(serverA, serverB, {
    username: "cross-disable-race",
    oldPassword: disabledAccount.password,
    accountId: disabledAccount.id,
    administratorAction: { action: "status", isActive: false },
    description: "旧密码验证后管理员停用账号仍阻止会话建立",
  });
  const savedStatus = readDatabaseValue("SELECT is_active FROM app_users WHERE id = ?", disabledAccount.id);
  assert.equal(savedStatus.is_active, 0);

  // 重新启用后原密码应恢复正常登录资格，证明竞态测试没有破坏账号或密码资料。
  await requestApi(serverA, "/api/auth/accounts", {
    method: "PATCH",
    cookie: administratorCookie,
    json: { userId: disabledAccount.id, action: "status", isActive: true },
  });
  const reenabledLogin = await login(serverB, "cross-disable-race", disabledAccount.password);
  await requestApi(serverB, "/api/auth/logout", { method: "POST", cookie: reenabledLogin.cookie });
}

function verifyFinalDatabase() {
  // 所有服务器停止后再做 SQLite 自检，避免后台连接或尚未结束的 HTTP 请求干扰结果。
  const db = new Database(testDatabasePath, { readonly: true });
  try {
    assert.deepEqual(db.pragma("integrity_check"), [{ integrity_check: "ok" }]);
    assert.deepEqual(db.pragma("foreign_key_check"), []);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM courses").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM course_sections").get().count, 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM scheduled_lessons").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM schedule_backups").get().count, 1);
  } finally {
    db.close();
  }
}

function cleanupTemporaryResources() {
  // 普通 finally、Ctrl-C 和 CI SIGTERM 共用一个幂等 Promise，保证最多清理一次。
  if (!cleanupPromise) {
    cleanupPromise = (async () => {
      // 若认证请求停在 preload，先建立 release 文件，再终止两个进程。
      await Promise.all([...activeAuthRaceReleases].map(([releaseFile, nonce]) => (
        releaseAuthenticationRace(releaseFile, nonce).catch(() => undefined)
      )));
      await Promise.allSettled(serverHandles.map((handle) => stopServer(handle)));
      if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
    })();
  }
  return cleanupPromise;
}

function installTerminationCleanup() {
  // 开发人员中断或 CI 终止时先释放 barrier、停止 A/B、删除临时 SQLite，再按信号退出。
  for (const [signal, exitCode] of [["SIGINT", 130], ["SIGTERM", 143]]) {
    process.once(signal, () => {
      void cleanupTemporaryResources()
        .then(() => process.exit(exitCode))
        .catch(() => process.exit(exitCode));
    });
  }
}

async function run() {
  // 独立脚本复用已生成的 production build；缺少构建或 preload 时给出明确提示。
  try {
    await access(standaloneServerPath);
    await access(authRacePreloadPath);
  } catch {
    throw new Error("Standalone build or authentication race preload is missing. Run `npm run build` before this verification.");
  }

  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "timetabling-api-concurrency-"));
  testDatabasePath = path.join(temporaryDirectory, "shared.sqlite");
  authRaceControlDirectory = path.join(temporaryDirectory, "auth-race-control");
  authRaceRunToken = randomBytes(32).toString("hex");
  assert.equal(path.dirname(testDatabasePath), temporaryDirectory);
  await mkdir(authRaceControlDirectory, { mode: 0o700 });
  await writeFile(path.join(authRaceControlDirectory, "run-token.marker"), `${authRaceRunToken}\n`, {
    flag: "wx",
    mode: 0o600,
  });

  // A 先完成空库初始化和管理员 setup，B 再加载同一个数据库及测试专用 preload。
  const serverA = await startServer("A");
  // B 必须在管理员 setup 之后启动，避免空库初始化本身成为本测试的竞争对象。
  const setup = await requestApi(serverA, "/api/auth/setup", {
    method: "POST",
    authenticated: false,
    expectedStatus: 201,
    json: { username: "cross-admin", password: "CrossProcessAdmin123!" },
  });
  administratorCookie = cookieFrom(setup.response, "Initial administrator setup");
  const serverB = await startServer("B");

  // 管理员已提前建立；接下来创建账号、独立会话和课程 fixture。
  const fixture = await initializeFixtureAfterAdministrator(serverA, serverB);

  await verifyConcurrentFirstPlacement(serverA, serverB, fixture);
  await verifyConcurrentCourseSetup(serverA, serverB, fixture);
  await verifyConcurrentCycleStartAndRestore(serverA, serverB, fixture);
  await verifyAuthenticationRaces(serverA, serverB, fixture);

  await Promise.all(serverHandles.map((handle) => stopServer(handle)));
  verifyFinalDatabase();
  console.log("Cross-process SQLite concurrency verification passed.");
}

async function initializeFixtureAfterAdministrator(serverA, serverB) {
  // 管理员已经在 B 启动前建立；其余逻辑与完整初始化相同，并确保两个真实会话分属 A/B。
  const accountDefinitions = [
    ["cross-scheduler-a", "CrossSchedulerA123!"],
    ["cross-scheduler-b", "CrossSchedulerB123!"],
    ["cross-reset-race", "ResetRaceOld123!"],
    ["cross-disable-race", "DisableRaceOld123!"],
  ];
  const accounts = new Map();
  for (const [username, password] of accountDefinitions) {
    const created = await requestApi(serverA, "/api/auth/accounts", {
      method: "POST",
      cookie: administratorCookie,
      expectedStatus: 201,
      json: { username, password },
    });
    accounts.set(username, { ...created.body, password });
  }
  const schedulerA = await login(serverA, "cross-scheduler-a", accounts.get("cross-scheduler-a").password);
  const schedulerB = await login(serverB, "cross-scheduler-b", accounts.get("cross-scheduler-b").password);
  assert.notEqual(schedulerA.cookie, schedulerB.cookie);
  const statusFromB = await requestApi(serverB, "/api/auth/status", { cookie: schedulerA.cookie });
  const statusFromA = await requestApi(serverA, "/api/auth/status", { cookie: schedulerB.cookie });
  assert.equal(statusFromB.body.user.username, "cross-scheduler-a");
  assert.equal(statusFromA.body.user.username, "cross-scheduler-b");
  await requestApi(serverB, "/api/teachers", { cookie: schedulerA.cookie });
  await requestApi(serverA, "/api/teachers", { cookie: schedulerB.cookie });

  const course = (await requestApi(serverA, "/api/courses", {
    method: "POST",
    cookie: schedulerA.cookie,
    expectedStatus: 201,
    json: { code: "CROSS_PROCESS", catalog: "Two standalone concurrency fixture", sectionCount: 2 },
  })).body;
  const initialSetup = await requestApi(serverA, `/api/courses/${course.id}`, {
    method: "PATCH",
    cookie: schedulerA.cookie,
    json: {
      revision: course.revision,
      durationHours: 2,
      sessionsPerWeek: 1,
      primaryYear: 1,
      minimumRoomCapacity: 20,
      requiresLab: false,
      requiresMultiProjector: false,
      requiresSmartClassroom: false,
      separateSectionsAcrossDays: false,
      weekStart: null,
      weekEnd: null,
    },
  });
  const sections = (await requestApi(serverB, `/api/courses/${course.id}/sections`, { cookie: schedulerB.cookie })).body;
  assert.equal(sections.length, 2);
  report("两个 standalone 共享账号、会话和最小课程资料");
  return {
    accounts,
    courseId: course.id,
    setupRevision: initialSetup.body.revision,
    sections,
    schedulerACookie: schedulerA.cookie,
    schedulerBCookie: schedulerB.cookie,
  };
}

installTerminationCleanup();

try {
  await run();
} catch (error) {
  // 失败时只显示简洁断言和 A/B 各自的有限日志，不输出密码或 Cookie。
  console.error("Cross-process concurrency verification failed:", error);
  for (const handle of serverHandles) {
    if (handle.output.trim()) console.error(`Last standalone server ${handle.label} output:\n${handle.output.trim()}`);
  }
  process.exitCode = 1;
} finally {
  // 成功、超时、断言失败和未处理异常都不会留下子进程或临时数据库。
  await cleanupTemporaryResources();
}
