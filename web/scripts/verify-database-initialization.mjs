import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import Module, { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import ts from "typescript";

// 这项回归直接加载真实 database.ts，而不是使用 production build。
// 原因是 production 会移除开发 seed 分支；只有直接执行源码才能验证 seed 失败时
// 连接、事务和全局 schema 版本都保持干净。所有数据库都位于系统临时目录。
const projectRoot = process.cwd();
const databaseSourcePath = path.join(projectRoot, "src", "lib", "database.ts");
const masterDataInputSourcePath = path.join(projectRoot, "src", "lib", "master-data-input.ts");
const persistentStorageScriptPath = path.join(projectRoot, "scripts", "verify-persistent-storage.mjs");
const nativeRequire = createRequire(import.meta.url);
const databaseSource = await readFile(databaseSourcePath, "utf8");
const masterDataInputSource = await readFile(masterDataInputSourcePath, "utf8");
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

function loadMasterDataInputSource() {
  // database.ts 与生产路由共用资料长度和控制字符规则。初始化测试的单文件 CommonJS
  // 加载器也要编译这份真实 TypeScript 依赖，不能用一组可能随版本漂移的手写常量替身。
  const transpiled = ts.transpileModule(masterDataInputSource, {
    fileName: masterDataInputSourcePath,
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
  assert.deepEqual(errors, [], "master-data-input.ts could not be transpiled for initialization verification.");
  const loadedModule = new Module(masterDataInputSourcePath);
  loadedModule.filename = masterDataInputSourcePath;
  loadedModule.paths = Module._nodeModulePaths(path.dirname(masterDataInputSourcePath));
  loadedModule._compile(transpiled.outputText, masterDataInputSourcePath);
  return loadedModule.exports;
}

const masterDataInputModule = loadMasterDataInputSource();

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
    if (request === "./master-data-input") return masterDataInputModule;
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

const legacyFixtureIds = {
  teacher: "legacy-teacher-stable-id",
  studentGroup: "legacy-group-stable-id",
  room: "legacy-room-stable-id",
  course: "legacy-course-stable-id",
  allocation: "legacy-allocation-stable-id",
  section: "legacy-section-stable-id",
  lesson: "legacy-lesson-stable-id",
};

function createLegacyMasterDataFixture(databasePath) {
  // 这份夹具刻意使用 master-data revision 上线前的真实表形状：教师、班级和
  // 教室没有 revision，教师也没有 Teaching Members 来源键。课程、分配、班次、
  // 班级关联和已排课次组成一条完整外键链，用来证明 ALTER 不只是“列出现了”，
  // 还保留了生产旧库中的稳定 ID、文字、时间戳和所有既有关系。
  const db = new Database(databasePath);
  try {
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE teachers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        staff_type TEXT NOT NULL CHECK (staff_type IN ('FT', 'PT')),
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE student_groups (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        year INTEGER NOT NULL CHECK (year IN (1, 2, 3)),
        program TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE rooms (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        block TEXT,
        capacity INTEGER NOT NULL CHECK (capacity > 0),
        has_multi_projector INTEGER NOT NULL DEFAULT 0,
        is_lab INTEGER NOT NULL DEFAULT 0,
        is_smart_classroom INTEGER NOT NULL DEFAULT 0,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE courses (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        catalog TEXT,
        duration_hours INTEGER,
        sessions_per_week INTEGER NOT NULL DEFAULT 1 CHECK (sessions_per_week > 0),
        primary_year INTEGER CHECK (primary_year IN (1, 2, 3)),
        minimum_room_capacity INTEGER,
        requires_lab INTEGER NOT NULL DEFAULT 0,
        requires_multi_projector INTEGER NOT NULL DEFAULT 0,
        requires_smart_classroom INTEGER NOT NULL DEFAULT 0,
        separate_sections_across_days INTEGER NOT NULL DEFAULT 0,
        week_pattern TEXT NOT NULL DEFAULT 'ALL' CHECK (week_pattern IN ('ALL', 'W1_4', 'W5_8')),
        week_start INTEGER CHECK (week_start IS NULL OR week_start >= 1),
        week_end INTEGER CHECK (week_end IS NULL OR week_end >= 1),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        revision INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE teaching_allocations (
        id TEXT PRIMARY KEY,
        course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
        teacher_id TEXT NOT NULL REFERENCES teachers(id) ON DELETE RESTRICT,
        assigned_group_count INTEGER NOT NULL CHECK (assigned_group_count > 0),
        UNIQUE(course_id, teacher_id)
      );
      CREATE TABLE course_sections (
        id TEXT PRIMARY KEY,
        course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        teacher_id TEXT REFERENCES teachers(id) ON DELETE SET NULL,
        allocation_teacher_id TEXT REFERENCES teachers(id) ON DELETE SET NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        UNIQUE(course_id, sequence)
      );
      CREATE TABLE section_student_groups (
        section_id TEXT NOT NULL REFERENCES course_sections(id) ON DELETE CASCADE,
        student_group_id TEXT NOT NULL REFERENCES student_groups(id) ON DELETE CASCADE,
        PRIMARY KEY (section_id, student_group_id)
      );
      CREATE TABLE scheduled_lessons (
        id TEXT PRIMARY KEY,
        section_id TEXT NOT NULL REFERENCES course_sections(id) ON DELETE CASCADE,
        occurrence INTEGER NOT NULL DEFAULT 1,
        day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 1 AND 5),
        start_hour INTEGER NOT NULL CHECK (start_hour BETWEEN 8 AND 17),
        duration_hours INTEGER NOT NULL CHECK (duration_hours BETWEEN 1 AND 4),
        room_id TEXT REFERENCES rooms(id) ON DELETE SET NULL,
        warnings_json TEXT NOT NULL DEFAULT '[]',
        revision INTEGER NOT NULL DEFAULT 1,
        UNIQUE(section_id, occurrence)
      );
    `);
    const insert = db.transaction(() => {
      db.prepare(`INSERT INTO teachers
        (id, name, staff_type, is_active, created_at, updated_at)
        VALUES (?, 'LEGACY LECTURER', 'FT', 1, '2025-01-02T03:04:05.000Z', '2025-02-03T04:05:06.000Z')`).run(legacyFixtureIds.teacher);
      db.prepare(`INSERT INTO student_groups
        (id, code, year, program, created_at, updated_at)
        VALUES (?, 'LEGACY_01', 2, 'LEGACY', '2025-01-03T03:04:05.000Z', '2025-02-04T04:05:06.000Z')`).run(legacyFixtureIds.studentGroup);
      db.prepare(`INSERT INTO rooms
        (id, code, block, capacity, has_multi_projector, is_lab, is_smart_classroom, is_active, created_at, updated_at)
        VALUES (?, '88-02-03', '88', 45, 1, 1, 0, 1, '2025-01-04T03:04:05.000Z', '2025-02-05T04:05:06.000Z')`).run(legacyFixtureIds.room);
      db.prepare(`INSERT INTO courses
        (id, code, catalog, duration_hours, sessions_per_week, primary_year,
          minimum_room_capacity, requires_lab, requires_multi_projector,
          requires_smart_classroom, separate_sections_across_days, week_pattern,
          week_start, week_end, created_at, updated_at, revision)
        VALUES (?, 'LEGACY101', 'Legacy Catalog', 2, 1, 2, 30, 1, 1, 0, 0,
          'ALL', NULL, NULL, '2025-01-05T03:04:05.000Z', '2025-02-06T04:05:06.000Z', 1)`).run(legacyFixtureIds.course);
      db.prepare("INSERT INTO teaching_allocations (id, course_id, teacher_id, assigned_group_count) VALUES (?, ?, ?, 1)")
        .run(legacyFixtureIds.allocation, legacyFixtureIds.course, legacyFixtureIds.teacher);
      db.prepare(`INSERT INTO course_sections
        (id, course_id, sequence, teacher_id, allocation_teacher_id, revision)
        VALUES (?, ?, 1, ?, ?, 1)`).run(legacyFixtureIds.section, legacyFixtureIds.course, legacyFixtureIds.teacher, legacyFixtureIds.teacher);
      db.prepare("INSERT INTO section_student_groups (section_id, student_group_id) VALUES (?, ?)")
        .run(legacyFixtureIds.section, legacyFixtureIds.studentGroup);
      db.prepare(`INSERT INTO scheduled_lessons
        (id, section_id, occurrence, day_of_week, start_hour, duration_hours, room_id, warnings_json, revision)
        VALUES (?, ?, 1, 2, 10, 2, ?, '[]', 1)`).run(legacyFixtureIds.lesson, legacyFixtureIds.section, legacyFixtureIds.room);
    });
    insert.immediate();
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally {
    db.close();
  }
}

function readLegacyOriginalState(databasePath) {
  // 迁移前后都可读取的旧字段用明确列清单比较；新增列不参与这份快照，避免测试
  // 因 SELECT * 的物理列顺序不同而误报，同时逐字段锁定所有旧业务资料。
  const db = new Database(databasePath, { readonly: true });
  try {
    return {
      teachers: db.prepare("SELECT id, name, staff_type, is_active, created_at, updated_at FROM teachers ORDER BY id").all(),
      studentGroups: db.prepare("SELECT id, code, year, program, created_at, updated_at FROM student_groups ORDER BY id").all(),
      rooms: db.prepare(`SELECT id, code, block, capacity, has_multi_projector, is_lab,
        is_smart_classroom, is_active, created_at, updated_at FROM rooms ORDER BY id`).all(),
      courses: db.prepare("SELECT * FROM courses ORDER BY id").all(),
      allocations: db.prepare("SELECT * FROM teaching_allocations ORDER BY id").all(),
      sections: db.prepare("SELECT * FROM course_sections ORDER BY id").all(),
      sectionGroups: db.prepare("SELECT * FROM section_student_groups ORDER BY section_id, student_group_id").all(),
      lessons: db.prepare("SELECT * FROM scheduled_lessons ORDER BY id").all(),
    };
  } finally {
    db.close();
  }
}

function readMigratedLegacyState(databasePath) {
  // 第二次初始化必须是真正 no-op。把新增字段、七条规则和完整旧关联一起纳入快照，
  // 可发现重复迁移重写 timestamp、revision、来源键或关系的任何回归。
  const db = new Database(databasePath, { readonly: true });
  try {
    return {
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
      rules: db.prepare("SELECT * FROM rule_settings ORDER BY rule_key").all(),
      scheduleBackups: db.prepare("SELECT * FROM schedule_backups ORDER BY created_at, id").all(),
      appUsers: db.prepare("SELECT * FROM app_users ORDER BY id").all(),
      authSessions: db.prepare("SELECT * FROM auth_sessions ORDER BY token_hash").all(),
    };
  } finally {
    db.close();
  }
}

function assertTeachingMembersSourceIndex(databasePath) {
  // 只检查索引名称不够；旧库里可能残留同名但非唯一或指向错误列的索引。
  const db = new Database(databasePath, { readonly: true });
  try {
    const index = db.prepare("PRAGMA index_list(teachers)").all()
      .find((candidate) => candidate.name === "teachers_teaching_members_key_key");
    assert(index, "Teaching Members source-key index was not created during legacy migration.");
    assert.equal(index.unique, 1);
    assert.deepEqual(
      db.prepare("PRAGMA index_info(teachers_teaching_members_key_key)").all().map((column) => column.name),
      ["teaching_members_key"],
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

async function verifyPersistentStorageBoundary() {
  // 启动检查必须在一个全新 Node 进程中执行，因为脚本会直接读取环境变量。
  // 全部路径都位于同一个系统临时根，测试绝不会创建或探测正式数据库目录。
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "timetabling-storage-check-"));
  const volumeDirectory = path.join(temporaryDirectory, "volume");
  const outsideDirectory = path.join(temporaryDirectory, "ephemeral-container");
  const cleanEnvironment = { ...process.env, NODE_ENV: "production" };
  delete cleanEnvironment.RAILWAY_ENVIRONMENT;
  delete cleanEnvironment.RAILWAY_SERVICE_ID;
  delete cleanEnvironment.RAILWAY_VOLUME_MOUNT_PATH;
  delete cleanEnvironment.TIMETABLING_DATABASE_PATH;

  function runStorageCheck(environment) {
    return spawnSync(process.execPath, [persistentStorageScriptPath], {
      cwd: projectRoot,
      encoding: "utf8",
      env: { ...cleanEnvironment, ...environment },
    });
  }

  try {
    const localResult = runStorageCheck({
      TIMETABLING_DATABASE_PATH: path.join(temporaryDirectory, "local", "test.sqlite"),
    });
    assert.equal(localResult.status, 0, localResult.stderr);

    const missingVolumeResult = runStorageCheck({
      RAILWAY_ENVIRONMENT: "production",
      TIMETABLING_DATABASE_PATH: path.join(outsideDirectory, "test.sqlite"),
    });
    assert.notEqual(missingVolumeResult.status, 0);
    assert.match(missingVolumeResult.stderr, /persistent volume is missing/i);

    const absentMountResult = runStorageCheck({
      RAILWAY_ENVIRONMENT: "production",
      RAILWAY_VOLUME_MOUNT_PATH: volumeDirectory,
    });
    assert.notEqual(absentMountResult.status, 0);
    assert.match(absentMountResult.stderr, /volume path is unavailable/i);

    await mkdir(volumeDirectory, { recursive: true });
    const outsideVolumeResult = runStorageCheck({
      RAILWAY_ENVIRONMENT: "production",
      RAILWAY_VOLUME_MOUNT_PATH: volumeDirectory,
      TIMETABLING_DATABASE_PATH: path.join(outsideDirectory, "test.sqlite"),
    });
    assert.notEqual(outsideVolumeResult.status, 0);
    assert.match(outsideVolumeResult.stderr, /must stay inside/i);

    const danglingLinkPath = path.join(volumeDirectory, "linked.sqlite");
    await symlink(path.join(outsideDirectory, "created-after-check.sqlite"), danglingLinkPath);
    const danglingLinkResult = runStorageCheck({
      RAILWAY_ENVIRONMENT: "production",
      RAILWAY_VOLUME_MOUNT_PATH: volumeDirectory,
      TIMETABLING_DATABASE_PATH: danglingLinkPath,
    });
    assert.notEqual(danglingLinkResult.status, 0);
    assert.match(danglingLinkResult.stderr, /must not be a symbolic link/i);

    await mkdir(outsideDirectory, { recursive: true });
    const directoryLinkPath = path.join(volumeDirectory, "escape");
    await symlink(outsideDirectory, directoryLinkPath);
    const escapedSubdirectory = path.join(outsideDirectory, "must-not-be-created");
    const directoryLinkResult = runStorageCheck({
      RAILWAY_ENVIRONMENT: "production",
      RAILWAY_VOLUME_MOUNT_PATH: volumeDirectory,
      TIMETABLING_DATABASE_PATH: path.join(directoryLinkPath, "must-not-be-created", "test.sqlite"),
    });
    assert.notEqual(directoryLinkResult.status, 0);
    assert.match(directoryLinkResult.stderr, /directory resolves outside/i);
    await assert.rejects(access(escapedSubdirectory));

    const defaultVolumeResult = runStorageCheck({
      RAILWAY_ENVIRONMENT: "production",
      RAILWAY_VOLUME_MOUNT_PATH: volumeDirectory,
    });
    assert.equal(defaultVolumeResult.status, 0, defaultVolumeResult.stderr);

    const insideVolumeResult = runStorageCheck({
      RAILWAY_ENVIRONMENT: "production",
      RAILWAY_VOLUME_MOUNT_PATH: volumeDirectory,
      TIMETABLING_DATABASE_PATH: path.join(volumeDirectory, "sqlite", "test.sqlite"),
    });
    assert.equal(insideVolumeResult.status, 0, insideVolumeResult.stderr);
    assert.match(insideVolumeResult.stdout, /storage is writable/i);
    report("Railway 缺卷或卷外数据库路径会拒绝启动，卷内路径可正常通过");
  } finally {
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

await withIsolatedDatabase("legacy-master-data", "production", async (databasePath) => {
  createLegacyMasterDataFixture(databasePath);
  const legacyStateBeforeMigration = readLegacyOriginalState(databasePath);
  const beforeColumns = new Database(databasePath, { readonly: true });
  try {
    assert(!beforeColumns.prepare("PRAGMA table_info(teachers)").all().some((column) => column.name === "revision"));
    assert(!beforeColumns.prepare("PRAGMA table_info(teachers)").all().some((column) => column.name === "teaching_members_key"));
    assert(!beforeColumns.prepare("PRAGMA table_info(student_groups)").all().some((column) => column.name === "revision"));
    assert(!beforeColumns.prepare("PRAGMA table_info(rooms)").all().some((column) => column.name === "revision"));
  } finally {
    beforeColumns.close();
  }

  const scenario = { failInitializationOnce: false, failSeedOnce: false };
  const tracking = createTrackingDatabase(scenario);
  const databaseModule = loadDatabaseSource(tracking.TrackingDatabase);
  assert.equal(databaseModule.databaseHealth(), true);
  assert.equal(tracking.instances.length, 1);
  assert.equal(globalThis.timetableSchemaVersion, runtimeSchemaVersion);

  // ALTER 必须逐字段保留旧资料；三个新增 revision 都从1开始，历史教师来源保持
  // NULL，等待未来同名 Teaching Members 行显式认领，不能在迁移时猜测来源。
  assert.deepEqual(readLegacyOriginalState(databasePath), legacyStateBeforeMigration);
  const migratedDatabase = new Database(databasePath, { readonly: true });
  try {
    assert.deepEqual(
      migratedDatabase.prepare("SELECT id, revision, teaching_members_key FROM teachers ORDER BY id").all(),
      [{ id: legacyFixtureIds.teacher, revision: 1, teaching_members_key: null }],
    );
    assert.deepEqual(
      migratedDatabase.prepare("SELECT id, revision FROM student_groups ORDER BY id").all(),
      [{ id: legacyFixtureIds.studentGroup, revision: 1 }],
    );
    assert.deepEqual(
      migratedDatabase.prepare("SELECT id, revision FROM rooms ORDER BY id").all(),
      [{ id: legacyFixtureIds.room, revision: 1 }],
    );
    assert.deepEqual(migratedDatabase.pragma("foreign_key_check"), []);
  } finally {
    migratedDatabase.close();
  }
  assertTeachingMembersSourceIndex(databasePath);
  assertHealthyDatabase(databasePath);

  // 模拟开发热重载看到旧 schema version：同一连接会再执行完整 initializeTables。
  // 第二次运行必须完全幂等，不能新增连接、提高 revision、认领来源键或改写旧关系。
  const stateAfterFirstMigration = readMigratedLegacyState(databasePath);
  globalThis.timetableSchemaVersion = runtimeSchemaVersion - 1;
  assert.equal(databaseModule.databaseHealth(), true);
  assert.equal(tracking.instances.length, 1);
  assert.equal(globalThis.timetableSchemaVersion, runtimeSchemaVersion);
  assert.deepEqual(readMigratedLegacyState(databasePath), stateAfterFirstMigration);
  assertTeachingMembersSourceIndex(databasePath);

  // 真实业务查询必须能沿旧稳定 ID 读取 allocation、section、学生班级和教室关系；
  // 这比只检查 PRAGMA 列更能发现迁移后 ORM/API 读取形状不兼容的问题。
  assert.deepEqual(databaseModule.listTeachers(), [{
    id: legacyFixtureIds.teacher,
    revision: 1,
    name: "LEGACY LECTURER",
    staffType: "FT",
    status: "Active",
    sections: 1,
  }]);
  assert.deepEqual(databaseModule.listStudentGroups(), [{
    id: legacyFixtureIds.studentGroup,
    revision: 1,
    code: "LEGACY_01",
    year: 2,
    program: "LEGACY",
  }]);
  assert.deepEqual(databaseModule.listRooms(), [{
    id: legacyFixtureIds.room,
    revision: 1,
    code: "88-02-03",
    capacity: 45,
    features: ["Lab", "Multi projector"],
    status: "Active",
  }]);
  const legacyCourse = databaseModule.listCourses().find((course) => course.id === legacyFixtureIds.course);
  assert(legacyCourse);
  assert.deepEqual({
    code: legacyCourse.code,
    revision: legacyCourse.revision,
    allocatedSections: legacyCourse.allocatedSections,
    configuredSections: legacyCourse.configuredSections,
    scheduledLessons: legacyCourse.scheduledLessons,
    allocationVarianceCount: legacyCourse.allocationVarianceCount,
  }, {
    code: "LEGACY101",
    revision: 1,
    allocatedSections: 1,
    configuredSections: 1,
    scheduledLessons: 1,
    allocationVarianceCount: 0,
  });
  const legacyLesson = databaseModule.listScheduledLessons(2).find((lesson) => lesson.id === legacyFixtureIds.lesson);
  assert(legacyLesson);
  assert.equal(legacyLesson.sectionId, legacyFixtureIds.section);
  assert.equal(legacyLesson.teacherId, legacyFixtureIds.teacher);
  assert.equal(legacyLesson.roomId, legacyFixtureIds.room);
  assert.deepEqual(legacyLesson.studentGroupIds, [legacyFixtureIds.studentGroup]);

  // Route Handler 已经验证 JSON，但维护脚本、未来 job 或另一个 server module 可以直接
  // 调用 database export。下面从真实 CommonJS 转译模块越过 route，逐项证明 DB 边界
  // 自己仍拒绝宽松类型、异常 ID 和不安全整数；每次异常后都比较全部业务表，避免
  // “抛了 typed error、却已先写一半”的假保护。
  const directBoundarySnapshot = readMigratedLegacyState(databasePath);
  function expectDirectInputFailure(runOperation, ErrorConstructor, expectedMessage, label) {
    let caught;
    try {
      runOperation();
    } catch (error) {
      caught = error;
    }
    assert(caught, `${label} did not reject invalid direct database input.`);
    assert(caught instanceof ErrorConstructor, `${label} threw ${caught?.constructor?.name || typeof caught} instead of ${ErrorConstructor.name}.`);
    assert.equal(caught.message, expectedMessage, `${label} returned the wrong typed input error.`);
    assert.deepEqual(readMigratedLegacyState(databasePath), directBoundarySnapshot, `${label} changed business data before rejecting input.`);
  }

  const manualCourseError = "Use a course code, optional catalog and a section count from 1 to 999.";
  const invalidManualCourses = [
    null,
    [],
    { code: 123, catalog: null, sectionCount: 1 },
    { code: "DIRECT_STRING_SECTION", catalog: null, sectionCount: "2" },
    { code: "DIRECT_FRACTION_SECTION", catalog: null, sectionCount: 1.5 },
    { code: "DIRECT_LARGE_SECTION", catalog: null, sectionCount: 1_000 },
    { code: "DIRECT_UNSAFE_SECTION", catalog: null, sectionCount: Number.MAX_SAFE_INTEGER + 1 },
  ];
  for (const [index, input] of invalidManualCourses.entries()) {
    expectDirectInputFailure(
      () => databaseModule.createManualCourse(input),
      databaseModule.ManualCourseInputError,
      manualCourseError,
      `createManualCourse invalid case ${index + 1}`,
    );
  }

  const validSectionAssignment = {
    teacherId: legacyFixtureIds.teacher,
    studentGroupIds: [legacyFixtureIds.studentGroup],
    revision: 1,
  };
  const sectionInputError = "Teacher, student groups and revision are invalid.";
  const opaqueIdFailures = ["", "CONTROL\nID", "I".repeat(129)];
  for (const invalidId of opaqueIdFailures) {
    expectDirectInputFailure(
      () => databaseModule.updateCourseSection(invalidId, validSectionAssignment),
      databaseModule.CourseSectionInputError,
      "Section id is invalid.",
      `updateCourseSection invalid id ${JSON.stringify(invalidId.slice(0, 16))}`,
    );
  }
  const tooManyGroupIds = Array.from({ length: 1_000 }, (_, index) => `direct-group-${index}`);
  const invalidSectionAssignments = [
    null,
    { ...validSectionAssignment, teacherId: "" },
    { ...validSectionAssignment, teacherId: "TEACHER\nCONTROL" },
    { ...validSectionAssignment, teacherId: "T".repeat(129) },
    { ...validSectionAssignment, studentGroupIds: "not-an-array" },
    { ...validSectionAssignment, studentGroupIds: [legacyFixtureIds.studentGroup, legacyFixtureIds.studentGroup] },
    { ...validSectionAssignment, studentGroupIds: tooManyGroupIds },
    { ...validSectionAssignment, revision: 1.5 },
    { ...validSectionAssignment, revision: Number.MAX_SAFE_INTEGER + 1 },
  ];
  for (const [index, input] of invalidSectionAssignments.entries()) {
    expectDirectInputFailure(
      () => databaseModule.updateCourseSection(legacyFixtureIds.section, input),
      databaseModule.CourseSectionInputError,
      sectionInputError,
      `updateCourseSection invalid assignment ${index + 1}`,
    );
  }

  const validPlacement = {
    sectionId: legacyFixtureIds.section,
    occurrence: 1,
    dayOfWeek: 2,
    startHour: 10,
    roomId: legacyFixtureIds.room,
  };
  const placementInputError = "Section, weekly session, day, start hour and room are invalid.";
  const invalidPlacements = [
    null,
    ...opaqueIdFailures.map((sectionId) => ({ ...validPlacement, sectionId })),
    { ...validPlacement, occurrence: "1" },
    { ...validPlacement, occurrence: 1.5 },
    { ...validPlacement, occurrence: Number.MAX_SAFE_INTEGER + 1 },
    { ...validPlacement, dayOfWeek: 2.5 },
    { ...validPlacement, dayOfWeek: Number.MAX_SAFE_INTEGER + 1 },
    { ...validPlacement, startHour: 10.5 },
    { ...validPlacement, startHour: Number.MAX_SAFE_INTEGER + 1 },
    { ...validPlacement, roomId: "" },
    { ...validPlacement, roomId: "ROOM\nCONTROL" },
    { ...validPlacement, roomId: "R".repeat(129) },
  ];
  for (const [index, input] of invalidPlacements.entries()) {
    expectDirectInputFailure(
      () => databaseModule.placeScheduledLesson(input),
      databaseModule.ScheduledLessonPlacementInputError,
      placementInputError,
      `placeScheduledLesson invalid input ${index + 1}`,
    );
  }

  const validLessonUpdate = {
    dayOfWeek: 2,
    startHour: 10,
    roomId: legacyFixtureIds.room,
    teacherId: legacyFixtureIds.teacher,
    studentGroupIds: [legacyFixtureIds.studentGroup],
    revision: 1,
  };
  const lessonUpdateInputError = "Day, start hour, teacher, room, student groups and revision are invalid.";
  for (const invalidId of opaqueIdFailures) {
    expectDirectInputFailure(
      () => databaseModule.updateScheduledLesson(invalidId, validLessonUpdate),
      databaseModule.ScheduledLessonUpdateInputError,
      "Lesson id is invalid.",
      `updateScheduledLesson invalid id ${JSON.stringify(invalidId.slice(0, 16))}`,
    );
  }
  const invalidLessonUpdates = [
    null,
    { ...validLessonUpdate, dayOfWeek: "2" },
    { ...validLessonUpdate, dayOfWeek: 2.5 },
    { ...validLessonUpdate, dayOfWeek: Number.MAX_SAFE_INTEGER + 1 },
    { ...validLessonUpdate, startHour: 10.5 },
    { ...validLessonUpdate, startHour: Number.MAX_SAFE_INTEGER + 1 },
    { ...validLessonUpdate, roomId: "" },
    { ...validLessonUpdate, roomId: "ROOM\nCONTROL" },
    { ...validLessonUpdate, roomId: "R".repeat(129) },
    { ...validLessonUpdate, teacherId: "" },
    { ...validLessonUpdate, teacherId: "TEACHER\nCONTROL" },
    { ...validLessonUpdate, teacherId: "T".repeat(129) },
    { ...validLessonUpdate, studentGroupIds: "not-an-array" },
    { ...validLessonUpdate, studentGroupIds: [legacyFixtureIds.studentGroup, legacyFixtureIds.studentGroup] },
    { ...validLessonUpdate, studentGroupIds: tooManyGroupIds },
    { ...validLessonUpdate, revision: 1.5 },
    { ...validLessonUpdate, revision: Number.MAX_SAFE_INTEGER + 1 },
  ];
  for (const [index, input] of invalidLessonUpdates.entries()) {
    expectDirectInputFailure(
      () => databaseModule.updateScheduledLesson(legacyFixtureIds.lesson, input),
      databaseModule.ScheduledLessonUpdateInputError,
      lessonUpdateInputError,
      `updateScheduledLesson invalid input ${index + 1}`,
    );
  }

  for (const invalidId of opaqueIdFailures) {
    expectDirectInputFailure(
      () => databaseModule.removeScheduledLesson(invalidId, 1),
      databaseModule.ScheduledLessonUpdateInputError,
      "Lesson id and revision are invalid.",
      `removeScheduledLesson invalid id ${JSON.stringify(invalidId.slice(0, 16))}`,
    );
  }
  for (const invalidRevision of ["1", 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    expectDirectInputFailure(
      () => databaseModule.removeScheduledLesson(legacyFixtureIds.lesson, invalidRevision),
      databaseModule.ScheduledLessonUpdateInputError,
      "Lesson id and revision are invalid.",
      `removeScheduledLesson invalid revision ${String(invalidRevision)}`,
    );
  }
  report("database exports 直调严格类型／ID／数量边界均以 typed error 零写入拒绝");

  // 在另一门未排课程上导入同一旧教师，验证 name + NULL key 的认领路径复用稳定 ID；
  // 只写隐藏来源键不提高教师 revision 或 updated_at。完全相同的第二次导入也必须 no-op。
  const importRows = [{
    mod: "LEGACY102",
    catalog: "Post-migration Import",
    lecturer: "LEGACY LECTURER",
    staffType: "FT",
    groupCount: 1,
  }];
  const firstImport = databaseModule.importTeachingMembers(importRows, 0);
  assert.deepEqual(firstImport, {
    courses: 1,
    teachers: 1,
    allocations: 1,
    sections: 1,
    zeroAllocationRows: 0,
    ignoredZeroRows: 0,
  });
  const afterImport = new Database(databasePath, { readonly: true });
  try {
    assert.deepEqual(
      afterImport.prepare("SELECT id, revision, teaching_members_key, updated_at FROM teachers WHERE id = ?")
        .get(legacyFixtureIds.teacher),
      {
        id: legacyFixtureIds.teacher,
        revision: 1,
        teaching_members_key: "LEGACY LECTURER",
        updated_at: "2025-02-03T04:05:06.000Z",
      },
    );
    const importedCourse = afterImport.prepare("SELECT id, revision FROM courses WHERE code = 'LEGACY102'").get();
    assert(importedCourse);
    assert.equal(importedCourse.revision, 1);
    assert.equal(
      afterImport.prepare("SELECT teacher_id FROM teaching_allocations WHERE course_id = ?").get(importedCourse.id).teacher_id,
      legacyFixtureIds.teacher,
    );
    assert.equal(
      afterImport.prepare("SELECT teacher_id FROM course_sections WHERE course_id = ?").get(importedCourse.id).teacher_id,
      legacyFixtureIds.teacher,
    );
  } finally {
    afterImport.close();
  }
  const stateAfterFirstImport = readMigratedLegacyState(databasePath);
  assert.deepEqual(databaseModule.importTeachingMembers(importRows, 0), firstImport);
  assert.deepEqual(readMigratedLegacyState(databasePath), stateAfterFirstImport);

  // 完整备份会执行 integrity、FK、业务 invariant、在线复制与会话脱敏。它成功读取
  // legacy 关系并在副本中保留稳定 ID，证明升级结果不仅可 list/import，也可发布备份。
  databaseModule.createInitialAdmin("legacy-admin", "LegacyBackup123!");
  const verifiedBackup = await databaseModule.createVerifiedSystemBackup();
  assert.match(verifiedBackup.filename, /^timetabling-backup-.*\.sqlite$/);
  const backupDatabase = new Database(verifiedBackup.contents, { readonly: true });
  try {
    assert.deepEqual(backupDatabase.pragma("integrity_check"), [{ integrity_check: "ok" }]);
    assert.deepEqual(backupDatabase.pragma("foreign_key_check"), []);
    assert.equal(backupDatabase.prepare("SELECT COUNT(*) AS count FROM auth_sessions").get().count, 0);
    assert.equal(
      backupDatabase.prepare("SELECT teaching_members_key FROM teachers WHERE id = ?").get(legacyFixtureIds.teacher).teaching_members_key,
      "LEGACY LECTURER",
    );
    assert.equal(
      backupDatabase.prepare("SELECT teacher_id FROM course_sections WHERE id = ?").get(legacyFixtureIds.section).teacher_id,
      legacyFixtureIds.teacher,
    );
    assert.equal(
      backupDatabase.prepare("SELECT student_group_id FROM section_student_groups WHERE section_id = ?").get(legacyFixtureIds.section).student_group_id,
      legacyFixtureIds.studentGroup,
    );
    assert.equal(
      backupDatabase.prepare("SELECT room_id FROM scheduled_lessons WHERE id = ?").get(legacyFixtureIds.lesson).room_id,
      legacyFixtureIds.room,
    );
  } finally {
    backupDatabase.close();
  }
  report("旧 master-data schema 原位升级保留资料关系、来源索引且二次幂等，list/import/backup 可用");
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

await verifyPersistentStorageBoundary();

console.log("Database initialization failure verification passed.");
