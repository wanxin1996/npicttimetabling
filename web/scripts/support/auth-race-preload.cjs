"use strict";

/* eslint-disable @typescript-eslint/no-require-imports -- Node 的 --require preload 必须使用 CommonJS。 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");

// 这个文件只能由跨进程回归通过 `node --require` 加载。启动时先验证一组无法由
// HTTP 请求伪造的环境、随机 marker 和临时路径；任一条件不符都会让测试子进程退出。
const exactTestMode = "timetabling-cross-process-race-v1";
const testMode = process.env.TIMETABLING_AUTH_RACE_TEST_MODE;
const runToken = process.env.TIMETABLING_AUTH_RACE_RUN_TOKEN || "";
const processLabel = process.env.TIMETABLING_CONCURRENCY_PROCESS_LABEL || "";
const controlDirectory = path.resolve(process.env.TIMETABLING_AUTH_RACE_CONTROL_DIR || "");
const databasePath = path.resolve(process.env.TIMETABLING_DATABASE_PATH || "");
const temporaryRoot = path.dirname(databasePath);
const systemTemporaryDirectory = path.resolve(os.tmpdir());
const runTokenMarker = path.join(controlDirectory, "run-token.marker");

const rootHasExpectedName = path.basename(temporaryRoot).startsWith("timetabling-api-concurrency-");
const rootIsInsideSystemTemporaryDirectory = temporaryRoot.startsWith(`${systemTemporaryDirectory}${path.sep}`);
const databaseIsDirectChild = path.dirname(databasePath) === temporaryRoot;
const controlIsDirectChild = path.dirname(controlDirectory) === temporaryRoot
  && path.basename(controlDirectory) === "auth-race-control";
const tokenHasExpectedShape = /^[a-f0-9]{64}$/.test(runToken);
let markerMatches = false;
try {
  markerMatches = fs.readFileSync(runTokenMarker, "utf8").trim() === runToken;
} catch {
  markerMatches = false;
}
if (testMode !== exactTestMode || !/^[AB]$/.test(processLabel) || !tokenHasExpectedShape || !rootHasExpectedName
  || !rootIsInsideSystemTemporaryDirectory || !databaseIsDirectChild || !controlIsDirectChild
  || !markerMatches) {
  throw new Error("Concurrency race preload refused to start outside its isolated test run.");
}

const armFile = path.join(controlDirectory, "arm.json");
const originalTimingSafeEqual = crypto.timingSafeEqual;
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
const candidateEntrySqlMarker = "/* timetabling:candidate-entry */";
const candidateSnapshotSqlMarker = "/* timetabling:candidate-snapshot */";
const candidateRoomUpdateSqlMarker = "/* timetabling:candidate-race-room-update */";
const yearWorkspaceLessonsSqlMarker = "/* timetabling:year-workspace-lessons */";
const yearWorkspacePlacementSqlMarker = "/* timetabling:year-workspace-race-placement */";
const dataWorkspaceTeachersSqlMarker = "/* timetabling:data-workspace-teachers */";
const dataWorkspaceImportSqlMarker = "/* timetabling:data-workspace-import-write */";
const courseWorkspaceSectionsSqlMarker = "/* timetabling:course-workspace-sections */";
const courseWorkspaceSectionWriteSqlMarker = "/* timetabling:course-workspace-section-write */";
const rulesWorkspaceWindowsSqlMarker = "/* timetabling:rules-workspace-windows */";
const rulesWorkspaceRuleWriteSqlMarker = "/* timetabling:rules-workspace-rule-write */";
const rulesWorkspaceWindowWriteSqlMarker = "/* timetabling:rules-workspace-window-write */";
const ownPasswordPreReadSqlMarker = "/* timetabling:own-password-pre-read */";
const databaseInitializationSqlMarker = "/* timetabling:database-initialization */";
let pendingInitializationClose;

function consumeDatabaseInitializationArm(database) {
  // 只让 A 在首次空库启动时注入一次故障。真实 schema SQL 已执行后再抛错，
  // 可以同时验证“部分初始化的连接被关闭”和“下一次健康检查能幂等重试”。
  if (processLabel !== "A") return;
  const armFile = path.join(controlDirectory, "database-initialization-arm-A.json");
  let control;
  try {
    control = JSON.parse(fs.readFileSync(armFile, "utf8"));
  } catch (error) {
    // 没有 arm 表示普通启动；损坏的控制文件必须让测试安全失败，不能静默跳过。
    if (error && error.code === "ENOENT") return;
    throw error;
  }
  if (!control || typeof control !== "object" || control.version !== 1) return;
  if (control.runToken !== runToken || control.label !== processLabel) return;
  if (typeof control.nonce !== "string" || !/^[a-f0-9]{32}$/.test(control.nonce)) return;

  // rename 在同一 control 目录内是原子的；arm 被消费后，后续健康检查不会再次注入。
  const consumedFile = path.join(
    controlDirectory,
    `database-initialization-consumed-A-${control.nonce}.json`,
  );
  const readyFile = path.join(
    controlDirectory,
    `database-initialization-close-ready-A-${control.nonce}.json`,
  );
  fs.renameSync(armFile, consumedFile);
  pendingInitializationClose = { database, control, consumedFile, readyFile };
  throw new Error("Forced database initialization failure for isolated cleanup verification.");
}

