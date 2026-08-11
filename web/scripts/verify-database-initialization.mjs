import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import Module, { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import ts from "typescript";

// 这项回归直接加载真实 database.ts，而不是使用 production build。
// 原因是 production 会移除开发 seed 分支；只有直接执行源码才能验证 seed 失败时
// 连接、事务和全局 schema 版本都保持干净。所有数据库都位于系统临时目录。
const projectRoot = process.cwd();
const databaseSourcePath = path.join(projectRoot, "src", "lib", "database.ts");
const nativeRequire = createRequire(import.meta.url);
const databaseSource = await readFile(databaseSourcePath, "utf8");
const schemaVersionMatch = databaseSource.match(/const runtimeSchemaVersion = (\d+);/);
assert(schemaVersionMatch, "database.ts did not expose a readable runtime schema version constant.");
const runtimeSchemaVersion = Number(schemaVersionMatch[1]);

function report(message) {
  // 每个故障边界完成后只输出一行，方便基础开发人员快速定位失败阶段。
  console.log(`✓ ${message}`);
}

function clearPublishedDatabase() {
  // 每个场景都要从完全空白的 globalThis 开始；若上一场景已成功发布连接，
  // 先真实关闭它，再删除两个开发热重载使用的全局字段。
  const published = globalThis.timetableDatabase;
  if (published?.open) published.close();
  delete globalThis.timetableDatabase;
  delete globalThis.timetableSchemaVersion;
}

function createTrackingDatabase(scenario) {
  const instances = [];
  const closeCounts = new WeakMap();

  class TrackingDatabase extends Database {
    constructor(...argumentsList) {
      super(...argumentsList);
      instances.push(this);
      closeCounts.set(this, 0);
    }

    exec(sql) {
      // 先执行真实 schema SQL，再只抛一次指定错误。这样测试会留下部分已提交 DDL，
      // 第二次调用必须依靠幂等初始化补齐，而不是面对一个从未打开过的空文件。
      const result = super.exec(sql);
      if (scenario.failInitializationOnce
        && typeof sql === "string"
        && sql.includes("/* timetabling:database-initialization */")) {
        scenario.failInitializationOnce = false;
        throw scenario.initializationError;
      }
      return result;
    }

    prepare(sql) {
      const statement = super.prepare(sql);
      if (!scenario.failSeedOnce
        || typeof sql !== "string"
        || !sql.startsWith("INSERT INTO teachers (id, name, staff_type)")) return statement;

      // seed 的第二位教师先真实写入事务，再抛错。若事务边界正确，连接关闭后
      // 重新读取 teachers／groups／rooms 都必须仍为0，而不是留下半套示例资料。
      const originalRun = statement.run;
      let teacherInsertCount = 0;
      statement.run = function seedFailureAwareRun(...argumentsList) {
        const result = Reflect.apply(originalRun, this, argumentsList);
        teacherInsertCount += 1;
        if (scenario.failSeedOnce && teacherInsertCount === 2) {
          scenario.failSeedOnce = false;
          throw scenario.seedError;
        }
        return result;
      };
      return statement;
    }

    close() {
      // 计数发生在真实 close 之前；断言还会检查 `.open === false`，因此只调用但未关闭
      // 不能让测试假通过。
      closeCounts.set(this, (closeCounts.get(this) || 0) + 1);
      return super.close();
    }
  }

  return {
    TrackingDatabase,
    instances,
    closeCount(database) {
      return closeCounts.get(database) || 0;
    },
  };
}

function loadDatabaseSource(TrackingDatabase) {
  // TypeScript 的 transpileModule 只移除类型并转成 CommonJS，不复制或改写业务逻辑。
  // 自定义 Module.require 仅把 better-sqlite3 换成可计数子类；Node 内置模块仍走真实实现。
  const transpiled = ts.transpileModule(databaseSource, {
    fileName: databaseSourcePath,
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    reportDiagnostics: true,
  });
  const errors = (transpiled.diagnostics || []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  assert.deepEqual(errors, [], "database.ts could not be transpiled for initialization verification.");

  const loadedModule = new Module(databaseSourcePath);
  loadedModule.filename = databaseSourcePath;
  loadedModule.paths = Module._nodeModulePaths(path.dirname(databaseSourcePath));
  loadedModule.require = (request) => {
    if (request === "better-sqlite3") return TrackingDatabase;
    // 本脚本只审计 database.ts 的连接发布与事务初始化，不测试部署 token。源码新增的
    // 健康配置依赖在这里提供最小开发态替身，避免 CommonJS 单文件转译器错误地从
    // scripts 目录解析相对 TypeScript 模块；真实 token 行为由 standalone CRUD 覆盖。
    if (request === "./auth-input") {
      return { administratorSetupConfigurationAvailable: () => true };
    }
    return nativeRequire(request);
  };
  loadedModule._compile(transpiled.outputText, databaseSourcePath);
  return loadedModule.exports;
}

function readCounts(databasePath) {
  // 独立只读连接检查刚失败或成功后的落盘状态，避免误读测试子类中的内存计数。
  const db = new Database(databasePath, { readonly: true });
  try {
    return {
      teachers: db.prepare("SELECT COUNT(*) AS count FROM teachers").get().count,
      studentGroups: db.prepare("SELECT COUNT(*) AS count FROM student_groups").get().count,
      rooms: db.prepare("SELECT COUNT(*) AS count FROM rooms").get().count,
      rules: db.prepare("SELECT COUNT(*) AS count FROM rule_settings").get().count,
    };
  } finally {
    db.close();
  }
}

function assertHealthyDatabase(databasePath) {
  // 成功重试必须得到结构完整、外键完整且索引补齐的数据库，不能只满足 SELECT 1。
  const db = new Database(databasePath, { readonly: true });
  try {
    assert.deepEqual(db.pragma("integrity_check"), [{ integrity_check: "ok" }]);
    assert.deepEqual(db.pragma("foreign_key_check"), []);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get("auth_sessions_user_id_idx").count,
      1,
    );
  } finally {
    db.close();
  }
}

async function withIsolatedDatabase(name, nodeEnvironment, callback) {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), `timetabling-db-init-${name}-`));
  const databasePath = path.join(temporaryDirectory, "test.sqlite");
  const previousDatabasePath = process.env.TIMETABLING_DATABASE_PATH;
  const previousRailwayPath = process.env.RAILWAY_VOLUME_MOUNT_PATH;
  const previousNodeEnvironment = process.env.NODE_ENV;
  clearPublishedDatabase();
  process.env.TIMETABLING_DATABASE_PATH = databasePath;
  delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
  process.env.NODE_ENV = nodeEnvironment;
  try {
    await callback(databasePath);
  } finally {
    clearPublishedDatabase();
    if (previousDatabasePath === undefined) delete process.env.TIMETABLING_DATABASE_PATH;
    else process.env.TIMETABLING_DATABASE_PATH = previousDatabasePath;
    if (previousRailwayPath === undefined) delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
    else process.env.RAILWAY_VOLUME_MOUNT_PATH = previousRailwayPath;
    if (previousNodeEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnvironment;
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

await withIsolatedDatabase("schema", "production", async (databasePath) => {
  const initializationError = new Error("forced fresh schema initialization failure");
  const scenario = { failInitializationOnce: true, initializationError, failSeedOnce: false };
  const tracking = createTrackingDatabase(scenario);
  const databaseModule = loadDatabaseSource(tracking.TrackingDatabase);

  assert.throws(() => databaseModule.databaseHealth(), (error) => error === initializationError);
  assert.equal(tracking.instances.length, 1);
  assert.equal(tracking.closeCount(tracking.instances[0]), 1);
  assert.equal(tracking.instances[0].open, false);
  assert.equal(globalThis.timetableDatabase, undefined);
  assert.equal(globalThis.timetableSchemaVersion, undefined);
  assert.deepEqual(readCounts(databasePath), { teachers: 0, studentGroups: 0, rooms: 0, rules: 0 });

  assert.equal(databaseModule.databaseHealth(), true);
  assert.equal(tracking.instances.length, 2);
  assert.equal(globalThis.timetableDatabase, tracking.instances[1]);
  assert.equal(globalThis.timetableSchemaVersion, runtimeSchemaVersion);
  assert.deepEqual(readCounts(databasePath), { teachers: 0, studentGroups: 0, rooms: 0, rules: 7 });
  assertHealthyDatabase(databasePath);
  assert.equal(databaseModule.databaseHealth(), true);
  assert.equal(tracking.instances.length, 2);
  report("fresh schema 初始化失败会关闭局部连接、保持全局未发布并幂等重试");
});

await withIsolatedDatabase("seed", "development", async (databasePath) => {
  const seedError = new Error("forced development seed failure");
  const scenario = { failInitializationOnce: false, failSeedOnce: true, seedError };
  const tracking = createTrackingDatabase(scenario);
  const databaseModule = loadDatabaseSource(tracking.TrackingDatabase);

  assert.throws(() => databaseModule.databaseHealth(), (error) => error === seedError);
  assert.equal(tracking.instances.length, 1);
  assert.equal(tracking.closeCount(tracking.instances[0]), 1);
  assert.equal(tracking.instances[0].open, false);
  assert.equal(globalThis.timetableDatabase, undefined);
  assert.equal(globalThis.timetableSchemaVersion, undefined);
  assert.deepEqual(readCounts(databasePath), { teachers: 0, studentGroups: 0, rooms: 0, rules: 7 });

  assert.equal(databaseModule.databaseHealth(), true);
  assert.equal(tracking.instances.length, 2);
  assert.equal(globalThis.timetableDatabase, tracking.instances[1]);
  assert.equal(globalThis.timetableSchemaVersion, runtimeSchemaVersion);
  assert.deepEqual(readCounts(databasePath), { teachers: 4, studentGroups: 4, rooms: 3, rules: 7 });
  assertHealthyDatabase(databasePath);
  report("development seed 中途失败会整体回滚、关闭连接并在重试后只写一套示例资料");
});

await withIsolatedDatabase("global", "production", async (databasePath) => {
  const migrationError = new Error("forced reused global migration failure");
  const scenario = { failInitializationOnce: false, failSeedOnce: false, initializationError: migrationError };
  const tracking = createTrackingDatabase(scenario);
  const databaseModule = loadDatabaseSource(tracking.TrackingDatabase);

  assert.equal(databaseModule.databaseHealth(), true);
  assert.equal(tracking.instances.length, 1);
  const publishedDatabase = tracking.instances[0];
  globalThis.timetableSchemaVersion = runtimeSchemaVersion - 1;
  scenario.failInitializationOnce = true;

  assert.throws(() => databaseModule.databaseHealth(), (error) => error === migrationError);
  assert.equal(tracking.instances.length, 1);
  assert.equal(tracking.closeCount(publishedDatabase), 0);
  assert.equal(publishedDatabase.open, true);
  assert.equal(globalThis.timetableDatabase, publishedDatabase);
  assert.equal(globalThis.timetableSchemaVersion, runtimeSchemaVersion - 1);

  assert.equal(databaseModule.databaseHealth(), true);
  assert.equal(tracking.instances.length, 1);
  assert.equal(globalThis.timetableDatabase, publishedDatabase);
  assert.equal(globalThis.timetableSchemaVersion, runtimeSchemaVersion);
  assert.equal(publishedDatabase.open, true);
  assertHealthyDatabase(databasePath);
  report("热重载迁移失败不会误关全局连接，旧版本保留并由同一连接重试");
});

console.log("Database initialization failure verification passed.");
