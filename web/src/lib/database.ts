import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

// 下面这些类型描述数据库发送给浏览器的简化数据结构。
// 字段名刻意使用业务人员容易理解的名称，避免前端代码直接依赖 SQLite 的底层列名。
export type TeacherRecord = {
  id: string;
  name: string;
  staffType: "FT" | "PT";
  status: "Active" | "Inactive";
  sections: number;
};

export type StudentGroupRecord = {
  id: string;
  code: string;
  year: number;
  program: string;
};

export type RoomRecord = {
  id: string;
  code: string;
  capacity: number;
  features: string[];
  status: "Active" | "Inactive";
};

export type CourseRecord = {
  id: string;
  code: string;
  catalog: string | null;
  revision: number;
  durationHours: number | null;
  sessionsPerWeek: number;
  primaryYear: number | null;
  minimumRoomCapacity: number | null;
  requiresLab: boolean;
  requiresMultiProjector: boolean;
  requiresSmartClassroom: boolean;
  separateSectionsAcrossDays: boolean;
  weekPattern: "ALL" | "W1_4" | "W5_8";
  weekStart: number | null;
  weekEnd: number | null;
  allocatedSections: number;
  configuredSections: number;
  scheduledLessons: number;
  allocationVarianceCount: number;
};

export type CourseSetupInput = {
  revision: number;
  durationHours: number;
  sessionsPerWeek: number;
  primaryYear: number | null;
  minimumRoomCapacity: number | null;
  requiresLab: boolean;
  requiresMultiProjector: boolean;
  requiresSmartClassroom: boolean;
  separateSectionsAcrossDays: boolean;
  weekStart: number | null;
  weekEnd: number | null;
};

export type AllocationVarianceRecord = {
  teacherId: string;
  teacherName: string;
  expectedSections: number;
  actualSections: number;
};

export type TeachingMembersImportRow = {
  mod: string;
  catalog: string | null;
  lecturer: string;
  staffType: "FT" | "PT";
  groupCount: number;
};

export type TeachingMembersImportSummary = {
  courses: number;
  teachers: number;
  allocations: number;
  sections: number;
  ignoredZeroRows: number;
};

export type CourseSectionRecord = {
  id: string;
  label: string;
  teacherId: string | null;
  teacherName: string | null;
  studentGroupIds: string[];
  studentGroupCodes: string[];
  revision: number;
};

export type ScheduledLessonRecord = {
  id: string;
  sectionId: string;
  sectionLabel: string;
  courseCode: string;
  teacherId: string | null;
  teacherName: string | null;
  dayOfWeek: number;
  startHour: number;
  durationHours: number;
  roomId: string | null;
  roomCode: string | null;
  studentGroupIds: string[];
  studentGroups: string[];
  occurrence: number;
  sessionsPerWeek: number;
  revision: number;
  warnings: string[];
  warningSeverity: "High" | "Warning" | "Advisory" | null;
};

export type UnscheduledSectionRecord = {
  id: string;
  label: string;
  teacherName: string | null;
  teacherIsActive: boolean | null;
  staffType: "FT" | "PT" | null;
  durationHours: number;
  studentGroups: string[];
  occurrence: number;
  sessionsPerWeek: number;
};

export type UnavailableWindowRecord = { id: string; kind: "Teacher" | "Year"; ownerId: string; ownerLabel: string; dayOfWeek: number; startHour: number; endHour: number };

export type ScheduleIssueRecord = {
  id: string;
  lessonId: string;
  sectionLabel: string;
  primaryYear: number;
  dayOfWeek: number;
  startHour: number;
  endHour: number;
  teacherName: string | null;
  roomCode: string | null;
  studentGroups: string[];
  category: "Assignment" | "Availability" | "Conflict" | "Course rule" | "Preference" | "Room" | "Travel" | "Workload";
  severity: "High" | "Warning" | "Advisory";
  message: string;
};

export type CandidateSlotRecord = {
  dayOfWeek: number;
  startHour: number;
  endHour: number;
  roomId: string;
  roomCode: string;
  roomCapacity: number;
  roomFeatures: string[];
};

export type RuleSettingRecord = {
  key: "prefer_9am" | "lunch_break" | "max_continuous" | "student_daily_limit" | "teacher_daily_limit" | "same_block" | "separate_weekly_sessions";
  label: string;
  description: string;
  enabled: boolean;
};

export type AppUserRecord = { id: string; username: string; isAdmin: boolean; isActive: boolean };

export type CycleStatusRecord = {
  courses: number;
  sections: number;
  lessons: number;
  currentToken: string;
  backup: null | { id: string; createdAt: string; courses: number; sections: number; lessons: number };
};

// 紧急快照只保存当前排课周期的数据，例如课程、班次和已排课记录。
// 教师、教室等基础资料以及账号数据不会写入快照，因为开始新周期时必须继续保留它们。
type CourseSnapshotRow = { id: string; code: string; catalog: string | null; revision?: number; duration_hours: number | null; sessions_per_week: number; primary_year: number | null; minimum_room_capacity: number | null; requires_lab: number; requires_multi_projector: number; requires_smart_classroom: number; separate_sections_across_days: number; week_pattern: "ALL" | "W1_4" | "W5_8"; week_start?: number | null; week_end?: number | null; created_at: string; updated_at: string };
type AllocationSnapshotRow = { id: string; course_id: string; teacher_id: string; assigned_group_count: number };
type SectionSnapshotRow = { id: string; course_id: string; sequence: number; teacher_id: string | null; allocation_teacher_id?: string | null; revision?: number };
type SectionGroupSnapshotRow = { section_id: string; student_group_id: string };
type LessonSnapshotRow = { id: string; section_id: string; occurrence: number; day_of_week: number; start_hour: number; duration_hours: number; room_id: string | null; warnings_json: string; revision: number };
type CycleSnapshot = { courses: CourseSnapshotRow[]; allocations: AllocationSnapshotRow[]; sections: SectionSnapshotRow[]; sectionGroups: SectionGroupSnapshotRow[]; lessons: LessonSnapshotRow[] };

type DatabaseInstance = InstanceType<typeof Database>;

function weekRangeSuffix(weekStart: number | null, weekEnd: number | null) {
  // 只有在课程并非全学期上课时才显示简短周次标签，方便区分不同教学阶段；
  // 全学期课程不额外显示标签，以免时间表卡片过于拥挤。
  return weekStart !== null && weekEnd !== null ? ` · W${weekStart}–${weekEnd}` : "";
}

function legacyWeekPattern(weekStart: number | null, weekEnd: number | null): "ALL" | "W1_4" | "W5_8" {
  // 保留旧字段是为了兼容旧版本生成的紧急快照；当前所有冲突判断都改为读取
  // 数字形式的开始周和结束周，因此也能处理任意周次范围，而不只固定的半学期。
  if (weekStart === 1 && weekEnd === 4) return "W1_4";
  if (weekStart === 5 && weekEnd === 8) return "W5_8";
  return "ALL";
}

// Next.js 在开发模式中会反复重新加载模块。把数据库连接保存在全局对象里，
// 可以避免每次刷新路由都重新打开一个 SQLite 连接，减少锁冲突和资源浪费。
const globalForDatabase = globalThis as unknown as {
  timetableDatabase: DatabaseInstance | undefined;
  timetableSchemaVersion: number | undefined;
};

// 这个数字只在 initializeTables 的表、列或索引定义发生变化时增加。
// 开发热重载会保留全局 SQLite 连接，但会重新载入本文件；版本不同就补做一次迁移，
// 同一版本的普通 API 请求则直接复用连接，不再每次解析整组 CREATE／ALTER 语句。
const runtimeSchemaVersion = 2026081101;

function databaseFilePath() {
  // 数据库路径统一从这里取得，确保正式数据库和恢复前自动生成的安全副本
  // 始终位于同一块本地磁盘或 Railway 持久化磁盘中。
  const configuredPath = process.env.TIMETABLING_DATABASE_PATH?.trim();
  const railwayVolumePath = process.env.RAILWAY_VOLUME_MOUNT_PATH?.trim();
  const selectedPath = configuredPath || (railwayVolumePath ? path.join(railwayVolumePath, "timetabling.db") : path.join(process.cwd(), "data", "timetabling.db"));
  return path.resolve(selectedPath);
}

function database() {
  // 已打开的连接只在代码里的 schema 版本变化时重复初始化。这样既保留开发热重载
  // 自动补迁移的能力，也避免每个五秒轮询请求反复执行整套 DDL 和兼容 UPDATE。
  if (globalForDatabase.timetableDatabase) {
    if (globalForDatabase.timetableSchemaVersion !== runtimeSchemaVersion) {
      initializeTables(globalForDatabase.timetableDatabase);
      globalForDatabase.timetableSchemaVersion = runtimeSchemaVersion;
    }
    return globalForDatabase.timetableDatabase;
  }

  // 显式路径便于本地回归测试使用独立数据库；部署到 Railway 时，如果没有显式配置，
  // 就使用平台自动注入的持久化磁盘挂载点，避免在控制台重复维护同一个路径。
  const databasePath = databaseFilePath();
  const dataDirectory = path.dirname(databasePath);
  mkdirSync(dataDirectory, { recursive: true });
  const db = new Database(databasePath);
  db.pragma("foreign_keys = ON");
  initializeTables(db);
  globalForDatabase.timetableSchemaVersion = runtimeSchemaVersion;
  // 示例数据只用于本地开发时快速查看界面。部署环境中的空数据库必须保持干净，
  // 防止真实用户误把虚构的教师、学生班级或教室当成正式资料。
  if (process.env.NODE_ENV !== "production") seed(db);
  globalForDatabase.timetableDatabase = db;
  return db;
}

export function databaseHealth() {
  // 用固定查询确认数据库文件能够打开并执行 SQL，同时不向健康检查接口泄露
  // 排课数量、账号资料或服务器上的真实文件路径。
  const row = database().prepare("SELECT 1 AS healthy").get() as { healthy: number };
  return row.healthy === 1;
}

function assertDatabaseIntegrity(db: DatabaseInstance, stage: string) {
  // SQLite 检测到文件结构损坏时会返回一条或多条问题说明；
  // 健康的数据库只会返回一行内容为“ok”的结果。
  const integrityRows = db.pragma("integrity_check") as Array<Record<string, unknown>>;
  const integrityMessages = integrityRows.flatMap((row) => Object.values(row).map(String));
  if (integrityMessages.length !== 1 || integrityMessages[0].toLowerCase() !== "ok") {
    throw new Error(`${stage} failed SQLite integrity check.`);
  }

  // 数据库文件结构正常时仍可能存在外键关系错误，因此还要单独检查关联完整性，
  // 例如确保每条排课记录引用的教室确实存在。
  const foreignKeyProblems = db.pragma("foreign_key_check") as unknown[];
  if (foreignKeyProblems.length > 0) throw new Error(`${stage} failed foreign-key check.`);
}