function recordClosedInitializationConnection(database) {
  // ready 只在命中故障的同一个 Database 实例完成真实 close 后建立。
  // 若生产代码只等待垃圾回收而没有主动关闭，回归会因缺少这个证据而失败。
  const pending = pendingInitializationClose;
  if (!pending || pending.database !== database) return;
  fs.renameSync(pending.consumedFile, pending.readyFile);
  pendingInitializationClose = undefined;
}

function waitForRaceRelease(releaseFile, nonce, description) {
  // 所有同步屏障都要求 release 文件内容精确匹配随机 nonce；只创建文件名不能误放行。
  // 二十秒硬上限保证主测试异常退出时，standalone 不会永久卡在同步等待中。
  const deadline = Date.now() + 20_000;
  while (true) {
    try {
      if (fs.readFileSync(releaseFile, "utf8").trim() === nonce) return;
    } catch {
      // release 尚未建立属于正常测试时序，短暂休眠后继续检查。
    }
    if (Date.now() >= deadline) throw new Error(`Timed out while waiting for the ${description} release nonce.`);
    Atomics.wait(sleepBuffer, 0, 0, 25);
  }
}

function consumeCandidateSnapshotArm(rooms) {
  // 只有 A 进程负责候选读取竞态。带 marker 的 Active rooms 已从内存快照完整返回后，
  // 原子建立 ready 并暂停；此时主测试可以证明 B 不受正式数据库读锁阻塞。
  if (processLabel !== "A") return;
  const candidateArmFile = path.join(controlDirectory, "candidate-snapshot-arm-A.json");
  try {
    const control = JSON.parse(fs.readFileSync(candidateArmFile, "utf8"));
    if (!control || typeof control !== "object" || control.version !== 1) return;
    if (control.runToken !== runToken || control.label !== processLabel) return;
    if (typeof control.nonce !== "string" || !/^[a-f0-9]{32}$/.test(control.nonce)) return;
    if (typeof control.roomId !== "string" || !Array.isArray(rooms)
      || !rooms.some((room) => room && room.id === control.roomId)) return;
    const readyFile = path.join(controlDirectory, `candidate-snapshot-ready-A-${control.nonce}.json`);
    fs.renameSync(candidateArmFile, readyFile);
    const releaseFile = path.join(controlDirectory, `candidate-snapshot-release-${control.nonce}.txt`);
    waitForRaceRelease(releaseFile, control.nonce, "candidate snapshot");
  } catch (error) {
    // arm 不存在表示普通候选请求；已经被同一请求消费也可直接继续。
    if (error && error.code === "ENOENT") return;
    throw error;
  }
}

function consumeYearWorkspaceSnapshotArm(rows, year) {
  // A 已经把旧版 lessons 完整物化后才暂停。正式 DELETE journal 配置下，只要
  // workspace 的 DEFERRED 事务仍在，B 就能执行 INSERT，但 COMMIT 必须等待 A 读完。
  if (processLabel !== "A") return;
  const workspaceArmFile = path.join(controlDirectory, "year-workspace-arm-A.json");
  try {
    const control = JSON.parse(fs.readFileSync(workspaceArmFile, "utf8"));
    if (!control || typeof control !== "object" || control.version !== 1) return;
    if (control.runToken !== runToken || control.label !== processLabel || control.year !== year) return;
    if (typeof control.nonce !== "string" || !/^[a-f0-9]{32}$/.test(control.nonce)) return;
    if (typeof control.sectionId !== "string" || !Array.isArray(rows)) return;
    // 本轮 fixture 的目标课次起初必须仍在待排区；若首条查询已经看到它，不能用错误
    // 基线生成 ready 并让一致性测试假绿。
    if (rows.some((row) => row && row.section_id === control.sectionId)) return;
    const readyFile = path.join(controlDirectory, `year-workspace-ready-A-${control.nonce}.json`);
    fs.renameSync(workspaceArmFile, readyFile);
    const releaseFile = path.join(controlDirectory, `year-workspace-release-${control.nonce}.txt`);
    waitForRaceRelease(releaseFile, control.nonce, "year workspace snapshot");
  } catch (error) {
    // 没有 arm 的普通总表或聚合工作区读取保持透明；损坏控制文件必须让测试失败。
    if (error && error.code === "ENOENT") return;
    throw error;
  }
}

function consumeYearWorkspacePlacementArm(sectionId, occurrence, changes) {
  // B 的首次排课 INSERT 已在 IMMEDIATE 事务内真实执行后才暂停。主测试先释放 B，
  // 再证明它仍因 A 的 workspace 读事务无法 COMMIT；不能只靠请求启动时间猜测并发。
  if (processLabel !== "B" || changes !== 1) return;
  const placementArmFile = path.join(controlDirectory, "year-workspace-placement-arm-B.json");
  try {
    const control = JSON.parse(fs.readFileSync(placementArmFile, "utf8"));
    if (!control || typeof control !== "object" || control.version !== 1) return;
    if (control.runToken !== runToken || control.label !== processLabel) return;
    if (control.sectionId !== sectionId || control.occurrence !== occurrence) return;
    if (typeof control.nonce !== "string" || !/^[a-f0-9]{32}$/.test(control.nonce)) return;
    const readyFile = path.join(controlDirectory, `year-workspace-placement-ready-B-${control.nonce}.json`);
    fs.renameSync(placementArmFile, readyFile);
    const releaseFile = path.join(controlDirectory, `year-workspace-placement-release-${control.nonce}.txt`);
    waitForRaceRelease(releaseFile, control.nonce, "year workspace placement");
  } catch (error) {
    // 没有 arm 的普通首次排课保持透明；损坏控制文件必须让测试失败。
    if (error && error.code === "ENOENT") return;
    throw error;
  }
}

