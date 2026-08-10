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

function readFullBusinessSnapshot() {
  // Candidate 失败属于纯读取。14 张业务表在同一个 DEFERRED 快照中逐字段读取，
  // 能发现 revision、warning、会话或备份的任何隐藏写入，而不只是比较行数。
  const db = new Database(testDatabasePath, { readonly: true });
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

function readDatabaseValue(sql, ...parameters) {
  // 简短精确断言使用独立只读连接；调用结束立即关闭，不与后续写入争抢资源。
  const db = new Database(testDatabasePath, { readonly: true });
  try {
    return db.prepare(sql).get(...parameters);
  } finally {
    db.close();
  }
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

async function verifyCandidateSnapshotConsistency(serverA, serverB, fixture) {
  const candidatePath = `/api/course-sections/${fixture.candidateSectionId}/candidates?occurrence=1`;
  const roomPayload = (capacity) => ({
    code: fixture.candidateRoom.code,
    capacity,
    hasLab: false,
    hasMultiProjector: false,
    isSmartClassroom: false,
  });

  // 先分别证明夹具的完整旧状态和完整新状态，避免竞态断言只因候选功能本身坏掉而假绿。
  const oldBaseline = await requestApi(serverA, candidatePath, { cookie: fixture.schedulerACookie });
  assertCandidateSnapshot(oldBaseline.body, fixture, 20);
  await requestApi(serverB, `/api/rooms/${fixture.candidateRoom.id}`, {
    method: "PATCH",
    cookie: fixture.schedulerBCookie,
    json: roomPayload(40),
  });
  const newBaseline = await requestApi(serverB, candidatePath, { cookie: fixture.schedulerBCookie });
  assertCandidateSnapshot(newBaseline.body, fixture, 40);
  await requestApi(serverA, `/api/rooms/${fixture.candidateRoom.id}`, {
    method: "PATCH",
    cookie: fixture.schedulerACookie,
    json: roomPayload(20),
  });
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
      json: roomPayload(40),
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
  activeRaceReleases.set(releaseFile, nonce);
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
    await releaseRaceBarrier(releaseFile, nonce);
    const rejectedLogin = await pendingLogin;
    assert.deepEqual(rejectedLogin.body, { error: "Username or password is incorrect." });
    assert.equal(rejectedLogin.response.headers.get("set-cookie"), null);
    assert.equal(
      readDatabaseValue("SELECT COUNT(*) AS count FROM auth_sessions WHERE user_id = ?", accountId).count,
      0,
    );
  } finally {
    // 任一断言失败也必须释放 B；否则同步 preload 会一直等到自己的超时上限。
    await releaseRaceBarrier(releaseFile, nonce).catch(() => undefined);
    activeRaceReleases.delete(releaseFile);
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
      // 若认证或候选读取停在 preload，先建立对应 release 文件，再终止两个进程。
      await Promise.all([...activeRaceReleases].map(([releaseFile, nonce]) => (
        releaseRaceBarrier(releaseFile, nonce).catch(() => undefined)
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

  // 先执行源码级初始化故障回归，覆盖 production build 会裁掉的 development seed 分支。
  // 现有 integration／release 都会运行本脚本，因此无需改动老师尚未提交的 package UX 区块。
  await import("./verify-database-initialization.mjs");

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

  // A 首次 health 会在部分初始化后故意失败一次。生产代码必须主动关闭局部连接，
  // 同一个进程的下一次 health 才能完成幂等初始化；整个过程只使用本轮临时 SQLite。
  const initializationFault = await armDatabaseInitializationFailure();
  const serverA = await startServer("A");
  await verifyDatabaseInitializationRecovery(serverA, initializationFault);

  // A 完成空库初始化和管理员 setup 后，B 才加载同一个数据库及测试专用 preload。
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

  await verifyCandidateSnapshotConsistency(serverA, serverB, fixture);
  await verifyCandidateFailureBoundaries(serverA, fixture);
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
    candidateRoom,
    candidateSectionId: sections[1].id,
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