export async function createVerifiedSystemBackup() {
  // 每次下载都创建独立的系统临时目录，避免多人同时导出时文件互相覆盖，
  // 也确保临时副本不会混放在正式数据库旁边。
  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "timetabling-backup-"));
  const backupPath = path.join(temporaryDirectory, "timetabling.sqlite");
  let backupDatabase: DatabaseInstance | undefined;

  try {
    // 先检查源数据库，再使用 SQLite 的在线备份接口生成一致副本。
    // 不能直接复制正在使用的数据库文件及其预写日志，否则可能得到不完整的数据。
    const sourceDatabase = database();
    assertDatabaseIntegrity(sourceDatabase, "Source database");
    await sourceDatabase.backup(backupPath);

    // 浏览器登录会话属于敏感的运行凭证，不属于需要备份的院系业务数据。
    // 从副本删除会话后执行 VACUUM，重建文件页面，避免已删除凭证残留在空闲页中。
    backupDatabase = new Database(backupPath);
    backupDatabase.pragma("foreign_keys = ON");
    backupDatabase.prepare("DELETE FROM auth_sessions").run();
    backupDatabase.exec("VACUUM");

    // 对最终提供下载的脱敏文件本身做完整性检查；读取文件字节前先关闭数据库，
    // 让 SQLite 的所有写入都刷新到磁盘，确保响应内容完整。
    assertDatabaseIntegrity(backupDatabase, "Generated backup");
    backupDatabase.close();
    backupDatabase = undefined;
    const contents = readFileSync(backupPath);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    return { contents, filename: `timetabling-backup-${timestamp}.sqlite` };
  } finally {
    // 响应对象已经持有内存中的文件内容，因此无论成功还是校验报错，
    // 都可以立即删除包含业务数据的临时文件，减少敏感副本在磁盘上的停留时间。
    backupDatabase?.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export class SystemBackupValidationError extends Error {
  // 使用专门的错误类型，让 API 能区分“不安全的上传文件”和“服务器意外故障”，
  // 同时不必把 SQLite 的内部实现细节暴露给浏览器。
  constructor(message: string) {
    super(message);
    this.name = "SystemBackupValidationError";
  }
}

type TableColumn = { cid: number; name: string; type: string; notnull: number; dflt_value: string | null; pk: number };
type ComparableTableColumn = Omit<TableColumn, "cid">;
type TableShape = { name: string; columns: ComparableTableColumn[] };

function quoteIdentifier(value: string) {
  // 表名虽然来自 SQLite 自己的元数据，仍然要进行安全引用。
  // 这样即使出现特殊字符，也不会改变恢复语句原本要执行的 SQL 命令。
  return `"${value.replaceAll('"', '""')}"`;
}

function tableShapes(db: DatabaseInstance) {
  // 恢复功能只接受与当前应用具有完全相同业务表和列定义的数据库。
  // SQLite 自己维护的 sqlite_* 内部表不会参与比较，也不会被复制。历史升级库通过
  // ALTER TABLE 把新列追加在表尾，因此这里只比较排序后的列定义，不把物理 cid 顺序
  // 当成不兼容；真正复制时也会显式写出列名，绝不使用顺序敏感的 SELECT *。
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>;
  return tables.map<TableShape>(({ name }) => ({
    name,
    columns: (db.prepare(`PRAGMA table_info(${quoteIdentifier(name)})`).all() as TableColumn[])
      .map(({ name: columnName, type, notnull, dflt_value, pk }) => ({ name: columnName, type, notnull, dflt_value, pk }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  }));
}

function assertRestorableSystemBackup(source: DatabaseInstance, live: DatabaseInstance) {
  // 在修改任何现有记录之前，先检查上传文件的结构和外键关系。
  // 表结构完全一致也能证明该文件来自兼容的应用版本，而不是任意 SQLite 文件。
  // 列顺序可以不同，但名称、类型、必填、默认值与主键定义必须全部相同。
  assertDatabaseIntegrity(source, "Uploaded backup");
  const sourceShapes = tableShapes(source);
  const liveShapes = tableShapes(live);
  if (JSON.stringify(sourceShapes) !== JSON.stringify(liveShapes)) {
    throw new SystemBackupValidationError("The selected file does not match this version of the timetabling system.");
  }

  // 恢复后所有旧会话都会被删除，因此上传文件中必须至少保留一个启用状态的管理员，
  // 并且密码哈希格式有效，保证恢复完成后仍有人能够重新登录。
  const administrators = source.prepare("SELECT password_hash FROM app_users WHERE is_admin = 1 AND is_active = 1").all() as Array<{ password_hash: string }>;
  const validPasswordHash = /^[0-9a-f]{32}:[0-9a-f]{128}$/i;
  if (!administrators.some((administrator) => validPasswordHash.test(administrator.password_hash))) {
    throw new SystemBackupValidationError("The selected backup has no usable active administrator account.");
  }

  return sourceShapes.map((table) => table.name);
}

function saveRestoreSafetyCopy(contents: Buffer, sourceFilename: string) {
  // 恢复前的安全快照保存在正式数据库旁边，使 Railway 能把它保留在持久化磁盘中；
  // 即使恢复后应用容器重启，这份回滚副本也不会随临时文件系统消失。
  const livePath = databaseFilePath();
  const databaseName = path.basename(livePath, path.extname(livePath));
  const safetyDirectory = path.join(path.dirname(livePath), `${databaseName}-restore-safety`);
  mkdirSync(safetyDirectory, { recursive: true });
  const safetyFilename = `pre-restore-${randomBytes(4).toString("hex")}-${sourceFilename}`;
  writeFileSync(path.join(safetyDirectory, safetyFilename), contents, { flag: "wx", mode: 0o600 });
  return safetyFilename;
}

export async function restoreVerifiedSystemBackup(contents: Buffer) {
  // 上传内容只在独立临时文件中停留到 SQLite 完成校验和读取为止。
  // 文件权限限制其他本机用户访问，降低业务数据在服务器上泄露的风险。
  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "timetabling-restore-"));
  const uploadedPath = path.join(temporaryDirectory, "uploaded.sqlite");
  writeFileSync(uploadedPath, contents, { mode: 0o600 });
  let uploadedDatabase: DatabaseInstance | undefined;
  let restoreAttached = false;
  const liveDatabase = database();

  try {
    let tableNames: string[];
    try {
      // 只读方式打开上传文件，防止校验过程自动修复或改写管理员选择的原文件；
      // 如果内容不是有效 SQLite 数据，则转换成可预期的 400 请求错误。
      uploadedDatabase = new Database(uploadedPath, { readonly: true, fileMustExist: true });
      uploadedDatabase.pragma("query_only = ON");
      tableNames = assertRestorableSystemBackup(uploadedDatabase, liveDatabase);
    } catch (error) {
      if (error instanceof SystemBackupValidationError) throw error;
      throw new SystemBackupValidationError("The selected file is not a valid verified timetabling backup.");
    } finally {
      uploadedDatabase?.close();
      uploadedDatabase = undefined;
    }

    // 在覆盖现有数据这种高风险操作之前，先生成并验证一份当前状态的持久化快照。
    // 快照刻意排除正在使用的登录会话凭证。
    const safetyBackup = await createVerifiedSystemBackup();
    const safetyBackupFilename = saveRestoreSafetyCopy(safetyBackup.contents, safetyBackup.filename);

    // 把已通过校验的上传数据库附加到当前连接，并在一个同步事务中替换全部业务表。
    // 任何复制错误或约束错误都会让整个事务回滚，避免只恢复了一部分数据。
    liveDatabase.prepare("ATTACH DATABASE ? AS restore_source").run(uploadedPath);
    restoreAttached = true;
    liveDatabase.pragma("foreign_keys = OFF");
    try {
      const restoreAllTables = liveDatabase.transaction(() => {
        for (const tableName of tableNames) liveDatabase.prepare(`DELETE FROM main.${quoteIdentifier(tableName)}`).run();
        for (const tableName of tableNames) {
          // 全新库和经过多次 ALTER TABLE 的旧库可能拥有不同物理列顺序；两边已经按
          // 排序后的列定义通过安全检查，因此这里使用 live 表的真实列名明确映射。
          const columns = (liveDatabase.prepare(`PRAGMA main.table_info(${quoteIdentifier(tableName)})`).all() as TableColumn[])
            .sort((left, right) => left.cid - right.cid)
            .map((column) => quoteIdentifier(column.name));
          const columnList = columns.join(", ");
          liveDatabase.prepare(`INSERT INTO main.${quoteIdentifier(tableName)} (${columnList}) SELECT ${columnList} FROM restore_source.${quoteIdentifier(tableName)}`).run();
        }

        // 当前数据库和上传数据库中的登录会话都不能在完整恢复后继续有效。
        // 外键检查也放在事务内执行，一旦失败，前面复制的所有表都会一起回滚。
        liveDatabase.prepare("DELETE FROM main.auth_sessions").run();
        const relationshipProblems = liveDatabase.pragma("foreign_key_check") as unknown[];
        if (relationshipProblems.length > 0) throw new Error("Restored data failed foreign-key check.");
      });
      restoreAllTables();
    } finally {
      liveDatabase.pragma("foreign_keys = ON");
    }

    // 恢复提交后补齐可重复执行的默认规则，并再次校验正式数据库。
    // 只有所有检查通过，API 才会通知浏览器恢复成功。
    initializeTables(liveDatabase);
    assertDatabaseIntegrity(liveDatabase, "Restored database");
    const counts = liveDatabase.prepare(`SELECT
      (SELECT COUNT(*) FROM teachers) AS teachers,
      (SELECT COUNT(*) FROM courses) AS courses,
      (SELECT COUNT(*) FROM course_sections) AS sections,
      (SELECT COUNT(*) FROM scheduled_lessons) AS lessons,
      (SELECT COUNT(*) FROM app_users) AS accounts`).get() as { teachers: number; courses: number; sections: number; lessons: number; accounts: number };
    return { safetyBackupFilename, ...counts };
  } finally {
    // 删除临时目录前先从 SQLite 连接卸载上传数据库。无论恢复成功、被拒绝还是执行失败，
    // 都会清理上传临时文件，但不会删除恢复前保留的安全快照。
    if (restoreAttached) liveDatabase.exec("DETACH DATABASE restore_source");
    uploadedDatabase?.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function initializeTables(db: DatabaseInstance) {
  // CREATE ... IF NOT EXISTS 让初始化逻辑可以在每次启动时安全重复执行。
  // 下面这些表构成当前界面实际使用的排课数据模型。
  db.exec(`
    CREATE TABLE IF NOT EXISTS teachers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      staff_type TEXT NOT NULL CHECK (staff_type IN ('FT', 'PT')),
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS student_groups (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      year INTEGER NOT NULL CHECK (year IN (1, 2, 3)),
      program TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS rooms (
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
    CREATE TABLE IF NOT EXISTS courses (
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
    CREATE TABLE IF NOT EXISTS teaching_allocations (
      id TEXT PRIMARY KEY,
      course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
      teacher_id TEXT NOT NULL REFERENCES teachers(id) ON DELETE RESTRICT,
      assigned_group_count INTEGER NOT NULL CHECK (assigned_group_count > 0),
      UNIQUE(course_id, teacher_id)
    );
    CREATE TABLE IF NOT EXISTS course_sections (
      id TEXT PRIMARY KEY,
      course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL CHECK (sequence > 0),
      teacher_id TEXT REFERENCES teachers(id) ON DELETE SET NULL,
      allocation_teacher_id TEXT REFERENCES teachers(id) ON DELETE SET NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      UNIQUE(course_id, sequence)
    );
    CREATE TABLE IF NOT EXISTS section_student_groups (
      section_id TEXT NOT NULL REFERENCES course_sections(id) ON DELETE CASCADE,
      student_group_id TEXT NOT NULL REFERENCES student_groups(id) ON DELETE CASCADE,
      PRIMARY KEY (section_id, student_group_id)
    );
    CREATE TABLE IF NOT EXISTS scheduled_lessons (
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
    CREATE TABLE IF NOT EXISTS teacher_unavailable_windows (
      id TEXT PRIMARY KEY,
      teacher_id TEXT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
      day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 1 AND 5),
      start_hour INTEGER NOT NULL,
      end_hour INTEGER NOT NULL CHECK (end_hour > start_hour)
    );
    CREATE TABLE IF NOT EXISTS year_blocked_windows (
      id TEXT PRIMARY KEY,
      year INTEGER NOT NULL CHECK (year IN (1, 2, 3)),
      day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 1 AND 5),
      start_hour INTEGER NOT NULL,
      end_hour INTEGER NOT NULL CHECK (end_hour > start_hour)
    );
    CREATE TABLE IF NOT EXISTS rule_settings (
      rule_key TEXT PRIMARY KEY,
      is_enabled INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS app_users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS schedule_backups (
      id TEXT PRIMARY KEY,
      snapshot_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // 政策规则采用数据库开关控制。后续版本新增可选规则时只补入缺失的默认值，
  // 不覆盖排课老师已经做出的启用或停用选择。
  const addRule = db.prepare("INSERT OR IGNORE INTO rule_settings (rule_key, is_enabled) VALUES (?, 1)");
  for (const ruleKey of ["prefer_9am", "lunch_break", "max_continuous", "student_daily_limit", "teacher_daily_limit", "same_block", "separate_weekly_sessions"]) addRule.run(ruleKey);

  // 表已经存在后，重复执行 CREATE TABLE 不会自动补上新列。
  // 因此这里检查旧版本地数据库，并用安全的小型迁移方式升级原型表结构。
  const courseColumns = db.prepare("PRAGMA table_info(courses)").all() as Array<{ name: string }>;
  if (!courseColumns.some((column) => column.name === "primary_year")) {
    db.exec("ALTER TABLE courses ADD COLUMN primary_year INTEGER CHECK (primary_year IN (1, 2, 3))");
  }
  if (!courseColumns.some((column) => column.name === "separate_sections_across_days")) {
    db.exec("ALTER TABLE courses ADD COLUMN separate_sections_across_days INTEGER NOT NULL DEFAULT 0");
  }
  if (!courseColumns.some((column) => column.name === "week_pattern")) {
    db.exec("ALTER TABLE courses ADD COLUMN week_pattern TEXT NOT NULL DEFAULT 'ALL' CHECK (week_pattern IN ('ALL', 'W1_4', 'W5_8'))");
  }
  if (!courseColumns.some((column) => column.name === "week_start")) {
    db.exec("ALTER TABLE courses ADD COLUMN week_start INTEGER CHECK (week_start IS NULL OR week_start >= 1)");
  }
  if (!courseColumns.some((column) => column.name === "week_end")) {
    db.exec("ALTER TABLE courses ADD COLUMN week_end INTEGER CHECK (week_end IS NULL OR week_end >= 1)");
  }
  if (!courseColumns.some((column) => column.name === "revision")) {
    // 旧数据库中的每门课程从 revision 1 开始；之后 Setup 保存使用比较后更新，
    // 防止两个账号打开同一表单后由最后提交者静默覆盖前一位老师。
    db.exec("ALTER TABLE courses ADD COLUMN revision INTEGER NOT NULL DEFAULT 1");
  }
  // 只为旧版“前半学期/后半学期”选项补填一次数字周次范围。
  // 自定义范围在保留的旧字段中使用 ALL，因此不会被这里的兼容逻辑误覆盖。
  db.exec("UPDATE courses SET week_start = 1, week_end = 4 WHERE week_pattern = 'W1_4' AND week_start IS NULL AND week_end IS NULL");
  db.exec("UPDATE courses SET week_start = 5, week_end = 8 WHERE week_pattern = 'W5_8' AND week_start IS NULL AND week_end IS NULL");
  const lessonColumns = db.prepare("PRAGMA table_info(scheduled_lessons)").all() as Array<{ name: string }>;
  if (!lessonColumns.some((column) => column.name === "warnings_json")) {
    db.exec("ALTER TABLE scheduled_lessons ADD COLUMN warnings_json TEXT NOT NULL DEFAULT '[]'");
  }
  if (!lessonColumns.some((column) => column.name === "revision")) {
    db.exec("ALTER TABLE scheduled_lessons ADD COLUMN revision INTEGER NOT NULL DEFAULT 1");
  }
  const sectionColumns = db.prepare("PRAGMA table_info(course_sections)").all() as Array<{ name: string }>;
  if (!sectionColumns.some((column) => column.name === "allocation_teacher_id")) {
    // 旧数据库无法可靠判断某个教师来自 Excel 还是老师手工修改，因此新列保持 NULL，
    // 把既有分配视为需要保护的手工资料；只有后续新导入生成的班次才由 Excel 自动维护。
    db.exec("ALTER TABLE course_sections ADD COLUMN allocation_teacher_id TEXT REFERENCES teachers(id) ON DELETE SET NULL");
  }
  if (!sectionColumns.some((column) => column.name === "revision")) {
    // 教师与学生班级属于整个班次的共享资料；独立 revision 防止两个排课老师
    // 同时编辑同一个班次时，后提交者把先提交者的选择静默覆盖。
    db.exec("ALTER TABLE course_sections ADD COLUMN revision INTEGER NOT NULL DEFAULT 1");
  }

  // SQLite 不会像 Prisma migration 那样自动建立 @@index，也不会为普通外键自动加索引。
  // 这里只建立实际 API 查询会使用的最小集合；普通唯一键已经自动拥有索引，不再重复建立。
  // 复合索引名称写出完整列清单，避免旧版本曾建立同名前缀索引时，IF NOT EXISTS
  // 静默保留旧形状。开发热重载和旧数据库升级都可以安全重复执行这一组语句。
  db.exec(`
    CREATE INDEX IF NOT EXISTS auth_sessions_user_id_idx
      ON auth_sessions (user_id);
    CREATE INDEX IF NOT EXISTS auth_sessions_expires_at_idx
      ON auth_sessions (expires_at);
    CREATE INDEX IF NOT EXISTS rooms_is_active_code_idx
      ON rooms (is_active, code);
    CREATE INDEX IF NOT EXISTS courses_primary_year_idx
      ON courses (primary_year);
    CREATE INDEX IF NOT EXISTS teaching_allocations_teacher_id_idx
      ON teaching_allocations (teacher_id);
    CREATE INDEX IF NOT EXISTS course_sections_teacher_id_idx
      ON course_sections (teacher_id);
    CREATE INDEX IF NOT EXISTS section_student_groups_student_group_id_section_id_idx
      ON section_student_groups (student_group_id, section_id);
    CREATE INDEX IF NOT EXISTS scheduled_lessons_room_id_day_of_week_start_hour_idx
      ON scheduled_lessons (room_id, day_of_week, start_hour);
    CREATE INDEX IF NOT EXISTS scheduled_lessons_day_of_week_start_hour_idx
      ON scheduled_lessons (day_of_week, start_hour);
    CREATE INDEX IF NOT EXISTS scheduled_lessons_section_id_day_of_week_start_hour_idx
      ON scheduled_lessons (section_id, day_of_week, start_hour);
    CREATE INDEX IF NOT EXISTS teacher_unavailable_windows_teacher_id_day_of_week_start_hour_end_hour_idx
      ON teacher_unavailable_windows (teacher_id, day_of_week, start_hour, end_hour);
    CREATE INDEX IF NOT EXISTS year_blocked_windows_year_day_of_week_start_hour_end_hour_idx
      ON year_blocked_windows (year, day_of_week, start_hour, end_hour);
  `);
}

function seed(db: DatabaseInstance) {
  // 示例记录让全新的本地开发环境在导入真实数据前也能展示可用界面。
  // 一旦数据库中已有任何教师，就认定用户已开始使用，绝不覆盖其资料。
  const count = db.prepare("SELECT COUNT(*) AS count FROM teachers").get() as { count: number };
  if (count.count > 0) return;

  // 重复使用的插入语句只预编译一次，并在同一个事务中原子性写入全部示例数据。
  const createTeacher = db.prepare("INSERT INTO teachers (id, name, staff_type) VALUES (?, ?, ?)");
  const createGroup = db.prepare("INSERT INTO student_groups (id, code, year, program) VALUES (?, ?, ?, ?)");
  const createRoom = db.prepare("INSERT INTO rooms (id, code, block, capacity, has_multi_projector, is_lab, is_smart_classroom) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const populate = db.transaction(() => {
    createTeacher.run("teacher-1", "WAN XIN", "FT");
    createTeacher.run("teacher-2", "ANDREW TOH SZE CHOW", "PT");
    createTeacher.run("teacher-3", "LIEW YOON HIN", "FT");
    createTeacher.run("teacher-4", "SII-HARTONO ALICE", "PT");
    createGroup.run("group-1", "AAA_01", 1, "AAA");
    createGroup.run("group-2", "CICTP_02", 1, "CICTP");
    createGroup.run("group-3", "CSF_03", 2, "CSF");
    createGroup.run("group-4", "IT_01", 3, "IT");
    createRoom.run("room-1", "31-05-10", "31", 40, 1, 0, 1);
    createRoom.run("room-2", "31-04-02", "31", 24, 0, 1, 0);
    createRoom.run("room-3", "27-03-08", "27", 20, 1, 0, 0);
  });
  populate();
}

function activeStatus(isActive: number) {
  // SQLite 用 0 和 1 保存布尔值；API 再把它转换为容易阅读的状态文字。
  return isActive ? "Active" : "Inactive";
}

function hashPassword(password: string) {
  // Scrypt 会刻意增加密码猜测成本。每个密码使用独立随机盐值，因此相同密码也不会
  // 产生相同的存储结果；系统任何时候都不会把明文密码写入数据库。
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}

function passwordMatches(password: string, stored: string) {
  // 使用原始盐值重新计算 Scrypt 结果，再通过恒定时间比较验证密码，
  // 防止攻击者根据响应耗时推测哪些字符已经匹配。
  const [salt, expectedHex] = stored.split(":");
  if (!salt || !expectedHex) return false;
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function sessionHash(token: string) {
  // 数据库只保存登录令牌的单向摘要。即使账号登录期间数据库被复制，
  // 攻击者也不能直接拿存储值冒充浏览器会话。
  return createHash("sha256").update(token).digest("hex");
}

function createSession(db: DatabaseInstance, userId: string) {
  // 浏览器收到随机原始令牌，SQLite 中只保存它的哈希。
  // 没有原始 Cookie 的人即使复制了会话表，也难以利用其中的数据登录。
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
  // 过期会话只在低频登录／建立新会话时清理。若放在每次 validateSession，
  // 即使 DELETE 没有匹配资料，所有五秒轮询 GET 仍会尝试取得 SQLite 写锁。
  const saveSession = db.transaction(() => {
    db.prepare("DELETE FROM auth_sessions WHERE expires_at <= ?").run(new Date().toISOString());
    db.prepare("INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(sessionHash(token), userId, expiresAt);
  });
  saveSession();
  return { token, expiresAt };
}

export function authenticationStatus(token?: string): { setupRequired: boolean; user: AppUserRecord | null } {
  // 登录页需要判断系统是否仍处于首次初始化状态，并确认浏览器提供的会话令牌
  // 是否仍然对应一个启用中的有效用户。
  const db = database();
  const count = db.prepare("SELECT COUNT(*) AS count FROM app_users").get() as { count: number };
  return { setupRequired: count.count === 0, user: token ? validateSession(token) : null };
}

export function validateSession(token: string): AppUserRecord | null {
  // 会话校验在一次查询中同时关联启用账号并检查过期时间，
  // 让被停用的用户或已过期的 Cookie 立即失去访问权限。
  const db = database();
  const row = db.prepare(`SELECT users.id, users.username, users.is_admin, users.is_active FROM auth_sessions sessions JOIN app_users users ON users.id = sessions.user_id WHERE sessions.token_hash = ? AND sessions.expires_at > ? AND users.is_active = 1`).get(sessionHash(token), new Date().toISOString()) as { id: string; username: string; is_admin: number; is_active: number } | undefined;
  return row ? { id: row.id, username: row.username, isAdmin: Boolean(row.is_admin), isActive: Boolean(row.is_active) } : null;
}

export function createInitialAdmin(username: string, password: string) {
  // 只有账号表为空时才允许首次初始化；管理员账号和第一个会话在同一事务中创建，
  // 避免出现“账号已建但登录会话未建”的半完成状态。
  const db = database();
  // 检查首位用户和插入账号使用同一个事务，防止两个同时到达的初始化请求
  // 各自创建一个初始管理员。
  return db.transaction(() => {
    const count = db.prepare("SELECT COUNT(*) AS count FROM app_users").get() as { count: number };
    if (count.count > 0) throw new Error("Initial administrator has already been created.");
    const id = crypto.randomUUID();
    db.prepare("INSERT INTO app_users (id, username, password_hash, is_admin) VALUES (?, ?, ?, 1)").run(id, username, hashPassword(password));
    return { user: { id, username, isAdmin: true, isActive: true }, session: createSession(db, id) };
  })();
}

export function loginUser(username: string, password: string) {
  // 登录只接受启用状态且密码匹配的账号；验证成功后生成新的服务器端会话，
  // 再由浏览器通过安全 Cookie 保存原始会话令牌。
  const db = database();
  const row = db.prepare("SELECT id, username, password_hash, is_admin, is_active FROM app_users WHERE username = ? COLLATE NOCASE").get(username) as { id: string; username: string; password_hash: string; is_admin: number; is_active: number } | undefined;
  if (!row || !row.is_active || !passwordMatches(password, row.password_hash)) return null;

  // Scrypt 故意在写锁外运行，避免一次登录长时间挡住排课保存；但密码验证完成后，
  // 管理员可能恰好重置密码或停用账号。因此建立会话前在 IMMEDIATE 事务内再次确认
  // Active 状态和密码哈希仍是刚才验证的版本，旧请求不能在撤销之后补回新会话。
  const finishLogin = db.transaction(() => {
    const current = db.prepare("SELECT password_hash, is_active FROM app_users WHERE id = ?").get(row.id) as { password_hash: string; is_active: number } | undefined;
    if (!current || current.is_active !== 1 || current.password_hash !== row.password_hash) return null;
    return { user: { id: row.id, username: row.username, isAdmin: Boolean(row.is_admin), isActive: true }, session: createSession(db, row.id) };
  });
  return finishLogin.immediate();
}

export function logoutSession(token: string) {
  // 退出登录只删除当前浏览器会话令牌对应的哈希，不影响该用户在其他浏览器的会话。
  return database().prepare("DELETE FROM auth_sessions WHERE token_hash = ?").run(sessionHash(token)).changes > 0;
}

export function listAppUsers(): AppUserRecord[] {
  // 管理员只能查看账号标识和启用状态，接口绝不返回密码哈希或登录会话资料。
  const rows = database().prepare("SELECT id, username, is_admin, is_active FROM app_users ORDER BY username").all() as Array<{ id: string; username: string; is_admin: number; is_active: number }>;
  return rows.map((row) => ({ id: row.id, username: row.username, isAdmin: Boolean(row.is_admin), isActive: Boolean(row.is_active) }));
}

export function createAppUser(username: string, password: string): AppUserRecord {
  // 后续新增成员默认都是普通排课账号；只有首次初始化账号是管理员，
  // 由它负责创建、停用或重置其他账号。
  const id = crypto.randomUUID();
  database().prepare("INSERT INTO app_users (id, username, password_hash, is_admin) VALUES (?, ?, ?, 0)").run(id, username, hashPassword(password));
  return { id, username, isAdmin: false, isActive: true };
}

export function changeOwnPassword(userId: string, currentPassword: string, newPassword: string) {
  // 已登录用户修改密码前必须再次证明当前密码正确。更新哈希后撤销该账号的全部会话，
  // 确保旧密码或遗留浏览器不能继续访问。
  const db = database();
  const user = db.prepare("SELECT password_hash FROM app_users WHERE id = ? AND is_active = 1").get(userId) as { password_hash: string } | undefined;
  if (!user || !passwordMatches(currentPassword, user.password_hash)) return false;
  // 密码修改会撤销该账号所有现有登录，包括用户可能已经忘记的其他浏览器。
  db.transaction(() => {
    db.prepare("UPDATE app_users SET password_hash = ? WHERE id = ?").run(hashPassword(newPassword), userId);
    db.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(userId);
  })();
  return true;
}

export function setAppUserStatus(userId: string, isActive: boolean) {
  // 停用账号是可恢复操作：删除现有会话，但保留用户名及历史操作归属信息。
  const db = database();
  // 停用后立即撤销活跃会话；重新启用只恢复登录资格，不会自动创建新会话。
  return db.transaction(() => {
    const changed = db.prepare("UPDATE app_users SET is_active = ? WHERE id = ? AND is_admin = 0").run(isActive ? 1 : 0, userId).changes > 0;
    if (changed && !isActive) db.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(userId);
    return changed;
  })();
}

export function resetAppUserPassword(userId: string, newPassword: string) {
  // 管理员重置密码时会替换已存哈希，并让该账号在所有浏览器中退出登录，
  // 账号持有人必须使用新密码重新验证身份。
  const db = database();
  return db.transaction(() => {
    const changed = db.prepare("UPDATE app_users SET password_hash = ? WHERE id = ? AND is_admin = 0").run(hashPassword(newPassword), userId).changes > 0;
    if (changed) db.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(userId);
    return changed;
  })();
}

export function listTeachers(): TeacherRecord[] {
  // 在教师资料旁统计从教学分配表导入的班次数量，让资料页无需额外计算，
  // 就能直接显示每位教师预计承担多少个班次。
  const rows = database().prepare(`
    SELECT teachers.id, teachers.name, teachers.staff_type, teachers.is_active,
      COALESCE(SUM(teaching_allocations.assigned_group_count), 0) AS sections
    FROM teachers
    LEFT JOIN teaching_allocations ON teaching_allocations.teacher_id = teachers.id
    GROUP BY teachers.id
    ORDER BY teachers.staff_type DESC, teachers.name ASC
  `).all() as Array<{ id: string; name: string; staff_type: "FT" | "PT"; is_active: number; sections: number }>;
  return rows.map((row) => ({ id: row.id, name: row.name, staffType: row.staff_type, status: activeStatus(row.is_active), sections: row.sections }));
}

export function createTeacher(name: string, staffType: "FT" | "PT"): TeacherRecord {
  // 使用 UUID 生成稳定主键，使本地新增资料不必依赖数据库自增序号。
  const id = crypto.randomUUID();
  database().prepare("INSERT INTO teachers (id, name, staff_type) VALUES (?, ?, ?)").run(id, name, staffType);
  return { id, name, staffType, status: "Active", sections: 0 };
}

export function updateTeacher(id: string, input: { name: string; staffType: "FT" | "PT" }) {
  // 编辑时保留原有教师 ID，因此已经关联的教学分配、不可用时段和排课记录
  // 都会继续指向同一位教师，不会因修改姓名而丢失。
  const result = database().prepare(`
    UPDATE teachers SET name = ?, staff_type = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(input.name, input.staffType, id);
  return result.changes > 0;
}

export function setTeacherStatus(id: string, isActive: boolean) {
  // 停用教师只会把其从后续可选名单中隐藏，同时完整保留旧时间表中的历史记录。
  // 状态和全部相关 warning 必须一起提交；重算失败时回滚状态，不能留下界面与警告互相矛盾的资料。
  const db = database();
  const statusTransaction = db.transaction(() => {
    const result = db.prepare("UPDATE teachers SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(isActive ? 1 : 0, id);
    if (result.changes > 0) refreshAllScheduleWarnings(db);
    return result.changes > 0;
  });
  return statusTransaction.immediate();
}

export function listStudentGroups(): StudentGroupRecord[] {
  // 学生班级按年级、专业、班级编号依次排序，保证老师每次查看时顺序一致、容易查找。
  const rows = database().prepare("SELECT id, code, year, program FROM student_groups ORDER BY year ASC, program ASC, code ASC").all() as StudentGroupRecord[];
  return rows;
}

export class MasterDataUniqueConflictError extends Error {
  // 基础资料的编号／名称重复属于可修正的 409，而 warning trigger 或 SQLite
  // 其他故障必须走安全 500。独立类型避免 API 把所有异常都误报成“重复资料”。
  constructor(message: string) {
    super(message);
    this.name = "MasterDataUniqueConflictError";
  }
}

export class MasterDataInputError extends Error {
  // 不可用时段等基础资料若引用不存在的教师，应返回明确 400，而不是暴露外键错误。
  constructor(message: string) {
    super(message);
    this.name = "MasterDataInputError";
  }
}

export function createStudentGroup(code: string, year: number, program: string): StudentGroupRecord {
  // 学生班级 ID 是冲突检查所依赖的稳定身份；年级和专业仍可修改，
  // 由数据库生成的 ID 则保护已有课程关联不受名称调整影响。
  const id = crypto.randomUUID();
  try {
    database().prepare("INSERT INTO student_groups (id, code, year, program) VALUES (?, ?, ?, ?)").run(id, code, year, program);
  } catch (error) {
    // 只有稳定的 SQLite 唯一键错误才代表班级编号重复；磁盘、trigger 等未知故障继续向上抛，
    // 由 API 隐藏技术细节并返回通用 500，不能误导老师继续修改一个本来并未重复的编号。
    if (isSqliteUniqueConstraintError(error)) throw new MasterDataUniqueConflictError("A student group with this code already exists.");
    throw error;
  }
  return { id, code, year, program };
}

export function updateStudentGroup(id: string, input: { code: string; year: number; program: string }) {
  // 修改拼写、专业或年级时保留原班级 ID，因此已经分配给该班的所有课程班次都会继续存在。
  const db = database();
  const updateTransaction = db.transaction(() => {
    const result = db.prepare(`
      UPDATE student_groups SET code = ?, year = ?, program = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(input.code, input.year, input.program, id);
    // 冲突警告会直接显示班级编号，因此资料修改和 warning 重算必须一起提交；
    // 重算失败时保留原编号、年级和专业，避免接口假失败后资料其实已经改变。
    if (result.changes > 0) refreshAllScheduleWarnings(db);
    return result.changes > 0;
  });
  try {
    return updateTransaction.immediate();
  } catch (error) {
    if (isSqliteUniqueConstraintError(error)) throw new MasterDataUniqueConflictError("A student group with this code already exists.");
    throw error;
  }
}

export function listRooms(): RoomRecord[] {
  // 把数据库中分开的教室功能布尔字段转换为简短列表，方便资料表格直接展示。
  const rows = database().prepare("SELECT id, code, capacity, has_multi_projector, is_lab, is_smart_classroom, is_active FROM rooms ORDER BY code ASC").all() as Array<{ id: string; code: string; capacity: number; has_multi_projector: number; is_lab: number; is_smart_classroom: number; is_active: number }>;
  return rows.map((row) => ({
    id: row.id,
    code: row.code,
    capacity: row.capacity,
    features: [row.is_lab ? "Lab" : "", row.has_multi_projector ? "Multi projector" : "", row.is_smart_classroom ? "Smart classroom" : ""].filter(Boolean),
    status: activeStatus(row.is_active),
  }));
}

export function createRoom(input: { code: string; capacity: number; hasLab: boolean; hasMultiProjector: boolean; isSmartClassroom: boolean }): RoomRecord {
  // 教室容量和全部设施标记一次性保存。根据院系规则，Smart Classroom 必然同时属于
  // Multi Projector，确保后续教室要求检查始终看到一致资料。
  const id = crypto.randomUUID();
  // 教室编号格式是 Block-Level-Room，因此取第一段作为楼栋编号，供连续课程跨楼提醒使用。
  const block = input.code.split("-")[0] || null;
  // 本院系规定 Smart Classroom 一定具备 Multi Projector，所以保存时自动补上该标记。
  const hasMultiProjector = input.hasMultiProjector || input.isSmartClassroom;
  try {
    database().prepare("INSERT INTO rooms (id, code, block, capacity, has_multi_projector, is_lab, is_smart_classroom) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, input.code, block, input.capacity, hasMultiProjector ? 1 : 0, input.hasLab ? 1 : 0, input.isSmartClassroom ? 1 : 0);
  } catch (error) {
    // 与学生班级相同，只把真正的编号唯一键冲突转换为 409；其他数据库异常不能伪装成重复编号。
    if (isSqliteUniqueConstraintError(error)) throw new MasterDataUniqueConflictError("A room with this code already exists.");
    throw error;
  }
  return { id, code: input.code, capacity: input.capacity, features: [input.hasLab ? "Lab" : "", hasMultiProjector ? "Multi projector" : "", input.isSmartClassroom ? "Smart classroom" : ""].filter(Boolean), status: "Active" };
}

export function updateRoom(id: string, input: { code: string; capacity: number; hasLab: boolean; hasMultiProjector: boolean; isSmartClassroom: boolean }) {
  // 教室地址变化时重新解析 Block，保证背靠背课程的跨楼提醒使用最新楼栋，
  // 而不是继续读取旧地址留下的值。
  const block = input.code.split("-")[0] || null;
  // 编辑资料时同样强制执行“Smart Classroom 也是 Multi Projector”的院系规则。
  const hasMultiProjector = input.hasMultiProjector || input.isSmartClassroom;
  const db = database();
  const updateTransaction = db.transaction(() => {
    const result = db.prepare(`
      /* timetabling:candidate-race-room-update */
      UPDATE rooms SET code = ?, block = ?, capacity = ?, has_multi_projector = ?,
        is_lab = ?, is_smart_classroom = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(input.code, block, input.capacity, hasMultiProjector ? 1 : 0, input.hasLab ? 1 : 0, input.isSmartClassroom ? 1 : 0, id);
    // 容量、设施和 Block 都会改变课程警告，因此和 warning 重算放在同一个事务。
    if (result.changes > 0) refreshAllScheduleWarnings(db);
    return result.changes > 0;
  });
  try {
    return updateTransaction.immediate();
  } catch (error) {
    if (isSqliteUniqueConstraintError(error)) throw new MasterDataUniqueConflictError("A room with this code already exists.");
    throw error;
  }
}

export function setRoomStatus(id: string, isActive: boolean) {
  // 教室只停用、不直接删除，使旧时间表卡片仍能引用有效的历史教室；
  // 新的排课候选搜索则会自动排除已停用教室。
  const db = database();
  const statusTransaction = db.transaction(() => {
    const result = db.prepare("UPDATE rooms SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(isActive ? 1 : 0, id);
    // 状态和 `Room is unavailable` warning 必须始终来自同一次提交。
    if (result.changes > 0) refreshAllScheduleWarnings(db);
    return result.changes > 0;
  });
  return statusTransaction.immediate();
}

export function listUnavailableWindows(): UnavailableWindowRecord[] {
  // 教师和年级不可用时段合并成一个界面列表，但保留类型字段，方便编辑时识别来源。
  const teachers = database().prepare(`SELECT windows.id, windows.teacher_id AS owner_id, teachers.name AS owner_label, windows.day_of_week, windows.start_hour, windows.end_hour FROM teacher_unavailable_windows windows JOIN teachers ON teachers.id = windows.teacher_id ORDER BY teachers.name, windows.day_of_week, windows.start_hour`).all() as Array<{ id: string; owner_id: string; owner_label: string; day_of_week: number; start_hour: number; end_hour: number }>;
  const years = database().prepare(`SELECT id, CAST(year AS TEXT) AS owner_id, 'Year ' || year AS owner_label, day_of_week, start_hour, end_hour FROM year_blocked_windows ORDER BY year, day_of_week, start_hour`).all() as Array<{ id: string; owner_id: string; owner_label: string; day_of_week: number; start_hour: number; end_hour: number }>;
  return [...teachers.map((row) => ({ id: row.id, kind: "Teacher" as const, ownerId: row.owner_id, ownerLabel: row.owner_label, dayOfWeek: row.day_of_week, startHour: row.start_hour, endHour: row.end_hour })), ...years.map((row) => ({ id: row.id, kind: "Year" as const, ownerId: row.owner_id, ownerLabel: row.owner_label, dayOfWeek: row.day_of_week, startHour: row.start_hour, endHour: row.end_hour }))];
}

export function createUnavailableWindow(input: { kind: "Teacher" | "Year"; ownerId: string; dayOfWeek: number; startHour: number; endHour: number }) {
  // 不可用时段采用左闭右开区间 [开始, 结束)，与课程重叠判断规则保持一致。
  const id = crypto.randomUUID();
  const db = database();
  const createTransaction = db.transaction(() => {
    if (input.kind === "Teacher") {
      // API 会先验证格式；数据库边界再确认教师仍存在，封住删除与保存同时发生的竞态。
      const teacherExists = db.prepare("SELECT 1 FROM teachers WHERE id = ?").get(input.ownerId);
      if (!teacherExists) throw new MasterDataInputError("Choose a valid teacher.");
      db.prepare("INSERT INTO teacher_unavailable_windows (id, teacher_id, day_of_week, start_hour, end_hour) VALUES (?, ?, ?, ?, ?)").run(id, input.ownerId, input.dayOfWeek, input.startHour, input.endHour);
    } else {
      db.prepare("INSERT INTO year_blocked_windows (id, year, day_of_week, start_hour, end_hour) VALUES (?, ?, ?, ?, ?)").run(id, Number(input.ownerId), input.dayOfWeek, input.startHour, input.endHour);
    }
    // 新时段和受影响课程 warning 必须一起出现；任何重算故障都会删除刚插入的时段。
    refreshAllScheduleWarnings(db);
    return id;
  });
  return createTransaction.immediate();
}

export function deleteUnavailableWindow(id: string, kind: "Teacher" | "Year") {
  // 先根据类型选择准确的数据表，避免不同表中恰好出现相同 ID 时误删其他记录。
  const table = kind === "Teacher" ? "teacher_unavailable_windows" : "year_blocked_windows";
  const db = database();
  const deleteTransaction = db.transaction(() => {
    const removed = db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id).changes > 0;
    // 删除时段和清除对应 warning 属于一个业务动作，必须一起成功或一起回滚。
    if (removed) refreshAllScheduleWarnings(db);
    return removed;
  });
  return deleteTransaction.immediate();
}

const ruleSettingDetails: Array<Omit<RuleSettingRecord, "enabled">> = [
  { key: "prefer_9am", label: "Prefer 09:00 starts", description: "Warn when a lesson starts at 08:00." },
  { key: "lunch_break", label: "Keep one lunch hour", description: "Keep 12:00–13:00 or 13:00–14:00 free." },
  { key: "max_continuous", label: "Maximum 4 continuous hours", description: "Warn teachers and classes after four continuous hours." },
  { key: "student_daily_limit", label: "Student maximum 6 hours/day", description: "Highlight every student group above six class hours." },
  { key: "teacher_daily_limit", label: "Teacher maximum 7 hours/day", description: "Highlight every teacher above seven teaching hours." },
  { key: "same_block", label: "Back-to-back lessons in one block", description: "Warn about immediate travel between different blocks." },
  { key: "separate_weekly_sessions", label: "Separate twice-weekly sessions", description: "Warn when both meetings of one class use the same day." },
];

export function listRuleSettings(): RuleSettingRecord[] {
  // 在程序中把固定的规则说明与数据库中的开关值合并；数据库只保存老师可修改的状态，
  // 文字说明由代码统一维护，避免重复和版本不一致。
  const rows = database().prepare("SELECT rule_key, is_enabled FROM rule_settings").all() as Array<{ rule_key: string; is_enabled: number }>;
  const enabledByKey = new Map(rows.map((row) => [row.rule_key, Boolean(row.is_enabled)]));
  return ruleSettingDetails.map((rule) => ({ ...rule, enabled: enabledByKey.get(rule.key) ?? true }));
}

export function updateRuleSetting(key: string, enabled: boolean) {
  // 只有已登记的政策规则键可以修改。教师、班级和教室重叠等核心冲突没有开关，
  // 因而不会被用户意外停用。
  if (!ruleSettingDetails.some((rule) => rule.key === key)) return false;
  const db = database();
  const settingTransaction = db.transaction(() => {
    const changed = db.prepare("UPDATE rule_settings SET is_enabled = ? WHERE rule_key = ?").run(enabled ? 1 : 0, key).changes > 0;
    // 规则开关和由它生成／清除的所有 warning 对老师来说是一个不可分割的结果。
    if (changed) refreshAllScheduleWarnings(db);
    return changed;
  });
  return settingTransaction.immediate();
}

function readCycleSnapshot(db: DatabaseInstance): CycleSnapshot {
  // 明确列出周期表，让备份范围可以被代码审查：只有“开始新周期”会清空的数据进入快照，
  // 账号以及需要跨周期保留的基础资料永远不在其中。
  return {
    courses: db.prepare("SELECT id, code, catalog, revision, duration_hours, sessions_per_week, primary_year, minimum_room_capacity, requires_lab, requires_multi_projector, requires_smart_classroom, separate_sections_across_days, week_pattern, week_start, week_end, created_at, updated_at FROM courses ORDER BY id").all() as CourseSnapshotRow[],
    allocations: db.prepare("SELECT id, course_id, teacher_id, assigned_group_count FROM teaching_allocations ORDER BY id").all() as AllocationSnapshotRow[],
    sections: db.prepare("SELECT id, course_id, sequence, teacher_id, allocation_teacher_id, revision FROM course_sections ORDER BY id").all() as SectionSnapshotRow[],
    sectionGroups: db.prepare("SELECT section_id, student_group_id FROM section_student_groups ORDER BY section_id, student_group_id").all() as SectionGroupSnapshotRow[],
    lessons: db.prepare("SELECT id, section_id, occurrence, day_of_week, start_hour, duration_hours, room_id, warnings_json, revision FROM scheduled_lessons ORDER BY id").all() as LessonSnapshotRow[],
  };
}

function parseCycleSnapshot(snapshotJson: string): CycleSnapshot | null {
  // 紧急备份是数据库内部 JSON，但升级、磁盘损坏或人工维护都可能留下无效内容。
  // 这里只接受具有五个必需数组的对象；读取状态时把无效备份隐藏，恢复时则返回明确冲突。
  try {
    const parsed: unknown = JSON.parse(snapshotJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const candidate = parsed as Partial<Record<keyof CycleSnapshot, unknown>>;
    if (![candidate.courses, candidate.allocations, candidate.sections, candidate.sectionGroups, candidate.lessons].every(Array.isArray)) return null;
    const snapshot = candidate as CycleSnapshot;

    // 老版本或人工损坏的 JSON 可能在结构上仍有五个数组，却让已排课程引用一个
    // primary_year 为空的课程。恢复后这类 lesson 会从三张年级总表全部消失，
    // 因此必须在删除当前周期之前验证跨数组关系，而不能只依赖外键。
    const primaryYearByCourse = new Map(snapshot.courses.map((course) => [course.id, course.primary_year]));
    const courseBySection = new Map(snapshot.sections.map((section) => [section.id, section.course_id]));
    const everyLessonHasVisibleYear = snapshot.lessons.every((lesson) => {
      const courseId = courseBySection.get(lesson.section_id);
      if (!courseId) return false;
      return [1, 2, 3].includes(primaryYearByCourse.get(courseId) ?? 0);
    });
    if (!everyLessonHasVisibleYear) return null;
    return snapshot;
  } catch {
    return null;
  }
}

export class CycleActionConflictError extends Error {
  // 空周期、缺少备份、旧页面确认了已被替换的备份等都属于当前资料状态冲突，
  // 可以安全显示为 409；未知 SQLite 或 trigger 故障必须由 API 隐藏成通用 500。
  constructor(message: string) {
    super(message);
    this.name = "CycleActionConflictError";
  }
}

export class CycleActionBusyError extends Error {
  // 另一个服务进程正在执行写事务时，老师可以稍后重试；它不同于资料状态冲突，
  // API 使用 503 表达临时不可用，同时不暴露 SQLite 锁文字。
  constructor() {
    super("Another scheduler is updating the cycle. Try again in a moment.");
    this.name = "CycleActionBusyError";
  }
}

function isSqliteBusyError(error: unknown) {
  return error instanceof Database.SqliteError && (error.code.startsWith("SQLITE_BUSY") || error.code.startsWith("SQLITE_LOCKED"));
}

function cycleDatabase() {
  // database() 每次都会执行幂等结构检查，其中也可能短暂取得写锁；把连接初始化
  // 一并纳入 BUSY 转换，确保锁竞争不会在事务建立前漏成通用 500。
  try {
    return database();
  } catch (error) {
    if (isSqliteBusyError(error)) throw new CycleActionBusyError();
    throw error;
  }
}

function backupSummary(id: string, createdAt: string, snapshot: CycleSnapshot) {
  // 周期管理页面只显示记录数量和快照时间，不把体积较大的 JSON 快照内容发送给浏览器。
  return { id, createdAt, courses: snapshot.courses.length, sections: snapshot.sections.length, lessons: snapshot.lessons.length };
}

function cycleSnapshotToken(snapshot: CycleSnapshot) {
  // 浏览器只持有不可逆 SHA-256 指纹，不接收完整课程资料。恢复或清空时在写锁内重算，
  // 若另一个账号已经修改当前周期，旧页面的确认就会得到 409，而不会覆盖未见过的新工作。
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

export function cycleStatus(): CycleStatusRecord {
  // 返回当前排课数据总数，以及开始新周期后可用于一次撤销操作的最新紧急快照。
  const db = cycleDatabase();
  const statusTransaction = db.transaction(() => {
    // 当前五张周期表和最新备份都在同一个只读事务快照中读取，避免 GET 把两个并发版本拼在一起。
    const currentSnapshot = readCycleSnapshot(db);
    const backup = db.prepare("SELECT id, snapshot_json, created_at FROM schedule_backups ORDER BY created_at DESC LIMIT 1").get() as { id: string; snapshot_json: string; created_at: string } | undefined;
    const backupSnapshot = backup ? parseCycleSnapshot(backup.snapshot_json) : null;
    // 即使备份内容损坏，也不能阻止老师打开周期页；此时仅把它视为不可恢复。
    return {
      courses: currentSnapshot.courses.length,
      sections: currentSnapshot.sections.length,
      lessons: currentSnapshot.lessons.length,
      currentToken: cycleSnapshotToken(currentSnapshot),
      backup: backup && backupSnapshot && backupSnapshot.courses.length > 0 ? backupSummary(backup.id, backup.created_at, backupSnapshot) : null,
    };
  });
  try {
    return statusTransaction.deferred();
  } catch (error) {
    if (isSqliteBusyError(error)) throw new CycleActionBusyError();
    throw error;
  }
}

export function startNewCycle(expectedCurrentToken: string): CycleStatusRecord {
  // 先快照当前排课工作，再在一个事务中清空课程、生成班次和排课记录；
  // 教师、学生班级、教室、规则及账号继续保留供新周期使用。
  const db = cycleDatabase();
  const replaceCycle = db.transaction(() => {
    // 取得 IMMEDIATE 写锁之后再执行五张表的快照查询，保证数组彼此来自同一数据库版本；
    // 其他账号不能在快照完成后、清空之前再插入一门不在备份里的课程。
    const snapshot = readCycleSnapshot(db);
    if (cycleSnapshotToken(snapshot) !== expectedCurrentToken) throw new CycleActionConflictError("The current cycle changed. Refresh this page and review the latest contents before starting a new cycle.");
    if (snapshot.courses.length === 0) throw new CycleActionConflictError("There is no current course cycle to clear.");
    const backupId = crypto.randomUUID();
    const createdAt = new Date().toISOString();

    // 保存完整快照、替换旧备份和清空当前周期属于一个不可分割动作。
    // 任一步失败都会恢复原课程和原备份，避免“资料清空但备份不完整”。
    db.prepare("DELETE FROM schedule_backups").run();
    db.prepare("INSERT INTO schedule_backups (id, snapshot_json, created_at) VALUES (?, ?, ?)").run(backupId, JSON.stringify(snapshot), createdAt);
    db.prepare("DELETE FROM courses").run();
    // 在事务函数内构造响应，避免提交后再查状态失败而出现“接口说失败但周期已经清空”。
    const clearedSnapshot = readCycleSnapshot(db);
    return {
      courses: clearedSnapshot.courses.length,
      sections: clearedSnapshot.sections.length,
      lessons: clearedSnapshot.lessons.length,
      currentToken: cycleSnapshotToken(clearedSnapshot),
      backup: backupSummary(backupId, createdAt, snapshot),
    };
  });
  try {
    return replaceCycle.immediate();
  } catch (error) {
    if (error instanceof CycleActionConflictError) throw error;
    if (isSqliteBusyError(error)) throw new CycleActionBusyError();
    throw error;
  }
}

export function restoreLastCycleBackup(expectedBackupId: string, expectedCurrentToken: string): CycleStatusRecord {
  // 在单一事务中用最新紧急 JSON 快照替换当前周期数据，随后根据目前保留的规则
  // 和不可用时段重新计算全部警告。
  const db = cycleDatabase();
  const restore = db.transaction(() => {
    // 在取得 IMMEDIATE 写锁后才选择最新备份，并与页面确认的稳定 ID 比较。
    // 如果另一账号已开始了新周期，旧页面不能悄悄恢复一个用户从未确认过的新备份。
    const currentSnapshot = readCycleSnapshot(db);
    if (cycleSnapshotToken(currentSnapshot) !== expectedCurrentToken) throw new CycleActionConflictError("The current cycle changed. Refresh this page and review the latest contents before restoring.");
    const backup = db.prepare("SELECT id, snapshot_json, created_at FROM schedule_backups ORDER BY created_at DESC LIMIT 1").get() as { id: string; snapshot_json: string; created_at: string } | undefined;
    if (!backup) throw new CycleActionConflictError("No emergency cycle backup is available.");
    if (backup.id !== expectedBackupId) throw new CycleActionConflictError("The emergency backup changed. Refresh this page and review the latest backup before restoring.");
    const snapshot = parseCycleSnapshot(backup.snapshot_json);
    // 正常 Start 从不允许空课程周期，因此零课程快照一定是损坏或不兼容资料；
    // 不能把它当成有效恢复并静默清空老师当前工作。
    if (!snapshot || snapshot.courses.length === 0) throw new CycleActionConflictError("The emergency backup is not valid.");

    // 按父表到子表的顺序恢复，确保每一步外键都有效。清空、重建和 warning 重算
    // 都在同一个事务中；如果基础资料已经不存在或任一步失败，当前周期完整回滚。
    db.prepare("DELETE FROM courses").run();
    const insertCourse = db.prepare(`INSERT INTO courses (id, code, catalog, revision, duration_hours, sessions_per_week, primary_year, minimum_room_capacity, requires_lab, requires_multi_projector, requires_smart_classroom, separate_sections_across_days, week_pattern, week_start, week_end, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const row of snapshot.courses) {
      // 旧备份只包含 week_pattern；在升级后的结构中恢复时，
      // 根据旧值推导数字形式的开始周和结束周以保持兼容。
      const weekStart = row.week_start ?? (row.week_pattern === "W1_4" ? 1 : row.week_pattern === "W5_8" ? 5 : null);
      const weekEnd = row.week_end ?? (row.week_pattern === "W1_4" ? 4 : row.week_pattern === "W5_8" ? 8 : null);
      insertCourse.run(row.id, row.code, row.catalog, row.revision ?? 1, row.duration_hours, row.sessions_per_week, row.primary_year, row.minimum_room_capacity, row.requires_lab, row.requires_multi_projector, row.requires_smart_classroom, row.separate_sections_across_days, row.week_pattern, weekStart, weekEnd, row.created_at, row.updated_at);
    }
    const insertAllocation = db.prepare("INSERT INTO teaching_allocations (id, course_id, teacher_id, assigned_group_count) VALUES (?, ?, ?, ?)");
    for (const row of snapshot.allocations) insertAllocation.run(row.id, row.course_id, row.teacher_id, row.assigned_group_count);
    const insertSection = db.prepare("INSERT INTO course_sections (id, course_id, sequence, teacher_id, allocation_teacher_id, revision) VALUES (?, ?, ?, ?, ?, ?)");
    for (const row of snapshot.sections) {
      // 旧版紧急快照没有 Excel 来源教师和班次 revision；恢复时分别按受保护分配与 revision 1 处理，
      // 既防止下一次导入覆盖历史教师，也保持旧快照能够安全恢复。
      insertSection.run(row.id, row.course_id, row.sequence, row.teacher_id, row.allocation_teacher_id ?? null, row.revision ?? 1);
    }
    const insertSectionGroup = db.prepare("INSERT INTO section_student_groups (section_id, student_group_id) VALUES (?, ?)");
    for (const row of snapshot.sectionGroups) insertSectionGroup.run(row.section_id, row.student_group_id);
    const insertLesson = db.prepare("INSERT INTO scheduled_lessons (id, section_id, occurrence, day_of_week, start_hour, duration_hours, room_id, warnings_json, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const row of snapshot.lessons) insertLesson.run(row.id, row.section_id, row.occurrence, row.day_of_week, row.start_hour, row.duration_hours, row.room_id, row.warnings_json, row.revision);
    // 基础资料或政策规则可能在备份后变化，所以用当前规则重新评估；嵌套 transaction
    // 会使用 SAVEPOINT，任何重算异常都会继续向外抛并撤销整次周期恢复。
    refreshAllScheduleWarnings(db);
    const restoredSnapshot = readCycleSnapshot(db);
    return {
      courses: restoredSnapshot.courses.length,
      sections: restoredSnapshot.sections.length,
      lessons: restoredSnapshot.lessons.length,
      currentToken: cycleSnapshotToken(restoredSnapshot),
      backup: backupSummary(backup.id, backup.created_at, snapshot),
    };
  });
  try {
    return restore.immediate();
  } catch (error) {
    if (error instanceof CycleActionConflictError) throw error;
    if (isSqliteBusyError(error)) throw new CycleActionBusyError();
    // 备份引用的教师、学生班级或教室在新周期期间可能被物理删除；这是可解释的
    // 当前状态冲突。只转换稳定外键错误代码，不把 trigger 等未知约束误报成 409。
    if (error instanceof Database.SqliteError && error.code === "SQLITE_CONSTRAINT_FOREIGNKEY") {
      throw new CycleActionConflictError("The emergency backup depends on master data that no longer exists.");
    }
    throw error;
  }
}

export function listCourses(): CourseRecord[] {
  // 班次数量和教师分配总数分别使用独立子查询，避免一门课同时有多位教师和多个班次时，
  // 连接结果互相相乘而造成统计数字虚高。
  const rows = database().prepare(`
    SELECT courses.id, courses.code, courses.catalog, courses.revision, courses.duration_hours, courses.sessions_per_week,
      courses.primary_year, courses.minimum_room_capacity, courses.requires_lab,
      courses.requires_multi_projector, courses.requires_smart_classroom,
      courses.separate_sections_across_days, courses.week_pattern, courses.week_start, courses.week_end,
      (SELECT COUNT(*) FROM course_sections WHERE course_sections.course_id = courses.id) AS configured_sections,
      (SELECT COUNT(*) FROM scheduled_lessons
        JOIN course_sections ON course_sections.id = scheduled_lessons.section_id
        WHERE course_sections.course_id = courses.id) AS scheduled_lessons,
      (SELECT COALESCE(SUM(assigned_group_count), 0) FROM teaching_allocations WHERE teaching_allocations.course_id = courses.id) AS allocated_sections
    FROM courses
    ORDER BY courses.code ASC
  `).all() as Array<{ id: string; code: string; catalog: string | null; revision: number; duration_hours: number | null; sessions_per_week: number; primary_year: number | null; minimum_room_capacity: number | null; requires_lab: number; requires_multi_projector: number; requires_smart_classroom: number; separate_sections_across_days: number; week_pattern: "ALL" | "W1_4" | "W5_8"; week_start: number | null; week_end: number | null; configured_sections: number; scheduled_lessons: number; allocated_sections: number }>;
  return rows.map((row) => ({
    id: row.id,
    code: row.code,
    catalog: row.catalog,
    revision: row.revision,
    durationHours: row.duration_hours,
    sessionsPerWeek: row.sessions_per_week,
    primaryYear: row.primary_year,
    minimumRoomCapacity: row.minimum_room_capacity,
    requiresLab: Boolean(row.requires_lab),
    requiresMultiProjector: Boolean(row.requires_multi_projector),
    requiresSmartClassroom: Boolean(row.requires_smart_classroom),
    separateSectionsAcrossDays: Boolean(row.separate_sections_across_days),
    weekPattern: row.week_pattern,
    weekStart: row.week_start,
    weekEnd: row.week_end,
    allocatedSections: row.allocated_sections,
    configuredSections: row.configured_sections,
    scheduledLessons: row.scheduled_lessons,
    allocationVarianceCount: listCourseAllocationVariances(row.id).length,
  }));
}

export function createManualCourse(input: { code: string; catalog: string | null; sectionCount: number }): CourseRecord {
  // 手动新增用于补充 Excel 遗漏的课程；新生成的班次暂不分配教师和学生班级，
  // 由排课老师明确选择，避免系统自行猜测。
  const db = database();
  // 手动课程只补齐 Excel 缺失行，不会凭空创建教学分配数量；
  // 所有班次初始未分配，教师和学生班级由老师自行设置。
  const create = db.transaction(() => {
    const id = crypto.randomUUID();
    db.prepare("INSERT INTO courses (id, code, catalog) VALUES (?, ?, ?)").run(id, input.code, input.catalog);
    const insertSection = db.prepare("INSERT INTO course_sections (id, course_id, sequence, teacher_id) VALUES (?, ?, ?, NULL)");
    for (let sequence = 1; sequence <= input.sectionCount; sequence += 1) {
      insertSection.run(crypto.randomUUID(), id, sequence);
    }
    return id;
  });
  const id = create();
  // 复用标准查询结果，让手动课程和表格导入课程始终返回完全相同的 API 结构，
  // 后续界面与业务逻辑无需区分资料来源。
  const course = listCourses().find((item) => item.id === id);
  if (!course) throw new Error("The course was created but could not be read.");
  return course;
}

export function resizeCourseSections(courseId: string, sectionCount: number) {
  // 增加数量时接着现有编号生成班次；减少数量时只从编号最大的未排班次开始删除，
  // 绝不会静默丢弃已经排入时间表的工作。
  const db = database();
  // 只调整最高序号一端的班次，保证保留下来的 LEAD_01 至 LEAD_N 标签、
  // 教师分配和学生班级关联都保持稳定。
  const resize = db.transaction(() => {
    const course = db.prepare("SELECT id FROM courses WHERE id = ?").get(courseId) as { id: string } | undefined;
    if (!course) return false;
    const currentSections = db.prepare("SELECT id, sequence, teacher_id FROM course_sections WHERE course_id = ? ORDER BY sequence ASC").all(courseId) as Array<{ id: string; sequence: number; teacher_id: string | null }>;

    if (sectionCount > currentSections.length) {
      const insertSection = db.prepare("INSERT INTO course_sections (id, course_id, sequence, teacher_id) VALUES (?, ?, ?, NULL)");
      for (let sequence = currentSections.length + 1; sequence <= sectionCount; sequence += 1) {
        insertSection.run(crypto.randomUUID(), courseId, sequence);
      }
    }

    if (sectionCount < currentSections.length) {
      const removable = currentSections.filter((section) => section.sequence > sectionCount);
      const hasScheduledLesson = db.prepare("SELECT 1 FROM scheduled_lessons WHERE section_id = ? LIMIT 1");
      const hasStudentGroup = db.prepare("SELECT 1 FROM section_student_groups WHERE section_id = ? LIMIT 1");
      for (const section of removable) {
        // 若要删除的班次已经排课、分配教师或关联学生班级，用户必须先明确清除资料，
        // 防止修正数量时无提示地删除真实工作。即使班次尚未排入总表，教师也是人工决定。
        if (hasScheduledLesson.get(section.id)) throw new Error(`${section.sequence} is already scheduled. Return that section to the tray before reducing the count.`);
        if (section.teacher_id) throw new Error(`${section.sequence} has a teacher. Clear its assignments before reducing the count.`);
        if (hasStudentGroup.get(section.id)) throw new Error(`${section.sequence} has student groups. Clear its assignments before reducing the count.`);
      }
      const removeSection = db.prepare("DELETE FROM course_sections WHERE id = ?");
      for (const section of removable) removeSection.run(section.id);
    }
    return true;
  });
  // IMMEDIATE 让“检查尾部是否仍有资料”和真正删除之间不会被另一服务进程插入新分配。
  return resize.immediate();
}

export class CourseSetupInputError extends Error {
  // 字段范围错误可以安全地原样显示给老师；数据库或 trigger 错误绝不能使用这个类型。
  constructor(message: string) {
    super(message);
    this.name = "CourseSetupInputError";
  }
}

export class CourseSetupStateConflictError extends Error {
  // 已排课次与新设置互相矛盾时返回 409，提醒老师先处理总表上的课程。
  constructor(message: string) {
    super(message);
    this.name = "CourseSetupStateConflictError";
  }
}

export class CourseSetupRevisionConflictError extends Error {
  // 浏览器提交的 revision 不是最新版本，说明另一账号已经先保存。
  constructor() {
    super("This course setup was changed by another scheduler. Reload the latest setup before editing it again.");
    this.name = "CourseSetupRevisionConflictError";
  }
}

export class CourseSetupBusyError extends Error {
  // SQLite 正由另一服务进程写入时提供可重试提示，不向浏览器暴露锁或数据库路径。
  constructor() {
    super("Another scheduler is updating course data. Try again in a moment.");
    this.name = "CourseSetupBusyError";
  }
}

function courseSetupDatabase() {
  // database() 本身会执行幂等结构升级，可能在正式事务开始前遇到 SQLite 写锁；
  // 这里把初始化阶段和后面的 IMMEDIATE 事务统一映射为安全的 503 业务错误。
  try {
    return database();
  } catch (error) {
    if (isSqliteBusyError(error)) throw new CourseSetupBusyError();
    throw error;
  }
}

export function updateCourseSetup(id: string, input: CourseSetupInput): { revision: number; changed: boolean } | null {
  // 课程要求适用于该课生成的每个班次，因此只保存在课程层级；
  // 像 LEAD 有 18 个班次时无需重复存储 18 份相同设置。
  // 业务规则也必须在共用数据库入口验证，因为维护脚本可能绕过网页 API。
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) throw new CourseSetupInputError("Course revision must be a positive whole number.");
  if (!Number.isInteger(input.durationHours) || input.durationHours < 2 || input.durationHours > 4) throw new CourseSetupInputError("Course duration must be 2 to 4 whole hours.");
  if (![1, 2].includes(input.sessionsPerWeek)) throw new CourseSetupInputError("Weekly sessions must be 1 or 2.");
  if (input.primaryYear !== null && ![1, 2, 3].includes(input.primaryYear)) throw new CourseSetupInputError("Primary year must be Year 1, Year 2, Year 3 or blank.");
  if (input.minimumRoomCapacity !== null && (!Number.isSafeInteger(input.minimumRoomCapacity) || input.minimumRoomCapacity < 1)) throw new CourseSetupInputError("Minimum room capacity must be a positive whole number or blank.");
  if (![input.requiresLab, input.requiresMultiProjector, input.requiresSmartClassroom, input.separateSectionsAcrossDays].every((value) => typeof value === "boolean")) throw new CourseSetupInputError("Course requirement switches must be true or false.");
  if ((input.weekStart === null) !== (input.weekEnd === null) || (input.weekStart !== null && input.weekEnd !== null && (!Number.isSafeInteger(input.weekStart) || !Number.isSafeInteger(input.weekEnd) || input.weekStart < 1 || input.weekEnd < input.weekStart))) {
    throw new CourseSetupInputError("Teaching weeks must be blank for all weeks or a valid positive start and end range.");
  }

  const db = courseSetupDatabase();
  const save = db.transaction(() => {
    // 取得写锁后才读取课程和所有排课状态。这样另一位老师不能在检查完成后、
    // UPDATE 执行前插入 occurrence 2、晚课或第一条排课记录。
    const current = db.prepare(`
      SELECT revision, duration_hours, sessions_per_week, primary_year, minimum_room_capacity,
        requires_lab, requires_multi_projector, requires_smart_classroom,
        separate_sections_across_days, week_start, week_end
      FROM courses WHERE id = ?
    `).get(id) as { revision: number; duration_hours: number | null; sessions_per_week: number; primary_year: number | null; minimum_room_capacity: number | null; requires_lab: number; requires_multi_projector: number; requires_smart_classroom: number; separate_sections_across_days: number; week_start: number | null; week_end: number | null } | undefined;
    if (!current) return null;
    if (current.revision !== input.revision) throw new CourseSetupRevisionConflictError();

    // 完全相同的表单不应消耗 revision 或让打开中的 Inspector 失效。
    const changed = current.duration_hours !== input.durationHours
      || current.sessions_per_week !== input.sessionsPerWeek
      || current.primary_year !== input.primaryYear
      || current.minimum_room_capacity !== input.minimumRoomCapacity
      || Boolean(current.requires_lab) !== input.requiresLab
      || Boolean(current.requires_multi_projector) !== input.requiresMultiProjector
      || Boolean(current.requires_smart_classroom) !== input.requiresSmartClassroom
      || Boolean(current.separate_sections_across_days) !== input.separateSectionsAcrossDays
      || current.week_start !== input.weekStart
      || current.week_end !== input.weekEnd;
    // 年级总表只按课程的主要年级读取资料。已有排课时清空年级会留下数据库记录，
    // 但它不会出现在三张总表，因此必须在同一写锁中阻止。
    const hasScheduledLesson = db.prepare(`
      SELECT 1 FROM scheduled_lessons lessons
      JOIN course_sections sections ON sections.id = lessons.section_id
      WHERE sections.course_id = ? LIMIT 1
    `).get(id);
    if (input.primaryYear === null && hasScheduledLesson) throw new CourseSetupStateConflictError("Choose a primary year before saving a course that already has scheduled lessons.");

    // 已排的额外课次和晚课不能被新设置变成超出课程规则的隐藏资料。
    const scheduledExtra = db.prepare(`SELECT 1 FROM scheduled_lessons lessons JOIN course_sections sections ON sections.id = lessons.section_id WHERE sections.course_id = ? AND lessons.occurrence > ? LIMIT 1`).get(id, input.sessionsPerWeek);
    if (scheduledExtra) throw new CourseSetupStateConflictError("Return the extra weekly sessions to the tray before reducing sessions per week.");
    const outsideGrid = db.prepare(`SELECT 1 FROM scheduled_lessons lessons JOIN course_sections sections ON sections.id = lessons.section_id WHERE sections.course_id = ? AND lessons.start_hour + ? > 18 LIMIT 1`).get(id, input.durationHours);
    if (outsideGrid) throw new CourseSetupStateConflictError("Move late lessons earlier before increasing this course duration.");

    // 即使表单没有字段变化，也先完成上面的不变量检查；这样旧版本遗留的隐藏课程
    // 不会被一次 no-op Save 误报为健康成功。合法 no-op 仍不会执行任何 UPDATE。
    if (!changed) return { revision: current.revision, changed: false };

    // WHERE revision = ? 是最终比较后更新保护。即使未来事务结构改变，也不能让旧表单覆盖新设置。
    const result = db.prepare(`
      UPDATE courses SET duration_hours = ?, sessions_per_week = ?, primary_year = ?,
        minimum_room_capacity = ?, requires_lab = ?, requires_multi_projector = ?,
        requires_smart_classroom = ?, separate_sections_across_days = ?, week_pattern = ?,
        week_start = ?, week_end = ?, revision = revision + 1,
        updated_at = CURRENT_TIMESTAMP WHERE id = ? AND revision = ?
    `).run(input.durationHours, input.sessionsPerWeek, input.primaryYear, input.minimumRoomCapacity, input.requiresLab ? 1 : 0, input.requiresMultiProjector ? 1 : 0, input.requiresSmartClassroom ? 1 : 0, input.separateSectionsAcrossDays ? 1 : 0, legacyWeekPattern(input.weekStart, input.weekEnd), input.weekStart, input.weekEnd, id, input.revision);
    if (result.changes !== 1) throw new CourseSetupRevisionConflictError();

    // 每条已排课程冗余保存时长；任何课程设置变化也会改变规则语义，因此全部课次
    // revision 一起增加，阻止仍开着的旧 Inspector 在新规则上继续静默保存。
    db.prepare("UPDATE scheduled_lessons SET duration_hours = ?, revision = revision + 1 WHERE section_id IN (SELECT id FROM course_sections WHERE course_id = ?)").run(input.durationHours, id);
    // warning 重算属于同一次事务。若 trigger、磁盘或规则计算失败，课程、课次和 warning 全部回滚。
    refreshAllScheduleWarnings(db);
    return { revision: input.revision + 1, changed: true };
  });

  try {
    return save.immediate();
  } catch (error) {
    if (error instanceof CourseSetupInputError || error instanceof CourseSetupStateConflictError || error instanceof CourseSetupRevisionConflictError || error instanceof CourseSetupBusyError) throw error;
    if (isSqliteBusyError(error)) throw new CourseSetupBusyError();
    throw error;
  }
}

export function listCourseSections(courseId: string): CourseSectionRecord[] {
  // 把一个班次关联的多个学生班级聚合到同一结果行，
  // 让浏览器能在教师分配旁完整展示该班次涉及的冲突范围。
  const rows = database().prepare(`
    SELECT course_sections.id, courses.code, course_sections.sequence, course_sections.revision, teachers.id AS teacher_id,
      teachers.name AS teacher_name, student_groups.id AS group_id, student_groups.code AS group_code
    FROM course_sections
    JOIN courses ON courses.id = course_sections.course_id
    LEFT JOIN teachers ON teachers.id = course_sections.teacher_id
    LEFT JOIN section_student_groups ON section_student_groups.section_id = course_sections.id
    LEFT JOIN student_groups ON student_groups.id = section_student_groups.student_group_id
    WHERE course_sections.course_id = ?
    ORDER BY course_sections.sequence ASC, student_groups.code ASC
  `).all(courseId) as Array<{ id: string; code: string; sequence: number; revision: number; teacher_id: string | null; teacher_name: string | null; group_id: string | null; group_code: string | null }>;
  const sections = new Map<string, CourseSectionRecord>();
  for (const row of rows) {
    const section = sections.get(row.id) ?? { id: row.id, label: `${row.code}_${String(row.sequence).padStart(2, "0")}`, teacherId: row.teacher_id, teacherName: row.teacher_name, studentGroupIds: [], studentGroupCodes: [], revision: row.revision };
    if (row.group_id && row.group_code) {
      section.studentGroupIds.push(row.group_id);
      section.studentGroupCodes.push(row.group_code);
    }
    sections.set(row.id, section);
  }
  return [...sections.values()];
}

export function listCourseAllocationVariances(courseId: string): AllocationVarianceRecord[] {
  // 比较导入的教师班次数量与当前实际班次分配。系统允许老师手动替换任课教师，
  // 但会把与原分配不一致的情况清楚显示给排课人员。
  const db = database();
  // 手动课程没有 Teaching Members 的原始分配基线，因此自由选择的教师
  // 不应被误报为与一个根本不存在的分配不一致。
  const hasAllocation = db.prepare("SELECT 1 FROM teaching_allocations WHERE course_id = ? LIMIT 1").get(courseId);
  if (!hasAllocation) return [];

  // 结果同时包含预期教师和当前实际使用的代课教师。
  // 相关子查询使计算逻辑容易阅读，而且在院系规模的数据量下性能足够。
  const rows = db.prepare(`
    SELECT teachers.id, teachers.name,
      COALESCE((SELECT assigned_group_count FROM teaching_allocations allocations WHERE allocations.course_id = ? AND allocations.teacher_id = teachers.id), 0) AS expected_sections,
      (SELECT COUNT(*) FROM course_sections sections WHERE sections.course_id = ? AND sections.teacher_id = teachers.id) AS actual_sections
    FROM teachers
    WHERE EXISTS (SELECT 1 FROM teaching_allocations allocations WHERE allocations.course_id = ? AND allocations.teacher_id = teachers.id)
       OR EXISTS (SELECT 1 FROM course_sections sections WHERE sections.course_id = ? AND sections.teacher_id = teachers.id)
    ORDER BY teachers.name
  `).all(courseId, courseId, courseId, courseId) as Array<{ id: string; name: string; expected_sections: number; actual_sections: number }>;
  return rows
    .filter((row) => row.expected_sections !== row.actual_sections)
    .map((row) => ({ teacherId: row.id, teacherName: row.name, expectedSections: row.expected_sections, actualSections: row.actual_sections }));
}

export class CourseSectionRevisionConflictError extends Error {
  // 专用错误类型让 API 把多人同时保存识别为 409，而不是误报成教师或班级格式错误。
  constructor() {
    super("This section was changed by another scheduler. The latest assignments have been reloaded. Review them before saving again.");
    this.name = "CourseSectionRevisionConflictError";
  }
}

export class CourseSectionInputError extends Error {
  // 已知的教师或学生班级选择错误可以安全显示给老师，未知数据库错误则不能暴露内部细节。
  constructor(message: string) {
    super(message);
    this.name = "CourseSectionInputError";
  }
}

export function updateCourseSection(id: string, input: { teacherId: string | null; studentGroupIds: string[]; revision: number }) {
  // 教师和学生班级属于整个班次的共享资料；独立 revision 与事务 CAS
  // 可阻止两个账号从旧页面先后保存时，后提交者静默覆盖先提交者。
  const db = database();
  const transaction = db.transaction(() => {
    const section = db.prepare("SELECT id, course_id, teacher_id, revision FROM course_sections WHERE id = ?").get(id) as { id: string; course_id: string; teacher_id: string | null; revision: number } | undefined;
    if (!section) return null;
    if (section.revision !== input.revision) throw new CourseSectionRevisionConflictError();

    const teacherChanged = input.teacherId !== section.teacher_id;

    // 停用教师不能被分配给新的班次，但旧班次必须能够保留原教师并继续修改学生班级。
    // 因此只有教师 ID 真正改变时才要求目标教师处于启用状态；所有验证仍留在同一个事务中。
    if (input.teacherId && teacherChanged) {
      const teacher = db.prepare("SELECT id FROM teachers WHERE id = ? AND is_active = 1").get(input.teacherId);
      if (!teacher) throw new CourseSectionInputError("Choose an active teacher.");
    }
    const studentGroupIds = [...new Set(input.studentGroupIds)];
    if (studentGroupIds.length > 0) {
      const placeholders = studentGroupIds.map(() => "?").join(", ");
      const validGroups = db.prepare(`SELECT id FROM student_groups WHERE id IN (${placeholders})`).all(...studentGroupIds) as Array<{ id: string }>;
      if (validGroups.length !== studentGroupIds.length) throw new CourseSectionInputError("Choose valid student groups.");
    }

    const currentGroups = db.prepare("SELECT student_group_id FROM section_student_groups WHERE section_id = ? ORDER BY student_group_id").all(id) as Array<{ student_group_id: string }>;
    const currentGroupIds = currentGroups.map((group) => group.student_group_id);
    const sortedStudentGroupIds = [...studentGroupIds].sort();
    const groupsChanged = currentGroupIds.length !== sortedStudentGroupIds.length || currentGroupIds.some((groupId, index) => groupId !== sortedStudentGroupIds[index]);
    // revision 的比较必须出现在 UPDATE 条件中，不能只依靠前面的 SELECT；这样即使另一进程
    // 恰好在两条语句之间先保存，changes 也会变成 0，并触发明确的并发冲突。
    const updateResult = teacherChanged
      ? db.prepare("UPDATE course_sections SET teacher_id = ?, allocation_teacher_id = NULL, revision = revision + 1 WHERE id = ? AND revision = ?").run(input.teacherId, id, input.revision)
      : db.prepare("UPDATE course_sections SET revision = revision + 1 WHERE id = ? AND revision = ?").run(id, input.revision);
    if (updateResult.changes !== 1) throw new CourseSectionRevisionConflictError();

    if (groupsChanged) {
      db.prepare("DELETE FROM section_student_groups WHERE section_id = ?").run(id);
      const addGroup = db.prepare("INSERT INTO section_student_groups (section_id, student_group_id) VALUES (?, ?)");
      for (const groupId of sortedStudentGroupIds) addGroup.run(id, groupId);
    }

    if (teacherChanged || groupsChanged) {
      // 共享分配真正变化后，同一班次的所有已排课次和旧 Inspector 都必须失效；
      // warning 刷新也留在同一外层事务中，失败时教师、班级和 revision 会一起回滚。
      db.prepare("UPDATE scheduled_lessons SET revision = revision + 1 WHERE section_id = ?").run(id);
      refreshAllScheduleWarnings(db);
    }
    return { courseId: section.course_id, revision: section.revision + 1 };
  });
  // IMMEDIATE 先取得写入次序，避免另一进程恰好在验证 Active 状态与保存教师之间插入停用操作。
  return transaction.immediate();
}

export function listScheduledLessons(year: number): ScheduledLessonRecord[] {
  // 年级总表按课程的主要年级筛选；每条排课记录仍保留全部跨年级学生班级关联，
  // 因此其他年级发生重叠时仍能正确提示冲突。
  const rows = database().prepare(`
    SELECT lessons.id, lessons.section_id, courses.code, sections.sequence, teachers.id AS teacher_id, teachers.name AS teacher_name,
      lessons.day_of_week, lessons.start_hour, lessons.duration_hours, lessons.room_id,
      lessons.warnings_json, lessons.occurrence, lessons.revision, courses.sessions_per_week,
      courses.week_start, courses.week_end,
      rooms.code AS room_code,
      (SELECT GROUP_CONCAT(groups.id, ',')
        FROM section_student_groups links
        JOIN student_groups groups ON groups.id = links.student_group_id
        WHERE links.section_id = sections.id) AS student_group_ids,
      (SELECT GROUP_CONCAT(groups.code, ', ')
        FROM section_student_groups links
        JOIN student_groups groups ON groups.id = links.student_group_id
        WHERE links.section_id = sections.id) AS student_groups
    FROM scheduled_lessons lessons
    JOIN course_sections sections ON sections.id = lessons.section_id
    JOIN courses ON courses.id = sections.course_id
    LEFT JOIN teachers ON teachers.id = sections.teacher_id
    LEFT JOIN rooms ON rooms.id = lessons.room_id
    WHERE courses.primary_year = ? ORDER BY lessons.day_of_week, lessons.start_hour
  `).all(year) as Array<{ id: string; section_id: string; code: string; sequence: number; teacher_id: string | null; teacher_name: string | null; day_of_week: number; start_hour: number; duration_hours: number; room_id: string | null; warnings_json: string; occurrence: number; revision: number; sessions_per_week: number; week_start: number | null; week_end: number | null; room_code: string | null; student_group_ids: string | null; student_groups: string | null }>;
  return rows.map((row) => {
    // 把该课程最高严重等级附加到结果中，使时间表卡片和综合问题清单使用同一套颜色标准，
    // 前端不必再次解析规则文字来判断颜色。
    const warnings = JSON.parse(row.warnings_json) as string[];
    return { id: row.id, sectionId: row.section_id, sectionLabel: `${row.code}_${String(row.sequence).padStart(2, "0")}${row.sessions_per_week > 1 ? ` · Session ${row.occurrence}` : ""}${weekRangeSuffix(row.week_start, row.week_end)}`, courseCode: row.code, teacherId: row.teacher_id, teacherName: row.teacher_name, dayOfWeek: row.day_of_week, startHour: row.start_hour, durationHours: row.duration_hours, roomId: row.room_id, roomCode: row.room_code, studentGroupIds: row.student_group_ids ? row.student_group_ids.split(",") : [], studentGroups: row.student_groups ? row.student_groups.split(", ") : [], occurrence: row.occurrence, sessionsPerWeek: row.sessions_per_week, revision: row.revision, warnings, warningSeverity: highestIssueSeverity(warnings) };
  });
}

export function listPersonalScheduledLessons(kind: "Teacher" | "StudentGroup" | "Room", ownerId: string): ScheduledLessonRecord[] {
  // 教师、学生班级和教室视图都查询三个年级共用的同一批排课记录，
  // 系统不会为个人视图复制另一份时间表数据。
  const db = database();
  // 教师和教室日程横跨三个年级总表；学生班级日程通过关联表查询，
  // 因而跨年级课程会出现在每个参与班级的视图中。
  const ownerFilter = kind === "Teacher"
    ? "sections.teacher_id = ?"
    : kind === "Room"
      ? "lessons.room_id = ?"
      : "personal_links.student_group_id = ?";
  // 学生班级视图从“每节课再执行一条关联子查询”改为直接 JOIN 反向索引。
  // 教师和教室不需要这张关联表，因此只在 StudentGroup 分支加入 JOIN，避免产生重复课程行。
  const personalGroupJoin = kind === "StudentGroup"
    ? "JOIN section_student_groups personal_links ON personal_links.section_id = sections.id"
    : "";
  const rows = db.prepare(`
    SELECT lessons.id, lessons.section_id, courses.code, sections.sequence,
      teachers.id AS teacher_id, teachers.name AS teacher_name, lessons.day_of_week,
      lessons.start_hour, lessons.duration_hours, lessons.room_id,
      lessons.warnings_json, lessons.occurrence, lessons.revision, courses.sessions_per_week,
      courses.week_start, courses.week_end,
      rooms.code AS room_code,
      (SELECT GROUP_CONCAT(groups.id, ',')
        FROM section_student_groups links
        JOIN student_groups groups ON groups.id = links.student_group_id
        WHERE links.section_id = sections.id) AS student_group_ids,
      (SELECT GROUP_CONCAT(groups.code, ', ')
        FROM section_student_groups links
        JOIN student_groups groups ON groups.id = links.student_group_id
        WHERE links.section_id = sections.id) AS student_groups
    FROM scheduled_lessons lessons
    JOIN course_sections sections ON sections.id = lessons.section_id
    JOIN courses ON courses.id = sections.course_id
    ${personalGroupJoin}
    LEFT JOIN teachers ON teachers.id = sections.teacher_id
    LEFT JOIN rooms ON rooms.id = lessons.room_id
    WHERE ${ownerFilter}
    ORDER BY lessons.day_of_week, lessons.start_hour, courses.code, sections.sequence
  `).all(ownerId) as Array<{ id: string; section_id: string; code: string; sequence: number; teacher_id: string | null; teacher_name: string | null; day_of_week: number; start_hour: number; duration_hours: number; room_id: string | null; warnings_json: string; occurrence: number; revision: number; sessions_per_week: number; week_start: number | null; week_end: number | null; room_code: string | null; student_group_ids: string | null; student_groups: string | null }>;
  return rows.map((row) => {
    // 教师、学生和教室个人视图使用服务器计算出的同一个问题等级，
    // 与年级总表的卡片颜色和警告含义完全一致。
    const warnings = JSON.parse(row.warnings_json) as string[];
    return { id: row.id, sectionId: row.section_id, sectionLabel: `${row.code}_${String(row.sequence).padStart(2, "0")}${row.sessions_per_week > 1 ? ` · Session ${row.occurrence}` : ""}${weekRangeSuffix(row.week_start, row.week_end)}`, courseCode: row.code, teacherId: row.teacher_id, teacherName: row.teacher_name, dayOfWeek: row.day_of_week, startHour: row.start_hour, durationHours: row.duration_hours, roomId: row.room_id, roomCode: row.room_code, studentGroupIds: row.student_group_ids ? row.student_group_ids.split(",") : [], studentGroups: row.student_groups ? row.student_groups.split(", ") : [], occurrence: row.occurrence, sessionsPerWeek: row.sessions_per_week, revision: row.revision, warnings, warningSeverity: highestIssueSeverity(warnings) };
  });
}

export function listUnscheduledSections(year: number): UnscheduledSectionRecord[] {
  // 只有已经设置课程时长的班次才能拖入时间表；资料未完成的班次仍显示在 Courses 页面，
  // 提醒老师先补齐时长和主要年级等必要设置。
  const rows = database().prepare(`
    SELECT sections.id, courses.code, sections.sequence, courses.duration_hours,
      courses.sessions_per_week, courses.week_start, courses.week_end, occurrences.occurrence,
      teachers.name AS teacher_name, teachers.is_active AS teacher_is_active,
      teachers.staff_type, student_groups.code AS group_code
    FROM course_sections sections
    JOIN courses ON courses.id = sections.course_id
    JOIN (SELECT 1 AS occurrence UNION ALL SELECT 2) occurrences
      ON occurrences.occurrence <= courses.sessions_per_week
    LEFT JOIN teachers ON teachers.id = sections.teacher_id
    LEFT JOIN section_student_groups links ON links.section_id = sections.id
    LEFT JOIN student_groups ON student_groups.id = links.student_group_id
    WHERE courses.primary_year = ? AND courses.duration_hours IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM scheduled_lessons WHERE scheduled_lessons.section_id = sections.id AND scheduled_lessons.occurrence = occurrences.occurrence)
    ORDER BY CASE
      WHEN teachers.is_active = 1 AND teachers.staff_type = 'PT' THEN 0
      WHEN teachers.is_active = 1 THEN 1
      ELSE 2
    END,
      courses.code, sections.sequence, occurrences.occurrence, student_groups.code
  `).all(year) as Array<{ id: string; code: string; sequence: number; duration_hours: number; sessions_per_week: number; week_start: number | null; week_end: number | null; occurrence: number; teacher_name: string | null; teacher_is_active: number | null; staff_type: "FT" | "PT" | null; group_code: string | null }>;
  const sections = new Map<string, UnscheduledSectionRecord>();
  for (const row of rows) {
    // 每周上两次的同一班次会生成两张独立待排卡片，分别代表第一和第二次课。
    const occurrenceKey = `${row.id}:${row.occurrence}`;
    const section = sections.get(occurrenceKey) ?? { id: occurrenceKey, label: `${row.code}_${String(row.sequence).padStart(2, "0")}${row.sessions_per_week > 1 ? ` · Session ${row.occurrence}` : ""}${weekRangeSuffix(row.week_start, row.week_end)}`, teacherName: row.teacher_name, teacherIsActive: row.teacher_is_active === null ? null : row.teacher_is_active === 1, staffType: row.staff_type, durationHours: row.duration_hours, studentGroups: [], occurrence: row.occurrence, sessionsPerWeek: row.sessions_per_week };
    if (row.group_code) section.studentGroups.push(row.group_code);
    sections.set(occurrenceKey, section);
  }
  return [...sections.values()];
}

type DailyInterval = { startHour: number; durationHours: number; block: string | null };

function longestContinuousHours(intervals: DailyInterval[]) {
  // 首尾相接的课程视为同一个连续教学时段；发生重叠的区间先合并，
  // 让连续上课警告按真实经过时间计算，而不是重复累计冲突部分。
  const ordered = [...intervals].sort((left, right) => left.startHour - right.startHour);
  let longest = 0;
  let blockStart = ordered[0]?.startHour ?? 0;
  let blockEnd = blockStart;
  for (const interval of ordered) {
    const endHour = interval.startHour + interval.durationHours;
    if (interval.startHour > blockEnd) {
      longest = Math.max(longest, blockEnd - blockStart);
      blockStart = interval.startHour;
    }
    blockEnd = Math.max(blockEnd, endHour);
  }
  return Math.max(longest, blockEnd - blockStart);
}

function hasLunchHour(intervals: DailyInterval[]) {
  // 课程都以整点为边界，因此在 12:00–14:00 午餐窗口中，
  // 只要 12:00–13:00 或 13:00–14:00 任一小时没有课程，就满足一小时休息要求。
  const occupied = (hour: number) => intervals.some((interval) => interval.startHour <= hour && interval.startHour + interval.durationHours >= hour + 1);
  return !occupied(12) || !occupied(13);
}

function hasBackToBackBlockChange(intervals: DailyInterval[], proposed: DailyInterval) {
  // 跨楼提醒只检查时间上紧邻的两节课，并且要求两个教室都能解析出 Block 楼栋信息。
  if (!proposed.block) return false;
  const proposedEnd = proposed.startHour + proposed.durationHours;
  return intervals.some((interval) => interval.block && interval.block !== proposed.block && (interval.startHour + interval.durationHours === proposed.startHour || interval.startHour === proposedEnd));
}

type PlacementWarningInput = {
  sectionId: string;
  lessonId?: string;
  teacherId: string | null;
  roomId: string | null;
  dayOfWeek: number;
  startHour: number;
  durationHours: number;
};

function preparePlacementWarningStatements(db: DatabaseInstance) {
  // better-sqlite3 的 prepare 会编译 SQL。候选时段可能连续检查上千个“时间 + 教室”组合，
  // 全量刷新也会逐节重算警告；因此每批工作只编译一次，再用不同参数重复执行。
  // 这里只复用 Statement，不缓存查询结果，所以同一事务里刚写入的课程、规则或资料仍会被下一次执行看到。
  const prepare = (sql: string) => db.prepare(`/* timetabling:placement-warning */ ${sql}`);
  return {
    // 第一组查询负责读取课程政策、同日限制以及所有会发生时间重叠的既有课程。
    enabledRules: prepare("SELECT rule_key FROM rule_settings WHERE is_enabled = 1"),
    courseRule: prepare(`SELECT courses.id, courses.code, courses.sessions_per_week, courses.separate_sections_across_days, courses.week_start, courses.week_end FROM courses JOIN course_sections ON course_sections.course_id = courses.id WHERE course_sections.id = ?`),
    sameSectionDay: prepare("SELECT 1 FROM scheduled_lessons WHERE id <> ? AND section_id = ? AND day_of_week = ?"),
    sameCourseDay: prepare(`SELECT 1 FROM scheduled_lessons lessons JOIN course_sections sections ON sections.id = lessons.section_id WHERE lessons.id <> ? AND sections.course_id = ? AND lessons.day_of_week = ?`),
    overlaps: prepare(`
      SELECT lessons.id, sections.teacher_id, lessons.room_id
      FROM scheduled_lessons lessons
      JOIN course_sections sections ON sections.id = lessons.section_id
      JOIN courses occupied_courses ON occupied_courses.id = sections.course_id
      WHERE lessons.id <> ? AND lessons.day_of_week = ?
        AND lessons.start_hour < ? AND lessons.start_hour + lessons.duration_hours > ?
        AND (? IS NULL OR occupied_courses.week_start IS NULL
          OR (occupied_courses.week_start <= ? AND ? <= occupied_courses.week_end))
    `),

    // 第二组查询检查教师、学生班级和年级不可用时段；跨年级课程会返回多个 affected year。
    teacherStatus: prepare("SELECT is_active FROM teachers WHERE id = ?"),
    teacherUnavailable: prepare("SELECT 1 FROM teacher_unavailable_windows WHERE teacher_id = ? AND day_of_week = ? AND start_hour < ? AND end_hour > ?"),
    groupConflicts: prepare(`
      SELECT DISTINCT groups.code FROM scheduled_lessons lessons
      JOIN course_sections occupied_sections ON occupied_sections.id = lessons.section_id
      JOIN courses occupied_courses ON occupied_courses.id = occupied_sections.course_id
      JOIN section_student_groups occupied ON occupied.section_id = lessons.section_id
      JOIN section_student_groups proposed ON proposed.student_group_id = occupied.student_group_id
      JOIN student_groups groups ON groups.id = occupied.student_group_id
      WHERE proposed.section_id = ? AND lessons.id <> ? AND lessons.day_of_week = ?
        AND lessons.start_hour < ? AND lessons.start_hour + lessons.duration_hours > ?
        AND (? IS NULL OR occupied_courses.week_start IS NULL
          OR (occupied_courses.week_start <= ? AND ? <= occupied_courses.week_end))
      ORDER BY groups.code
    `),
    groupCount: prepare("SELECT COUNT(*) AS count FROM section_student_groups WHERE section_id = ?"),
    affectedYears: prepare(`SELECT DISTINCT year FROM student_groups JOIN section_student_groups ON section_student_groups.student_group_id = student_groups.id WHERE section_student_groups.section_id = ? UNION SELECT primary_year AS year FROM courses JOIN course_sections ON course_sections.course_id = courses.id WHERE course_sections.id = ? AND primary_year IS NOT NULL`),
    yearBlocked: prepare("SELECT 1 FROM year_blocked_windows WHERE year = ? AND day_of_week = ? AND start_hour < ? AND end_hour > ?"),

    // 第三组查询检查教室要求，并读取教师与每个学生班级当天的课程，用于午餐、连续时长和跨楼提醒。
    roomSuitability: prepare(`SELECT rooms.code, rooms.capacity, rooms.has_multi_projector, rooms.is_lab, rooms.is_smart_classroom, rooms.is_active, courses.minimum_room_capacity, courses.requires_multi_projector, courses.requires_lab, courses.requires_smart_classroom FROM rooms JOIN course_sections sections ON sections.id = ? JOIN courses ON courses.id = sections.course_id WHERE rooms.id = ?`),
    roomBlock: prepare("SELECT block FROM rooms WHERE id = ?"),
    teacherDay: prepare(`
      SELECT lessons.start_hour, lessons.duration_hours, rooms.block
      FROM scheduled_lessons lessons
      JOIN course_sections sections ON sections.id = lessons.section_id
      JOIN courses occupied_courses ON occupied_courses.id = sections.course_id
      LEFT JOIN rooms ON rooms.id = lessons.room_id
      WHERE lessons.id <> ? AND sections.teacher_id = ? AND lessons.day_of_week = ?
        AND (? IS NULL OR occupied_courses.week_start IS NULL
          OR (occupied_courses.week_start <= ? AND ? <= occupied_courses.week_end))
    `),
    proposedGroups: prepare("SELECT student_groups.id, student_groups.code FROM section_student_groups JOIN student_groups ON student_groups.id = section_student_groups.student_group_id WHERE section_id = ?"),
    groupDay: prepare(`
      SELECT DISTINCT lessons.id, lessons.start_hour, lessons.duration_hours, rooms.block
      FROM scheduled_lessons lessons
      JOIN course_sections sections ON sections.id = lessons.section_id
      JOIN courses occupied_courses ON occupied_courses.id = sections.course_id
      JOIN section_student_groups links ON links.section_id = lessons.section_id
      LEFT JOIN rooms ON rooms.id = lessons.room_id
      WHERE lessons.id <> ? AND links.student_group_id = ? AND lessons.day_of_week = ?
        AND (? IS NULL OR occupied_courses.week_start IS NULL
          OR (occupied_courses.week_start <= ? AND ? <= occupied_courses.week_end))
    `),
  };
}

type PlacementWarningStatements = ReturnType<typeof preparePlacementWarningStatements>;

function calculatePlacementWarnings(input: PlacementWarningInput, statements: PlacementWarningStatements) {
  // 所有排课入口都使用同一个警告引擎，确保拖放、编辑以及候选时段建议
  // 对同一种冲突采用完全一致的定义。
  const warnings: string[] = [];
  const lessonId = input.lessonId ?? "";
  const endHour = input.startHour + input.durationHours;
  // 可选政策规则可能每学期调整；下面的教师、班级、教室和时间重叠属于核心冲突，
  // 始终无条件检查，刻意不放进可关闭规则集合。
  const enabledRules = new Set((statements.enabledRules.all() as Array<{ rule_key: string }>).map((row) => row.rule_key));
  const courseRule = statements.courseRule.get(input.sectionId) as { id: string; code: string; sessions_per_week: number; separate_sections_across_days: number; week_start: number | null; week_end: number | null } | undefined;
  // 正常外键和候选只读快照保证班次一定关联课程；仍显式检查内部不变量，
  // 避免未来事务边界调整后把 undefined 解引用文字意外送进路由错误处理。
  if (!courseRule) throw new Error("Warning calculation source was not found.");
  if (courseRule.sessions_per_week > 1 && enabledRules.has("separate_weekly_sessions")) {
    // 同一班次每周分开的两次课不应排在同一天，
    // 否则名义上的“每周两次”会变成同一天的一段长课。
    const sameSectionDay = statements.sameSectionDay.get(lessonId, input.sectionId, input.dayOfWeek);
    if (sameSectionDay) warnings.push(`${courseRule.code} weekly sessions should be scheduled on different days`);
  }
  if (courseRule.separate_sections_across_days) {
    const sameDay = statements.sameCourseDay.get(lessonId, courseRule.id, input.dayOfWeek);
    if (sameDay) warnings.push(`${courseRule.code} sections should not be scheduled on the same day`);
  }
  // 周次边界为空表示覆盖全学期。两个有限周次范围按包含端点方式判断重叠：
  // 若它们在同一周相接，该周仍同时上课，因此属于冲突。
  const overlaps = statements.overlaps.all(lessonId, input.dayOfWeek, endHour, input.startHour, courseRule.week_start, courseRule.week_end, courseRule.week_start) as Array<{ id: string; teacher_id: string | null; room_id: string | null }>;

  // 草拟阶段允许暂时缺少教师、学生班级或教室分配，但系统会持续显示警告提醒补齐。
  if (!input.teacherId) warnings.push("Teacher not assigned");
  else {
    // 停用不会删除旧排课中的教师关联。系统用高优先级警告说明这位教师已不在可用名单中，
    // 让老师仍可移动课程或修正其他资料，同时候选位置会因为存在警告而自动排除该班次。
    const teacher = statements.teacherStatus.get(input.teacherId) as { is_active: number } | undefined;
    if (!teacher || teacher.is_active !== 1) warnings.push("Teacher is inactive");
    if (overlaps.some((row) => row.teacher_id === input.teacherId)) warnings.push("Teacher conflict");
    const unavailable = statements.teacherUnavailable.get(input.teacherId, input.dayOfWeek, endHour, input.startHour);
    if (unavailable) warnings.push("Teacher is unavailable at this time");
  }
  if (!input.roomId) warnings.push("Room not assigned");
  else if (overlaps.some((row) => row.room_id === input.roomId)) warnings.push("Room conflict");

  // 通过稳定的学生班级 ID 比较重叠课程，因此也能识别跨年级课程共享班级造成的冲突。
  const groupConflicts = statements.groupConflicts.all(input.sectionId, lessonId, input.dayOfWeek, endHour, input.startHour, courseRule.week_start, courseRule.week_end, courseRule.week_start) as Array<{ code: string }>;
  if (groupConflicts.length) warnings.push(`Student group conflict (${groupConflicts.map((group) => group.code).join(", ")})`);
  const groupCount = statements.groupCount.get(input.sectionId) as { count: number };
  if (groupCount.count === 0) warnings.push("Student group not assigned");
  const affectedYears = statements.affectedYears.all(input.sectionId, input.sectionId) as Array<{ year: number }>;
  for (const affected of affectedYears) {
    const blocked = statements.yearBlocked.get(affected.year, input.dayOfWeek, endHour, input.startHour);
    if (blocked) warnings.push(`Year ${affected.year} is unavailable at this time`);
  }

  // 所选教室必须同时满足该课程的所有设施和容量要求；保存教室资料时已经保证
  // Smart Classroom 自动包含 Multi Projector 属性。
  if (input.roomId) {
    const suitability = statements.roomSuitability.get(input.sectionId, input.roomId) as { code: string; capacity: number; has_multi_projector: number; is_lab: number; is_smart_classroom: number; is_active: number; minimum_room_capacity: number | null; requires_multi_projector: number; requires_lab: number; requires_smart_classroom: number } | undefined;
    if (!suitability || !suitability.is_active) warnings.push("Room is unavailable");
    else {
      if (suitability.minimum_room_capacity && suitability.capacity < suitability.minimum_room_capacity) warnings.push(`Room capacity too small (${suitability.capacity}/${suitability.minimum_room_capacity})`);
      if (suitability.requires_lab && !suitability.is_lab) warnings.push("Lab room required");
      if (suitability.requires_multi_projector && !suitability.has_multi_projector) warnings.push("Multi Projector required");
      if (suitability.requires_smart_classroom && !suitability.is_smart_classroom) warnings.push("Smart Classroom required");
    }
  }

  // 院系偏好最早 09:00 开课；08:00 仍然允许使用，但会作为软规则产生提醒。
  if (input.startHour === 8 && enabledRules.has("prefer_9am")) warnings.push("08:00 start is discouraged");

  const proposedRoom = input.roomId ? statements.roomBlock.get(input.roomId) as { block: string | null } | undefined : undefined;
  const proposed = { startHour: input.startHour, durationHours: input.durationHours, block: proposedRoom?.block ?? null };
  if (input.teacherId) {
    const teacherDay = statements.teacherDay.all(lessonId, input.teacherId, input.dayOfWeek, courseRule.week_start, courseRule.week_end, courseRule.week_start) as Array<{ start_hour: number; duration_hours: number; block: string | null }>;
    const existing = teacherDay.map((lesson) => ({ startHour: lesson.start_hour, durationHours: lesson.duration_hours, block: lesson.block }));
    const combined = [...existing, proposed];
    if (enabledRules.has("lunch_break") && !hasLunchHour(combined)) warnings.push("Teacher has no free lunch hour between 12:00 and 14:00");
    if (enabledRules.has("max_continuous") && longestContinuousHours(combined) > 4) warnings.push("Teacher has more than 4 continuous hours");
    if (enabledRules.has("teacher_daily_limit") && combined.reduce((total, lesson) => total + lesson.durationHours, 0) > 7) warnings.push("Teacher exceeds 7 teaching hours in one day");
    if (enabledRules.has("same_block") && hasBackToBackBlockChange(existing, proposed)) warnings.push("Teacher has back-to-back lessons in different blocks");
  }

  // 每个关联学生班级都要分别评估，因为一节跨年级课程的单次排课
  // 可能同时影响多个年级总表的每日时长和连续上课限制。
  const proposedGroups = statements.proposedGroups.all(input.sectionId) as Array<{ id: string; code: string }>;
  for (const group of proposedGroups) {
    const groupDay = statements.groupDay.all(lessonId, group.id, input.dayOfWeek, courseRule.week_start, courseRule.week_end, courseRule.week_start) as Array<{ id: string; start_hour: number; duration_hours: number; block: string | null }>;
    const existing = groupDay.map((lesson) => ({ startHour: lesson.start_hour, durationHours: lesson.duration_hours, block: lesson.block }));
    const combined = [...existing, proposed];
    if (enabledRules.has("lunch_break") && !hasLunchHour(combined)) warnings.push(`${group.code} has no free lunch hour between 12:00 and 14:00`);
    if (enabledRules.has("max_continuous") && longestContinuousHours(combined) > 4) warnings.push(`${group.code} has more than 4 continuous hours`);
    if (enabledRules.has("student_daily_limit") && combined.reduce((total, lesson) => total + lesson.durationHours, 0) > 6) warnings.push(`${group.code} exceeds 6 class hours in one day`);
    if (enabledRules.has("same_block") && hasBackToBackBlockChange(existing, proposed)) warnings.push(`${group.code} has back-to-back lessons in different blocks`);
  }
  return warnings;
}

function refreshAllScheduleWarnings(db: DatabaseInstance, warningStatements: PlacementWarningStatements = preparePlacementWarningStatements(db)) {
  // 课程位置、班次分配、教室或规则的任何变化都可能影响相邻卡片。
  // 修改后统一重新计算这个院系规模不大的时间表，使所有年级和个人视图
  // 读取同一份一致的警告快照。
  const lessons = db.prepare(`
    SELECT lessons.id, lessons.section_id, lessons.day_of_week, lessons.start_hour,
      lessons.duration_hours, lessons.room_id, sections.teacher_id
    FROM scheduled_lessons lessons
    JOIN course_sections sections ON sections.id = lessons.section_id
    ORDER BY lessons.id
  `).all() as Array<{ id: string; section_id: string; day_of_week: number; start_hour: number; duration_hours: number; room_id: string | null; teacher_id: string | null }>;
  const warningsByLesson = new Map<string, string[]>();
  const saveWarnings = db.prepare("UPDATE scheduled_lessons SET warnings_json = ? WHERE id = ?");
  const refresh = db.transaction(() => {
    for (const lesson of lessons) {
      // warningStatements 属于当前这一次刷新，不跨请求保存；每节课只更换参数，
      // 既省去重复编译 SQL，又能读取本事务前面刚刚写入的最新资料。
      const warnings = calculatePlacementWarnings({ sectionId: lesson.section_id, lessonId: lesson.id, teacherId: lesson.teacher_id, roomId: lesson.room_id, dayOfWeek: lesson.day_of_week, startHour: lesson.start_hour, durationHours: lesson.duration_hours }, warningStatements);
      saveWarnings.run(JSON.stringify(warnings), lesson.id);
      warningsByLesson.set(lesson.id, warnings);
    }
  });
  refresh();
  return warningsByLesson;
}

function describeIssue(message: string): Pick<ScheduleIssueRecord, "category" | "severity"> {
  // 摘要标签帮助老师快速浏览较长的问题列表，但不会改变底层规则行为：
  // 所有问题都只是警告，永远不会阻止用户保存排课。
  if (message.includes("not assigned")) return { category: "Assignment", severity: "Advisory" };
  if (message.includes("inactive")) return { category: "Availability", severity: "High" };
  if (message.includes("unavailable")) return { category: "Availability", severity: "High" };
  if (message.includes("conflict")) return { category: "Conflict", severity: "High" };
  if (message.includes("required") || message.includes("capacity too small")) return { category: "Room", severity: "High" };
  if (message.includes("different blocks")) return { category: "Travel", severity: "Advisory" };
  if (message.includes("discouraged")) return { category: "Preference", severity: "Advisory" };
  if (message.includes("weekly sessions should")) return { category: "Course rule", severity: "High" };
  if (message.includes("sections should not")) return { category: "Course rule", severity: "High" };
  if (message.includes("no free lunch hour") || message.includes("more than 4 continuous hours")) return { category: "Workload", severity: "High" };
  return { category: "Workload", severity: "Warning" };
}

function highestIssueSeverity(messages: string[]): "High" | "Warning" | "Advisory" | null {
  // 一节课有多条规则消息时，只取最紧急等级决定卡片颜色：红色高于黄色，
  // 黄色高于蓝色；没有消息时则不显示问题颜色。
  const severities = messages.map((message) => describeIssue(message).severity);
  if (severities.includes("High")) return "High";
  if (severities.includes("Warning")) return "Warning";
  if (severities.includes("Advisory")) return "Advisory";
  return null;
}

export function listScheduleIssues(): ScheduleIssueRecord[] {
  // 把写入操作已经保存的多条 warning 展开为可排序的问题记录，
  // 供全局问题清单和年级检查面板共同使用。GET 必须保持纯读取：如果先读旧课程
  // 再晚于另一个写事务回写 warning，反而可能覆盖刚提交的新规则结果。
  const db = database();
  const rows = db.prepare(`
    SELECT lessons.id, lessons.section_id, lessons.day_of_week, lessons.start_hour,
      lessons.duration_hours, lessons.room_id, lessons.occurrence, lessons.warnings_json,
      sections.teacher_id, sections.sequence, courses.code, courses.primary_year,
      courses.sessions_per_week, courses.week_start, courses.week_end, teachers.name AS teacher_name,
      rooms.code AS room_code,
      (SELECT GROUP_CONCAT(groups.code, ', ')
        FROM section_student_groups links
        JOIN student_groups groups ON groups.id = links.student_group_id
        WHERE links.section_id = sections.id) AS student_groups
    FROM scheduled_lessons lessons
    JOIN course_sections sections ON sections.id = lessons.section_id
    JOIN courses ON courses.id = sections.course_id
    LEFT JOIN teachers ON teachers.id = sections.teacher_id
    LEFT JOIN rooms ON rooms.id = lessons.room_id
    WHERE courses.primary_year IS NOT NULL
    ORDER BY courses.primary_year, lessons.day_of_week, lessons.start_hour, courses.code, sections.sequence
  `).all() as Array<{ id: string; section_id: string; day_of_week: number; start_hour: number; duration_hours: number; room_id: string | null; occurrence: number; warnings_json: string; teacher_id: string | null; sequence: number; code: string; primary_year: number; sessions_per_week: number; week_start: number | null; week_end: number | null; teacher_name: string | null; room_code: string | null; student_groups: string | null }>;

  const issues: ScheduleIssueRecord[] = [];
  for (const row of rows) {
    // warnings_json 只由受控事务写入；读取时仍按 JSON 解析成一条条业务说明。
    const warnings = JSON.parse(row.warnings_json) as string[];
    // 把一节课的多条警告展开成独立问题行，使每条规则都能单独筛选和查看。
    warnings.forEach((message, index) => {
      const description = describeIssue(message);
      issues.push({
        id: `${row.id}:${index}`,
        lessonId: row.id,
        sectionLabel: `${row.code}_${String(row.sequence).padStart(2, "0")}${row.sessions_per_week > 1 ? ` · Session ${row.occurrence}` : ""}${weekRangeSuffix(row.week_start, row.week_end)}`,
        primaryYear: row.primary_year,
        dayOfWeek: row.day_of_week,
        startHour: row.start_hour,
        endHour: row.start_hour + row.duration_hours,
        teacherName: row.teacher_name,
        roomCode: row.room_code,
        studentGroups: row.student_groups ? row.student_groups.split(", ") : [],
        ...description,
        message,
      });
    });
  }
  return issues;
}

export class CandidateSlotsInputError extends Error {
  // 课程时长、每周课次或教师资料不完整时，老师可以根据这段安全业务提示修正资料。
  constructor(message: string) {
    super(message);
    this.name = "CandidateSlotsInputError";
  }
}

export class CandidateSlotsNotFoundError extends Error {
  // 另一账号或新周期已经删除班次时使用明确 404，不把内部 undefined／SQLite 文字发给浏览器。
  constructor() {
    super("Course section not found.");
    this.name = "CandidateSlotsNotFoundError";
  }
}

export class CandidateSlotsStateConflictError extends Error {
  // 候选只适用于仍存在的待排课次；另一位老师可能已排课，或把每周两次改成一次。
  constructor() {
    super("This course section or weekly session has changed. Reload the latest timetable before finding clear options.");
    this.name = "CandidateSlotsStateConflictError";
  }
}

export class CandidateSlotsBusyError extends Error {
  // 极短的 SQLite 锁竞争属于可以重试的暂时状态；独立类型让 API 安全返回 503。
  constructor() {
    super("Another scheduler is updating timetable data. Try finding clear options again in a moment.");
    this.name = "CandidateSlotsBusyError";
  }
}

function candidateSlotsDatabase() {
  // database() 初始化也可能遇到另一个进程的写锁，必须与候选读取中的 BUSY 使用相同安全语义。
  try {
    return database();
  } catch (error) {
    if (isSqliteBusyError(error)) throw new CandidateSlotsBusyError();
    throw error;
  }
}

function calculateCandidateSlotsFromSnapshot(db: DatabaseInstance, sectionId: string, occurrence: number): { sectionLabel: string; occurrence: number; sessionsPerWeek: number; slots: CandidateSlotRecord[] } {
  // 候选搜索只提供建议，不自动排课：系统评估所有有效教室和整点时段，
  // 只返回在当前已启用规则下完全没有警告的组合。
  // 候选搜索读取班次已保存的教师、学生班级、时长及教室要求。
  // 资料不完整时不返回可能误导用户的候选结果。
  const section = db.prepare(`
    /* timetabling:candidate-entry */
    SELECT sections.id, sections.sequence, sections.teacher_id, courses.code,
      courses.duration_hours, courses.sessions_per_week, courses.week_start, courses.week_end
    FROM course_sections sections
    JOIN courses ON courses.id = sections.course_id
    WHERE sections.id = ?
  `).get(sectionId) as { id: string; sequence: number; teacher_id: string | null; code: string; duration_hours: number | null; sessions_per_week: number; week_start: number | null; week_end: number | null } | undefined;
  if (!section) throw new CandidateSlotsNotFoundError();
  if (!section.duration_hours) throw new CandidateSlotsInputError("Configure the course duration before finding candidate slots.");
  if (!Number.isSafeInteger(occurrence) || ![1, 2].includes(occurrence)) throw new CandidateSlotsInputError("Choose a valid weekly session.");
  if (occurrence > section.sessions_per_week) throw new CandidateSlotsStateConflictError();
  const alreadyScheduled = db.prepare("SELECT 1 FROM scheduled_lessons WHERE section_id = ? AND occurrence = ?").get(sectionId, occurrence);
  if (alreadyScheduled) throw new CandidateSlotsStateConflictError();

  // Clear slots 只展示“完全没有问题”的组合。没有教师或教师已停用时，不应返回一个含糊的空清单，
  // 而是直接说明需要先选择 Active 教师；老师仍可绕过候选功能手工放课并保留红色警告。
  const assignedTeacher = section.teacher_id ? db.prepare("SELECT is_active FROM teachers WHERE id = ?").get(section.teacher_id) as { is_active: number } | undefined : undefined;
  if (!assignedTeacher || assignedTeacher.is_active !== 1) throw new CandidateSlotsInputError("Assign an active teacher before looking for clear options.");

  // 遍历每个启用教室和所有合法整点位置；现有警告引擎是唯一判断标准，
  // 只有零条警告的排法才会通过候选筛选。
  const rooms = db.prepare(`
    /* timetabling:candidate-snapshot */
    SELECT id, code, capacity, has_multi_projector, is_lab, is_smart_classroom
    FROM rooms
    WHERE is_active = 1
    ORDER BY code
  `).all() as Array<{ id: string; code: string; capacity: number; has_multi_projector: number; is_lab: number; is_smart_classroom: number }>;
  const slots: CandidateSlotRecord[] = [];
  const preferredStartRule = db.prepare("SELECT is_enabled FROM rule_settings WHERE rule_key = 'prefer_9am'").get() as { is_enabled: number } | undefined;
  // 一次候选搜索会评估许多教室和时段。查询模板只在这里准备一次，
  // 但每个组合仍完整执行全部规则，因此结果与逐项重新编译 SQL 时完全相同。
  const warningStatements = preparePlacementWarningStatements(db);
  for (let dayOfWeek = 1; dayOfWeek <= 5; dayOfWeek += 1) {
    // 只有老师明确关闭“偏好 09:00 后开课”规则时，08:00 才会成为无警告候选；
    // 最终是否通过仍由统一警告引擎判断。
    for (let startHour = preferredStartRule?.is_enabled === 0 ? 8 : 9; startHour + section.duration_hours <= 18; startHour += 1) {
      for (const room of rooms) {
        const warnings = calculatePlacementWarnings({ sectionId, teacherId: section.teacher_id, roomId: room.id, dayOfWeek, startHour, durationHours: section.duration_hours }, warningStatements);
        if (warnings.length > 0) continue;
        slots.push({
          dayOfWeek,
          startHour,
          endHour: startHour + section.duration_hours,
          roomId: room.id,
          roomCode: room.code,
          roomCapacity: room.capacity,
          roomFeatures: [room.is_lab ? "Lab" : "", room.has_multi_projector ? "Multi projector" : "", room.is_smart_classroom ? "Smart classroom" : ""].filter(Boolean),
        });
      }
    }
  }
  return { sectionLabel: `${section.code}_${String(section.sequence).padStart(2, "0")}${section.sessions_per_week > 1 ? ` · Session ${occurrence}` : ""}${weekRangeSuffix(section.week_start, section.week_end)}`, occurrence, sessionsPerWeek: section.sessions_per_week, slots };
}

export function listCandidateSlots(sectionId: string, occurrence: number): { sectionLabel: string; occurrence: number; sessionsPerWeek: number; slots: CandidateSlotRecord[] } {
  const db = candidateSlotsDatabase();
  // SQLite 的 DEFERRED 只读事务在第一条 SELECT 时固定一致快照。候选计算约两百毫秒，
  // 期间另一进程可以先取得 RESERVED 写锁，但提交会等本次读取结束；一个响应不会混合修改前后的规则或课程。
  try {
    // transaction wrapper 的建立和执行都放进同一个错误边界；未来 SQLite 若在准备
    // BEGIN／COMMIT 控制语句时遇到锁，也会稳定转换为安全 503。
    const readConsistentSnapshot = db.transaction(() => calculateCandidateSlotsFromSnapshot(db, sectionId, occurrence));
    return readConsistentSnapshot.deferred();
  } catch (error) {
    if (error instanceof CandidateSlotsInputError || error instanceof CandidateSlotsNotFoundError
      || error instanceof CandidateSlotsStateConflictError || error instanceof CandidateSlotsBusyError) throw error;
    if (isSqliteBusyError(error)) throw new CandidateSlotsBusyError();
    throw error;
  }
}

function listSectionStudentGroupAssignments(db: DatabaseInstance, sectionId: string) {
  // 多个排课接口都需要同时返回学生班级的稳定数据库 ID 和给老师看的编号；集中查询可避免两份清单顺序或内容不一致。
  return db.prepare(`
    SELECT groups.id, groups.code
    FROM section_student_groups links
    JOIN student_groups groups ON groups.id = links.student_group_id
    WHERE links.section_id = ?
    ORDER BY groups.year, groups.program, groups.code
  `).all(sectionId) as Array<{ id: string; code: string }>;
}

export class ScheduledLessonPlacementConflictError extends Error {
  // 首次排课没有可供浏览器提交的 revision，因此用“班次 + 每周课次”的唯一键判断
  // 是否已被另一位老师先放入总表。专用错误类型让 API 可以准确返回 409。
  constructor() {
    super("This weekly session has already been placed by another scheduler.");
    this.name = "ScheduledLessonPlacementConflictError";
  }
}

export class ScheduledLessonPlacementInputError extends Error {
  // 已知的班次、时间和教室输入问题可以安全显示；其他 SQLite 异常必须留在服务端日志中。
  constructor(message: string) {
    super(message);
    this.name = "ScheduledLessonPlacementInputError";
  }
}

export class ScheduledLessonRevisionConflictError extends Error {
  // 已排课程编辑使用 revision 识别旧 Inspector 或另一账号先完成的修改；
  // 独立类型让 API 稳定返回 409，不再依靠英文句子内容猜测错误类别。
  constructor() {
    super("This lesson was changed by another scheduler. Review the latest timetable and try again.");
    this.name = "ScheduledLessonRevisionConflictError";
  }
}

export class ScheduledLessonNotFoundError extends Error {
  // 不存在或已经被删除的课程位置属于资源状态，不是老师填写的时间、教室等字段错误。
  // 独立类型让 API 返回准确的 404，同时仍隐藏底层查询和表结构。
  constructor() {
    super("Scheduled lesson not found.");
    this.name = "ScheduledLessonNotFoundError";
  }
}

export class ScheduledLessonUpdateInputError extends Error {
  // 时间、教师、班级和教室等可修正输入可以安全显示给老师；未知 SQLite
  // 或 warning 重算异常必须由 API 转换为通用 500，不能暴露底层资料。
  constructor(message: string) {
    super(message);
    this.name = "ScheduledLessonUpdateInputError";
  }
}

function isSqliteUniqueConstraintError(error: unknown) {
  // SQLite 提供稳定错误代码，可安全区分“唯一键重复”和 trigger、磁盘或其他数据库故障。
  // 所有对外业务提示都通过这个代码判断，绝不解析可能变化或泄露表名的英文错误文字。
  return error instanceof Database.SqliteError && error.code === "SQLITE_CONSTRAINT_UNIQUE";
}

function isScheduledOccurrenceUniqueError(error: unknown) {
  // 预先查询能提供友好提示，但多个应用进程仍可能在查询后同时写入。
  // 这里依赖 SQLite 的稳定错误代码而不是可能随版本或语言变化的英文错误文字。
  // 当前事务只有 scheduled_lessons INSERT 会触发唯一键，所以这个代码可以准确代表同一课次已存在。
  return isSqliteUniqueConstraintError(error);
}

export function placeScheduledLesson(input: { sectionId: string; occurrence: number; dayOfWeek: number; startHour: number; roomId: string | null }): ScheduledLessonRecord {
  // 即使存在警告，也按用户要求创建整点课程并保存警告内容；
  // 新课程、关联警告和返回资料放在同一个事务中，任一步失败都不会留下半完成排课。
  const db = database();
  const placementTransaction = db.transaction(() => {
    const section = db.prepare(`SELECT sections.id, courses.code, sections.sequence, courses.duration_hours, courses.sessions_per_week, courses.primary_year, courses.week_start, courses.week_end, teachers.id AS teacher_id, teachers.name AS teacher_name FROM course_sections sections JOIN courses ON courses.id = sections.course_id LEFT JOIN teachers ON teachers.id = sections.teacher_id WHERE sections.id = ?`).get(input.sectionId) as { id: string; code: string; sequence: number; duration_hours: number | null; sessions_per_week: number; primary_year: number | null; week_start: number | null; week_end: number | null; teacher_id: string | null; teacher_name: string | null } | undefined;
    if (!section || !section.duration_hours) throw new ScheduledLessonPlacementInputError("Section must have a course duration before placement.");
    // 三张年级总表只读取 primary_year；旧页面即使在课程年级被另一位老师清空后继续提交，
    // 也不能建立一条在总表中完全看不见的排课记录。
    if (section.primary_year === null) throw new ScheduledLessonPlacementInputError("Choose a primary year before placing this course.");
    if (!Number.isInteger(input.occurrence) || input.occurrence < 1 || input.occurrence > section.sessions_per_week) throw new ScheduledLessonPlacementInputError("Choose a valid weekly session before placement.");
    if (input.dayOfWeek < 1 || input.dayOfWeek > 5 || input.startHour < 8 || input.startHour + section.duration_hours > 18) throw new ScheduledLessonPlacementInputError("Lessons must be placed Monday to Friday between 08:00 and 18:00.");

    // 如果另一个账号已经保存同一课次，就在运行警告引擎前尽早停止；
    // 数据库唯一键仍是最终保护，负责覆盖两个服务器进程真正同时写入的极短竞态窗口。
    const existingLesson = db.prepare("SELECT 1 FROM scheduled_lessons WHERE section_id = ? AND occurrence = ?").get(input.sectionId, input.occurrence);
    if (existingLesson) throw new ScheduledLessonPlacementConflictError();

    // 只允许选择仍启用的教室。候选清单生成后教室也可能被其他账号停用，
    // 所以正式保存时必须重新检查，而不能相信浏览器中的旧下拉选项。
    const room = input.roomId
      ? db.prepare("SELECT code FROM rooms WHERE id = ? AND is_active = 1").get(input.roomId) as { code: string } | undefined
      : undefined;
    if (input.roomId && !room) throw new ScheduledLessonPlacementInputError("Choose an active room.");

    // 首次放置会先计算新课程自身的警告，再在 INSERT 后刷新整张表。
    // 两个阶段处于同一事务，可以安全共用已编译查询；INSERT 后再次执行时仍会看到新记录。
    const warningStatements = preparePlacementWarningStatements(db);
    const conflicts = calculatePlacementWarnings({ sectionId: input.sectionId, teacherId: section.teacher_id, roomId: input.roomId, dayOfWeek: input.dayOfWeek, startHour: input.startHour, durationHours: section.duration_hours }, warningStatements);
    const id = crypto.randomUUID();
    try {
      db.prepare("INSERT INTO scheduled_lessons (id, section_id, occurrence, day_of_week, start_hour, duration_hours, room_id, warnings_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, input.sectionId, input.occurrence, input.dayOfWeek, input.startHour, section.duration_hours, input.roomId, JSON.stringify(conflicts));
    } catch (error) {
      if (isScheduledOccurrenceUniqueError(error)) throw new ScheduledLessonPlacementConflictError();
      throw error;
    }

    const refreshedWarnings = refreshAllScheduleWarnings(db, warningStatements).get(id) ?? conflicts;
    // 保存后连同关联班级编号一起返回，使界面无需再次请求，
    // 就能立即显示新课程分配的教师、班级和教室等完整资源。
    const studentGroupAssignments = listSectionStudentGroupAssignments(db, section.id);
    return { id, sectionId: section.id, sectionLabel: `${section.code}_${String(section.sequence).padStart(2, "0")}${section.sessions_per_week > 1 ? ` · Session ${input.occurrence}` : ""}${weekRangeSuffix(section.week_start, section.week_end)}`, courseCode: section.code, teacherId: section.teacher_id, teacherName: section.teacher_name, dayOfWeek: input.dayOfWeek, startHour: input.startHour, durationHours: section.duration_hours, roomId: input.roomId, roomCode: room?.code ?? null, studentGroupIds: studentGroupAssignments.map((group) => group.id), studentGroups: studentGroupAssignments.map((group) => group.code), occurrence: input.occurrence, sessionsPerWeek: section.sessions_per_week, revision: 1, warnings: refreshedWarnings, warningSeverity: highestIssueSeverity(refreshedWarnings) };
  });

  // IMMEDIATE 在事务开始时取得写入预留锁，使两个服务器进程不会都先读取到“尚未排课”再互相争抢写锁。
  // 即使部署环境未能串行化，INSERT 的唯一键捕获仍会把后提交者转换为相同的业务冲突。
  return placementTransaction.immediate();
}

export function updateScheduledLesson(id: string, input: { dayOfWeek: number; startHour: number; roomId: string | null; teacherId: string | null; studentGroupIds: string[]; revision: number }): ScheduledLessonRecord {
  // 修订版本检查防止多人编辑时静默覆盖；教师、学生班级和课程位置一起保存，
  // 确保重新计算的冲突始终与界面显示的卡片资料一致。读取、验证和写入全部
  // 放进 IMMEDIATE 事务，另一服务进程不能在验证教师或教室后抢先改变状态。
  const db = database();
  const updateTransaction = db.transaction(() => {
    // 先在写锁内读取课程、当前 revision、共享教师和原教室；学生班级属于班次，
    // 后面还要同步更新同班次的其他每周课次。
    const lesson = db.prepare(`SELECT lessons.section_id, lessons.occurrence, lessons.revision, lessons.room_id AS lesson_room_id, courses.code, sections.sequence, sections.teacher_id AS section_teacher_id, courses.duration_hours, courses.sessions_per_week, courses.week_start, courses.week_end FROM scheduled_lessons lessons JOIN course_sections sections ON sections.id = lessons.section_id JOIN courses ON courses.id = sections.course_id WHERE lessons.id = ?`).get(id) as { section_id: string; occurrence: number; revision: number; lesson_room_id: string | null; code: string; sequence: number; section_teacher_id: string | null; duration_hours: number; sessions_per_week: number; week_start: number | null; week_end: number | null } | undefined;
    if (!lesson) throw new ScheduledLessonNotFoundError();
    if (lesson.revision !== input.revision) throw new ScheduledLessonRevisionConflictError();
    if (input.dayOfWeek < 1 || input.dayOfWeek > 5 || input.startHour < 8 || input.startHour + lesson.duration_hours > 18) {
      throw new ScheduledLessonUpdateInputError("Lessons must remain Monday to Friday between 08:00 and 18:00.");
    }

    // 旧排课可以保留已经停用的教师；只有教师 ID 真正改变时才要求目标教师仍为 Active。
    const teacher = input.teacherId ? db.prepare("SELECT id, name, is_active FROM teachers WHERE id = ?").get(input.teacherId) as { id: string; name: string; is_active: number } | undefined : undefined;
    const teacherChanged = input.teacherId !== lesson.section_teacher_id;
    if (input.teacherId && !teacher) throw new ScheduledLessonUpdateInputError("Choose a valid teacher.");
    if (teacherChanged && input.teacherId && teacher?.is_active !== 1) throw new ScheduledLessonUpdateInputError("Choose an active teacher.");

    // 教室采用相同的 grandfather 规则：现有停用教室可以在调整其他字段时原样保留，
    // 但不存在的教室或新改派的停用教室不能进入课程记录。
    const room = input.roomId ? db.prepare("SELECT id, code, is_active FROM rooms WHERE id = ?").get(input.roomId) as { id: string; code: string; is_active: number } | undefined : undefined;
    const roomChanged = input.roomId !== lesson.lesson_room_id;
    if (input.roomId && !room) throw new ScheduledLessonUpdateInputError("Choose a valid room.");
    if (roomChanged && input.roomId && room?.is_active !== 1) throw new ScheduledLessonUpdateInputError("Choose an active room.");

    // 去重后确认每个 ID 都来自现有学生班级，避免过期页面写入悬空关联。
    const studentGroupIds = [...new Set(input.studentGroupIds)];
    if (studentGroupIds.length > 0) {
      const placeholders = studentGroupIds.map(() => "?").join(", ");
      const validGroups = db.prepare(`SELECT id FROM student_groups WHERE id IN (${placeholders})`).all(...studentGroupIds) as Array<{ id: string }>;
      if (validGroups.length !== studentGroupIds.length) throw new ScheduledLessonUpdateInputError("Choose valid student groups.");
    }

    const currentStudentGroups = listSectionStudentGroupAssignments(db, lesson.section_id);
    const currentStudentGroupIds = currentStudentGroups.map((group) => group.id).sort();
    const sortedStudentGroupIds = [...studentGroupIds].sort();
    const groupsChanged = currentStudentGroupIds.length !== sortedStudentGroupIds.length || currentStudentGroupIds.some((groupId, index) => groupId !== sortedStudentGroupIds[index]);
    const sharedAssignmentsChanged = teacherChanged || groupsChanged;

    // 拖动课程也会把未改变的教师和班级原样提交；只有共享分配真的变化时才修改班次 revision。
    // 教师改变才清除 Excel 来源，纯粹移动时间、改教室或只改班级都不会误伤教师来源资料。
    if (sharedAssignmentsChanged) {
      if (teacherChanged) {
        db.prepare("UPDATE course_sections SET teacher_id = ?, allocation_teacher_id = NULL, revision = revision + 1 WHERE id = ?").run(input.teacherId, lesson.section_id);
      } else {
        db.prepare("UPDATE course_sections SET revision = revision + 1 WHERE id = ?").run(lesson.section_id);
      }
    }
    if (groupsChanged) {
      db.prepare("DELETE FROM section_student_groups WHERE section_id = ?").run(lesson.section_id);
      const addStudentGroup = db.prepare("INSERT INTO section_student_groups (section_id, student_group_id) VALUES (?, ?)");
      for (const studentGroupId of sortedStudentGroupIds) addStudentGroup.run(lesson.section_id, studentGroupId);
    }

    // 同一班次每周可能上两次；共享分配改变后，其他课次的旧 Inspector 也必须失效。
    // 纯时间或教室移动不影响其他课次，因此不会无意义地提高它们的 revision。
    if (sharedAssignmentsChanged) {
      db.prepare("UPDATE scheduled_lessons SET revision = revision + 1 WHERE section_id = ? AND id <> ?").run(lesson.section_id, id);
    }
    const updateResult = db.prepare("UPDATE scheduled_lessons SET day_of_week = ?, start_hour = ?, room_id = ?, revision = revision + 1 WHERE id = ? AND revision = ?").run(input.dayOfWeek, input.startHour, input.roomId, id, input.revision);
    if (updateResult.changes !== 1) throw new ScheduledLessonRevisionConflictError();

    // warning 属于保存结果的一部分；放在相同事务中后，若重算失败，位置、共享分配和全部 revision 会一起回滚。
    const currentLessonWarnings = refreshAllScheduleWarnings(db).get(id) ?? [];
    const studentGroupAssignments = listSectionStudentGroupAssignments(db, lesson.section_id);
    // 返回结构与普通时间表查询保持一致，使 Inspector 保存后立即拥有完整关联资料。
    return { id, sectionId: lesson.section_id, sectionLabel: `${lesson.code}_${String(lesson.sequence).padStart(2, "0")}${lesson.sessions_per_week > 1 ? ` · Session ${lesson.occurrence}` : ""}${weekRangeSuffix(lesson.week_start, lesson.week_end)}`, courseCode: lesson.code, teacherId: teacher?.id ?? null, teacherName: teacher?.name ?? null, dayOfWeek: input.dayOfWeek, startHour: input.startHour, durationHours: lesson.duration_hours, roomId: input.roomId, roomCode: room?.code ?? null, studentGroupIds: studentGroupAssignments.map((group) => group.id), studentGroups: studentGroupAssignments.map((group) => group.code), occurrence: lesson.occurrence, sessionsPerWeek: lesson.sessions_per_week, revision: input.revision + 1, warnings: currentLessonWarnings, warningSeverity: highestIssueSeverity(currentLessonWarnings) } satisfies ScheduledLessonRecord;
  });
  return updateTransaction.immediate();
}

export function removeScheduledLesson(id: string, revision: number) {
  // 删除一条排课只会把对应的每周课次退回待排区；若该班次每周上两次，
  // 另一课次仍保留在原时间表位置。
  const db = database();
  const removeTransaction = db.transaction(() => {
    const removed = db.prepare("DELETE FROM scheduled_lessons WHERE id = ? AND revision = ?").run(id, revision).changes > 0;
    // 退回待排区会改变其他课程的冲突和连续时长；DELETE 与 warning 重算必须一起回滚或提交。
    if (removed) refreshAllScheduleWarnings(db);
    return removed;
  });
  return removeTransaction.immediate();
}

export class TeachingAllocationImportConflictError extends Error {
  // 这种错误表示工作簿格式正确，但当前手工资料或排课状态不允许安全套用变化。
  // 独立类型让 API 返回 409，同时避免靠英文句子内容猜测错误类别。
  constructor(message: string) {
    super(message);
    this.name = "TeachingAllocationImportConflictError";
  }
}

export function importTeachingMembers(rows: TeachingMembersImportRow[], ignoredZeroRows: number): TeachingMembersImportSummary {
  // 先把已验证的工作表行整理为教师清单、课程清单和教学分配映射，
  // 再一次性执行完整导入事务。
  const db = database();
  // 使用 Map 去除表格中的重复项，同时保证每位教师、每门课程以及每个课程—教师组合
  // 最终都只有一条明确记录。
  const teachers = new Map<string, { name: string; staffType: "FT" | "PT" }>();
  const courses = new Map<string, { code: string; catalog: string | null }>();
  const allocations = new Map<string, TeachingMembersImportRow>();

  for (const row of rows) {
    // 每一行有效工作表资料都会加入教师基础清单，即使该教师当前所有课程分配都为零。
    teachers.set(row.lecturer, { name: row.lecturer, staffType: row.staffType });
    // 明确的零表示该教师不教授这门课，因此该单元格不会创建教师分配、课程，
    // 也不会生成任何待排班次。
    if (row.groupCount === 0) continue;
    courses.set(row.mod, { code: row.mod, catalog: row.catalog });
    // 空字符分隔符不会出现在正常课程编号或姓名中，因此可安全组成复合键，
    // 用于识别同一个教学分配在多行中重复出现的情况。
    const key = `${row.mod}\u0000${row.lecturer}`;
    const existing = allocations.get(key);
    allocations.set(key, existing ? { ...existing, groupCount: existing.groupCount + row.groupCount } : row);
  }
  const transaction = db.transaction(() => {
    // 整个导入保持“全部成功或全部失败”的原子性，老师不会看到只导入了一半的教学分配。
    const findTeacher = db.prepare("SELECT id, is_active FROM teachers WHERE name = ?");
    const insertTeacher = db.prepare("INSERT INTO teachers (id, name, staff_type) VALUES (?, ?, ?)");
    const updateTeacher = db.prepare("UPDATE teachers SET staff_type = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?");
    const findCourse = db.prepare("SELECT id FROM courses WHERE code = ?");
    const insertCourse = db.prepare("INSERT INTO courses (id, code, catalog) VALUES (?, ?, ?)");
    const updateCourse = db.prepare("UPDATE courses SET catalog = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?");
    const courseIds = new Map<string, string>();
    const teacherIds = new Map<string, string>();
    const teacherActiveById = new Map<string, boolean>();
    const teacherNameById = new Map<string, string>();

    for (const teacher of teachers.values()) {
      // 如果已有同名手动教师则复用其稳定 ID，并保留老师在系统内明确设置的 Active／Inactive 状态；
      // Excel 只能维护教师类型，不能用一次重新导入偷偷覆盖人工停用决定。新教师仍使用数据库默认的 Active 状态。
      const existing = findTeacher.get(teacher.name) as { id: string; is_active: number } | undefined;
      const id = existing?.id ?? crypto.randomUUID();
      if (existing) updateTeacher.run(teacher.staffType, id);
      else insertTeacher.run(id, teacher.name, teacher.staffType);
      teacherIds.set(teacher.name, id);
      teacherActiveById.set(id, existing ? existing.is_active === 1 : true);
      teacherNameById.set(id, teacher.name);
    }
    for (const course of courses.values()) {
      // 这里刻意不覆盖课程时长、年级和教室要求等手动设置，只刷新 Excel 课程目录资料，
      // 因而以后重新导入教学分配时不会丢失已经完成的排课配置。
      const existing = findCourse.get(course.code) as { id: string } | undefined;
      const id = existing?.id ?? crypto.randomUUID();
      if (existing) updateCourse.run(course.catalog, id);
      else insertCourse.run(id, course.code, course.catalog);
      courseIds.set(course.code, id);
    }

    // 只更新本工作簿中出现的课程；老师因 Excel 遗漏而手动新增的其他课程会继续保留。
    const importedCourseIds = [...courseIds.values()];
    const findScheduledCourse = db.prepare(`SELECT 1 FROM scheduled_lessons lessons JOIN course_sections sections ON sections.id = lessons.section_id WHERE sections.course_id = ? LIMIT 1`);
    for (const courseId of importedCourseIds) {
      // 已开始排课后导入可能改变班次数和教师，因此仍然要求先进入新周期或手工修正，
      // 避免工作簿在老师不知情时改变已经发布到总表的安排。
      if (findScheduledCourse.get(courseId)) throw new TeachingAllocationImportConflictError("Teaching allocation cannot be re-imported after one of its courses has been scheduled. Use the manual course and section corrections, or start a new cycle first.");
    }

    // 工作簿中的 teaching_allocations 是最新的“期望数量”，可以整体替换；课程班次则包含
    // 手工教师和学生班级，必须保留稳定 ID，并按 sequence 做差异化更新。
    const deleteCourseAllocations = db.prepare("DELETE FROM teaching_allocations WHERE course_id = ?");
    const insertAllocation = db.prepare("INSERT INTO teaching_allocations (id, course_id, teacher_id, assigned_group_count) VALUES (?, ?, ?, ?)");
    for (const courseId of importedCourseIds) deleteCourseAllocations.run(courseId);

    // 每门课程建立按 Excel 顺序展开的教师清单，例如 A 教 2 班、B 教 1 班会得到 [A, A, B]。
    // 它只自动维护仍带 allocation_teacher_id 的班次；老师手工改过的班次来源标记已被清空。
    const desiredTeachersByCourse = new Map<string, string[]>();
    for (const allocation of allocations.values()) {
      const courseId = courseIds.get(allocation.mod);
      const teacherId = teacherIds.get(allocation.lecturer);
      if (!courseId || !teacherId) continue;
      insertAllocation.run(crypto.randomUUID(), courseId, teacherId, allocation.groupCount);
      const desiredTeachers = desiredTeachersByCourse.get(courseId) ?? [];
      for (let group = 0; group < allocation.groupCount; group += 1) {
        desiredTeachers.push(teacherId);
      }
      desiredTeachersByCourse.set(courseId, desiredTeachers);
    }

    const listExistingSections = db.prepare(`
      SELECT sections.id, sections.sequence, sections.teacher_id, sections.allocation_teacher_id,
        EXISTS(SELECT 1 FROM section_student_groups groups WHERE groups.section_id = sections.id) AS has_student_groups
      FROM course_sections sections
      WHERE sections.course_id = ?
      ORDER BY sections.sequence ASC
    `);
    const updateImportedSection = db.prepare("UPDATE course_sections SET teacher_id = ?, allocation_teacher_id = ?, revision = revision + 1 WHERE id = ?");
    const insertSection = db.prepare("INSERT INTO course_sections (id, course_id, sequence, teacher_id, allocation_teacher_id) VALUES (?, ?, ?, ?, ?)");
    const deleteSection = db.prepare("DELETE FROM course_sections WHERE id = ?");

    for (const [courseCode, courseId] of [...courseIds.entries()]) {
      const desiredTeachers = desiredTeachersByCourse.get(courseId) ?? [];
      const existingSections = listExistingSections.all(courseId) as Array<{ id: string; sequence: number; teacher_id: string | null; allocation_teacher_id: string | null; has_student_groups: number }>;
      const existingBySequence = new Map(existingSections.map((section) => [section.sequence, section]));

      // 保留 01 至目标数量内的稳定班次 ID 和学生班级。只有由新版导入器建立、仍带 Excel 来源教师的班次才自动更新教师；
      // 旧数据库和老师手工修改过的班次保持原样，差异会继续显示在 allocation variance 中供人工复核。
      for (let sequence = 1; sequence <= desiredTeachers.length; sequence += 1) {
        const desiredTeacherId = desiredTeachers[sequence - 1];
        const existingSection = existingBySequence.get(sequence);
        if (!existingSection) {
          // 增加班次数会建立一条全新的教师分配；目标教师若已停用，整次导入必须回滚并要求先人工确认。
          if (!teacherActiveById.get(desiredTeacherId)) {
            throw new TeachingAllocationImportConflictError(`${teacherNameById.get(desiredTeacherId) ?? "The allocated teacher"} is inactive. Activate this teacher before assigning new sections through Teaching allocation.`);
          }
          insertSection.run(crypto.randomUUID(), courseId, sequence, desiredTeacherId, desiredTeacherId);
        } else if (existingSection.allocation_teacher_id !== null && (existingSection.teacher_id !== desiredTeacherId || existingSection.allocation_teacher_id !== desiredTeacherId)) {
          // 同一个停用教师已经属于该班次时可 grandfather 并保持稳定 ID；只有实际改派到停用教师才属于被禁止的新分配。
          if (existingSection.teacher_id !== desiredTeacherId && !teacherActiveById.get(desiredTeacherId)) {
            throw new TeachingAllocationImportConflictError(`${teacherNameById.get(desiredTeacherId) ?? "The allocated teacher"} is inactive. Activate this teacher before changing section assignments through Teaching allocation.`);
          }
          // 自动维护的教师真的变化时提高班次 revision，使已经打开的 Sections 表单不能用旧资料覆盖导入结果。
          updateImportedSection.run(desiredTeacherId, desiredTeacherId, existingSection.id);
        }
      }

      // 课程数量减少时只处理目标范围以外的高编号班次。含学生班级或受保护教师的班次绝不删除，
      // 老师必须先在 Sections 页面明确清空这些资料，避免一次上传静默毁掉手工作业。
      const extraSections = existingSections.filter((section) => section.sequence > desiredTeachers.length).sort((left, right) => right.sequence - left.sequence);
      for (const section of extraSections) {
        const hasProtectedTeacher = section.teacher_id !== null && section.allocation_teacher_id === null;
        if (section.has_student_groups || hasProtectedTeacher) {
          const label = `${courseCode}_${String(section.sequence).padStart(2, "0")}`;
          throw new TeachingAllocationImportConflictError(`Teaching allocation cannot reduce ${courseCode} because ${label} has a manually maintained teacher or student group. Clear that section first, then import again.`);
        }
        deleteSection.run(section.id);
      }
    }
  });
  // 导入会同时读取教师状态并写入教师、课程和班次；IMMEDIATE 让停用操作与导入形成清楚的先后次序。
  transaction.immediate();

  // 返回精简的审计摘要，供上传完成提示显示导入了多少教师、课程、分配和班次。
  return {
    courses: courses.size,
    teachers: teachers.size,
    allocations: allocations.size,
    sections: [...allocations.values()].reduce((total, allocation) => total + allocation.groupCount, 0),
    ignoredZeroRows,
  };
}