function consumeDataWorkspaceEntryArm() {
  // 认证完成且 DEFERRED 已建立、首张 teachers 清单尚未读取时暂停 A。第三连接随后
  // 可以确定性制造真实 SQLITE_BUSY；internal 分支则验证未知异常不会泄漏 SQL 细节。
  if (processLabel !== "A") return;
  const entryArmFile = path.join(controlDirectory, "data-workspace-entry-arm-A.json");
  try {
    const control = JSON.parse(fs.readFileSync(entryArmFile, "utf8"));
    if (!control || typeof control !== "object" || control.version !== 1) return;
    if (control.runToken !== runToken || control.label !== processLabel) return;
    if (typeof control.nonce !== "string" || !/^[a-f0-9]{32}$/.test(control.nonce)) return;
    if (!["busy", "internal"].includes(control.fault)) return;
    const readyFile = path.join(controlDirectory, `data-workspace-entry-ready-A-${control.nonce}.json`);
    fs.renameSync(entryArmFile, readyFile);
    if (control.fault === "internal") {
      throw new Error("SECRET data workspace fault: SELECT teachers from /private/tmp/private.sqlite stack");
    }
    const releaseFile = path.join(controlDirectory, `data-workspace-entry-release-${control.nonce}.txt`);
    waitForRaceRelease(releaseFile, control.nonce, "data workspace entry");
  } catch (error) {
    if (error && error.code === "ENOENT") return;
    throw error;
  }
}

function consumeDataWorkspaceSnapshotArm(rows) {
  // teachers 已完整物化为旧版本后暂停 A；后续 groups、rooms、courses 仍必须留在
  // 同一个 DEFERRED 快照，不能与 B 随后提交的 Teaching Members 导入拼成混合画面。
  if (processLabel !== "A") return;
  const snapshotArmFile = path.join(controlDirectory, "data-workspace-arm-A.json");
  try {
    const control = JSON.parse(fs.readFileSync(snapshotArmFile, "utf8"));
    if (!control || typeof control !== "object" || control.version !== 1) return;
    if (control.runToken !== runToken || control.label !== processLabel) return;
    if (typeof control.nonce !== "string" || !/^[a-f0-9]{32}$/.test(control.nonce)) return;
    if (typeof control.teacherId !== "string" || !Array.isArray(rows)) return;
    const target = rows.find((row) => row && row.id === control.teacherId);
    if (!target || target.staff_type !== control.expectedStaffType
      || target.sections !== control.expectedSections) return;
    const readyFile = path.join(controlDirectory, `data-workspace-ready-A-${control.nonce}.json`);
    fs.renameSync(snapshotArmFile, readyFile);
    const releaseFile = path.join(controlDirectory, `data-workspace-release-${control.nonce}.txt`);
    waitForRaceRelease(releaseFile, control.nonce, "data workspace snapshot");
  } catch (error) {
    if (error && error.code === "ENOENT") return;
    throw error;
  }
}

function consumeDataWorkspaceImportArm(courseId, changes) {
  // B 已在同一 IMMEDIATE 导入事务完成教师、allocation、班次和课程 revision 写入后
  // 才建立 ready。释放测试暂停点后，正式 COMMIT 仍应被 A 的旧快照读锁挡住。
  if (processLabel !== "B" || changes !== 1) return;
  const importArmFile = path.join(controlDirectory, "data-workspace-import-arm-B.json");
  try {
    const control = JSON.parse(fs.readFileSync(importArmFile, "utf8"));
    if (!control || typeof control !== "object" || control.version !== 1) return;
    if (control.runToken !== runToken || control.label !== processLabel || control.courseId !== courseId) return;
    if (typeof control.nonce !== "string" || !/^[a-f0-9]{32}$/.test(control.nonce)) return;
    const readyFile = path.join(controlDirectory, `data-workspace-import-ready-B-${control.nonce}.json`);
    fs.renameSync(importArmFile, readyFile);
    const releaseFile = path.join(controlDirectory, `data-workspace-import-release-${control.nonce}.txt`);
    waitForRaceRelease(releaseFile, control.nonce, "data workspace import");
  } catch (error) {
    if (error && error.code === "ENOENT") return;
    throw error;
  }
}

function consumeCourseWorkspaceEntryArm(courseId) {
  // 课程聚合已完成认证、并在首张 sections 查询前暂停。绑定 courseId 可防止 arm 被
  // 同进程的其他课程详情请求误消费。
  if (processLabel !== "A") return;
  const entryArmFile = path.join(controlDirectory, "course-workspace-entry-arm-A.json");
  try {
    const control = JSON.parse(fs.readFileSync(entryArmFile, "utf8"));
    if (!control || typeof control !== "object" || control.version !== 1) return;
    if (control.runToken !== runToken || control.label !== processLabel || control.courseId !== courseId) return;
    if (typeof control.nonce !== "string" || !/^[a-f0-9]{32}$/.test(control.nonce)) return;
    if (!["busy", "internal"].includes(control.fault)) return;
    const readyFile = path.join(controlDirectory, `course-workspace-entry-ready-A-${control.nonce}.json`);
    fs.renameSync(entryArmFile, readyFile);
    if (control.fault === "internal") {
      throw new Error("SECRET course workspace fault: SELECT sections from /private/tmp/private.sqlite stack");
    }
    const releaseFile = path.join(controlDirectory, `course-workspace-entry-release-${control.nonce}.txt`);
    waitForRaceRelease(releaseFile, control.nonce, "course workspace entry");
  } catch (error) {
    if (error && error.code === "ENOENT") return;
    throw error;
  }
}

