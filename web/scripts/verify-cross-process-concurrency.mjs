import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import * as XLSX from "xlsx";

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
let administratorSetupToken;
let administratorCookie = "";
let cleanupPromise;
const serverHandles = [];
const externalWriterHandles = new Set();
const activeRaceReleases = new Map();

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
      "TIMETABLING_SETUP_TOKEN",
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
      TIMETABLING_SETUP_TOKEN: administratorSetupToken,
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

async function armDatabaseInitializationFailure() {
  // A 启动前先准备一次性故障。Preload 会在第一组真实 CREATE TABLE 已执行后消费它，
  // 因而第二次健康检查面对的是一个“表已部分建立、但连接已经关闭”的真实重试场景。
  const nonce = randomBytes(16).toString("hex");
  const control = {
    version: 1,
    runToken: authRaceRunToken,
    label: "A",
    nonce,
  };
  const files = {
    arm: path.join(authRaceControlDirectory, "database-initialization-arm-A.json"),
    temporary: path.join(
      authRaceControlDirectory,
      `database-initialization-arm-A-${nonce}.tmp`,
    ),
    consumed: path.join(
      authRaceControlDirectory,
      `database-initialization-consumed-A-${nonce}.json`,
    ),
    ready: path.join(
      authRaceControlDirectory,
      `database-initialization-close-ready-A-${nonce}.json`,
    ),
  };
  await writeFile(files.temporary, JSON.stringify(control), { flag: "wx", mode: 0o600 });
  await rename(files.temporary, files.arm);
  return { control, files };
}

async function verifyDatabaseInitializationRecovery(serverA, fault) {
  try {
    // ready 文件只会在命中故障的同一个 better-sqlite3 实例真实 close 后出现。
    // startServer 已在同一个子进程里等到后续 health=200，因此也证明重试没有重启服务。
    assert.deepEqual(JSON.parse(await readFile(fault.files.ready, "utf8")), fault.control);
    assert.equal(serverA.child.exitCode, null);
    assert.equal(serverA.child.signalCode, null);

    // 第一次故障发生在建表 SQL 之后、规则与索引之前。成功重试必须补齐后续初始化，
    // 而不只是让 SELECT 1 健康检查偶然通过。
    const db = new Database(testDatabasePath, { readonly: true });
    try {
      assert.deepEqual(db.pragma("integrity_check"), [{ integrity_check: "ok" }]);
      assert.deepEqual(db.pragma("foreign_key_check"), []);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM rule_settings").get().count, 7);
      assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND name = ?")
          .get("auth_sessions_user_id_idx").count,
        1,
      );
    } finally {
      db.close();
    }
    report("首次数据库初始化失败会关闭局部连接并在同一服务进程中干净重试");
  } finally {
    // 成功和断言失败都删除本组一次性控制文件；顶层临时目录清理仍是最终保险。
    await Promise.all(Object.values(fault.files).map((filename) => (
      rm(filename, { force: true }).catch(() => undefined)
    )));
  }
}

