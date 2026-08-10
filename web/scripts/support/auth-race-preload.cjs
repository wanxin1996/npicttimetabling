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
  // 只有 A 进程负责候选读取竞态。带 marker 的 Active rooms 查询已经完整返回后，
  // 原子建立 ready 并暂停，使主测试可以让 B 在同一时刻修改教室容量。
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

function consumeCandidateRoomUpdateArm(roomId, changes) {
  // B 的真实 UPDATE 已经在 IMMEDIATE 事务内改到目标教室后才建立 ready。
  // 此时 HTTP 若仍未返回，说明 A 的候选读快照正在阻止这笔修改提交。
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
    // 只包装三个 Statement marker：Candidate 首条读取、Active rooms 读取，以及本回归
    // 使用的教室 UPDATE。数据库初始化使用上方 exec marker，其余 SQL 保持透明。
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