function consumeCourseWorkspaceSnapshotArm(rows, courseId) {
  // A 已物化旧版 sections 后暂停；currentCourse 在同一事务更早读取，variance 则会在
  // 释放后读取，三者必须共同保持旧提交版本。
  if (processLabel !== "A") return;
  const snapshotArmFile = path.join(controlDirectory, "course-workspace-arm-A.json");
  try {
    const control = JSON.parse(fs.readFileSync(snapshotArmFile, "utf8"));
    if (!control || typeof control !== "object" || control.version !== 1) return;
    if (control.runToken !== runToken || control.label !== processLabel || control.courseId !== courseId) return;
    if (typeof control.nonce !== "string" || !/^[a-f0-9]{32}$/.test(control.nonce)) return;
    if (typeof control.sectionId !== "string" || !Array.isArray(rows)) return;
    const target = rows.find((row) => row && row.id === control.sectionId);
    if (!target || target.teacher_id !== control.expectedTeacherId) return;
    const readyFile = path.join(controlDirectory, `course-workspace-ready-A-${control.nonce}.json`);
    fs.renameSync(snapshotArmFile, readyFile);
    const releaseFile = path.join(controlDirectory, `course-workspace-release-${control.nonce}.txt`);
    waitForRaceRelease(releaseFile, control.nonce, "course workspace snapshot");
  } catch (error) {
    if (error && error.code === "ENOENT") return;
    throw error;
  }
}

function consumeCourseWorkspaceSectionWriteArm(teacherId, sectionId, revision, changes) {
  // B 的 CAS UPDATE 已真实改变目标班次，但外层 IMMEDIATE 尚未提交。四个参数全部匹配
  // 才建立 ready，避免普通 Section 保存被测试屏障误拦截。
  if (processLabel !== "B" || changes !== 1) return;
  const writeArmFile = path.join(controlDirectory, "course-workspace-section-write-arm-B.json");
  try {
    const control = JSON.parse(fs.readFileSync(writeArmFile, "utf8"));
    if (!control || typeof control !== "object" || control.version !== 1) return;
    if (control.runToken !== runToken || control.label !== processLabel) return;
    if (control.teacherId !== teacherId || control.sectionId !== sectionId || control.revision !== revision) return;
    if (typeof control.nonce !== "string" || !/^[a-f0-9]{32}$/.test(control.nonce)) return;
    const readyFile = path.join(controlDirectory, `course-workspace-section-write-ready-B-${control.nonce}.json`);
    fs.renameSync(writeArmFile, readyFile);
    const releaseFile = path.join(controlDirectory, `course-workspace-section-write-release-${control.nonce}.txt`);
    waitForRaceRelease(releaseFile, control.nonce, "course workspace section write");
  } catch (error) {
    if (error && error.code === "ENOENT") return;
    throw error;
  }
}

function consumeRulesWorkspaceEntryArm() {
  // Rules 聚合已通过 proxy 身份校验并建立 DEFERRED，但首张 windows 表尚未真实读取。
  // internal 在这里注入未知异常；busy 则暂停，让第三连接取得 EXCLUSIVE 后再放行首读。
  if (processLabel !== "A") return;
  const entryArmFile = path.join(controlDirectory, "rules-workspace-entry-arm-A.json");
  try {
    const control = JSON.parse(fs.readFileSync(entryArmFile, "utf8"));
    if (!control || typeof control !== "object" || control.version !== 1) return;
    if (control.runToken !== runToken || control.label !== processLabel) return;
    if (typeof control.nonce !== "string" || !/^[a-f0-9]{32}$/.test(control.nonce)) return;
    if (!["busy", "internal"].includes(control.fault)) return;
    const readyFile = path.join(controlDirectory, `rules-workspace-entry-ready-A-${control.nonce}.json`);
    fs.renameSync(entryArmFile, readyFile);
    if (control.fault === "internal") {
      throw new Error("SECRET rules workspace fault: SELECT windows from /private/tmp/private.sqlite stack");
    }
    const releaseFile = path.join(controlDirectory, `rules-workspace-entry-release-${control.nonce}.txt`);
    waitForRaceRelease(releaseFile, control.nonce, "rules workspace entry");
  } catch (error) {
    if (error && error.code === "ENOENT") return;
    throw error;
  }
}