async function requestApi(server, pathname, options = {}) {
  // 请求器强制显式传入目标服务器和 Cookie，防止两个端口意外共用全局登录状态。
  const {
    method = "GET",
    json,
    body: requestBody,
    requestHeaders = {},
    expectedStatus = 200,
    authenticated = true,
    cookie = "",
  } = options;
  const headers = new Headers(requestHeaders);
  if (authenticated && cookie) headers.set("Cookie", cookie);
  if (json !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(new URL(pathname, server.baseUrl), {
    method,
    headers,
    body: json === undefined ? requestBody : JSON.stringify(json),
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

function teachingMembersImportForm(rows, filename = "cross-process-teaching-members.xlsx") {
  // 使用真实 SheetJS 工作簿和 multipart FormData 进入 production 导入路由；屏障测试
  // 不直接写数据库，才能同时覆盖解析、业务事务和聚合读锁之间的真实交错。
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.json_to_sheet(rows, {
    header: ["Mod", "Catalog", "Lecturer", "Staff Type", "# of grps teaching"],
  });
  XLSX.utils.book_append_sheet(workbook, worksheet, "Teaching Members");
  const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx", compression: true });
  const form = new FormData();
  form.append(
    "file",
    new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
    filename,
  );
  return form;
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

async function waitForRaceReady(server, readyFile, expectedControl, requestSettled, description, markerDescription) {
  // Preload 只有到达指定 SQLite 读取／写入同步点后才会把 arm 原子改名为 ready；
  // 因此完整 control 比固定 sleep 更能证明两个真实进程已经按预期交错。
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    assert.equal(requestSettled(), false, `${description} completed before reaching ${markerDescription}.`);
    try {
      const readyControl = JSON.parse(await readFile(readyFile, "utf8"));
      assert.deepEqual(readyControl, expectedControl);
      return;
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
    }
    await delay(25);
  }
  throw new Error(`${description} never reached ${markerDescription} in server ${server.label}.`);
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
      waitForRaceReady(serverA, writerFiles[0].ready, writerControls[0], () => settled[0], description, "its SQLite writer entry"),
      waitForRaceReady(serverB, writerFiles[1].ready, writerControls[1], () => settled[1], description, "its SQLite writer entry"),
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

function readFullBusinessSnapshotFrom(databasePath) {
  // Candidate 失败属于纯读取。14 张业务表在同一个 DEFERRED 快照中逐字段读取，
  // 能发现 revision、warning、会话或备份的任何隐藏写入，而不只是比较行数。
  const db = new Database(databasePath, { readonly: true });
  try {
    const snapshot = db.transaction(() => ({
      courses: db.prepare("SELECT * FROM courses ORDER BY id").all(),
      allocations: db.prepare("SELECT * FROM teaching_allocations ORDER BY id").all(),
      sections: db.prepare("SELECT * FROM course_sections ORDER BY id").all(),
      sectionGroups: db.prepare("SELECT * FROM section_student_groups ORDER BY section_id, student_group_id").all(),
      lessons: db.prepare("SELECT * FROM scheduled_lessons ORDER BY id").all(),
      teachers: db.prepare("SELECT * FROM teachers ORDER BY id").all(),
      studentGroups: db.prepare("SELECT * FROM student_groups ORDER BY id").all(),
      rooms: db.prepare("SELECT * FROM rooms ORDER BY id").all(),
      teacherWindows: db.prepare("SELECT * FROM teacher_unavailable_windows ORDER BY id").all(),
      yearWindows: db.prepare("SELECT * FROM year_blocked_windows ORDER BY id").all(),
      rules: db.prepare("SELECT * FROM rule_settings ORDER BY rule_key").all(),
      users: db.prepare("SELECT * FROM app_users ORDER BY id").all(),
      sessions: db.prepare("SELECT * FROM auth_sessions ORDER BY token_hash").all(),
      backups: db.prepare("SELECT * FROM schedule_backups ORDER BY id").all(),
    }));
    return snapshot.deferred();
  } finally {
    db.close();
  }
}

function readFullBusinessSnapshot() {
  return readFullBusinessSnapshotFrom(testDatabasePath);
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

async function waitForPendingRollbackJournalWriter(description, timeoutMilliseconds = 3_000) {
  // DELETE journal 中，writer 完成业务 SQL 并开始 COMMIT 时会先取得 PENDING 锁，
  // 阻止新的 reader 加入，再等待旧 SHARED reader 退出。用 busy_timeout=0 的新连接
  // 观察真实 SQLITE_BUSY，比固定 sleep 更能证明 writer 已到达 COMMIT 边界。
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    let observer;
    try {
      observer = new Database(testDatabasePath, { readonly: true });
      observer.pragma("busy_timeout = 0");
      observer.prepare("SELECT COUNT(*) AS count FROM scheduled_lessons").get();
    } catch (error) {
      if (error?.code === "SQLITE_BUSY" || error?.code === "SQLITE_LOCKED") return;
      throw error;
    } finally {
      observer?.close();
    }
    await delay(25);
  }
  throw new Error(`${description} never reached the rollback-journal PENDING lock before timeout.`);
}

function assertCandidateSnapshot(body, fixture, expectedCapacity) {
  // 旧快照容量20不满足课程最低30，所以必须没有候选；新快照容量40时，
  // 午餐规则会排除12:00，留下每天七个2小时整点位置，共35项。
  assert.equal(body.sectionLabel, "CROSS_PROCESS_02");
  assert.equal(body.occurrence, 1);
  assert.equal(body.sessionsPerWeek, 1);
  assert(Array.isArray(body.slots));
  if (expectedCapacity === 20) {
    assert.deepEqual(body.slots, []);
    return;
  }
  const expectedStarts = [9, 10, 11, 13, 14, 15, 16];
  const expectedKeys = [];
  for (let dayOfWeek = 1; dayOfWeek <= 5; dayOfWeek += 1) {
    for (const startHour of expectedStarts) expectedKeys.push(`${dayOfWeek}-${startHour}`);
  }
  assert.equal(body.slots.length, expectedKeys.length);
  assert.deepEqual(
    body.slots.map((slot) => `${slot.dayOfWeek}-${slot.startHour}`).sort(),
    expectedKeys.sort(),
  );
  for (const slot of body.slots) {
    assert.equal(slot.endHour, slot.startHour + 2);
    assert.equal(slot.roomId, fixture.candidateRoom.id);
    assert.equal(slot.roomCode, fixture.candidateRoom.code);
    assert.equal(slot.roomCapacity, 40);
    assert.deepEqual(slot.roomFeatures, []);
  }
}

async function verifyConcurrentMasterDataAndSectionResize(serverA, serverB, fixture) {
  // 两个独立 standalone 同时提交同一教师 revision，只能恰好一个成功；赢家提交后，
  // 两个进程必须读取同一版本，旧请求收到稳定 MASTER_DATA_CHANGED 而非静默覆盖。
  const teacherAttempts = [
    { server: serverA, cookie: fixture.schedulerACookie, name: "CROSS CAS TEACHER A", staffType: "FT" },
    { server: serverB, cookie: fixture.schedulerBCookie, name: "CROSS CAS TEACHER B", staffType: "PT" },
  ];
  const teacherResults = await Promise.all(teacherAttempts.map(async (attempt) => ({
    attempt,
    result: await requestApi(attempt.server, `/api/teachers/${fixture.candidateTeacher.id}`, {
      method: "PATCH",
      cookie: attempt.cookie,
      expectedStatus: [200, 409],
      json: { name: attempt.name, staffType: attempt.staffType, revision: fixture.candidateTeacher.revision },
    }),
  })));
  assert.deepEqual(teacherResults.map(({ result }) => result.response.status).sort(), [200, 409]);
  const teacherWinner = teacherResults.find(({ result }) => result.response.status === 200);
  const teacherLoser = teacherResults.find(({ result }) => result.response.status === 409);
  assert.equal(teacherWinner.result.body.revision, fixture.candidateTeacher.revision + 1);
  assert.equal(teacherLoser.result.body.code, "MASTER_DATA_CHANGED");
  const [teachersFromA, teachersFromB] = await Promise.all([
    requestApi(serverA, "/api/teachers", { cookie: fixture.schedulerACookie }),
    requestApi(serverB, "/api/teachers", { cookie: fixture.schedulerBCookie }),
  ]);
  const winningTeacherA = teachersFromA.body.find((teacher) => teacher.id === fixture.candidateTeacher.id);
  const winningTeacherB = teachersFromB.body.find((teacher) => teacher.id === fixture.candidateTeacher.id);
  assert.deepEqual(winningTeacherA, winningTeacherB);
  assert.equal(winningTeacherA.name, teacherWinner.attempt.name);
  const restoredTeacher = await requestApi(serverA, `/api/teachers/${fixture.candidateTeacher.id}`, {
    method: "PATCH",
    cookie: fixture.schedulerACookie,
    json: { name: fixture.candidateTeacher.name, staffType: fixture.candidateTeacher.staffType, revision: winningTeacherA.revision },
  });
  fixture.candidateTeacher.revision = restoredTeacher.body.revision;

  // 班次数量和 Course Setup 共用课程 revision。跨进程同时从2班扩到不同数量时，
  // 只能提交一种完整尾部拓扑；随后用赢家 revision 恢复2班，保持既有01/02稳定 ID。
  const originalSectionIds = fixture.sections.map((section) => section.id);
  const resizeAttempts = [
    { server: serverA, cookie: fixture.schedulerACookie, sectionCount: 3 },
    { server: serverB, cookie: fixture.schedulerBCookie, sectionCount: 4 },
  ];
  const resizeResults = await Promise.all(resizeAttempts.map(async (attempt) => ({
    attempt,
    result: await requestApi(attempt.server, `/api/courses/${fixture.courseId}/sections`, {
      method: "PATCH",
      cookie: attempt.cookie,
      expectedStatus: [200, 409],
      json: { sectionCount: attempt.sectionCount, revision: fixture.setupRevision },
    }),
  })));
  assert.deepEqual(resizeResults.map(({ result }) => result.response.status).sort(), [200, 409]);
  const resizeWinner = resizeResults.find(({ result }) => result.response.status === 200);
  const resizeLoser = resizeResults.find(({ result }) => result.response.status === 409);
  assert.equal(resizeWinner.result.body.revision, fixture.setupRevision + 1);
  assert.equal(resizeLoser.result.body.code, "COURSE_SETUP_CHANGED");
  const winningSections = (await requestApi(serverB, `/api/courses/${fixture.courseId}/sections`, { cookie: fixture.schedulerBCookie })).body;
  assert.equal(winningSections.length, resizeWinner.attempt.sectionCount);
  assert.deepEqual(winningSections.slice(0, 2).map((section) => section.id), originalSectionIds);
  const restoredSections = await requestApi(serverA, `/api/courses/${fixture.courseId}/sections`, {
    method: "PATCH",
    cookie: fixture.schedulerACookie,
    json: { sectionCount: 2, revision: resizeWinner.result.body.revision },
  });
  fixture.setupRevision = restoredSections.body.revision;
  assert.deepEqual(
    (await requestApi(serverB, `/api/courses/${fixture.courseId}/sections`, { cookie: fixture.schedulerBCookie })).body.map((section) => section.id),
    originalSectionIds,
  );
  report("主资料与班次数量 CAS 在两个 standalone 间只允许一个赢家");
}

async function verifyCandidateSnapshotConsistency(serverA, serverB, fixture) {
  const candidatePath = `/api/course-sections/${fixture.candidateSectionId}/candidates?occurrence=1`;
  const roomPayload = (capacity, revision) => ({
    code: fixture.candidateRoom.code,
    capacity,
    hasLab: false,
    hasMultiProjector: false,
    isSmartClassroom: false,
    revision,
  });

  // 先分别证明夹具的完整旧状态和完整新状态，避免竞态断言只因候选功能本身坏掉而假绿。
  const oldBaseline = await requestApi(serverA, candidatePath, { cookie: fixture.schedulerACookie });
  assertCandidateSnapshot(oldBaseline.body, fixture, 20);
  const grownRoom = await requestApi(serverB, `/api/rooms/${fixture.candidateRoom.id}`, {
    method: "PATCH",
    cookie: fixture.schedulerBCookie,
    json: roomPayload(40, fixture.candidateRoom.revision),
  });
  fixture.candidateRoom.revision = grownRoom.body.revision;
  const newBaseline = await requestApi(serverB, candidatePath, { cookie: fixture.schedulerBCookie });
  assertCandidateSnapshot(newBaseline.body, fixture, 40);
  const resetRoom = await requestApi(serverA, `/api/rooms/${fixture.candidateRoom.id}`, {
    method: "PATCH",
    cookie: fixture.schedulerACookie,
    json: roomPayload(20, fixture.candidateRoom.revision),
  });
  fixture.candidateRoom.revision = resetRoom.body.revision;
  const resetBaseline = await requestApi(serverB, candidatePath, { cookie: fixture.schedulerBCookie });
  assertCandidateSnapshot(resetBaseline.body, fixture, 20);

  // A 会在“已经复制完成的内存快照”中物化容量20的 Active rooms 后暂停；
  // B 随后必须能在 A 尚未完成候选计算时提交容量40，证明正式库读锁已经释放。
  const snapshotNonce = randomBytes(16).toString("hex");
  const updateNonce = randomBytes(16).toString("hex");
  const snapshotControl = {
    version: 1,
    runToken: authRaceRunToken,
    label: "A",
    nonce: snapshotNonce,
    roomId: fixture.candidateRoom.id,
  };
  const updateControl = {
    version: 1,
    runToken: authRaceRunToken,
    label: "B",
    nonce: updateNonce,
    roomId: fixture.candidateRoom.id,
  };
  const files = {
    snapshotArm: path.join(authRaceControlDirectory, "candidate-snapshot-arm-A.json"),
    snapshotTemporary: path.join(authRaceControlDirectory, `candidate-snapshot-arm-A-${snapshotNonce}.tmp`),
    snapshotReady: path.join(authRaceControlDirectory, `candidate-snapshot-ready-A-${snapshotNonce}.json`),
    snapshotRelease: path.join(authRaceControlDirectory, `candidate-snapshot-release-${snapshotNonce}.txt`),
    updateArm: path.join(authRaceControlDirectory, "candidate-room-update-arm-B.json"),
    updateTemporary: path.join(authRaceControlDirectory, `candidate-room-update-arm-B-${updateNonce}.tmp`),
    updateReady: path.join(authRaceControlDirectory, `candidate-room-update-ready-B-${updateNonce}.json`),
  };
  activeRaceReleases.set(files.snapshotRelease, snapshotNonce);
  await writeFile(files.snapshotTemporary, JSON.stringify(snapshotControl), { flag: "wx", mode: 0o600 });
  await rename(files.snapshotTemporary, files.snapshotArm);

  let candidateSettled = false;
  let roomUpdateSettled = false;
  const pendingCandidate = requestApi(serverA, candidatePath, { cookie: fixture.schedulerACookie });
  pendingCandidate.then(
    () => { candidateSettled = true; },
    () => { candidateSettled = true; },
  );
  let pendingRoomUpdate;
  try {
    await waitForRaceReady(
      serverA,
      files.snapshotReady,
      snapshotControl,
      () => candidateSettled,
      "Candidate snapshot consistency",
      "the materialized Active rooms snapshot",
    );
    await writeFile(files.updateTemporary, JSON.stringify(updateControl), { flag: "wx", mode: 0o600 });
    await rename(files.updateTemporary, files.updateArm);
    pendingRoomUpdate = requestApi(serverB, `/api/rooms/${fixture.candidateRoom.id}`, {
      method: "PATCH",
      cookie: fixture.schedulerBCookie,
      json: roomPayload(40, fixture.candidateRoom.revision),
    });
    pendingRoomUpdate.then(
      () => { roomUpdateSettled = true; },
      () => { roomUpdateSettled = true; },
    );

    // A 仍暂停在内存计算中时，B 的正式 UPDATE 和 COMMIT 必须在宽松的2秒内完成。
    // 旧的长读事务实现会让 B 一直等待 release，因此会稳定在这里超时。
    const writerStartedAt = Date.now();
    const roomUpdate = await Promise.race([
      pendingRoomUpdate,
      delay(2_000).then(() => {
        throw new Error("Room update stayed blocked while Candidate was calculating from its snapshot.");
      }),
    ]);
    assert.equal(roomUpdate.body.ok, true);
    fixture.candidateRoom.revision = roomUpdate.body.revision;
    assert(Date.now() - writerStartedAt < 2_000, "Room update took too long after Candidate captured its snapshot.");
    assert.equal(roomUpdateSettled, true);
    assert.equal(candidateSettled, false, "Candidate request left its calculation barrier before the writer committed.");
    assert.deepEqual(JSON.parse(await readFile(files.updateReady, "utf8")), updateControl);
    assert.equal(
      readDatabaseValue("SELECT capacity FROM rooms WHERE id = ?", fixture.candidateRoom.id).capacity,
      40,
    );

    // B 已提交新容量，但 A 必须继续用自己复制的旧版本完成，绝不能返回35项却显示旧容量20。
    await releaseRaceBarrier(files.snapshotRelease, snapshotNonce);
    const raceCandidate = await pendingCandidate;
    assertCandidateSnapshot(raceCandidate.body, fixture, 20);
    assert.deepEqual(raceCandidate.body, resetBaseline.body);

    // A 的旧响应完成后，两个独立进程都必须立即看到同一个完整新版本。
    const [latestA, latestB] = await Promise.all([
      requestApi(serverA, candidatePath, { cookie: fixture.schedulerACookie }),
      requestApi(serverB, candidatePath, { cookie: fixture.schedulerBCookie }),
    ]);
    assertCandidateSnapshot(latestA.body, fixture, 40);
    assertCandidateSnapshot(latestB.body, fixture, 40);
    assert.deepEqual(latestA.body, latestB.body);
  } finally {
    // 任一断言失败都先释放 A，再等待已启动请求结束，避免 preload 或 SQLite 锁残留。
    await releaseRaceBarrier(files.snapshotRelease, snapshotNonce).catch(() => undefined);
    activeRaceReleases.delete(files.snapshotRelease);
    await Promise.allSettled([pendingCandidate, pendingRoomUpdate].filter(Boolean));
    await Promise.all(Object.values(files).map((filename) => rm(filename, { force: true }).catch(() => undefined)));
  }
  report("候选建议使用单一内存快照计算，且不阻塞另一进程提交教室更新");
}

async function armCandidateEntryFault(fixture, fault) {
  // entry arm 绑定随机 nonce、目标 section 和故障类型；先完整写临时文件再原子改名，
  // A 的 preload 不会读到半截控制内容，也不会误拦截其他 Candidate 请求。
  const nonce = randomBytes(16).toString("hex");
  const control = {
    version: 1,
    runToken: authRaceRunToken,
    label: "A",
    nonce,
    sectionId: fixture.candidateSectionId,
    fault,
  };
  const files = {
    arm: path.join(authRaceControlDirectory, "candidate-entry-arm-A.json"),
    temporary: path.join(authRaceControlDirectory, `candidate-entry-arm-A-${nonce}.tmp`),
    ready: path.join(authRaceControlDirectory, `candidate-entry-ready-A-${nonce}.json`),
    release: path.join(authRaceControlDirectory, `candidate-entry-release-${nonce}.txt`),
  };
  await writeFile(files.temporary, JSON.stringify(control), { flag: "wx", mode: 0o600 });
  await rename(files.temporary, files.arm);
  return { control, files };
}

async function removeRaceFiles(files) {
  // 每个 arm、临时文件、ready 和 release 都位于本轮唯一 control 目录；
  // force 删除让成功路径和 finally 清理可以安全重复调用。
  await Promise.all(Object.values(files).map((filename) => rm(filename, { force: true }).catch(() => undefined)));
}

async function verifyCandidateFailureBoundaries(serverA, fixture) {
  const candidatePath = `/api/course-sections/${fixture.candidateSectionId}/candidates?occurrence=1`;
  const baseline = await requestApi(serverA, candidatePath, { cookie: fixture.schedulerACookie });
  assertCandidateSnapshot(baseline.body, fixture, 40);
  const expectedDatabase = readFullBusinessSnapshot();
  const observer = new Database(testDatabasePath, { readonly: true });
  const initialDataVersion = observer.pragma("data_version", { simple: true });

  try {
    // 第一组故障由 test-only preload 在 Candidate 首条 SELECT 前抛出带敏感哨兵的普通 Error。
    // 路由只能回固定500；ready control 证明响应确实来自本次注入，而不是其他偶然错误。
    const internalFault = await armCandidateEntryFault(fixture, "internal");
    try {
      const internalResponse = await requestApi(serverA, candidatePath, {
        cookie: fixture.schedulerACookie,
        expectedStatus: 500,
      });
      assert.deepEqual(
        JSON.parse(await readFile(internalFault.files.ready, "utf8")),
        internalFault.control,
      );
      assert.deepEqual(internalResponse.body, {
        error: "Candidate slots could not be calculated. Try again.",
      });
      assert.equal(internalResponse.response.headers.get("retry-after"), null);
      assert(!/secret|sqlite|select|rooms|private|table|column|stack|path/i.test(JSON.stringify(internalResponse.body)));
    } finally {
      await removeRaceFiles(internalFault.files);
    }
    assert.deepEqual(readFullBusinessSnapshot(), expectedDatabase);
    assert.equal(observer.pragma("data_version", { simple: true }), initialDataVersion);
    assert.deepEqual(
      (await requestApi(serverA, candidatePath, { cookie: fixture.schedulerACookie })).body,
      baseline.body,
    );

    // 第二组在认证完成、Candidate DEFERRED 已开始但尚未首读时暂停 A。
    // 第三连接随后取得真实 EXCLUSIVE 锁，并一直持有到 A 用 SQLite 默认 timeout 返回503。
    const busyFault = await armCandidateEntryFault(fixture, "busy");
    activeRaceReleases.set(busyFault.files.release, busyFault.control.nonce);
    let busyRequestSettled = false;
    const pendingBusyRequest = requestApi(serverA, candidatePath, {
      cookie: fixture.schedulerACookie,
      expectedStatus: 503,
    });
    pendingBusyRequest.then(
      () => { busyRequestSettled = true; },
      () => { busyRequestSettled = true; },
    );
    const blocker = new Database(testDatabasePath);
    let holdsExclusiveLock = false;
    try {
      await waitForRaceReady(
        serverA,
        busyFault.files.ready,
        busyFault.control,
        () => busyRequestSettled,
        "Candidate BUSY boundary",
        "the pre-SELECT Candidate entry",
      );
      assert.equal(blocker.pragma("journal_mode", { simple: true }), "delete");
      assert.equal(blocker.pragma("locking_mode", { simple: true }), "normal");
      assert.equal(blocker.pragma("busy_timeout", { simple: true }), 5_000);
      blocker.exec("BEGIN EXCLUSIVE");
      holdsExclusiveLock = true;
      const releasedAt = Date.now();
      await releaseRaceBarrier(busyFault.files.release, busyFault.control.nonce);
      const busyResponse = await pendingBusyRequest;
      const busyWaitMilliseconds = Date.now() - releasedAt;
      assert(busyWaitMilliseconds >= 4_000 && busyWaitMilliseconds < 15_000,
        `Candidate BUSY response used an unexpected wait of ${busyWaitMilliseconds} ms.`);
      assert.deepEqual(busyResponse.body, {
        error: "Another scheduler is updating timetable data. Try finding clear options again in a moment.",
      });
      assert.equal(busyResponse.response.headers.get("retry-after"), "1");
      assert(!/sqlite|\bbusy\b|\blocked\b|constraint|\bselect\b|\btable\b|\bcolumn\b|\bstack\b|\/private\/|path/i
        .test(JSON.stringify(busyResponse.body)));
    } finally {
      // 先释放真实 EXCLUSIVE 锁，再清理 arm；即使断言失败，后续 API 和两个服务也能继续退出。
      if (holdsExclusiveLock) {
        try { blocker.exec("ROLLBACK"); } catch { /* 连接关闭会执行最终锁清理。 */ }
      }
      blocker.close();
      await releaseRaceBarrier(busyFault.files.release, busyFault.control.nonce).catch(() => undefined);
      activeRaceReleases.delete(busyFault.files.release);
      await pendingBusyRequest.catch(() => undefined);
      await removeRaceFiles(busyFault.files);
    }
    assert.deepEqual(readFullBusinessSnapshot(), expectedDatabase);
    assert.equal(observer.pragma("data_version", { simple: true }), initialDataVersion);
    assert.deepEqual(
      (await requestApi(serverA, candidatePath, { cookie: fixture.schedulerACookie })).body,
      baseline.body,
    );
  } finally {
    observer.close();
  }
  report("Candidate 的真实 BUSY 503 与内部故障500均固定、安全且零写入");
}

async function verifyDataManagementWorkspaceSnapshotConsistency(serverA, serverB, fixture) {
  const workspacePath = "/api/data-management/workspace";
  const oldWorkspace = await requestApi(serverA, workspacePath, { cookie: fixture.schedulerACookie });
  for (const key of ["teachers", "groups", "rooms", "courses"]) {
    assert(Array.isArray(oldWorkspace.body[key]), `Data workspace ${key} must be an array.`);
  }
  const oldTeacher = oldWorkspace.body.teachers.find((teacher) => teacher.id === fixture.dataWorkspaceTeacher.id);
  const oldCourse = oldWorkspace.body.courses.find((course) => course.id === fixture.dataWorkspaceCourse.id);
  assert.equal(oldTeacher.staffType, "PT");
  assert.equal(oldTeacher.sections, 0);
  assert.equal(oldCourse.catalog, "Cross workspace old catalog");
  assert.equal(oldCourse.configuredSections, 1);
  assert.equal(oldCourse.allocatedSections, 0);
  assert.equal(oldCourse.allocationVarianceCount, 0);

  const snapshotNonce = randomBytes(16).toString("hex");
  const importNonce = randomBytes(16).toString("hex");
  const snapshotControl = {
    version: 1,
    runToken: authRaceRunToken,
    label: "A",
    nonce: snapshotNonce,
    teacherId: fixture.dataWorkspaceTeacher.id,
    expectedStaffType: "PT",
    expectedSections: 0,
  };
  const importControl = {
    version: 1,
    runToken: authRaceRunToken,
    label: "B",
    nonce: importNonce,
    courseId: fixture.dataWorkspaceCourse.id,
  };
  const files = {
    snapshotArm: path.join(authRaceControlDirectory, "data-workspace-arm-A.json"),
    snapshotTemporary: path.join(authRaceControlDirectory, `data-workspace-arm-A-${snapshotNonce}.tmp`),
    snapshotReady: path.join(authRaceControlDirectory, `data-workspace-ready-A-${snapshotNonce}.json`),
    snapshotRelease: path.join(authRaceControlDirectory, `data-workspace-release-${snapshotNonce}.txt`),
    importArm: path.join(authRaceControlDirectory, "data-workspace-import-arm-B.json"),
    importTemporary: path.join(authRaceControlDirectory, `data-workspace-import-arm-B-${importNonce}.tmp`),
    importReady: path.join(authRaceControlDirectory, `data-workspace-import-ready-B-${importNonce}.json`),
    importRelease: path.join(authRaceControlDirectory, `data-workspace-import-release-${importNonce}.txt`),
  };
  activeRaceReleases.set(files.snapshotRelease, snapshotNonce);
  activeRaceReleases.set(files.importRelease, importNonce);
  await writeFile(files.snapshotTemporary, JSON.stringify(snapshotControl), { flag: "wx", mode: 0o600 });
  await rename(files.snapshotTemporary, files.snapshotArm);

  // data marker 必须只存在于 data aggregate 的专用 teachers reader。Rules aggregate 也
  // 返回 teachers，legacy /api/teachers 更直接调用同一底层映射；两者在 arm 已就绪时
  // 仍须正常完成，且不能 rename/消费 data arm。否则五秒 Rules polling 可抢走测试钩子，
  // 更重要的是说明 production 又把聚合专属读取语义泄漏回共享 reader。
  const [rulesIsolationRead, teachersIsolationRead] = await Promise.all([
    requestApi(serverA, "/api/rules/workspace", { cookie: fixture.schedulerACookie }),
    requestApi(serverA, "/api/teachers", { cookie: fixture.schedulerACookie }),
  ]);
  assertRulesWorkspaceShape(rulesIsolationRead.body);
  assert(Array.isArray(teachersIsolationRead.body));
  assert.deepEqual(JSON.parse(await readFile(files.snapshotArm, "utf8")), snapshotControl);
  await assert.rejects(readFile(files.snapshotReady, "utf8"), (error) => error?.code === "ENOENT");

  let workspaceSettled = false;
  let importSettled = false;
  let pendingImport;
  const pendingWorkspace = requestApi(serverA, workspacePath, { cookie: fixture.schedulerACookie });
  pendingWorkspace.then(
    () => { workspaceSettled = true; },
    () => { workspaceSettled = true; },
  );
  try {
    await waitForRaceReady(
      serverA,
      files.snapshotReady,
      snapshotControl,
      () => workspaceSettled,
      "Data-management workspace snapshot consistency",
      "the materialized old teachers query",
    );
    await writeFile(files.importTemporary, JSON.stringify(importControl), { flag: "wx", mode: 0o600 });
    await rename(files.importTemporary, files.importArm);
    pendingImport = requestApi(serverB, "/api/imports/teaching-members", {
      method: "POST",
      cookie: fixture.schedulerBCookie,
      body: teachingMembersImportForm([{
        Mod: fixture.dataWorkspaceCourse.code,
        Catalog: "Cross workspace new catalog",
        Lecturer: fixture.dataWorkspaceTeacher.name,
        "Staff Type": "FT",
        "# of grps teaching": 2,
      }]),
    });
    pendingImport.then(
      () => { importSettled = true; },
      () => { importSettled = true; },
    );
    await waitForRaceReady(
      serverB,
      files.importReady,
      importControl,
      () => importSettled,
      "Data-management workspace import",
      "the applied Teaching Members transaction",
    );

    // B 的全部业务写入已完成。只释放测试暂停点后，它必须在正式 COMMIT 等待 A 的
    // DEFERRED 读锁；否则 A 后续 courses 查询就可能读取导入后的新版本。
    await releaseRaceBarrier(files.importRelease, importNonce);
    await waitForPendingRollbackJournalWriter("Data-management workspace import");
    assert.equal(importSettled, false, "The import committed while the old data workspace snapshot still held a read transaction.");
    assert.equal(workspaceSettled, false, "The data workspace left its snapshot barrier before the import reached COMMIT.");

    await releaseRaceBarrier(files.snapshotRelease, snapshotNonce);
    const [raceWorkspace, imported] = await Promise.all([pendingWorkspace, pendingImport]);
    assert.deepEqual(raceWorkspace.body, oldWorkspace.body);
    assert.deepEqual(
      {
        courses: imported.body.courses,
        teachers: imported.body.teachers,
        sections: imported.body.sections,
      },
      { courses: 1, teachers: 1, sections: 2 },
    );

    const [latestA, latestB] = await Promise.all([
      requestApi(serverA, workspacePath, { cookie: fixture.schedulerACookie }),
      requestApi(serverB, workspacePath, { cookie: fixture.schedulerBCookie }),
    ]);
    assert.deepEqual(latestA.body, latestB.body);
    const newTeacher = latestA.body.teachers.find((teacher) => teacher.id === fixture.dataWorkspaceTeacher.id);
    const newCourse = latestA.body.courses.find((course) => course.id === fixture.dataWorkspaceCourse.id);
    assert.equal(newTeacher.staffType, "FT");
    assert.equal(newTeacher.sections, 2);
    assert.equal(newCourse.catalog, "Cross workspace new catalog");
    assert.equal(newCourse.configuredSections, 2);
    assert.equal(newCourse.allocatedSections, 2);
    assert.equal(newCourse.allocationVarianceCount, 1);
    assert.equal(newCourse.revision, oldCourse.revision + 1);
    fixture.dataWorkspaceTeacher = newTeacher;
    fixture.dataWorkspaceCourse = newCourse;
  } finally {
    await releaseRaceBarrier(files.importRelease, importNonce).catch(() => undefined);
    await releaseRaceBarrier(files.snapshotRelease, snapshotNonce).catch(() => undefined);
    activeRaceReleases.delete(files.importRelease);
    activeRaceReleases.delete(files.snapshotRelease);
    await Promise.allSettled([pendingWorkspace, pendingImport].filter(Boolean));
    await removeRaceFiles(files);
  }
  report("资料管理聚合跨进程只返回完整旧版或完整新版，不混合教师与课程摘要");
}

async function verifyCourseWorkspaceSnapshotConsistency(serverA, serverB, fixture) {
  const workspacePath = `/api/courses/${fixture.dataWorkspaceCourse.id}/workspace`;
  const oldWorkspace = await requestApi(serverA, workspacePath, { cookie: fixture.schedulerACookie });
  assert.equal(oldWorkspace.body.currentCourse.id, fixture.dataWorkspaceCourse.id);
  assert.equal(oldWorkspace.body.currentCourse.allocationVarianceCount, 1);
  assert.equal(oldWorkspace.body.sections.length, 2);
  const importedSection = oldWorkspace.body.sections.find(
    (section) => section.teacherId === fixture.dataWorkspaceTeacher.id,
  );
  assert(importedSection, "The imported course must contain one automatically assigned section.");
  assert.deepEqual(oldWorkspace.body.allocationVariances, [{
    teacherId: fixture.dataWorkspaceTeacher.id,
    teacherName: fixture.dataWorkspaceTeacher.name,
    expectedSections: 2,
    actualSections: 1,
  }]);

  const snapshotNonce = randomBytes(16).toString("hex");
  const writeNonce = randomBytes(16).toString("hex");
  const snapshotControl = {
    version: 1,
    runToken: authRaceRunToken,
    label: "A",
    nonce: snapshotNonce,
    courseId: fixture.dataWorkspaceCourse.id,
    sectionId: importedSection.id,
    expectedTeacherId: fixture.dataWorkspaceTeacher.id,
  };
  const writeControl = {
    version: 1,
    runToken: authRaceRunToken,
    label: "B",
    nonce: writeNonce,
    teacherId: fixture.dataWorkspaceReplacementTeacher.id,
    sectionId: importedSection.id,
    revision: importedSection.revision,
  };
  const files = {
    snapshotArm: path.join(authRaceControlDirectory, "course-workspace-arm-A.json"),
    snapshotTemporary: path.join(authRaceControlDirectory, `course-workspace-arm-A-${snapshotNonce}.tmp`),
    snapshotReady: path.join(authRaceControlDirectory, `course-workspace-ready-A-${snapshotNonce}.json`),
    snapshotRelease: path.join(authRaceControlDirectory, `course-workspace-release-${snapshotNonce}.txt`),
    writeArm: path.join(authRaceControlDirectory, "course-workspace-section-write-arm-B.json"),
    writeTemporary: path.join(authRaceControlDirectory, `course-workspace-section-write-arm-B-${writeNonce}.tmp`),
    writeReady: path.join(authRaceControlDirectory, `course-workspace-section-write-ready-B-${writeNonce}.json`),
    writeRelease: path.join(authRaceControlDirectory, `course-workspace-section-write-release-${writeNonce}.txt`),
  };
  activeRaceReleases.set(files.snapshotRelease, snapshotNonce);
  activeRaceReleases.set(files.writeRelease, writeNonce);
  await writeFile(files.snapshotTemporary, JSON.stringify(snapshotControl), { flag: "wx", mode: 0o600 });
  await rename(files.snapshotTemporary, files.snapshotArm);

  let workspaceSettled = false;
  let sectionWriteSettled = false;
  let pendingSectionWrite;
  const pendingWorkspace = requestApi(serverA, workspacePath, { cookie: fixture.schedulerACookie });
  pendingWorkspace.then(
    () => { workspaceSettled = true; },
    () => { workspaceSettled = true; },
  );
  try {
    await waitForRaceReady(
      serverA,
      files.snapshotReady,
      snapshotControl,
      () => workspaceSettled,
      "Course workspace snapshot consistency",
      "the materialized old sections query",
    );
    await writeFile(files.writeTemporary, JSON.stringify(writeControl), { flag: "wx", mode: 0o600 });
    await rename(files.writeTemporary, files.writeArm);
    pendingSectionWrite = requestApi(serverB, `/api/course-sections/${importedSection.id}`, {
      method: "PATCH",
      cookie: fixture.schedulerBCookie,
      json: {
        teacherId: fixture.dataWorkspaceReplacementTeacher.id,
        studentGroupIds: importedSection.studentGroupIds,
        revision: importedSection.revision,
      },
    });
    pendingSectionWrite.then(
      () => { sectionWriteSettled = true; },
      () => { sectionWriteSettled = true; },
    );
    await waitForRaceReady(
      serverB,
      files.writeReady,
      writeControl,
      () => sectionWriteSettled,
      "Course workspace section update",
      "the applied section CAS update",
    );
    await releaseRaceBarrier(files.writeRelease, writeNonce);
    await waitForPendingRollbackJournalWriter("Course workspace section update");
    assert.equal(sectionWriteSettled, false, "The section update committed while the old course workspace snapshot still held a read transaction.");
    assert.equal(workspaceSettled, false, "The course workspace left its snapshot barrier before the section update reached COMMIT.");

    await releaseRaceBarrier(files.snapshotRelease, snapshotNonce);
    const [raceWorkspace, updated] = await Promise.all([pendingWorkspace, pendingSectionWrite]);
    assert.deepEqual(raceWorkspace.body, oldWorkspace.body);
    assert.equal(updated.body.revision, importedSection.revision + 1);

    const [latestA, latestB] = await Promise.all([
      requestApi(serverA, workspacePath, { cookie: fixture.schedulerACookie }),
      requestApi(serverB, workspacePath, { cookie: fixture.schedulerBCookie }),
    ]);
    assert.deepEqual(latestA.body, latestB.body);
    const replacedSection = latestA.body.sections.find((section) => section.id === importedSection.id);
    assert.equal(replacedSection.teacherId, fixture.dataWorkspaceReplacementTeacher.id);
    assert.equal(replacedSection.revision, importedSection.revision + 1);
    assert.equal(latestA.body.currentCourse.allocationVarianceCount, 2);
    const varianceByTeacher = new Map(
      latestA.body.allocationVariances.map((variance) => [variance.teacherId, variance]),
    );
    assert.deepEqual(varianceByTeacher.get(fixture.dataWorkspaceTeacher.id), {
      teacherId: fixture.dataWorkspaceTeacher.id,
      teacherName: fixture.dataWorkspaceTeacher.name,
      expectedSections: 2,
      actualSections: 0,
    });
    assert.deepEqual(varianceByTeacher.get(fixture.dataWorkspaceReplacementTeacher.id), {
      teacherId: fixture.dataWorkspaceReplacementTeacher.id,
      teacherName: fixture.dataWorkspaceReplacementTeacher.name,
      expectedSections: 0,
      actualSections: 1,
    });
  } finally {
    await releaseRaceBarrier(files.writeRelease, writeNonce).catch(() => undefined);
    await releaseRaceBarrier(files.snapshotRelease, snapshotNonce).catch(() => undefined);
    activeRaceReleases.delete(files.writeRelease);
    activeRaceReleases.delete(files.snapshotRelease);
    await Promise.allSettled([pendingWorkspace, pendingSectionWrite].filter(Boolean));
    await removeRaceFiles(files);
  }
  report("课程详情聚合跨进程保持 currentCourse、班次与分配差异同一快照");
}

function assertRulesWorkspaceShape(body) {
  assert.deepEqual(Object.keys(body).sort(), ["issues", "ruleSettings", "teachers", "unavailableWindows"]);
  for (const key of ["issues", "ruleSettings", "teachers", "unavailableWindows"]) {
    assert(Array.isArray(body[key]), `Rules workspace ${key} must be an array.`);
  }
}

async function verifyConcurrentRuleAndWindowConflicts(serverA, serverB, fixture) {
  const initialRules = (await requestApi(serverA, "/api/rule-settings", {
    cookie: fixture.schedulerACookie,
  })).body;
  const rule = initialRules.find((candidate) => candidate.key === "same_block");
  assert(rule, "The cross-process rule CAS fixture was not found.");

  // A 的专属 marker 在真实 CAS UPDATE 改变一行后暂停；随后才启动 B，并用通用 writer
  // ready 证明 B 已到达自己的 `.immediate()` 而非仍停在 HTTP/认证层。释放 A 后，它必须
  // 先提交，B 再读取同一旧 expected 并稳定得到 RULE_SETTING_CHANGED。
  const ruleNonce = randomBytes(16).toString("hex");
  const writerNonce = randomBytes(16).toString("hex");
  const ruleControl = {
    version: 1,
    runToken: authRaceRunToken,
    label: "A",
    nonce: ruleNonce,
    ruleKey: rule.key,
    expectedEnabled: rule.enabled,
    enabled: !rule.enabled,
  };
  const writerControl = {
    version: 1,
    runToken: authRaceRunToken,
    label: "B",
    nonce: writerNonce,
  };
  const ruleFiles = {
    arm: path.join(authRaceControlDirectory, "rules-workspace-rule-write-arm-A.json"),
    temporary: path.join(authRaceControlDirectory, `rules-workspace-rule-write-arm-A-${ruleNonce}.tmp`),
    ready: path.join(authRaceControlDirectory, `rules-workspace-rule-write-ready-A-${ruleNonce}.json`),
    release: path.join(authRaceControlDirectory, `rules-workspace-rule-write-release-A-${ruleNonce}.txt`),
    writerArm: path.join(authRaceControlDirectory, "writer-arm-B.json"),
    writerTemporary: path.join(authRaceControlDirectory, `writer-arm-B-${writerNonce}.tmp`),
    writerReady: path.join(authRaceControlDirectory, `writer-ready-B-${writerNonce}.json`),
  };
  activeRaceReleases.set(ruleFiles.release, ruleNonce);
  await writeFile(ruleFiles.temporary, JSON.stringify(ruleControl), { flag: "wx", mode: 0o600 });
  await rename(ruleFiles.temporary, ruleFiles.arm);
  let leftSettled = false;
  let rightSettled = false;
  let pendingRight;
  const pendingLeft = requestApi(serverA, "/api/rule-settings", {
    method: "PATCH",
    cookie: fixture.schedulerACookie,
    json: { key: rule.key, expectedEnabled: rule.enabled, enabled: !rule.enabled },
  });
  pendingLeft.then(
    () => { leftSettled = true; },
    () => { leftSettled = true; },
  );
  try {
    await waitForRaceReady(
      serverA,
      ruleFiles.ready,
      ruleControl,
      () => leftSettled,
      "Concurrent rule expectedEnabled CAS winner",
      "the applied rule CAS UPDATE",
    );
    await writeFile(ruleFiles.writerTemporary, JSON.stringify(writerControl), { flag: "wx", mode: 0o600 });
    await rename(ruleFiles.writerTemporary, ruleFiles.writerArm);
    pendingRight = requestApi(serverB, "/api/rule-settings", {
      method: "PATCH",
      cookie: fixture.schedulerBCookie,
      expectedStatus: 409,
      json: { key: rule.key, expectedEnabled: rule.enabled, enabled: !rule.enabled },
    });
    pendingRight.then(
      () => { rightSettled = true; },
      () => { rightSettled = true; },
    );
    await waitForRaceReady(
      serverB,
      ruleFiles.writerReady,
      writerControl,
      () => rightSettled,
      "Concurrent rule expectedEnabled CAS loser",
      "its SQLite writer entry",
    );
    assert.equal(leftSettled, false);
    assert.equal(rightSettled, false);
    await releaseRaceBarrier(ruleFiles.release, ruleNonce);
    const [winner, loser] = await Promise.all([pendingLeft, pendingRight]);
    assert.deepEqual(winner.body, { ok: true, enabled: !rule.enabled, changed: true });
    assert.equal(loser.body.code, "RULE_SETTING_CHANGED");
    assert(!/sqlite|database|rule_settings|is_enabled|constraint|update /i.test(JSON.stringify(loser.body)));
    const [latestA, latestB] = await Promise.all([
      requestApi(serverA, "/api/rules/workspace", { cookie: fixture.schedulerACookie }),
      requestApi(serverB, "/api/rules/workspace", { cookie: fixture.schedulerBCookie }),
    ]);
    assert.deepEqual(latestA.body, latestB.body);
    assert.equal(latestA.body.ruleSettings.find((candidate) => candidate.key === rule.key).enabled, !rule.enabled);
  } finally {
    await releaseRaceBarrier(ruleFiles.release, ruleNonce).catch(() => undefined);
    activeRaceReleases.delete(ruleFiles.release);
    await Promise.allSettled([pendingLeft, pendingRight].filter(Boolean));
    await removeRaceFiles(ruleFiles);
  }
  const currentRule = (await requestApi(serverB, "/api/rule-settings", {
    cookie: fixture.schedulerBCookie,
  })).body.find((candidate) => candidate.key === rule.key);
  if (currentRule.enabled !== rule.enabled) {
    await requestApi(serverB, "/api/rule-settings", {
      method: "PATCH",
      cookie: fixture.schedulerBCookie,
      json: { key: rule.key, expectedEnabled: currentRule.enabled, enabled: rule.enabled },
    });
  }

  // Window 的竞争采用相同证据链，但 A 在真实 INSERT 后暂停。B 已到达 writer entry
  // 仍不能越过 A 的事务；释放后 unique key 必须给出一个201和一个 typed409，数据库
  // 自然键计数严格为1，不能依赖 route 的预查形成两个成功响应。
  const windowInput = { kind: "Year", ownerId: "1", dayOfWeek: 4, startHour: 16, endHour: 18 };
  const windowNonce = randomBytes(16).toString("hex");
  const windowWriterNonce = randomBytes(16).toString("hex");
  const windowControl = {
    version: 1,
    runToken: authRaceRunToken,
    label: "A",
    nonce: windowNonce,
    ...windowInput,
  };
  const windowWriterControl = {
    version: 1,
    runToken: authRaceRunToken,
    label: "B",
    nonce: windowWriterNonce,
  };
  const windowFiles = {
    arm: path.join(authRaceControlDirectory, "rules-workspace-window-write-arm-A.json"),
    temporary: path.join(authRaceControlDirectory, `rules-workspace-window-write-arm-A-${windowNonce}.tmp`),
    ready: path.join(authRaceControlDirectory, `rules-workspace-window-write-ready-A-${windowNonce}.json`),
    release: path.join(authRaceControlDirectory, `rules-workspace-window-write-release-A-${windowNonce}.txt`),
    writerArm: path.join(authRaceControlDirectory, "writer-arm-B.json"),
    writerTemporary: path.join(authRaceControlDirectory, `writer-arm-B-${windowWriterNonce}.tmp`),
    writerReady: path.join(authRaceControlDirectory, `writer-ready-B-${windowWriterNonce}.json`),
  };
  activeRaceReleases.set(windowFiles.release, windowNonce);
  await writeFile(windowFiles.temporary, JSON.stringify(windowControl), { flag: "wx", mode: 0o600 });
  await rename(windowFiles.temporary, windowFiles.arm);
  let createSettled = false;
  let duplicateSettled = false;
  let pendingDuplicate;
  let createdWindow;
  const pendingCreate = requestApi(serverA, "/api/unavailability", {
    method: "POST",
    cookie: fixture.schedulerACookie,
    expectedStatus: 201,
    json: windowInput,
  });
  pendingCreate.then(
    () => { createSettled = true; },
    () => { createSettled = true; },
  );
  try {
    await waitForRaceReady(
      serverA,
      windowFiles.ready,
      windowControl,
      () => createSettled,
      "Concurrent exact unavailable window winner",
      "the applied unavailable-window INSERT",
    );
    await writeFile(windowFiles.writerTemporary, JSON.stringify(windowWriterControl), { flag: "wx", mode: 0o600 });
    await rename(windowFiles.writerTemporary, windowFiles.writerArm);
    pendingDuplicate = requestApi(serverB, "/api/unavailability", {
      method: "POST",
      cookie: fixture.schedulerBCookie,
      expectedStatus: 409,
      json: windowInput,
    });
    pendingDuplicate.then(
      () => { duplicateSettled = true; },
      () => { duplicateSettled = true; },
    );
    await waitForRaceReady(
      serverB,
      windowFiles.writerReady,
      windowWriterControl,
      () => duplicateSettled,
      "Concurrent exact unavailable window loser",
      "its SQLite writer entry",
    );
    assert.equal(createSettled, false);
    assert.equal(duplicateSettled, false);
    await releaseRaceBarrier(windowFiles.release, windowNonce);
    const completed = await Promise.all([pendingCreate, pendingDuplicate]);
    createdWindow = completed[0].body;
    assert.equal(typeof createdWindow.id, "string");
    assert.equal(completed[1].body.code, "UNAVAILABLE_WINDOW_EXISTS");
    assert(!/sqlite|unique|constraint|year_blocked|index/i.test(JSON.stringify(completed[1].body)));
    assert.equal(readDatabaseValue(`SELECT COUNT(*) AS count FROM year_blocked_windows
      WHERE year = 1 AND day_of_week = 4 AND start_hour = 16 AND end_hour = 18`).count, 1);
  } finally {
    await releaseRaceBarrier(windowFiles.release, windowNonce).catch(() => undefined);
    activeRaceReleases.delete(windowFiles.release);
    await Promise.allSettled([pendingCreate, pendingDuplicate].filter(Boolean));
    await removeRaceFiles(windowFiles);
  }
  if (createdWindow?.id) {
    await requestApi(serverA, `/api/unavailability?id=${encodeURIComponent(createdWindow.id)}&kind=Year`, {
      method: "DELETE",
      cookie: fixture.schedulerACookie,
    });
  }
  report("规则 expectedEnabled 与不可用时段 unique 在两个 standalone 间各只有一个赢家");
}

async function verifyRulesWorkspaceSnapshotConsistency(serverA, serverB, fixture) {
  const workspacePath = "/api/rules/workspace";
  const scheduled = readDatabaseValue(`SELECT lessons.day_of_week, lessons.start_hour,
    lessons.duration_hours, courses.primary_year
    FROM scheduled_lessons lessons
    JOIN course_sections sections ON sections.id = lessons.section_id
    JOIN courses ON courses.id = sections.course_id
    WHERE courses.primary_year IS NOT NULL ORDER BY lessons.id LIMIT 1`);
  assert(scheduled, "The Rules snapshot fixture needs one scheduled lesson with a primary year.");
  const baselineInput = {
    kind: "Teacher",
    ownerId: fixture.dataWorkspaceTeacher.id,
    dayOfWeek: 2,
    startHour: 8,
    endHour: 9,
  };
  const writeInput = {
    kind: "Year",
    ownerId: String(scheduled.primary_year),
    dayOfWeek: scheduled.day_of_week,
    startHour: scheduled.start_hour,
    endHour: scheduled.start_hour + scheduled.duration_hours,
  };
  const baselineWindow = (await requestApi(serverA, "/api/unavailability", {
    method: "POST",
    cookie: fixture.schedulerACookie,
    expectedStatus: 201,
    json: baselineInput,
  })).body;
  let insertedWindow;
  let pendingWorkspace;
  let pendingWrite;

  const oldWorkspace = await requestApi(serverA, workspacePath, { cookie: fixture.schedulerACookie });
  assertRulesWorkspaceShape(oldWorkspace.body);
  assert(oldWorkspace.body.unavailableWindows.some((window) => window.id === baselineWindow.id));
  const snapshotNonce = randomBytes(16).toString("hex");
  const writeNonce = randomBytes(16).toString("hex");
  const snapshotControl = {
    version: 1,
    runToken: authRaceRunToken,
    label: "A",
    nonce: snapshotNonce,
    windowId: baselineWindow.id,
  };
  const writeControl = {
    version: 1,
    runToken: authRaceRunToken,
    label: "B",
    nonce: writeNonce,
    ...writeInput,
  };
  const files = {
    snapshotArm: path.join(authRaceControlDirectory, "rules-workspace-arm-A.json"),
    snapshotTemporary: path.join(authRaceControlDirectory, `rules-workspace-arm-A-${snapshotNonce}.tmp`),
    snapshotReady: path.join(authRaceControlDirectory, `rules-workspace-ready-A-${snapshotNonce}.json`),
    snapshotRelease: path.join(authRaceControlDirectory, `rules-workspace-release-${snapshotNonce}.txt`),
    writeArm: path.join(authRaceControlDirectory, "rules-workspace-window-write-arm-B.json"),
    writeTemporary: path.join(authRaceControlDirectory, `rules-workspace-window-write-arm-B-${writeNonce}.tmp`),
    writeReady: path.join(authRaceControlDirectory, `rules-workspace-window-write-ready-B-${writeNonce}.json`),
    writeRelease: path.join(authRaceControlDirectory, `rules-workspace-window-write-release-B-${writeNonce}.txt`),
  };
  activeRaceReleases.set(files.snapshotRelease, snapshotNonce);
  activeRaceReleases.set(files.writeRelease, writeNonce);
  await writeFile(files.snapshotTemporary, JSON.stringify(snapshotControl), { flag: "wx", mode: 0o600 });
  await rename(files.snapshotTemporary, files.snapshotArm);
  let workspaceSettled = false;
  let writeSettled = false;
  pendingWorkspace = requestApi(serverA, workspacePath, { cookie: fixture.schedulerACookie });
  pendingWorkspace.then(
    () => { workspaceSettled = true; },
    () => { workspaceSettled = true; },
  );
  try {
    await waitForRaceReady(
      serverA,
      files.snapshotReady,
      snapshotControl,
      () => workspaceSettled,
      "Rules workspace snapshot consistency",
      "the materialized old unavailable-windows query",
    );
    await writeFile(files.writeTemporary, JSON.stringify(writeControl), { flag: "wx", mode: 0o600 });
    await rename(files.writeTemporary, files.writeArm);
    pendingWrite = requestApi(serverB, "/api/unavailability", {
      method: "POST",
      cookie: fixture.schedulerBCookie,
      expectedStatus: 201,
      json: writeInput,
    });
    pendingWrite.then(
      () => { writeSettled = true; },
      () => { writeSettled = true; },
    );
    await waitForRaceReady(
      serverB,
      files.writeReady,
      writeControl,
      () => writeSettled,
      "Rules workspace unavailable-window write",
      "the applied unavailable-window INSERT",
    );

    // 此刻 B 已在自己的 IMMEDIATE 中真实插入新 window，但还停在 warning 重算之前。
    // 先释放 B：它会完成 issues 对应的 warning 更新并进入 COMMIT；DELETE journal 必须
    // 取得 PENDING 后等待 A 的旧 SHARED 读锁。因此在释放 A 前，B HTTP 201 与 A 聚合
    // 响应都不能完成。这个锁证据排除了“请求碰巧慢”或“只暂停了 JavaScript”的假并发。
    await releaseRaceBarrier(files.writeRelease, writeNonce);
    await waitForPendingRollbackJournalWriter("Rules workspace unavailable-window write");
    assert.equal(writeSettled, false, "The unavailable-window write committed while the old Rules snapshot still held a read transaction.");
    assert.equal(workspaceSettled, false, "The Rules workspace left its snapshot barrier before the writer reached COMMIT.");

    await releaseRaceBarrier(files.snapshotRelease, snapshotNonce);
    const completed = await Promise.all([pendingWorkspace, pendingWrite]);
    const raceWorkspace = completed[0];
    insertedWindow = completed[1].body;
    // A 必须返回完整旧对象：不仅 windows 不含新行，issues、rules、teachers 也必须逐字段
    // 等于竞争前版本，不能由四次独立 GET 拼出任何中间组合。
    assert.deepEqual(raceWorkspace.body, oldWorkspace.body);
    assert(!raceWorkspace.body.unavailableWindows.some((window) => window.id === insertedWindow.id));

    // A 结束后两台 standalone 必须读取完全相同的完整新对象；新 window 与由它刷新出的
    // issues 同时可见，固定规则和教师数组也都保留在同一次 aggregate 响应中。
    const [latestA, latestB] = await Promise.all([
      requestApi(serverA, workspacePath, { cookie: fixture.schedulerACookie }),
      requestApi(serverB, workspacePath, { cookie: fixture.schedulerBCookie }),
    ]);
    assertRulesWorkspaceShape(latestA.body);
    assert.deepEqual(latestA.body, latestB.body);
    assert(latestA.body.unavailableWindows.some((window) => window.id === insertedWindow.id));
    assert(latestA.body.unavailableWindows.some((window) => window.id === baselineWindow.id));
    assert(latestA.body.teachers.some((teacher) => teacher.id === fixture.dataWorkspaceTeacher.id));
    assert.deepEqual(latestA.body.ruleSettings, oldWorkspace.body.ruleSettings);
    assert.notDeepEqual(latestA.body.issues, oldWorkspace.body.issues,
      "The overlapping year window did not refresh the Rules issues snapshot.");
  } finally {
    await releaseRaceBarrier(files.writeRelease, writeNonce).catch(() => undefined);
    await releaseRaceBarrier(files.snapshotRelease, snapshotNonce).catch(() => undefined);
    activeRaceReleases.delete(files.writeRelease);
    activeRaceReleases.delete(files.snapshotRelease);
    await Promise.allSettled([pendingWorkspace, pendingWrite].filter(Boolean));
    await removeRaceFiles(files);

    // 失败路径也通过 production DELETE 清理已提交夹具。先读取聚合定位可能在 HTTP
    // 不确定结果下已提交的目标行，避免直接数据库删除绕过 warning 重算。
    const current = await requestApi(serverA, workspacePath, { cookie: fixture.schedulerACookie }).catch(() => null);
    const cleanupWindows = current?.body?.unavailableWindows?.filter((window) => (
      window.id === baselineWindow.id
      || (window.kind === writeInput.kind && window.ownerId === writeInput.ownerId
        && window.dayOfWeek === writeInput.dayOfWeek && window.startHour === writeInput.startHour
        && window.endHour === writeInput.endHour)
    )) || [];
    for (const window of cleanupWindows) {
      await requestApi(serverA, `/api/unavailability?id=${encodeURIComponent(window.id)}&kind=${window.kind}`, {
        method: "DELETE",
        cookie: fixture.schedulerACookie,
      }).catch(() => undefined);
    }
  }
  report("Rules 聚合跨进程只返回完整旧版或完整新版，并与 window/warning 提交同边界");
}

async function armManagementWorkspaceEntryFault(kind, fixture, fault) {
  // 三个 production 聚合各有独立首读 marker；control 仍绑定本轮 run token、A 进程
  // 与随机 nonce。课程详情额外绑定稳定 course ID，防止其他详情请求误消费。
  const nonce = randomBytes(16).toString("hex");
  const prefix = {
    data: "data-workspace",
    course: "course-workspace",
    rules: "rules-workspace",
  }[kind];
  assert(prefix, `Unknown management workspace kind ${kind}.`);
  const control = {
    version: 1,
    runToken: authRaceRunToken,
    label: "A",
    nonce,
    fault,
    ...(kind === "course" ? { courseId: fixture.dataWorkspaceCourse.id } : {}),
  };
  const files = {
    arm: path.join(authRaceControlDirectory, `${prefix}-entry-arm-A.json`),
    temporary: path.join(authRaceControlDirectory, `${prefix}-entry-arm-A-${nonce}.tmp`),
    ready: path.join(authRaceControlDirectory, `${prefix}-entry-ready-A-${nonce}.json`),
    release: path.join(authRaceControlDirectory, `${prefix}-entry-release-${nonce}.txt`),
  };
  await writeFile(files.temporary, JSON.stringify(control), { flag: "wx", mode: 0o600 });
  await rename(files.temporary, files.arm);
  return { control, files };
}

async function verifyManagementWorkspaceFailureBoundaries(serverA, fixture) {
  const cases = [
    {
      kind: "data",
      pathname: "/api/data-management/workspace",
      fallbackError: "The master-data workspace could not be loaded. Try again.",
    },
    {
      kind: "course",
      pathname: `/api/courses/${fixture.dataWorkspaceCourse.id}/workspace`,
      fallbackError: "The course sections workspace could not be loaded. Try again.",
    },
    {
      kind: "rules",
      pathname: "/api/rules/workspace",
      fallbackError: "The rules workspace could not be loaded. Try again.",
    },
  ];
  const baselines = new Map();
  for (const testCase of cases) {
    baselines.set(
      testCase.kind,
      (await requestApi(serverA, testCase.pathname, { cookie: fixture.schedulerACookie })).body,
    );
  }
  const expectedDatabase = readFullBusinessSnapshot();
  const observer = new Database(testDatabasePath, { readonly: true });
  const initialDataVersion = observer.pragma("data_version", { simple: true });
  try {
    // 普通 Error 含敏感哨兵；三条路由都只能返回自己的固定 safe500，不能把 SQL、
    // 文件路径或堆栈回显给浏览器。失败前后14表逐字段与 data_version 均保持不变。
    for (const testCase of cases) {
      const fault = await armManagementWorkspaceEntryFault(testCase.kind, fixture, "internal");
      try {
        const response = await requestApi(serverA, testCase.pathname, {
          cookie: fixture.schedulerACookie,
          expectedStatus: 500,
        });
        assert.deepEqual(JSON.parse(await readFile(fault.files.ready, "utf8")), fault.control);
        assert.deepEqual(response.body, { error: testCase.fallbackError });
        assert.equal(response.response.headers.get("retry-after"), null);
        assert(!/secret|sqlite|select|private|table|column|stack|path/i
          .test(JSON.stringify(response.body)));
      } finally {
        await removeRaceFiles(fault.files);
      }
      assert.deepEqual(readFullBusinessSnapshot(), expectedDatabase);
      assert.equal(observer.pragma("data_version", { simple: true }), initialDataVersion);
      assert.deepEqual(
        (await requestApi(serverA, testCase.pathname, { cookie: fixture.schedulerACookie })).body,
        baselines.get(testCase.kind),
      );
    }

    // BUSY 必须发生在认证完成、DEFERRED 首读之前：preload 先报告 ready，第三连接再取
    // EXCLUSIVE。SQLite 默认五秒超时后三路都返回同一503/Retry-After，并可立即恢复。
    for (const testCase of cases) {
      const fault = await armManagementWorkspaceEntryFault(testCase.kind, fixture, "busy");
      activeRaceReleases.set(fault.files.release, fault.control.nonce);
      let requestSettled = false;
      const pending = requestApi(serverA, testCase.pathname, {
        cookie: fixture.schedulerACookie,
        expectedStatus: 503,
      });
      pending.then(
        () => { requestSettled = true; },
        () => { requestSettled = true; },
      );
      const blocker = new Database(testDatabasePath);
      let holdsExclusiveLock = false;
      try {
        await waitForRaceReady(
          serverA,
          fault.files.ready,
          fault.control,
          () => requestSettled,
          `${testCase.kind} workspace BUSY boundary`,
          "the pre-SELECT workspace entry",
        );
        assert.equal(blocker.pragma("journal_mode", { simple: true }), "delete");
        assert.equal(blocker.pragma("busy_timeout", { simple: true }), 5_000);
        blocker.exec("BEGIN EXCLUSIVE");
        holdsExclusiveLock = true;
        const releasedAt = Date.now();
        await releaseRaceBarrier(fault.files.release, fault.control.nonce);
        const response = await pending;
        const waitedMilliseconds = Date.now() - releasedAt;
        assert(waitedMilliseconds >= 4_000 && waitedMilliseconds < 15_000,
          `${testCase.kind} workspace BUSY response used an unexpected wait of ${waitedMilliseconds} ms.`);
        assert.deepEqual(response.body, {
          error: "Another scheduler is updating timetable data. Try again in a moment.",
        });
        assert.equal(response.response.headers.get("retry-after"), "1");
        assert(!/sqlite|database|\bbusy\b|\blocked\b|constraint|select |\btable\b|column|stack|\/private\//i
          .test(JSON.stringify(response.body)));
      } finally {
        if (holdsExclusiveLock) {
          try { blocker.exec("ROLLBACK"); } catch { /* close 仍会释放测试锁。 */ }
        }
        blocker.close();
        await releaseRaceBarrier(fault.files.release, fault.control.nonce).catch(() => undefined);
        activeRaceReleases.delete(fault.files.release);
        await pending.catch(() => undefined);
        await removeRaceFiles(fault.files);
      }
      assert.deepEqual(readFullBusinessSnapshot(), expectedDatabase);
      assert.equal(observer.pragma("data_version", { simple: true }), initialDataVersion);
      assert.deepEqual(
        (await requestApi(serverA, testCase.pathname, { cookie: fixture.schedulerACookie })).body,
        baselines.get(testCase.kind),
      );
    }
  } finally {
    observer.close();
  }
  report("三套管理聚合的真实 BUSY503 与未知500均安全、零写入且释放后恢复");
}

async function verifyYearWorkspaceSnapshotConsistency(serverA, serverB, fixture) {
  // Section 1 尚未排课。先锁定完整旧版：总表没有目标课次，待排区必须有它。
  const sectionId = fixture.sections[0].id;
  const sessionId = `${sectionId}:1`;
  const workspacePath = "/api/schedule/workspace?year=1";
  const oldWorkspace = await requestApi(serverA, workspacePath, { cookie: fixture.schedulerACookie });
  assert(!oldWorkspace.body.lessons.some((lesson) => lesson.sectionId === sectionId && lesson.occurrence === 1));
  assert(oldWorkspace.body.unscheduledSections.some((section) => section.id === sessionId));

  const snapshotNonce = randomBytes(16).toString("hex");
  const placementNonce = randomBytes(16).toString("hex");
  const snapshotControl = {
    version: 1,
    runToken: authRaceRunToken,
    label: "A",
    nonce: snapshotNonce,
    year: 1,
    sectionId,
  };
  const placementControl = {
    version: 1,
    runToken: authRaceRunToken,
    label: "B",
    nonce: placementNonce,
    sectionId,
    occurrence: 1,
  };
  const files = {
    snapshotArm: path.join(authRaceControlDirectory, "year-workspace-arm-A.json"),
    snapshotTemporary: path.join(authRaceControlDirectory, `year-workspace-arm-A-${snapshotNonce}.tmp`),
    snapshotReady: path.join(authRaceControlDirectory, `year-workspace-ready-A-${snapshotNonce}.json`),
    snapshotRelease: path.join(authRaceControlDirectory, `year-workspace-release-${snapshotNonce}.txt`),
    placementArm: path.join(authRaceControlDirectory, "year-workspace-placement-arm-B.json"),
    placementTemporary: path.join(authRaceControlDirectory, `year-workspace-placement-arm-B-${placementNonce}.tmp`),
    placementReady: path.join(authRaceControlDirectory, `year-workspace-placement-ready-B-${placementNonce}.json`),
    placementRelease: path.join(authRaceControlDirectory, `year-workspace-placement-release-${placementNonce}.txt`),
  };
  activeRaceReleases.set(files.snapshotRelease, snapshotNonce);
  activeRaceReleases.set(files.placementRelease, placementNonce);
  await writeFile(files.snapshotTemporary, JSON.stringify(snapshotControl), { flag: "wx", mode: 0o600 });
  await rename(files.snapshotTemporary, files.snapshotArm);

  let workspaceSettled = false;
  let placementSettled = false;
  let placementResult;
  let pendingPlacement;
  const pendingWorkspace = requestApi(serverA, workspacePath, { cookie: fixture.schedulerACookie });
  pendingWorkspace.then(
    () => { workspaceSettled = true; },
    () => { workspaceSettled = true; },
  );
  try {
    await waitForRaceReady(
      serverA,
      files.snapshotReady,
      snapshotControl,
      () => workspaceSettled,
      "Year workspace snapshot consistency",
      "the materialized old lessons query",
    );

    await writeFile(files.placementTemporary, JSON.stringify(placementControl), { flag: "wx", mode: 0o600 });
    await rename(files.placementTemporary, files.placementArm);
    pendingPlacement = requestApi(serverB, "/api/schedule/lessons", {
      method: "POST",
      cookie: fixture.schedulerBCookie,
      expectedStatus: 201,
      json: { sectionId, occurrence: 1, dayOfWeek: 3, startHour: 10, roomId: null },
    });
    pendingPlacement.then(
      () => { placementSettled = true; },
      () => { placementSettled = true; },
    );
    await waitForRaceReady(
      serverB,
      files.placementReady,
      placementControl,
      () => placementSettled,
      "Year workspace placement",
      "the applied scheduled lesson INSERT",
    );

    // B 已真实 INSERT。先只释放 B 的测试暂停点；正式 DELETE journal 下，如果 A 的
    // DEFERRED 快照仍覆盖后续四份查询，B 的 COMMIT 必须继续等待 A 释放读事务。
    await releaseRaceBarrier(files.placementRelease, placementNonce);
    await waitForPendingRollbackJournalWriter("Year workspace placement");
    assert.equal(placementSettled, false, "The writer committed while the year workspace snapshot should still hold its read transaction.");
    assert.equal(workspaceSettled, false, "The workspace request left its snapshot barrier before the writer reached COMMIT.");

    await releaseRaceBarrier(files.snapshotRelease, snapshotNonce);
    const completedRequests = await Promise.all([pendingWorkspace, pendingPlacement]);
    const raceWorkspace = completedRequests[0];
    placementResult = completedRequests[1];
    assert.equal(placementResult.response.status, 201);
    // A 必须完整返回写入前版本；不能同时缺少目标课次，也把它从待排区移除。
    assert.deepEqual(raceWorkspace.body, oldWorkspace.body);
    const savedDuringSnapshot = readDatabaseValue(
      "SELECT id, revision FROM scheduled_lessons WHERE section_id = ? AND occurrence = 1",
      sectionId,
    );
    assert.equal(savedDuringSnapshot.id, placementResult.body.id);

    // A 结束后两个 standalone 都必须看到完整新版：目标只在总表，不能仍留在 tray。
    const [newWorkspaceA, newWorkspaceB] = await Promise.all([
      requestApi(serverA, workspacePath, { cookie: fixture.schedulerACookie }),
      requestApi(serverB, workspacePath, { cookie: fixture.schedulerBCookie }),
    ]);
    assert.deepEqual(newWorkspaceA.body, newWorkspaceB.body);
    assert(newWorkspaceA.body.lessons.some((lesson) => lesson.id === placementResult.body.id));
    assert(!newWorkspaceA.body.unscheduledSections.some((section) => section.id === sessionId));

    // 恢复 fixture，后面的“两个账号同时首次排课”仍从同一待排状态开始。
    await requestApi(serverB, `/api/schedule/lessons/${placementResult.body.id}?revision=${placementResult.body.revision}`, {
      method: "DELETE",
      cookie: fixture.schedulerBCookie,
    });
    placementResult = undefined;
    const restoredWorkspace = await requestApi(serverA, workspacePath, { cookie: fixture.schedulerACookie });
    assert(!restoredWorkspace.body.lessons.some((lesson) => lesson.sectionId === sectionId && lesson.occurrence === 1));
    assert(restoredWorkspace.body.unscheduledSections.some((section) => section.id === sessionId));
  } finally {
    // 失败时先释放两侧同步等待，再尽量退回测试课次；不能留下 child 或 SQLite 锁。
    await releaseRaceBarrier(files.placementRelease, placementNonce).catch(() => undefined);
    await releaseRaceBarrier(files.snapshotRelease, snapshotNonce).catch(() => undefined);
    activeRaceReleases.delete(files.placementRelease);
    activeRaceReleases.delete(files.snapshotRelease);
    await pendingWorkspace.catch(() => undefined);
    await pendingPlacement?.catch(() => undefined);
    if (placementResult?.body?.id) {
      const saved = readDatabaseValue("SELECT revision FROM scheduled_lessons WHERE id = ?", placementResult.body.id);
      if (saved) {
        await requestApi(serverB, `/api/schedule/lessons/${placementResult.body.id}?revision=${saved.revision}`, {
          method: "DELETE",
          cookie: fixture.schedulerBCookie,
        }).catch(() => undefined);
      }
    }
    await Promise.all(Object.values(files).map((filename) => rm(filename, { force: true }).catch(() => undefined)));
  }
  report("年级聚合工作区跨进程只返回完整旧版或完整新版，不会混合总表与待排区");
}

async function verifyYearWorkspaceBusyContract(serverA, serverB, fixture) {
  // 使用第三条真实 SQLite 连接取得 EXCLUSIVE 锁。请求会先经过 production proxy 的
  // 会话读取，再进入 workspace；无论 BUSY 出现在认证读取还是五表快照，HTTP 契约都
  // 必须保持相同的 503、Retry-After 和安全固定文字。
  const before = readFullBusinessSnapshot();
  const blocker = new Database(testDatabasePath);
  let holdsExclusiveLock = false;
  try {
    assert.equal(blocker.pragma("journal_mode", { simple: true }), "delete");
    blocker.exec("BEGIN EXCLUSIVE");
    holdsExclusiveLock = true;
    const startedAt = Date.now();
    // A 的受保护 workspace 会在 proxy 会话读取处遇锁；B 的公开 login 不经过 proxy，
    // 因而能确定性走到 loginUser 自身的 BUSY 转换。两台 standalone 并行等待同一把锁，
    // 不会把测试耗时无谓叠加到十秒。
    const [busy, busyLogin] = await Promise.all([
      requestApi(serverA, "/api/schedule/workspace?year=1", {
        cookie: fixture.schedulerACookie,
        expectedStatus: 503,
      }),
      requestApi(serverB, "/api/auth/login", {
        method: "POST",
        authenticated: false,
        expectedStatus: 503,
        json: {
          username: "cross-scheduler-b",
          password: fixture.accounts.get("cross-scheduler-b").password,
        },
      }),
    ]);
    const waitedMilliseconds = Date.now() - startedAt;
    assert(waitedMilliseconds >= 4_000 && waitedMilliseconds < 15_000,
      `Workspace BUSY response used an unexpected wait of ${waitedMilliseconds} ms.`);
    assert.equal(busy.response.headers.get("retry-after"), "1");
    assert.deepEqual(busy.body, {
      error: "Another scheduler is updating timetable data. Try again in a moment.",
    });
    assert.equal(busyLogin.response.headers.get("retry-after"), "1");
    assert.deepEqual(busyLogin.body, busy.body);
    assert(!/sqlite|database|\bbusy\b|\blocked\b|constraint|select |\btable\b|column|stack|\/private\//i
      .test(JSON.stringify(busy.body)));
  } finally {
    if (holdsExclusiveLock) {
      try { blocker.exec("ROLLBACK"); } catch { /* close 仍会释放测试锁。 */ }
    }
    blocker.close();
  }
  assert.deepEqual(readFullBusinessSnapshot(), before);
  const recovered = await requestApi(serverA, "/api/schedule/workspace?year=1", {
    cookie: fixture.schedulerACookie,
  });
  assert(Array.isArray(recovered.body.lessons));
  assert(Array.isArray(recovered.body.unscheduledSections));
  const recoveredLogin = await login(
    serverB,
    "cross-scheduler-b",
    fixture.accounts.get("cross-scheduler-b").password,
  );
  await requestApi(serverB, "/api/auth/logout", {
    method: "POST",
    cookie: recoveredLogin.cookie,
  });
  assert.deepEqual(readFullBusinessSnapshot(), before);
  report("Year workspace proxy 与公开 login 在真实 EXCLUSIVE 锁下返回安全503并在释放后恢复");
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

async function verifyConcurrentScheduledLessonUpdate(serverA, serverB, fixture) {
  // Course Setup 已经把这一课次的 revision 提高一次。现在让两个独立服务拿着
  // 同一个最新 revision，同时把星期、时间、教室、教师和学生班级改成两套完全
  // 不同的组合；最终资料必须完整来自同一个赢家，不能混入败方的任何字段。
  const lessonBeforeUpdate = readDatabaseValue(
    "SELECT * FROM scheduled_lessons WHERE section_id = ? AND occurrence = 1",
    fixture.sections[0].id,
  );
  const sectionBeforeUpdate = readDatabaseValue(
    "SELECT * FROM course_sections WHERE id = ?",
    fixture.sections[0].id,
  );
  assert(lessonBeforeUpdate);
  assert(sectionBeforeUpdate);
  assert.equal(sectionBeforeUpdate.teacher_id, null);
  assert.deepEqual(
    readCycleSnapshot().sectionGroups.filter((link) => link.section_id === fixture.sections[0].id),
    [],
  );

  const updateCandidates = [
    {
      dayOfWeek: 3,
      startHour: 8,
      roomId: fixture.candidateRoom.id,
      teacherId: fixture.candidateTeacher.id,
      studentGroupIds: [],
      revision: lessonBeforeUpdate.revision,
    },
    {
      dayOfWeek: 5,
      startHour: 13,
      roomId: null,
      teacherId: null,
      studentGroupIds: [fixture.candidateGroup.id],
      revision: lessonBeforeUpdate.revision,
    },
  ];
  const results = await runWhileBothWritersAreBlocked(
    "Concurrent Scheduled Lesson update",
    serverA,
    serverB,
    () => requestApi(serverA, `/api/schedule/lessons/${lessonBeforeUpdate.id}`, {
      method: "PATCH",
      cookie: fixture.schedulerACookie,
      expectedStatus: [200, 409],
      json: updateCandidates[0],
    }),
    () => requestApi(serverB, `/api/schedule/lessons/${lessonBeforeUpdate.id}`, {
      method: "PATCH",
      cookie: fixture.schedulerBCookie,
      expectedStatus: [200, 409],
      json: updateCandidates[1],
    }),
  );
  assert.deepEqual(results.map((result) => result.response.status).sort(), [200, 409]);
  const winnerIndex = results.findIndex((result) => result.response.status === 200);
  const loserIndex = 1 - winnerIndex;
  const winner = results[winnerIndex];
  const loser = results[loserIndex];
  const winnerInput = updateCandidates[winnerIndex];
  assert.deepEqual(Object.keys(loser.body).sort(), ["code", "error"]);
  assert.equal(loser.body.code, "SCHEDULED_LESSON_CHANGED");
  assert(
    !/sqlite|database|constraint|scheduled_lessons|course_sections|section_student_groups|revision\s*=|stack/i.test(JSON.stringify(loser.body)),
  );

  // HTTP 赢家必须逐字段反映自己的完整输入，并且 revision 只能增加一次。
  // warning 也与数据库保存值核对，避免接口返回成功但事务只写入部分资料。
  assert.deepEqual(
    {
      id: winner.body.id,
      sectionId: winner.body.sectionId,
      occurrence: winner.body.occurrence,
      dayOfWeek: winner.body.dayOfWeek,
      startHour: winner.body.startHour,
      roomId: winner.body.roomId,
      teacherId: winner.body.teacherId,
      studentGroupIds: winner.body.studentGroupIds,
      revision: winner.body.revision,
    },
    {
      id: lessonBeforeUpdate.id,
      sectionId: lessonBeforeUpdate.section_id,
      occurrence: lessonBeforeUpdate.occurrence,
      dayOfWeek: winnerInput.dayOfWeek,
      startHour: winnerInput.startHour,
      roomId: winnerInput.roomId,
      teacherId: winnerInput.teacherId,
      studentGroupIds: winnerInput.studentGroupIds,
      revision: lessonBeforeUpdate.revision + 1,
    },
  );

  const lessonAfterUpdate = readDatabaseValue(
    "SELECT * FROM scheduled_lessons WHERE id = ?",
    lessonBeforeUpdate.id,
  );
  assert.equal(lessonAfterUpdate.section_id, lessonBeforeUpdate.section_id);
  assert.equal(lessonAfterUpdate.occurrence, lessonBeforeUpdate.occurrence);
  assert.equal(lessonAfterUpdate.day_of_week, winnerInput.dayOfWeek);
  assert.equal(lessonAfterUpdate.start_hour, winnerInput.startHour);
  assert.equal(lessonAfterUpdate.duration_hours, lessonBeforeUpdate.duration_hours);
  assert.equal(lessonAfterUpdate.room_id, winnerInput.roomId);
  assert.equal(lessonAfterUpdate.revision, lessonBeforeUpdate.revision + 1);
  assert.deepEqual(JSON.parse(lessonAfterUpdate.warnings_json), winner.body.warnings);

  // 两套候选都会真实改变一项共享分配，所以 section revision 也只应增加一次；
  // 教师和学生班级必须同时来自赢家，不能出现 A 的教师配上 B 的班级。
  const sectionAfterUpdate = readDatabaseValue(
    "SELECT * FROM course_sections WHERE id = ?",
    fixture.sections[0].id,
  );
  assert.equal(sectionAfterUpdate.teacher_id, winnerInput.teacherId);
  assert.equal(sectionAfterUpdate.revision, sectionBeforeUpdate.revision + 1);
  const savedStudentGroupIds = readCycleSnapshot().sectionGroups
    .filter((link) => link.section_id === fixture.sections[0].id)
    .map((link) => link.student_group_id);
  assert.deepEqual(savedStudentGroupIds, winnerInput.studentGroupIds);

  // 锁释放后让败方用原请求顺序重试，必须稳定返回同一业务409；完整14表快照
  // 前后相同，证明旧 revision 不会再次增加版本或留下半完成的共享分配。
  const snapshotBeforeStaleRetry = readFullBusinessSnapshot();
  const staleRetry = await requestApi(loserIndex === 0 ? serverA : serverB, `/api/schedule/lessons/${lessonBeforeUpdate.id}`, {
    method: "PATCH",
    cookie: loserIndex === 0 ? fixture.schedulerACookie : fixture.schedulerBCookie,
    expectedStatus: 409,
    json: updateCandidates[loserIndex],
  });
  assert.deepEqual(Object.keys(staleRetry.body).sort(), ["code", "error"]);
  assert.equal(staleRetry.body.code, "SCHEDULED_LESSON_CHANGED");
  assert(
    !/sqlite|database|constraint|scheduled_lessons|course_sections|section_student_groups|revision\s*=|stack/i.test(JSON.stringify(staleRetry.body)),
  );
  assert.deepEqual(readFullBusinessSnapshot(), snapshotBeforeStaleRetry);
  report("跨进程 Scheduled Lesson PATCH 严格得到一个 200 和一个 409");
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
  assert.equal(statusA.body.courses, snapshotBeforeStart.courses.length);

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
  // ready 文件只会在目标 standalone 已经用真实 Scrypt 和 timingSafeEqual
  // 验证旧密码后建立；登录与自改密码可以共用同一个确定性停点。
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null || server.child.signalCode !== null) {
      throw new Error(`Server ${server.label} exited before reaching the authentication race barrier.`);
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

async function armPasswordVerificationRace(server, accountId) {
  // Preload 只接受当前临时数据库里真实存储的 64-byte Scrypt 摘要指纹。
  // 每轮使用新的 nonce，并先完整写临时文件再原子 rename，目标进程不会读到半份控制资料。
  const nonce = randomBytes(16).toString("hex");
  const control = {
    version: 1,
    runToken: authRaceRunToken,
    label: server.label,
    nonce,
    expectedFingerprint: storedPasswordFingerprint(accountId),
  };
  const files = {
    arm: path.join(authRaceControlDirectory, "arm.json"),
    temporaryArm: path.join(authRaceControlDirectory, `arm-${nonce}.tmp`),
    ready: path.join(authRaceControlDirectory, `ready-${nonce}.json`),
    release: path.join(authRaceControlDirectory, `release-${nonce}.txt`),
  };
  await writeFile(files.temporaryArm, JSON.stringify(control), { flag: "wx", mode: 0o600 });
  await rename(files.temporaryArm, files.arm);
  activeRaceReleases.set(files.release, nonce);
  return { control, files };
}

async function armOwnPasswordPreReadRace(server, accountId) {
  // 这一屏障与 timingSafeEqual 屏障分开命名：它证明请求已通过 proxy 和 route，
  // 但 production 首条“账号 + 原始会话”查询还没有真正 `.get()`，不会靠固定 sleep 猜时序。
  const nonce = randomBytes(16).toString("hex");
  const control = {
    version: 1,
    runToken: authRaceRunToken,
    label: server.label,
    nonce,
    accountId,
  };
  const files = {
    arm: path.join(authRaceControlDirectory, `own-password-pre-read-arm-${server.label}.json`),
    temporaryArm: path.join(authRaceControlDirectory, `own-password-pre-read-arm-${server.label}-${nonce}.tmp`),
    ready: path.join(authRaceControlDirectory, `own-password-pre-read-ready-${server.label}-${nonce}.json`),
    release: path.join(authRaceControlDirectory, `own-password-pre-read-release-${server.label}-${nonce}.txt`),
  };
  await writeFile(files.temporaryArm, JSON.stringify(control), { flag: "wx", mode: 0o600 });
  await rename(files.temporaryArm, files.arm);
  activeRaceReleases.set(files.release, nonce);
  return { control, files };
}

async function releaseRaceBarrier(releaseFile, nonce) {
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
  const barrier = await armPasswordVerificationRace(serverB, accountId);

  // B 开始登录后会在旧密码已经确认正确、但 IMMEDIATE 会话事务尚未开始时暂停。
  // A 必须先完成 reset/deactivate，主测试才写 release 让 B 继续。
  let loginSettled = false;
  const pendingLogin = login(serverB, username, oldPassword, 401);
  pendingLogin.then(
    () => { loginSettled = true; },
    () => { loginSettled = true; },
  );
  try {
    await waitForAuthRaceReady(serverB, barrier.files.ready, barrier.control);
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
    await releaseRaceBarrier(barrier.files.release, barrier.control.nonce);
    const rejectedLogin = await pendingLogin;
    assert.deepEqual(rejectedLogin.body, { error: "Username or password is incorrect." });
    assert.equal(rejectedLogin.response.headers.get("set-cookie"), null);
    assert.equal(
      readDatabaseValue("SELECT COUNT(*) AS count FROM auth_sessions WHERE user_id = ?", accountId).count,
      0,
    );
  } finally {
    // 任一断言失败也必须释放 B；否则同步 preload 会一直等到自己的超时上限。
    await releaseRaceBarrier(barrier.files.release, barrier.control.nonce).catch(() => undefined);
    activeRaceReleases.delete(barrier.files.release);
    await rm(barrier.files.arm, { force: true }).catch(() => undefined);
    await pendingLogin.catch(() => undefined);
  }

  // 竞态结束后再次使用旧密码仍必须失败，证明没有在撤销之后补回新会话。
  const sequentialOldLogin = await login(serverB, username, oldPassword, 401);
  assert.deepEqual(sequentialOldLogin.body, { error: "Username or password is incorrect." });
  assert.equal(sequentialOldLogin.response.headers.get("set-cookie"), null);
  report(description);
}

async function verifyOwnPasswordRevocationRace(serverA, serverB, options) {
  const { username, oldPassword, proposedPassword, accountId, administratorAction, description } = options;
  const accountBeforeAction = readDatabaseValue(
    "SELECT password_hash, is_active FROM app_users WHERE id = ?",
    accountId,
  );
  assert.equal(accountBeforeAction.is_active, 1);

  // 必须先登录取得自改请求 Cookie，再建立 timingSafeEqual arm；反过来会让这次登录
  // 自己消费屏障，测试便没有停在真正的 `/api/auth/password` 旧密码验证之后。
  const schedulerLogin = await login(serverB, username, oldPassword);
  assert.equal(
    readDatabaseValue("SELECT COUNT(*) AS count FROM auth_sessions WHERE user_id = ?", accountId).count,
    1,
  );
  const barrier = await armPasswordVerificationRace(serverB, accountId);

  let passwordChangeSettled = false;
  const pendingPasswordChange = requestApi(serverB, "/api/auth/password", {
    method: "PATCH",
    cookie: schedulerLogin.cookie,
    expectedStatus: 409,
    json: { currentPassword: oldPassword, newPassword: proposedPassword },
  });
  pendingPasswordChange.then(
    () => { passwordChangeSettled = true; },
    () => { passwordChangeSettled = true; },
  );

  let administratorWinningState;
  try {
    await waitForAuthRaceReady(serverB, barrier.files.ready, barrier.control);
    assert.equal(passwordChangeSettled, false, `${description} completed before the administrator action.`);

    await requestApi(serverA, "/api/auth/accounts", {
      method: "PATCH",
      cookie: administratorCookie,
      json: { userId: accountId, ...administratorAction },
    });
    const revokedState = readDatabaseValue(
      "SELECT password_hash, is_active FROM app_users WHERE id = ?",
      accountId,
    );
    if (administratorAction.action === "resetPassword") {
      assert.notEqual(revokedState.password_hash, accountBeforeAction.password_hash);
      assert.equal(revokedState.is_active, 1);
    } else {
      assert.equal(revokedState.password_hash, accountBeforeAction.password_hash);
      assert.equal(revokedState.is_active, 0);
    }
    assert.equal(
      readDatabaseValue("SELECT COUNT(*) AS count FROM auth_sessions WHERE user_id = ?", accountId).count,
      0,
    );

    if (administratorAction.action === "status") {
      // 在放行旧请求前立即重新启用，专门防止只检查 `active + old hash` 的假修复。
      // 账号表面资料已经恢复原值，但被管理员删除的原始会话绝不能随之复活。
      await requestApi(serverA, "/api/auth/accounts", {
        method: "PATCH",
        cookie: administratorCookie,
        json: { userId: accountId, action: "status", isActive: true },
      });
    }
    administratorWinningState = readDatabaseValue(
      "SELECT password_hash, is_active FROM app_users WHERE id = ?",
      accountId,
    );
    assert.equal(administratorWinningState.is_active, 1);
    assert.equal(
      readDatabaseValue("SELECT COUNT(*) AS count FROM auth_sessions WHERE user_id = ?", accountId).count,
      0,
    );

    await releaseRaceBarrier(barrier.files.release, barrier.control.nonce);
    const conflict = await pendingPasswordChange;
    assert.deepEqual(conflict.body, {
      code: "PASSWORD_CHANGED",
      error: "Your password or account access changed while this request was being processed. Sign in again before changing your password.",
    });
    const clearedCookie = conflict.response.headers.get("set-cookie") || "";
    assert.match(clearedCookie, /timetable_session=;/i);
    assert.match(clearedCookie, /expires=Thu, 01 Jan 1970 00:00:00 GMT/i);
  } finally {
    // 主断言失败也先释放同步等待并收集 HTTP Promise，避免把 B 或共享 SQLite 锁留给下一组。
    await releaseRaceBarrier(barrier.files.release, barrier.control.nonce).catch(() => undefined);
    activeRaceReleases.delete(barrier.files.release);
    await rm(barrier.files.arm, { force: true }).catch(() => undefined);
    await pendingPasswordChange.catch(() => undefined);
  }

  assert.deepEqual(
    readDatabaseValue("SELECT password_hash, is_active FROM app_users WHERE id = ?", accountId),
    administratorWinningState,
  );
  assert.equal(
    readDatabaseValue("SELECT COUNT(*) AS count FROM auth_sessions WHERE user_id = ?", accountId).count,
    0,
  );

  // 自改请求提议的密码绝不能生效。Reset 组只接受管理员新密码；停用再启用组
  // 则继续接受原密码，直接证明失效会话没有趁 Active 恢复后改写账号。
  const proposedLogin = await login(serverB, username, proposedPassword, 401);
  assert.deepEqual(proposedLogin.body, { error: "Username or password is incorrect." });
  if (administratorAction.action === "resetPassword") {
    const oldLogin = await login(serverB, username, oldPassword, 401);
    assert.deepEqual(oldLogin.body, { error: "Username or password is incorrect." });
    const winningLogin = await login(serverB, username, administratorAction.password);
    await requestApi(serverB, "/api/auth/logout", { method: "POST", cookie: winningLogin.cookie });
  } else {
    const winningLogin = await login(serverB, username, oldPassword);
    await requestApi(serverB, "/api/auth/logout", { method: "POST", cookie: winningLogin.cookie });
  }
  const finalAccountState = readDatabaseValue(
    "SELECT password_hash, is_active FROM app_users WHERE id = ?",
    accountId,
  );
  if (administratorAction.action === "resetPassword") {
    assert.deepEqual(finalAccountState, administratorWinningState);
  } else {
    assert.deepEqual(finalAccountState, { password_hash: accountBeforeAction.password_hash, is_active: 1 });
  }
  assert.equal(
    readDatabaseValue("SELECT COUNT(*) AS count FROM auth_sessions WHERE user_id = ?", accountId).count,
    0,
  );
  report(description);
}

async function verifyOwnPasswordPreReadRevocationRace(serverA, serverB, options) {
  const { username, oldPassword, proposedPassword, accountId, administratorAction, description } = options;
  const accountBeforeAction = readDatabaseValue(
    "SELECT password_hash, is_active FROM app_users WHERE id = ?",
    accountId,
  );
  assert.equal(accountBeforeAction.is_active, 1);

  // 和旧密码校验后竞态一样，必须先取得 Cookie 再 arm；本轮 arm 只允许带 marker 的
  // 首条密码 SELECT 消费，普通 login 和 route 的 validateSession 查询都不会碰到它。
  const schedulerLogin = await login(serverB, username, oldPassword);
  assert.equal(
    readDatabaseValue("SELECT COUNT(*) AS count FROM auth_sessions WHERE user_id = ?", accountId).count,
    1,
  );
  const barrier = await armOwnPasswordPreReadRace(serverB, accountId);

  let passwordChangeSettled = false;
  const pendingPasswordChange = requestApi(serverB, "/api/auth/password", {
    method: "PATCH",
    cookie: schedulerLogin.cookie,
    expectedStatus: 409,
    json: { currentPassword: oldPassword, newPassword: proposedPassword },
  });
  pendingPasswordChange.then(
    () => { passwordChangeSettled = true; },
    () => { passwordChangeSettled = true; },
  );

  let administratorWinningState;
  try {
    await waitForRaceReady(
      serverB,
      barrier.files.ready,
      barrier.control,
      () => passwordChangeSettled,
      description,
      "the own-password pre-read marker",
    );

    // A 必须在 B 的真实 `.get()` 前完成提交；之后 B 首读看不到原始有效会话，
    // 应直接抛 PASSWORD_CHANGED，绝不能继续 Scrypt 后误报 Current password 400。
    await requestApi(serverA, "/api/auth/accounts", {
      method: "PATCH",
      cookie: administratorCookie,
      json: { userId: accountId, ...administratorAction },
    });
    administratorWinningState = readDatabaseValue(
      "SELECT password_hash, is_active FROM app_users WHERE id = ?",
      accountId,
    );
    if (administratorAction.action === "resetPassword") {
      assert.notEqual(administratorWinningState.password_hash, accountBeforeAction.password_hash);
      assert.equal(administratorWinningState.is_active, 1);
    } else {
      assert.equal(administratorWinningState.password_hash, accountBeforeAction.password_hash);
      assert.equal(administratorWinningState.is_active, 0);
    }
    assert.equal(
      readDatabaseValue("SELECT COUNT(*) AS count FROM auth_sessions WHERE user_id = ?", accountId).count,
      0,
    );

    await releaseRaceBarrier(barrier.files.release, barrier.control.nonce);
    const conflict = await pendingPasswordChange;
    assert.deepEqual(conflict.body, {
      code: "PASSWORD_CHANGED",
      error: "Your password or account access changed while this request was being processed. Sign in again before changing your password.",
    });
    const clearedCookie = conflict.response.headers.get("set-cookie") || "";
    assert.match(clearedCookie, /timetable_session=;/i);
    assert.match(clearedCookie, /expires=Thu, 01 Jan 1970 00:00:00 GMT/i);
  } finally {
    // 即使断言失败，也必须释放同步 `.get()` 并等待 HTTP 收口，再交给下一组复用 B。
    await releaseRaceBarrier(barrier.files.release, barrier.control.nonce).catch(() => undefined);
    activeRaceReleases.delete(barrier.files.release);
    await rm(barrier.files.arm, { force: true }).catch(() => undefined);
    await pendingPasswordChange.catch(() => undefined);
  }

  assert.deepEqual(
    readDatabaseValue("SELECT password_hash, is_active FROM app_users WHERE id = ?", accountId),
    administratorWinningState,
  );
  assert.equal(
    readDatabaseValue("SELECT COUNT(*) AS count FROM auth_sessions WHERE user_id = ?", accountId).count,
    0,
  );

  if (administratorAction.action === "resetPassword") {
    const proposedLogin = await login(serverB, username, proposedPassword, 401);
    assert.deepEqual(proposedLogin.body, { error: "Username or password is incorrect." });
    const oldLogin = await login(serverB, username, oldPassword, 401);
    assert.deepEqual(oldLogin.body, { error: "Username or password is incorrect." });
    const winningLogin = await login(serverB, username, administratorAction.password);
    await requestApi(serverB, "/api/auth/logout", { method: "POST", cookie: winningLogin.cookie });
  } else {
    // 停用提交后的 409 先保持 Inactive 终态；重新启用后再比较两套密码，才能证明
    // proposedPassword 没有在停用期间悄悄写入、旧密码仍是唯一有效凭证。
    await requestApi(serverA, "/api/auth/accounts", {
      method: "PATCH",
      cookie: administratorCookie,
      json: { userId: accountId, action: "status", isActive: true },
    });
    const proposedLogin = await login(serverB, username, proposedPassword, 401);
    assert.deepEqual(proposedLogin.body, { error: "Username or password is incorrect." });
    const winningLogin = await login(serverB, username, oldPassword);
    await requestApi(serverB, "/api/auth/logout", { method: "POST", cookie: winningLogin.cookie });
  }
  const finalAccountState = readDatabaseValue(
    "SELECT password_hash, is_active FROM app_users WHERE id = ?",
    accountId,
  );
  if (administratorAction.action === "resetPassword") {
    assert.deepEqual(finalAccountState, administratorWinningState);
  } else {
    assert.deepEqual(finalAccountState, { password_hash: accountBeforeAction.password_hash, is_active: 1 });
  }
  assert.equal(
    readDatabaseValue("SELECT COUNT(*) AS count FROM auth_sessions WHERE user_id = ?", accountId).count,
    0,
  );
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

  const preReadResetAccount = fixture.accounts.get("cross-own-preread-reset");
  await verifyOwnPasswordPreReadRevocationRace(serverA, serverB, {
    username: "cross-own-preread-reset",
    oldPassword: preReadResetAccount.password,
    proposedPassword: "PreReadResetProposed456!",
    accountId: preReadResetAccount.id,
    administratorAction: { action: "resetPassword", password: "PreReadResetAdmin789!" },
    description: "自改首读前管理员重置返回 PASSWORD_CHANGED 而非错误密码400",
  });

  const preReadDisableAccount = fixture.accounts.get("cross-own-preread-disable");
  await verifyOwnPasswordPreReadRevocationRace(serverA, serverB, {
    username: "cross-own-preread-disable",
    oldPassword: preReadDisableAccount.password,
    proposedPassword: "PreReadDisableProposed456!",
    accountId: preReadDisableAccount.id,
    administratorAction: { action: "status", isActive: false },
    description: "自改首读前管理员停用返回 PASSWORD_CHANGED 并保持旧密码",
  });

  const ownResetAccount = fixture.accounts.get("cross-own-reset-race");
  await verifyOwnPasswordRevocationRace(serverA, serverB, {
    username: "cross-own-reset-race",
    oldPassword: ownResetAccount.password,
    proposedPassword: "OwnResetProposed456!",
    accountId: ownResetAccount.id,
    administratorAction: { action: "resetPassword", password: "OwnResetAdmin789!" },
    description: "自改旧密码验证后管理员重置严格胜出并返回 PASSWORD_CHANGED",
  });

  const ownDisableAccount = fixture.accounts.get("cross-own-disable-race");
  await verifyOwnPasswordRevocationRace(serverA, serverB, {
    username: "cross-own-disable-race",
    oldPassword: ownDisableAccount.password,
    proposedPassword: "OwnDisableProposed456!",
    accountId: ownDisableAccount.id,
    administratorAction: { action: "status", isActive: false },
    description: "自改旧密码验证后停用再启用仍因会话撤销返回 PASSWORD_CHANGED",
  });
}

function fullRestoreForm(contents, expectedCurrentToken) {
  const form = new FormData();
  form.append("backupFile", new Blob([contents], { type: "application/vnd.sqlite3" }), "cross-process-source.sqlite");
  form.append("understandReplace", "on");
  form.append("understandSignOut", "on");
  form.append("confirmation", "RESTORE FULL BACKUP");
  form.append("expectedCurrentToken", expectedCurrentToken);
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

async function waitForRestoreLockBeforeSafetyDirectory(safetyDirectory, restoreSettled) {
  // 合法 cycle JSON 中放入较大 catalog 后，锁内同步 serialize/VACUUM 会持续足够久。
  // 新实现必须先持 IMMEDIATE，再开始建立 safety 目录；旧实现先异步 backup/落文件、
  // 后开事务，会在这里看到目录先于锁，从而稳定失败而不是依赖微秒级窗口。
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    assert.equal(restoreSettled(), false, "Full restore finished before its write lock was observed.");
    let probe;
    let lockIsHeld = false;
    try {
      probe = new Database(testDatabasePath);
      probe.pragma("busy_timeout = 0");
      probe.exec("BEGIN IMMEDIATE");
      probe.exec("ROLLBACK");
    } catch (error) {
      if (error?.code === "SQLITE_BUSY" || error?.code === "SQLITE_LOCKED") lockIsHeld = true;
      else throw error;
    } finally {
      probe?.close();
    }
    if (lockIsHeld) {
      assert.equal(await pathExists(safetyDirectory), false,
        "The restore safety directory appeared before the cross-process write lock was acquired.");
      return;
    }
    assert.equal(await pathExists(safetyDirectory), false,
      "The restore safety directory appeared while another writer could still commit.");
    await delay(2);
  }
  throw new Error("Full restore never acquired its pre-safety IMMEDIATE lock.");
}

async function waitForDurableSafetyFileUnderRestoreLock(safetyDirectory, restoreSettled) {
  // 某些 SQLite 版本会在 COMMIT 前的 integrity_check 就等待既有 reader，未必先出现
  // 可观察的 PENDING lock。安全文件完成且 IMMEDIATE 仍在，已经是启动竞争 writer
  // 所需的准确边界，不必把实现绑死在某个 rollback-journal 内部阶段。
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    assert.equal(restoreSettled(), false, "Full restore finished before its safety file was observed.");
    let filenames;
    try {
      filenames = await readdir(safetyDirectory);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      filenames = [];
    }
    const safetyFilename = filenames.find((filename) => filename.startsWith("pre-restore-") && filename.endsWith(".sqlite"));
    if (safetyFilename) {
      const probe = new Database(testDatabasePath);
      try {
        probe.pragma("busy_timeout = 0");
        assert.throws(
          () => probe.exec("BEGIN IMMEDIATE"),
          (error) => error?.code === "SQLITE_BUSY" || error?.code === "SQLITE_LOCKED",
          "Restore released its write lock before the safety file became durable.",
        );
      } finally {
        probe.close();
      }
      return safetyFilename;
    }
    await delay(10);
  }
  throw new Error("Full restore did not persist its safety file while holding the write lock.");
}

function startExternalTeacherWriter(id, name) {
  // 使用第三个真实 Node 进程直接连接同一临时 SQLite。它代表已经通过 HTTP proxy
  // 授权、但在 restore 取得锁之后才到达写事务的在途请求；不能在测试进程同步等待，
  // 否则会阻塞负责释放 reader 的事件循环。
  const source = `
    import Database from "better-sqlite3";
    const db = new Database(process.env.TIMETABLING_RACE_DATABASE_PATH);
    try {
      const parameters = [process.env.TIMETABLING_RACE_TEACHER_ID, process.env.TIMETABLING_RACE_TEACHER_NAME];
      const sql = "INSERT INTO teachers (id, name, staff_type) VALUES (?, ?, 'FT')";
      db.pragma("busy_timeout = 0");
      try {
        db.prepare(sql).run(...parameters);
        process.stdout.write("WROTE_WITHOUT_BUSY\\n");
        process.exitCode = 2;
      } catch (error) {
        if (error?.code !== "SQLITE_BUSY" && error?.code !== "SQLITE_LOCKED") throw error;
        process.stdout.write("FIRST_BUSY\\n");
        db.pragma("busy_timeout = 20000");
        db.prepare(sql).run(...parameters);
      }
    } finally {
      db.close();
    }
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    cwd: projectRoot,
    env: {
      ...process.env,
      TIMETABLING_RACE_DATABASE_PATH: testDatabasePath,
      TIMETABLING_RACE_TEACHER_ID: id,
      TIMETABLING_RACE_TEACHER_NAME: name,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let settled = false;
  let output = "";
  let firstBusyObserved = false;
  let resolveFirstBusy;
  let rejectFirstBusy;
  const firstBusy = new Promise((resolve, reject) => {
    resolveFirstBusy = resolve;
    rejectFirstBusy = reject;
  });
  child.stdout.on("data", (chunk) => {
    output = `${output}${String(chunk)}`.slice(-4_000);
    if (!firstBusyObserved && output.includes("FIRST_BUSY")) {
      firstBusyObserved = true;
      resolveFirstBusy();
    }
  });
  child.stderr.on("data", (chunk) => { output = `${output}${String(chunk)}`.slice(-4_000); });
  const promise = new Promise((resolve, reject) => {
    child.once("error", (error) => {
      settled = true;
      if (!firstBusyObserved) rejectFirstBusy(error);
      reject(error);
    });
    child.once("close", (code, signal) => {
      settled = true;
      if (!firstBusyObserved) rejectFirstBusy(new Error(`External writer exited before observing restore BUSY: ${output}`));
      if (code === 0) resolve();
      else reject(new Error(`External restore writer exited with code=${code} signal=${signal}: ${output}`));
    });
  });
  const handle = { child, firstBusy, promise, settled: () => settled };
  // SIGINT/SIGTERM 可能恰好发生在局部 finally 之前；spawn 后立即全局登记，统一清理
  // 会终止并等待这条第三进程，绝不让它继续持有临时 SQLite handle。
  externalWriterHandles.add(handle);
  const unregister = () => externalWriterHandles.delete(handle);
  child.once("error", unregister);
  child.once("close", unregister);
  return handle;
}

async function verifyAtomicFullSystemRestore(serverA, serverB) {
  // 放大一份仍然完全合法的 cycle snapshot，让测试能观察 restore 的“先锁、后 safety”顺序。
  // 不能再用一条超长 catalog：严格 Cycle 契约会正确拒绝它。这里改为许多彼此唯一、
  // 每字段都在 production 上限内的历史课程；大资料仍只存在本轮 mkdtemp 数据库。
  const inflationDatabase = new Database(testDatabasePath);
  try {
    const backup = inflationDatabase.prepare("SELECT id, snapshot_json FROM schedule_backups").get();
    assert(backup, "Full restore concurrency fixture needs one emergency cycle backup.");
    const snapshot = JSON.parse(backup.snapshot_json);
    assert(snapshot.courses.length > 0);
    const template = snapshot.courses[0];
    const catalog = "R".repeat(256);
    for (let index = 0; index < 20_000; index += 1) {
      const suffix = index.toString(36).toUpperCase().padStart(8, "0");
      snapshot.courses.push({
        ...template,
        id: `padding-course-${suffix}`.padEnd(128, "x"),
        code: `PAD_${suffix}`.padEnd(32, "X"),
        catalog,
      });
    }
    const serializedSnapshot = JSON.stringify(snapshot);
    assert(serializedSnapshot.length > 10 * 1024 * 1024 && serializedSnapshot.length < 18 * 1024 * 1024,
      `The legal restore fixture used an unexpected ${serializedSnapshot.length}-byte snapshot.`);
    inflationDatabase.prepare("UPDATE schedule_backups SET snapshot_json = ? WHERE id = ?")
      .run(serializedSnapshot, backup.id);
  } finally {
    inflationDatabase.close();
  }

  const download = await fetch(new URL("/api/system-backup", serverA.baseUrl), {
    headers: { Cookie: administratorCookie },
    signal: AbortSignal.timeout(requestTimeoutMilliseconds),
  });
  assert.equal(download.status, 200);
  const restoreSource = Buffer.from(await download.arrayBuffer());
  assert(restoreSource.byteLength < 20 * 1024 * 1024);
  const statusBeforeMarker = await requestApi(serverA, "/api/system-backup/status", {
    cookie: administratorCookie,
  });
  assert.match(statusBeforeMarker.body.currentToken, /^[0-9a-f]{64}$/);

  // 这个提交发生在 restore 请求之前，必须包含在 safety snapshot；目标备份较旧，
  // 因而成功恢复后的 live 中不应再有它。
  const preRestoreTeacher = (await requestApi(serverB, "/api/teachers", {
    method: "POST",
    cookie: administratorCookie,
    expectedStatus: 201,
    json: { name: "PRE RESTORE COMMITTED", staffType: "FT" },
  })).body;
  const beforeRestore = readFullBusinessSnapshot();
  const safetyDirectory = path.join(path.dirname(testDatabasePath), "shared-restore-safety");
  assert.equal(await pathExists(safetyDirectory), false);

  // status 后提交的 marker 使旧确认过期。冲突判断必须在 IMMEDIATE 内发生，并且在
  // 建立 safety 目录之前以 typed 409 返回；当前业务资料和会话逐字段保持不变。
  const staleRestore = await requestApi(serverA, "/api/system-backup", {
    method: "POST",
    cookie: administratorCookie,
    body: fullRestoreForm(restoreSource, statusBeforeMarker.body.currentToken),
    expectedStatus: 409,
  });
  assert.equal(staleRestore.body.code, "SYSTEM_STATE_CHANGED");
  assert.deepEqual(readFullBusinessSnapshot(), beforeRestore);
  assert.equal(await pathExists(safetyDirectory), false);
  const currentRestoreStatus = await requestApi(serverB, "/api/system-backup/status", {
    cookie: administratorCookie,
  });
  assert.match(currentRestoreStatus.body.currentToken, /^[0-9a-f]{64}$/);
  assert.notEqual(currentRestoreStatus.body.currentToken, statusBeforeMarker.body.currentToken);

  // IMMEDIATE 允许既有 reader 完成本轮快照。它会在 restore 复制完成后卡住 COMMIT，
  // 因此必须在发出 restore 前先建立 SHARED snapshot；若等观察到锁才建立，快速机器上
  // restore 可能已经提交，测试反而会错过真正的 COMMIT 边界。
  const reader = new Database(testDatabasePath, { readonly: true });
  let readerTransactionOpen = false;
  let restoreSettled = false;
  let restorePromise;
  const postRestoreTeacherId = `post-restore-${randomBytes(8).toString("hex")}`;
  let externalWriter;
  let readerPhaseSucceeded = false;
  let observedSafetyFilename;
  try {
    reader.exec("BEGIN");
    readerTransactionOpen = true;
    reader.prepare("SELECT COUNT(*) AS count FROM teachers").get();
    restorePromise = requestApi(serverA, "/api/system-backup", {
      method: "POST",
      cookie: administratorCookie,
      body: fullRestoreForm(restoreSource, currentRestoreStatus.body.currentToken),
    });
    restorePromise.then(
      () => { restoreSettled = true; },
      () => { restoreSettled = true; },
    );
    await waitForRestoreLockBeforeSafetyDirectory(safetyDirectory, () => restoreSettled);
    observedSafetyFilename = await waitForDurableSafetyFileUnderRestoreLock(safetyDirectory, () => restoreSettled);
    externalWriter = startExternalTeacherWriter(postRestoreTeacherId, "POST RESTORE IN FLIGHT");
    await Promise.race([
      externalWriter.firstBusy,
      delay(5_000).then(() => { throw new Error("The external writer did not report its first restore BUSY within five seconds."); }),
    ]);
    assert.equal(externalWriter.settled(), false, "The external writer exited immediately after its first restore BUSY.");
    reader.exec("COMMIT");
    readerTransactionOpen = false;
    readerPhaseSucceeded = true;
  } finally {
    if (readerTransactionOpen) {
      try { reader.exec("ROLLBACK"); } catch { /* close 会释放测试 SHARED lock。 */ }
    }
    reader.close();
    // 任一屏障或断言失败时，本测试自己负责终止并等待第三进程；不能依赖顶层删除
    // 临时目录让它得到 DBMOVED，也不能把一个仍持 SQLite handle 的 Node 留在后台。
    if (!readerPhaseSucceeded && externalWriter) {
      if (!externalWriter.settled()) await stopServer(externalWriter);
      await externalWriter.firstBusy.catch(() => undefined);
      await externalWriter.promise.catch(() => undefined);
    }
  }

  assert(externalWriter, "The external restore writer was not started at the COMMIT boundary.");
  assert(restorePromise, "The full restore request was not started.");
  let restored;
  try {
    [restored] = await Promise.all([restorePromise, externalWriter.promise]);
  } catch (error) {
    if (!externalWriter.settled()) await stopServer(externalWriter);
    await externalWriter.firstBusy.catch(() => undefined);
    await externalWriter.promise.catch(() => undefined);
    throw error;
  }
  assert.equal(restored.body.restored, true);
  assert.equal(path.basename(restored.body.safetyBackupFilename), restored.body.safetyBackupFilename);
  assert.equal(restored.body.safetyBackupFilename, observedSafetyFilename);

  // 该 writer 是恢复前已获授权的在途请求，但它在线性化顺序上发生于 restore 之后；
  // 因此最终 live = 目标备份 + 该写，而不是声称恢复响应后的资料永远精确等于目标。
  // 核心保证是不可逆丢失为零：锁前提交在 safety，锁后写入仍在 live。
  assert.equal(readDatabaseValue("SELECT COUNT(*) AS count FROM teachers WHERE id = ?", preRestoreTeacher.id).count, 0);
  assert.equal(readDatabaseValue("SELECT COUNT(*) AS count FROM teachers WHERE id = ?", postRestoreTeacherId).count, 1);

  const safetyPath = path.join(safetyDirectory, restored.body.safetyBackupFilename);
  assert.equal((await stat(safetyDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(safetyPath)).mode & 0o777, 0o600);
  const expectedSafety = { ...beforeRestore, sessions: [] };
  assert.deepEqual(readFullBusinessSnapshotFrom(safetyPath), expectedSafety);
  const safetyDatabase = new Database(safetyPath, { readonly: true });
  try {
    assert.deepEqual(safetyDatabase.pragma("integrity_check"), [{ integrity_check: "ok" }]);
    assert.deepEqual(safetyDatabase.pragma("foreign_key_check"), []);
    assert.equal(safetyDatabase.prepare("SELECT COUNT(*) AS count FROM auth_sessions").get().count, 0);
    assert.equal(safetyDatabase.prepare("SELECT COUNT(*) AS count FROM teachers WHERE id = ?").get(preRestoreTeacher.id).count, 1);
    assert.equal(safetyDatabase.prepare("SELECT COUNT(*) AS count FROM teachers WHERE id = ?").get(postRestoreTeacherId).count, 0);
  } finally {
    safetyDatabase.close();
  }
  report("完整系统恢复先锁后建耐久安全副本，跨进程在途写入按线性顺序零丢失");
}

function verifyFinalDatabase() {
  // 所有服务器停止后再做 SQLite 自检，避免后台连接或尚未结束的 HTTP 请求干扰结果。
  const db = new Database(testDatabasePath, { readonly: true });
  try {
    assert.deepEqual(db.pragma("integrity_check"), [{ integrity_check: "ok" }]);
    assert.deepEqual(db.pragma("foreign_key_check"), []);
    // 候选竞态课程与管理聚合竞态课程都经过 Cycle/完整恢复后保留；后者含一个
    // 手工班次和一个导入班次，因此最终明确为两门课程、四个班次。
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM courses").get().count, 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM course_sections").get().count, 4);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM scheduled_lessons").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM schedule_backups").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM auth_sessions").get().count, 0);
  } finally {
    db.close();
  }
}

function cleanupTemporaryResources() {
  // 普通 finally、Ctrl-C 和 CI SIGTERM 共用一个幂等 Promise，保证最多清理一次。
  if (!cleanupPromise) {
    cleanupPromise = (async () => {
      // 若认证或候选读取停在 preload，先建立对应 release 文件，再终止两个进程。
      await Promise.all([...activeRaceReleases].map(([releaseFile, nonce]) => (
        releaseRaceBarrier(releaseFile, nonce).catch(() => undefined)
      )));
      await Promise.allSettled(serverHandles.map((handle) => stopServer(handle)));
      const externalWriters = [...externalWriterHandles];
      await Promise.allSettled(externalWriters.map(async (handle) => {
        await stopServer(handle);
        await handle.firstBusy.catch(() => undefined);
        await handle.promise.catch(() => undefined);
      }));
      if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
    })();
  }
  return cleanupPromise;
}

function installTerminationCleanup() {
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

  // 先执行源码级初始化故障回归，覆盖 production build 会裁掉的 development seed 分支。
  // 现有 integration／release 都会运行本脚本，因此无需改动老师尚未提交的 package UX 区块。
  await import("./verify-database-initialization.mjs");

  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "timetabling-api-concurrency-"));
  testDatabasePath = path.join(temporaryDirectory, "shared.sqlite");
  authRaceControlDirectory = path.join(temporaryDirectory, "auth-race-control");
  authRaceRunToken = randomBytes(32).toString("hex");
  administratorSetupToken = randomBytes(32).toString("hex");
  assert.equal(path.dirname(testDatabasePath), temporaryDirectory);
  await mkdir(authRaceControlDirectory, { mode: 0o700 });
  await writeFile(path.join(authRaceControlDirectory, "run-token.marker"), `${authRaceRunToken}\n`, {
    flag: "wx",
    mode: 0o600,
  });

  // A 首次 health 会在部分初始化后故意失败一次。生产代码必须主动关闭局部连接，
  // 同一个进程的下一次 health 才能完成幂等初始化；整个过程只使用本轮临时 SQLite。
  const initializationFault = await armDatabaseInitializationFailure();
  const serverA = await startServer("A");
  await verifyDatabaseInitializationRecovery(serverA, initializationFault);

  // B 在空库 setup 前启动，才能让两个真实 standalone 同时竞争首位管理员。错误 token
  // 必须先被拒绝且零写入；正确 token 的两次并发请求则只能一胜一冲突。
  const serverB = await startServer("B");
  await requestApi(serverA, "/api/auth/setup", {
    method: "POST",
    authenticated: false,
    expectedStatus: 403,
    json: { username: "wrong-token-admin", password: "CrossProcessAdmin123!", setupToken: "x".repeat(64) },
  });
  const concurrentSetups = await Promise.all([
    requestApi(serverA, "/api/auth/setup", {
      method: "POST",
      authenticated: false,
      expectedStatus: [201, 409],
      json: { username: "cross-admin-a", password: "CrossProcessAdmin123!", setupToken: administratorSetupToken },
    }),
    requestApi(serverB, "/api/auth/setup", {
      method: "POST",
      authenticated: false,
      expectedStatus: [201, 409],
      json: { username: "cross-admin-b", password: "CrossProcessAdmin123!", setupToken: administratorSetupToken },
    }),
  ]);
  assert.deepEqual(concurrentSetups.map((result) => result.response.status).sort(), [201, 409]);
  const setupWinner = concurrentSetups.find((result) => result.response.status === 201);
  administratorCookie = cookieFrom(setupWinner.response, "Concurrent initial administrator setup");
  assert.equal(readDatabaseValue("SELECT COUNT(*) AS count FROM app_users").count, 1);
  await requestApi(serverA, "/api/auth/setup", {
    method: "POST",
    authenticated: false,
    expectedStatus: 409,
    json: { username: "cross-admin-repeat", password: "CrossProcessAdmin123!", setupToken: administratorSetupToken },
  });
  report("production setup token 拒绝未授权请求，且跨进程并发只建立一位管理员");

  // 管理员已提前建立；接下来创建账号、独立会话和课程 fixture。
  const fixture = await initializeFixtureAfterAdministrator(serverA, serverB);

  await verifyConcurrentMasterDataAndSectionResize(serverA, serverB, fixture);
  await verifyDataManagementWorkspaceSnapshotConsistency(serverA, serverB, fixture);
  await verifyCourseWorkspaceSnapshotConsistency(serverA, serverB, fixture);
  await verifyManagementWorkspaceFailureBoundaries(serverA, fixture);
  await verifyCandidateSnapshotConsistency(serverA, serverB, fixture);
  await verifyCandidateFailureBoundaries(serverA, fixture);
  await verifyYearWorkspaceSnapshotConsistency(serverA, serverB, fixture);
  await verifyYearWorkspaceBusyContract(serverA, serverB, fixture);
  await verifyConcurrentFirstPlacement(serverA, serverB, fixture);
  await verifyConcurrentCourseSetup(serverA, serverB, fixture);
  await verifyConcurrentScheduledLessonUpdate(serverA, serverB, fixture);
  await verifyConcurrentRuleAndWindowConflicts(serverA, serverB, fixture);
  await verifyRulesWorkspaceSnapshotConsistency(serverA, serverB, fixture);
  await verifyConcurrentCycleStartAndRestore(serverA, serverB, fixture);
  await verifyAuthenticationRaces(serverA, serverB, fixture);
  await verifyAtomicFullSystemRestore(serverA, serverB);

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
    ["cross-own-reset-race", "OwnResetOld123!"],
    ["cross-own-disable-race", "OwnDisableOld123!"],
    ["cross-own-preread-reset", "PreReadResetOld123!"],
    ["cross-own-preread-disable", "PreReadDisableOld123!"],
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

  // 候选快照夹具只建立一位 Active 教师、一个班级和一间容量20的教室。
  // 课程最低容量设为30，因此修改教室前一定没有 clear slot，修改到40后才会出现候选。
  const candidateTeacher = (await requestApi(serverA, "/api/teachers", {
    method: "POST",
    cookie: schedulerA.cookie,
    expectedStatus: 201,
    json: { name: "cross candidate teacher", staffType: "FT" },
  })).body;
  const candidateGroup = (await requestApi(serverA, "/api/student-groups", {
    method: "POST",
    cookie: schedulerA.cookie,
    expectedStatus: 201,
    json: { code: "cross_y1_01", year: 1, program: "cross" },
  })).body;
  const candidateRoom = (await requestApi(serverA, "/api/rooms", {
    method: "POST",
    cookie: schedulerA.cookie,
    expectedStatus: 201,
    json: {
      code: "31-01-01",
      capacity: 20,
      hasLab: false,
      hasMultiProjector: false,
      isSmartClassroom: false,
    },
  })).body;

  // 管理聚合竞态使用独立资料：一门手工课程先只有未分配01班，Teaching Members
  // 导入随后把同一教师由 PT 改为 FT，并新增自动02班。这样一笔真实事务会同时改变
  // teachers 与 courses 摘要；第二位教师则供课程详情竞态执行手工改派。
  const dataWorkspaceTeacher = (await requestApi(serverA, "/api/teachers", {
    method: "POST",
    cookie: schedulerA.cookie,
    expectedStatus: 201,
    json: { name: "CROSS DATA WORKSPACE TEACHER", staffType: "PT" },
  })).body;
  const dataWorkspaceReplacementTeacher = (await requestApi(serverA, "/api/teachers", {
    method: "POST",
    cookie: schedulerA.cookie,
    expectedStatus: 201,
    json: { name: "CROSS DATA REPLACEMENT", staffType: "FT" },
  })).body;
  const dataWorkspaceCourse = (await requestApi(serverA, "/api/courses", {
    method: "POST",
    cookie: schedulerA.cookie,
    expectedStatus: 201,
    json: {
      code: "CROSS_DATA_WORKSPACE",
      catalog: "Cross workspace old catalog",
      sectionCount: 1,
    },
  })).body;

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
      minimumRoomCapacity: 30,
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
  const candidateAssignment = await requestApi(serverA, `/api/course-sections/${sections[1].id}`, {
    method: "PATCH",
    cookie: schedulerA.cookie,
    json: {
      teacherId: candidateTeacher.id,
      studentGroupIds: [candidateGroup.id],
      revision: sections[1].revision,
    },
  });
  // PATCH 响应只返回新的 revision；稳定 ID 和显示资料继续取自刚读取的班次记录。
  sections[1] = {
    ...sections[1],
    teacherId: candidateTeacher.id,
    studentGroupIds: [candidateGroup.id],
    revision: candidateAssignment.body.revision,
  };
  report("两个 standalone 共享账号、会话和最小课程资料");
  return {
    accounts,
    courseId: course.id,
    setupRevision: initialSetup.body.revision,
    sections,
    candidateTeacher,
    candidateGroup,
    candidateRoom,
    candidateSectionId: sections[1].id,
    dataWorkspaceTeacher,
    dataWorkspaceReplacementTeacher,
    dataWorkspaceCourse,
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
