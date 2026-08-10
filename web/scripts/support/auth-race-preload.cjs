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
  Object.defineProperty(Database.prototype, "__timetablingRacePatched", { value: true });
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

  // release 文件内容必须精确等于本次随机 nonce，单纯创建同名文件不能解除暂停。
  // 二十秒上限确保主测试崩溃时 preload 不会永久挂起 Node 进程。
  const releaseFile = path.join(controlDirectory, `release-${control.nonce}.txt`);
  const deadline = Date.now() + 20_000;
  while (true) {
    try {
      if (fs.readFileSync(releaseFile, "utf8").trim() === control.nonce) break;
    } catch {
      // release 尚未建立属于预期状态，短暂休眠后再次检查。
    }
    if (Date.now() >= deadline) throw new Error("Timed out while waiting for the authentication race release nonce.");
    Atomics.wait(sleepBuffer, 0, 0, 25);
  }
  return passwordsMatch;
};