function consumeRulesWorkspaceSnapshotArm(rows) {
  // 首张 windows 查询已经把完整旧行物化后暂停 A。之后 issues、rule settings 与
  // teachers 必须继续留在同一 DEFERRED 快照，不能和 B 随后的规则写入拼成混合响应。
  if (processLabel !== "A") return;
  const snapshotArmFile = path.join(controlDirectory, "rules-workspace-arm-A.json");
  try {
    const control = JSON.parse(fs.readFileSync(snapshotArmFile, "utf8"));
    if (!control || typeof control !== "object" || control.version !== 1) return;
    if (control.runToken !== runToken || control.label !== processLabel) return;
    if (typeof control.nonce !== "string" || !/^[a-f0-9]{32}$/.test(control.nonce)) return;
    if (typeof control.windowId !== "string" || !Array.isArray(rows)) return;
    if (!rows.some((row) => row && row.id === control.windowId)) return;
    const readyFile = path.join(controlDirectory, `rules-workspace-ready-A-${control.nonce}.json`);
    fs.renameSync(snapshotArmFile, readyFile);
    const releaseFile = path.join(controlDirectory, `rules-workspace-release-${control.nonce}.txt`);
    waitForRaceRelease(releaseFile, control.nonce, "rules workspace snapshot");
  } catch (error) {
    if (error && error.code === "ENOENT") return;
    throw error;
  }
}

function consumeRulesWorkspaceRuleWriteArm(argumentsList, changes) {
  // marker 只放在规则 CAS UPDATE：参数顺序固定为 desired、rule key、expected。
  // 真实 UPDATE 恰好改变一行后才暂停，ready 因而能证明 B 已完成业务写但尚未 COMMIT。
  if (changes !== 1) return;
  const writeArmFile = path.join(controlDirectory, `rules-workspace-rule-write-arm-${processLabel}.json`);
  try {
    const control = JSON.parse(fs.readFileSync(writeArmFile, "utf8"));
    if (!control || typeof control !== "object" || control.version !== 1) return;
    if (control.runToken !== runToken || control.label !== processLabel) return;
    if (typeof control.nonce !== "string" || !/^[a-f0-9]{32}$/.test(control.nonce)) return;
    if (typeof control.ruleKey !== "string"
      || typeof control.expectedEnabled !== "boolean" || typeof control.enabled !== "boolean") return;
    if (argumentsList[0] !== Number(control.enabled) || argumentsList[1] !== control.ruleKey
      || argumentsList[2] !== Number(control.expectedEnabled)) return;
    const readyFile = path.join(
      controlDirectory,
      `rules-workspace-rule-write-ready-${processLabel}-${control.nonce}.json`,
    );
    fs.renameSync(writeArmFile, readyFile);
    const releaseFile = path.join(
      controlDirectory,
      `rules-workspace-rule-write-release-${processLabel}-${control.nonce}.txt`,
    );
    waitForRaceRelease(releaseFile, control.nonce, "rules workspace rule write");
  } catch (error) {
    if (error && error.code === "ENOENT") return;
    throw error;
  }
}

function consumeRulesWorkspaceWindowWriteArm(kind, argumentsList, changes) {
  // 两张 window 表共用一个专属 INSERT marker，但 control 同时绑定 kind、owner 和完整
  // 半开区间。只有指定进程真实插入目标行后才消费 arm，普通 Rules 保存完全透明。
  if (changes !== 1) return;
  const writeArmFile = path.join(controlDirectory, `rules-workspace-window-write-arm-${processLabel}.json`);
  try {
    const control = JSON.parse(fs.readFileSync(writeArmFile, "utf8"));
    if (!control || typeof control !== "object" || control.version !== 1) return;
    if (control.runToken !== runToken || control.label !== processLabel) return;
    if (typeof control.nonce !== "string" || !/^[a-f0-9]{32}$/.test(control.nonce)) return;
    if (control.kind !== kind || typeof control.ownerId !== "string") return;
    if (!Number.isSafeInteger(control.dayOfWeek) || !Number.isSafeInteger(control.startHour)
      || !Number.isSafeInteger(control.endHour)) return;
    if (String(argumentsList[1]) !== control.ownerId || argumentsList[2] !== control.dayOfWeek
      || argumentsList[3] !== control.startHour || argumentsList[4] !== control.endHour) return;
    const readyFile = path.join(
      controlDirectory,
      `rules-workspace-window-write-ready-${processLabel}-${control.nonce}.json`,
    );
    fs.renameSync(writeArmFile, readyFile);
    const releaseFile = path.join(
      controlDirectory,
      `rules-workspace-window-write-release-${processLabel}-${control.nonce}.txt`,
    );
    waitForRaceRelease(releaseFile, control.nonce, "rules workspace window write");
  } catch (error) {
    if (error && error.code === "ENOENT") return;
    throw error;
  }
}

function consumeCandidateEntryArm(sectionId) {
  // Candidate 路由已经完成 Cookie 验证并进入 DEFERRED 事务，但第一条业务 SELECT
  // 尚未执行。测试可在这里安全建立 EXCLUSIVE 锁，确保 BUSY 真正来自 Candidate 路径。
  if (processLabel !== "A") return;
  const entryArmFile = path.join(controlDirectory, "candidate-entry-arm-A.json");
  try {
    const control = JSON.parse(fs.readFileSync(entryArmFile, "utf8"));
    if (!control || typeof control !== "object" || control.version !== 1) return;
    if (control.runToken !== runToken || control.label !== processLabel || control.sectionId !== sectionId) return;
    if (typeof control.nonce !== "string" || !/^[a-f0-9]{32}$/.test(control.nonce)) return;
    if (!["busy", "internal"].includes(control.fault)) return;
    const readyFile = path.join(controlDirectory, `candidate-entry-ready-A-${control.nonce}.json`);
    fs.renameSync(entryArmFile, readyFile);

    if (control.fault === "internal") {
      // 故意包含不应出现在 HTTP 响应中的敏感诊断文字，验证路由只返回固定通用500。
      throw new Error("SECRET candidate fault: SELECT rooms from /private/tmp/private.sqlite table column stack");
    }
    const releaseFile = path.join(controlDirectory, `candidate-entry-release-${control.nonce}.txt`);
    waitForRaceRelease(releaseFile, control.nonce, "candidate entry");
  } catch (error) {
    // arm 不存在表示普通候选请求；其余错误必须继续交给真实路由错误边界处理。
    if (error && error.code === "ENOENT") return;
    throw error;
  }
}

