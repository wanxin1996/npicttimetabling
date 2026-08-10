"use strict";

/* eslint-disable @typescript-eslint/no-require-imports -- Node 的 --require preload 必须使用 CommonJS。 */

const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");

// 这个 preload 只在规模性能回归中加载。严格校验随机 marker、临时数据库和报告路径，
// 防止普通 development／production 进程误启用测试计数器。
const exactTestMode = "timetabling-statement-reuse-audit-v1";
const testMode = process.env.TIMETABLING_STATEMENT_AUDIT_MODE;
const runToken = process.env.TIMETABLING_STATEMENT_AUDIT_TOKEN || "";
const databasePath = path.resolve(process.env.TIMETABLING_DATABASE_PATH || "");
const temporaryRoot = path.dirname(databasePath);
const reportPath = path.resolve(process.env.TIMETABLING_STATEMENT_AUDIT_REPORT || "");
const markerPath = path.join(temporaryRoot, "statement-audit.marker");
const systemTemporaryDirectory = path.resolve(os.tmpdir());

const rootHasExpectedName = path.basename(temporaryRoot).startsWith("timetabling-api-performance-");
const rootIsInsideSystemTemporaryDirectory = temporaryRoot.startsWith(`${systemTemporaryDirectory}${path.sep}`);
const databaseIsDirectChild = path.dirname(databasePath) === temporaryRoot;
const reportIsDirectChild = path.dirname(reportPath) === temporaryRoot
  && /^statement-audit-[a-z-]+\.json$/.test(path.basename(reportPath));
const tokenHasExpectedShape = /^[a-f0-9]{64}$/.test(runToken);
let markerMatches = false;
try {
  markerMatches = fs.readFileSync(markerPath, "utf8").trim() === runToken;
} catch {
  markerMatches = false;
}
if (testMode !== exactTestMode || !tokenHasExpectedShape || !rootHasExpectedName
  || !rootIsInsideSystemTemporaryDirectory || !databaseIsDirectChild || !reportIsDirectChild
  || !markerMatches) {
  throw new Error("Statement reuse audit preload refused to start outside its isolated performance run.");
}

const warningSqlMarker = "/* timetabling:placement-warning */";
const statementSources = new WeakMap();
const patchedStatementPrototypes = new WeakSet();
const counters = new Map();
let lastCounterJson = "";
let snapshotSequence = 0;

function normalizedSql(sql) {
  // 报告只保存去掉多余空白后的 SQL 模板，不记录任何绑定参数或真实业务资料。
  return sql.replace(/\s+/g, " ").trim();
}

function counterFor(source) {
  // 同一 SQL 在不同批次重新准备时合并统计，便于比较“编译次数”和“执行次数”的比例。
  let counter = counters.get(source);
  if (!counter) {
    counter = { source, prepares: 0, executions: 0 };
    counters.set(source, counter);
  }
  return counter;
}

function patchStatementPrototype(statement) {
  // better-sqlite3 的 Statement 方法在原型上。只 patch 一次，并用 WeakMap 判断当前
  // Statement 是否带 warning marker；其他登录、页面和测试 SQL 不参与计数。
  const prototype = Object.getPrototypeOf(statement);
  if (!prototype || patchedStatementPrototypes.has(prototype)) return;
  patchedStatementPrototypes.add(prototype);
  for (const methodName of ["get", "all", "run", "iterate"]) {
    const originalMethod = prototype[methodName];
    if (typeof originalMethod !== "function") continue;
    prototype[methodName] = function auditedStatementExecution(...argumentsList) {
      const source = statementSources.get(this);
      if (source) counterFor(source).executions += 1;
      return Reflect.apply(originalMethod, this, argumentsList);
    };
  }
}

function patchBetterSqlite3(Database) {
  // Standalone 可能加载追踪复制中的 better-sqlite3；拦截真实 require 结果，
  // 而不是假定它一定使用项目根 node_modules 的构造器。
  if (!Database?.prototype || Database.prototype.__timetablingStatementAuditPatched) return Database;
  const originalPrepare = Database.prototype.prepare;
  Object.defineProperty(Database.prototype, "__timetablingStatementAuditPatched", { value: true });
  Database.prototype.prepare = function auditedPrepare(sql, ...argumentsList) {
    const statement = Reflect.apply(originalPrepare, this, [sql, ...argumentsList]);
    patchStatementPrototype(statement);
    if (typeof sql === "string" && sql.includes(warningSqlMarker)) {
      const source = normalizedSql(sql);
      statementSources.set(statement, source);
      counterFor(source).prepares += 1;
    }
    return statement;
  };
  return Database;
}

const originalModuleLoad = Module._load;
Module._load = function statementAuditModuleLoad(request, parent, isMain) {
  // 只有 better-sqlite3 被包装；Next.js、认证和其他 Node 模块保持原始加载行为。
  const loaded = originalModuleLoad.call(this, request, parent, isMain);
  return request === "better-sqlite3" ? patchBetterSqlite3(loaded) : loaded;
};

function writeReport(force = false) {
  // 低频快照只在计数发生变化时写入，并通过同目录 rename 原子替换；主测试不会读到半截 JSON。
  // SQL 每次执行只增加内存计数，不做文件 I/O，因此不会把磁盘写入成本混进每条 warning 查询。
  const statements = [...counters.values()].sort((left, right) => left.source.localeCompare(right.source));
  const counterJson = JSON.stringify(statements);
  if (!force && counterJson === lastCounterJson) return;
  lastCounterJson = counterJson;
  snapshotSequence += 1;
  const reportJson = JSON.stringify({ version: 1, runToken, snapshotSequence, statements });
  const temporaryReportPath = `${reportPath}.tmp-${process.pid}`;
  fs.writeFileSync(temporaryReportPath, reportJson, { mode: 0o600 });
  fs.renameSync(temporaryReportPath, reportPath);
}

// 100ms 的 unref 定时器不会阻止服务退出；正常运行中持续留下最新完整报告，
// 因此无需接管 SIGTERM，也不会影响 Next.js 自己的优雅停止处理。
const reportTimer = setInterval(writeReport, 100);
reportTimer.unref();
process.on("SIGUSR2", () => writeReport(true));
process.once("exit", () => writeReport(true));