function consumeOwnPasswordPreReadArm(accountId) {
  // 目标请求已经通过 proxy 与 route 的会话校验，但 production 的首条密码查询尚未执行。
  // 在真实 `.get()` 前暂停，主测试便能确定性让另一进程先 reset／deactivate 并提交。
  const preReadArmFile = path.join(controlDirectory, `own-password-pre-read-arm-${processLabel}.json`);
  try {
    const control = JSON.parse(fs.readFileSync(preReadArmFile, "utf8"));
    if (!control || typeof control !== "object" || control.version !== 1) return;
    if (control.runToken !== runToken || control.label !== processLabel || control.accountId !== accountId) return;
    if (typeof control.accountId !== "string" || control.accountId.length === 0) return;
    if (typeof control.nonce !== "string" || !/^[a-f0-9]{32}$/.test(control.nonce)) return;

    // 同目录 rename 原子地证明正确账号已到达首读前；release 内容仍须精确匹配 nonce。
    const readyFile = path.join(
      controlDirectory,
      `own-password-pre-read-ready-${processLabel}-${control.nonce}.json`,
    );
    fs.renameSync(preReadArmFile, readyFile);
    const releaseFile = path.join(
      controlDirectory,
      `own-password-pre-read-release-${processLabel}-${control.nonce}.txt`,
    );
    waitForRaceRelease(releaseFile, control.nonce, "own-password pre-read");
  } catch (error) {
    // 没有 arm 的普通密码修改完全透明；损坏或不一致的测试控制资料必须显式失败。
    if (error && error.code === "ENOENT") return;
    throw error;
  }
}

function consumeCandidateRoomUpdateArm(roomId, changes) {
  // B 的真实 UPDATE 已经在 IMMEDIATE 事务内改到目标教室后才建立 ready。
  // 主测试还会等待 HTTP 200，分别证明 UPDATE 已发生和整笔事务已经成功 COMMIT。
  if (processLabel !== "B" || changes !== 1) return;
  const updateArmFile = path.join(controlDirectory, "candidate-room-update-arm-B.json");
  try {
    const control = JSON.parse(fs.readFileSync(updateArmFile, "utf8"));
    if (!control || typeof control !== "object" || control.version !== 1) return;
    if (control.runToken !== runToken || control.label !== processLabel || control.roomId !== roomId) return;
    if (typeof control.nonce !== "string" || !/^[a-f0-9]{32}$/.test(control.nonce)) return;
    const readyFile = path.join(controlDirectory, `candidate-room-update-ready-B-${control.nonce}.json`);
    fs.renameSync(updateArmFile, readyFile);
  } catch (error) {
    // 没有 arm 的普通教室编辑不参与竞态同步，必须保持原执行路径。
    if (error && error.code === "ENOENT") return;
    throw error;
  }
}

function consumeWriterArm() {
  // 每个 standalone 拥有独立 writer arm。命中 run token、进程标签和随机 nonce 后，
  // 在调用真实 `.immediate()` 之前原子改名为 ready，让主测试确知两个进程均已到达写事务入口。
  const writerArmFile = path.join(controlDirectory, `writer-arm-${processLabel}.json`);
  try {
    const control = JSON.parse(fs.readFileSync(writerArmFile, "utf8"));
    if (!control || typeof control !== "object" || control.version !== 1) return;
    if (control.runToken !== runToken || control.label !== processLabel) return;
    if (typeof control.nonce !== "string" || !/^[a-f0-9]{32}$/.test(control.nonce)) return;
    const readyFile = path.join(controlDirectory, `writer-ready-${processLabel}-${control.nonce}.json`);
    fs.renameSync(writerArmFile, readyFile);
  } catch (error) {
    // arm 不存在表示当前 `.immediate()` 不是本轮目标事务；被另一调用刚消费也可安全继续。
    if (error && error.code === "ENOENT") return;
    throw error;
  }
}

function patchBetterSqlite3(Database) {
  // Standalone 拥有自己追踪复制的 better-sqlite3。通过 Module._load 拦截每一个实际
  // require 结果，而不是只 patch 项目根 node_modules 中可能完全不同的构造器实例。
  if (!Database?.prototype || Database.prototype.__timetablingRacePatched) return Database;
  const originalTransaction = Database.prototype.transaction;
  const originalPrepare = Database.prototype.prepare;
  const originalExec = Database.prototype.exec;
  const originalClose = Database.prototype.close;
  Object.defineProperty(Database.prototype, "__timetablingRacePatched", { value: true });
  Database.prototype.exec = function testAwareExec(...argumentsList) {
    // 初始化 SQL 先真实执行，再注入一次异常。由生产 database() 自己负责关闭这条
    // 尚未发布的连接；测试包装层只观察，不代替业务清理。
    const result = Reflect.apply(originalExec, this, argumentsList);
    const [sql] = argumentsList;
    if (typeof sql === "string" && sql.includes(databaseInitializationSqlMarker)) {
      consumeDatabaseInitializationArm(this);
    }
    return result;
  };
  Database.prototype.close = function testAwareClose(...argumentsList) {
    // 必须先完成 better-sqlite3 的真实关闭，再写 ready；关闭本身失败不能算通过。
    const result = Reflect.apply(originalClose, this, argumentsList);
    recordClosedInitializationConnection(this);
    return result;
  };
  Database.prototype.prepare = function testAwarePrepare(...argumentsList) {
    // 只包装带显式 production marker 的目标语句：Candidate、Year workspace、三套
    // 管理聚合、Rules 写入与自改密码首读。其余 SQL 保持透明。
    const statement = Reflect.apply(originalPrepare, this, argumentsList);
    const [sql] = argumentsList;
    if (typeof sql !== "string") return statement;
    if (sql.includes(candidateEntrySqlMarker)) {
      const originalGet = statement.get;
      statement.get = function candidateEntryAwareGet(...getArguments) {
        // 屏障在真实 `.get()` 之前触发，此时 DEFERRED 尚未取得 SHARED 读锁。
        consumeCandidateEntryArm(getArguments[0]);
        return Reflect.apply(originalGet, this, getArguments);
      };
    }
    if (sql.includes(ownPasswordPreReadSqlMarker)) {
      const originalGet = statement.get;
      statement.get = function ownPasswordPreReadAwareGet(...getArguments) {
        // accountId 是 production 查询第一个参数；屏障发生在 SQLite 真正取得读快照前。
        consumeOwnPasswordPreReadArm(getArguments[0]);
        return Reflect.apply(originalGet, this, getArguments);
      };
    }
    if (sql.includes(candidateSnapshotSqlMarker)) {
      const originalAll = statement.all;
      statement.all = function candidateSnapshotAwareAll(...allArguments) {
        const rows = Reflect.apply(originalAll, this, allArguments);
        // `.all()` 已经把旧教室行物化后才暂停，旧实现若随后读取新容量会产生可识别的混合结果。
        consumeCandidateSnapshotArm(rows);
        return rows;
      };
    }
    if (sql.includes(candidateRoomUpdateSqlMarker)) {
      const originalRun = statement.run;
      statement.run = function candidateRoomUpdateAwareRun(...runArguments) {
        const result = Reflect.apply(originalRun, this, runArguments);
        // 教室 ID 是 UPDATE 的最后一个参数；只有目标行确实改变后才允许写入 ready 证据。
        consumeCandidateRoomUpdateArm(runArguments.at(-1), result.changes);
        return result;
      };
    }
    if (sql.includes(yearWorkspaceLessonsSqlMarker)) {
      const originalAll = statement.all;
      statement.all = function yearWorkspaceAwareAll(...allArguments) {
        const rows = Reflect.apply(originalAll, this, allArguments);
        consumeYearWorkspaceSnapshotArm(rows, Number(allArguments[0]));
        return rows;
      };
    }
    if (sql.includes(yearWorkspacePlacementSqlMarker)) {
      const originalRun = statement.run;
      statement.run = function yearWorkspacePlacementAwareRun(...runArguments) {
        const result = Reflect.apply(originalRun, this, runArguments);
        consumeYearWorkspacePlacementArm(runArguments[1], runArguments[2], result.changes);
        return result;
      };
    }
    if (sql.includes(dataWorkspaceTeachersSqlMarker)) {
      const originalAll = statement.all;
      statement.all = function dataWorkspaceAwareAll(...allArguments) {
        consumeDataWorkspaceEntryArm();
        const rows = Reflect.apply(originalAll, this, allArguments);
        consumeDataWorkspaceSnapshotArm(rows);
        return rows;
      };
    }
    if (sql.includes(dataWorkspaceImportSqlMarker)) {
      const originalRun = statement.run;
      statement.run = function dataWorkspaceImportAwareRun(...runArguments) {
        const result = Reflect.apply(originalRun, this, runArguments);
        consumeDataWorkspaceImportArm(runArguments[0], result.changes);
        return result;
      };
    }
    if (sql.includes(courseWorkspaceSectionsSqlMarker)) {
      const originalAll = statement.all;
      statement.all = function courseWorkspaceAwareAll(...allArguments) {
        consumeCourseWorkspaceEntryArm(allArguments[0]);
        const rows = Reflect.apply(originalAll, this, allArguments);
        consumeCourseWorkspaceSnapshotArm(rows, allArguments[0]);
        return rows;
      };
    }
    if (sql.includes(courseWorkspaceSectionWriteSqlMarker)) {
      const originalRun = statement.run;
      statement.run = function courseWorkspaceSectionWriteAwareRun(...runArguments) {
        const result = Reflect.apply(originalRun, this, runArguments);
        consumeCourseWorkspaceSectionWriteArm(
          runArguments[0],
          runArguments[1],
          runArguments[2],
          result.changes,
        );
        return result;
      };
    }
    if (sql.includes(rulesWorkspaceWindowsSqlMarker)) {
      const originalAll = statement.all;
      statement.all = function rulesWorkspaceAwareAll(...allArguments) {
        consumeRulesWorkspaceEntryArm();
        const rows = Reflect.apply(originalAll, this, allArguments);
        consumeRulesWorkspaceSnapshotArm(rows);
        return rows;
      };
    }
    if (sql.includes(rulesWorkspaceRuleWriteSqlMarker)) {
      const originalRun = statement.run;
      statement.run = function rulesWorkspaceRuleWriteAwareRun(...runArguments) {
        const result = Reflect.apply(originalRun, this, runArguments);
        consumeRulesWorkspaceRuleWriteArm(runArguments, result.changes);
        return result;
      };
    }
    if (sql.includes(rulesWorkspaceWindowWriteSqlMarker)) {
      const originalRun = statement.run;
      const kind = sql.includes("teacher_unavailable_windows") ? "Teacher" : "Year";
      statement.run = function rulesWorkspaceWindowWriteAwareRun(...runArguments) {
        const result = Reflect.apply(originalRun, this, runArguments);
        consumeRulesWorkspaceWindowWriteArm(kind, runArguments, result.changes);
        return result;
      };
    }
    return statement;
  };
  Database.prototype.transaction = function testAwareTransaction(...argumentsList) {
    const transaction = originalTransaction.apply(this, argumentsList);
    // 四个 wrapper 都把调用者的 `this` 原样传给真实事务函数；测试同步点不能改变
    // better-sqlite3 事务回调原本能够读取的调用上下文。
    const variants = {
      default: function wrappedDefaultTransaction(...callArguments) {
        return Reflect.apply(transaction.default, this, callArguments);
      },
      deferred: function wrappedDeferredTransaction(...callArguments) {
        return Reflect.apply(transaction.deferred, this, callArguments);
      },
      immediate: function wrappedImmediateTransaction(...callArguments) {
        consumeWriterArm();
        return Reflect.apply(transaction.immediate, this, callArguments);
      },
      exclusive: function wrappedExclusiveTransaction(...callArguments) {
        return Reflect.apply(transaction.exclusive, this, callArguments);
      },
    };
    // better-sqlite3 把这些属性定义成不可配置，因此不能原地替换 immediate；
    // 为每个 variant 都补齐相同的交叉属性和 database，完整保留原公开 API 形状。
    for (const variant of Object.values(variants)) {
      Object.defineProperties(variant, {
        default: { value: variants.default },
        deferred: { value: variants.deferred },
        immediate: { value: variants.immediate },
        exclusive: { value: variants.exclusive },
        database: { value: transaction.database, enumerable: true },
      });
    }
    return variants.default;
  };
  return Database;
}

const originalModuleLoad = Module._load;
Module._load = function testAwareModuleLoad(request, parent, isMain) {
  // 只观察 better-sqlite3 的真实加载；其他 Node 或 Next.js 模块完全走原始加载器。
  const loaded = originalModuleLoad.call(this, request, parent, isMain);
  return request === "better-sqlite3" ? patchBetterSqlite3(loaded) : loaded;
};

function readValidArm(expectedBuffer) {
  // arm 不保存明文密码，只保存数据库中 64-byte Scrypt 结果的 SHA-256 指纹。
  // 指纹、随机 run token 和 nonce 都匹配时，才允许当前成功比较进入测试屏障。
  try {
    const control = JSON.parse(fs.readFileSync(armFile, "utf8"));
    if (!control || typeof control !== "object" || control.version !== 1) return null;
    if (control.runToken !== runToken || control.label !== processLabel) return null;
    if (typeof control.nonce !== "string" || !/^[a-f0-9]{32}$/.test(control.nonce)) return null;
    if (typeof control.expectedFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(control.expectedFingerprint)) return null;
    const actualFingerprint = crypto.createHash("sha256").update(expectedBuffer).digest("hex");
    return actualFingerprint === control.expectedFingerprint ? control : null;
  } catch {
    return null;
  }
}

crypto.timingSafeEqual = function testAwareTimingSafeEqual(...argumentsList) {
  // 先执行真实恒定时间比较。只有结果为 true、两端都是标准 64-byte 密码摘要，
  // 且 expected 端指纹命中已武装 arm 时，才消费一次性同步点。
  const passwordsMatch = originalTimingSafeEqual.apply(this, argumentsList);
  const [actualBuffer, expectedBuffer] = argumentsList;
  if (!passwordsMatch || !Buffer.isBuffer(actualBuffer) || !Buffer.isBuffer(expectedBuffer)
    || actualBuffer.length !== 64 || expectedBuffer.length !== 64) return passwordsMatch;
  const control = readValidArm(expectedBuffer);
  if (!control) return passwordsMatch;

  // rename 在同一临时目录内是原子的：成功后 arm 已被消费，ready 文件原样保留 nonce、
  // 指纹和 run token；第二个 timingSafeEqual 无法重复进入同一屏障。
  const readyFile = path.join(controlDirectory, `ready-${control.nonce}.json`);
  try {
    fs.renameSync(armFile, readyFile);
  } catch (error) {
    if (error && error.code === "ENOENT") return passwordsMatch;
    throw error;
  }

  // 复用统一 nonce 屏障；认证 ready 仍精确表示旧密码已经验证成功。
  const releaseFile = path.join(controlDirectory, `release-${control.nonce}.txt`);
  waitForRaceRelease(releaseFile, control.nonce, "authentication race");
  return passwordsMatch;
};
