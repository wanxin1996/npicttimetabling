import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

// These types describe the simplified data sent from the database to the browser.
// They intentionally use friendly names instead of SQLite column names.
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
  allocationVarianceCount: number;
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
  backup: null | { id: string; createdAt: string; courses: number; sections: number; lessons: number };
};

// The emergency snapshot covers only cycle data. Master records and account data are
// intentionally excluded because starting a new cycle must retain them.
type CourseSnapshotRow = { id: string; code: string; catalog: string | null; duration_hours: number | null; sessions_per_week: number; primary_year: number | null; minimum_room_capacity: number | null; requires_lab: number; requires_multi_projector: number; requires_smart_classroom: number; separate_sections_across_days: number; week_pattern: "ALL" | "W1_4" | "W5_8"; week_start?: number | null; week_end?: number | null; created_at: string; updated_at: string };
type AllocationSnapshotRow = { id: string; course_id: string; teacher_id: string; assigned_group_count: number };
type SectionSnapshotRow = { id: string; course_id: string; sequence: number; teacher_id: string | null };
type SectionGroupSnapshotRow = { section_id: string; student_group_id: string };
type LessonSnapshotRow = { id: string; section_id: string; occurrence: number; day_of_week: number; start_hour: number; duration_hours: number; room_id: string | null; warnings_json: string; revision: number };
type CycleSnapshot = { courses: CourseSnapshotRow[]; allocations: AllocationSnapshotRow[]; sections: SectionSnapshotRow[]; sectionGroups: SectionGroupSnapshotRow[]; lessons: LessonSnapshotRow[] };

type DatabaseInstance = InstanceType<typeof Database>;

function weekRangeSuffix(weekStart: number | null, weekEnd: number | null) {
  // Compact labels distinguish any limited teaching interval while all-week courses
  // stay uncluttered on the timetable.
  return weekStart !== null && weekEnd !== null ? ` · W${weekStart}–${weekEnd}` : "";
}

function legacyWeekPattern(weekStart: number | null, weekEnd: number | null): "ALL" | "W1_4" | "W5_8" {
  // Retain the old field for backward-compatible emergency snapshots; all conflict
  // logic now reads the arbitrary numeric start and end columns instead.
  if (weekStart === 1 && weekEnd === 4) return "W1_4";
  if (weekStart === 5 && weekEnd === 8) return "W5_8";
  return "ALL";
}

// Next.js reloads modules in development. Keeping one connection globally prevents
// a new SQLite connection from being opened each time a route is refreshed.
const globalForDatabase = globalThis as unknown as {
  timetableDatabase: DatabaseInstance | undefined;
};

function databaseFilePath() {
  // Keep path selection in one place so the live database and automatic restore
  // safety copies always use the same local disk or Railway persistent volume.
  const configuredPath = process.env.TIMETABLING_DATABASE_PATH?.trim();
  const railwayVolumePath = process.env.RAILWAY_VOLUME_MOUNT_PATH?.trim();
  const selectedPath = configuredPath || (railwayVolumePath ? path.join(railwayVolumePath, "timetabling.db") : path.join(process.cwd(), "data", "timetabling.db"));
  return path.resolve(selectedPath);
}

function database() {
  // Even an existing connection must run the table setup: this safely adds tables
  // after the application has been upgraded with a new feature.
  if (globalForDatabase.timetableDatabase) {
    initializeTables(globalForDatabase.timetableDatabase);
    return globalForDatabase.timetableDatabase;
  }

  // An explicit path is useful for isolated regression runs. On Railway, fall back
  // to its automatically injected volume mount so a correctly attached volume is
  // persistent without duplicating the mount path in another dashboard variable.
  const databasePath = databaseFilePath();
  const dataDirectory = path.dirname(databasePath);
  mkdirSync(dataDirectory, { recursive: true });
  const db = new Database(databasePath);
  db.pragma("foreign_keys = ON");
  initializeTables(db);
  // Demo records help local development, but a deployed empty database must start
  // clean so real staff never see invented teachers, classes or rooms.
  if (process.env.NODE_ENV !== "production") seed(db);
  globalForDatabase.timetableDatabase = db;
  return db;
}

export function databaseHealth() {
  // A constant query verifies that the configured file can be opened and queried
  // without exposing timetable counts, account details or the server file path.
  const row = database().prepare("SELECT 1 AS healthy").get() as { healthy: number };
  return row.healthy === 1;
}

function assertDatabaseIntegrity(db: DatabaseInstance, stage: string) {
  // SQLite returns one or more problem descriptions when the file structure is
  // damaged. A healthy database returns exactly one row containing "ok".
  const integrityRows = db.pragma("integrity_check") as Array<Record<string, unknown>>;
  const integrityMessages = integrityRows.flatMap((row) => Object.values(row).map(String));
  if (integrityMessages.length !== 1 || integrityMessages[0].toLowerCase() !== "ok") {
    throw new Error(`${stage} failed SQLite integrity check.`);
  }

  // Foreign-key problems can exist even when the file itself is structurally
  // healthy, so this separate check protects relationships such as lessons to rooms.
  const foreignKeyProblems = db.pragma("foreign_key_check") as unknown[];
  if (foreignKeyProblems.length > 0) throw new Error(`${stage} failed foreign-key check.`);
}

export async function createVerifiedSystemBackup() {
  // A unique operating-system temporary folder keeps simultaneous downloads apart
  // and ensures the generated file never appears beside the live database.
  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "timetabling-backup-"));
  const backupPath = path.join(temporaryDirectory, "timetabling.sqlite");
  let backupDatabase: DatabaseInstance | undefined;

  try {
    // Check the source first, then use SQLite's online backup API instead of copying
    // a possibly active database and its write-ahead log as ordinary files.
    const sourceDatabase = database();
    assertDatabaseIntegrity(sourceDatabase, "Source database");
    await sourceDatabase.backup(backupPath);

    // Existing browser sessions are operational secrets rather than department
    // records. Remove them from the copy and vacuum it so deleted pages are rebuilt.
    backupDatabase = new Database(backupPath);
    backupDatabase.pragma("foreign_keys = ON");
    backupDatabase.prepare("DELETE FROM auth_sessions").run();
    backupDatabase.exec("VACUUM");

    // Validate the exact sanitized file that will be downloaded, then close it before
    // reading the bytes so every SQLite write is flushed into the response payload.
    assertDatabaseIntegrity(backupDatabase, "Generated backup");
    backupDatabase.close();
    backupDatabase = undefined;
    const contents = readFileSync(backupPath);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    return { contents, filename: `timetabling-backup-${timestamp}.sqlite` };
  } finally {
    // The response already owns an in-memory copy, so the sensitive temporary file
    // can always be removed immediately, including when validation throws an error.
    backupDatabase?.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export class SystemBackupValidationError extends Error {
  // A dedicated error type lets the API distinguish an unsafe uploaded file from an
  // unexpected server failure without exposing SQLite implementation details.
  constructor(message: string) {
    super(message);
    this.name = "SystemBackupValidationError";
  }
}

type TableColumn = { cid: number; name: string; type: string; notnull: number; dflt_value: string | null; pk: number };
type TableShape = { name: string; columns: TableColumn[] };

function quoteIdentifier(value: string) {
  // Table names come from SQLite metadata, but quoting them still prevents unusual
  // names from changing the restore statements into a different SQL command.
  return `"${value.replaceAll('"', '""')}"`;
}

function tableShapes(db: DatabaseInstance) {
  // Restore accepts only a database with exactly the same user tables and column
  // order as the running application. Internal sqlite_* bookkeeping is never copied.
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>;
  return tables.map<TableShape>(({ name }) => ({
    name,
    columns: db.prepare(`PRAGMA table_info(${quoteIdentifier(name)})`).all() as TableColumn[],
  }));
}

function assertRestorableSystemBackup(source: DatabaseInstance, live: DatabaseInstance) {
  // Structural and relationship checks happen before any current record is touched.
  // Exact shapes also prove that the upload is a backup from this application version.
  assertDatabaseIntegrity(source, "Uploaded backup");
  const sourceShapes = tableShapes(source);
  const liveShapes = tableShapes(live);
  if (JSON.stringify(sourceShapes) !== JSON.stringify(liveShapes)) {
    throw new SystemBackupValidationError("The selected file does not match this version of the timetabling system.");
  }

  // All sessions will be removed, so at least one active administrator with a valid
  // password-hash shape must remain able to sign in after the restore completes.
  const administrators = source.prepare("SELECT password_hash FROM app_users WHERE is_admin = 1 AND is_active = 1").all() as Array<{ password_hash: string }>;
  const validPasswordHash = /^[0-9a-f]{32}:[0-9a-f]{128}$/i;
  if (!administrators.some((administrator) => validPasswordHash.test(administrator.password_hash))) {
    throw new SystemBackupValidationError("The selected backup has no usable active administrator account.");
  }

  return sourceShapes.map((table) => table.name);
}

function saveRestoreSafetyCopy(contents: Buffer, sourceFilename: string) {
  // Store the pre-restore snapshot beside the live database so Railway keeps it on
  // the mounted volume even if the application container restarts after a restore.
  const livePath = databaseFilePath();
  const databaseName = path.basename(livePath, path.extname(livePath));
  const safetyDirectory = path.join(path.dirname(livePath), `${databaseName}-restore-safety`);
  mkdirSync(safetyDirectory, { recursive: true });
  const safetyFilename = `pre-restore-${randomBytes(4).toString("hex")}-${sourceFilename}`;
  writeFileSync(path.join(safetyDirectory, safetyFilename), contents, { flag: "wx", mode: 0o600 });
  return safetyFilename;
}

export async function restoreVerifiedSystemBackup(contents: Buffer) {
  // The uploaded bytes live in a unique temporary file only long enough for SQLite
  // to validate and read them. Permissions limit other local users from opening it.
  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "timetabling-restore-"));
  const uploadedPath = path.join(temporaryDirectory, "uploaded.sqlite");
  writeFileSync(uploadedPath, contents, { mode: 0o600 });
  let uploadedDatabase: DatabaseInstance | undefined;
  let restoreAttached = false;
  const liveDatabase = database();

  try {
    let tableNames: string[];
    try {
      // Read-only mode prevents validation from repairing or changing the file the
      // administrator selected; invalid SQLite bytes become a controlled 400 error.
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

    // Before destructive work, make and persist a separately verified snapshot of
    // the current state. It deliberately excludes active session credentials.
    const safetyBackup = await createVerifiedSystemBackup();
    const safetyBackupFilename = saveRestoreSafetyCopy(safetyBackup.contents, safetyBackup.filename);

    // Attach the already validated upload and replace every application table in one
    // synchronous transaction. Any copy or constraint error rolls the whole change back.
    liveDatabase.prepare("ATTACH DATABASE ? AS restore_source").run(uploadedPath);
    restoreAttached = true;
    liveDatabase.pragma("foreign_keys = OFF");
    try {
      const restoreAllTables = liveDatabase.transaction(() => {
        for (const tableName of tableNames) liveDatabase.prepare(`DELETE FROM main.${quoteIdentifier(tableName)}`).run();
        for (const tableName of tableNames) liveDatabase.prepare(`INSERT INTO main.${quoteIdentifier(tableName)} SELECT * FROM restore_source.${quoteIdentifier(tableName)}`).run();

        // Sessions from either database must never survive a full restore. Checking
        // relationships inside the transaction makes a failure roll back all copies.
        liveDatabase.prepare("DELETE FROM main.auth_sessions").run();
        const relationshipProblems = liveDatabase.pragma("foreign_key_check") as unknown[];
        if (relationshipProblems.length > 0) throw new Error("Restored data failed foreign-key check.");
      });
      restoreAllTables();
    } finally {
      liveDatabase.pragma("foreign_keys = ON");
    }

    // Apply any idempotent defaults and validate the committed live file before the
    // API tells the browser that restoration succeeded.
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
    // Detach the upload before deleting its temporary folder. Cleanup runs for valid,
    // rejected and failed restores without touching the retained safety snapshot.
    if (restoreAttached) liveDatabase.exec("DETACH DATABASE restore_source");
    uploadedDatabase?.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function initializeTables(db: DatabaseInstance) {
  // CREATE ... IF NOT EXISTS makes this setup repeatable and safe on every start.
  // The tables below are the part of the timetable model currently used by the UI.
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
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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

  // Policy rules are data-driven switches. Insert new defaults without overwriting a
  // scheduler's existing choice when a later release adds another optional rule.
  const addRule = db.prepare("INSERT OR IGNORE INTO rule_settings (rule_key, is_enabled) VALUES (?, 1)");
  for (const ruleKey of ["prefer_9am", "lunch_break", "max_continuous", "student_daily_limit", "teacher_daily_limit", "same_block", "separate_weekly_sessions"]) addRule.run(ruleKey);

  // SQLite cannot add a new column through CREATE TABLE after the table already
  // exists. Check old local databases and upgrade this small prototype schema safely.
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
  // Backfill the two legacy half-cycle options once. Custom ranges use ALL in the
  // retained legacy field and therefore are never overwritten here.
  db.exec("UPDATE courses SET week_start = 1, week_end = 4 WHERE week_pattern = 'W1_4' AND week_start IS NULL AND week_end IS NULL");
  db.exec("UPDATE courses SET week_start = 5, week_end = 8 WHERE week_pattern = 'W5_8' AND week_start IS NULL AND week_end IS NULL");
  const lessonColumns = db.prepare("PRAGMA table_info(scheduled_lessons)").all() as Array<{ name: string }>;
  if (!lessonColumns.some((column) => column.name === "warnings_json")) {
    db.exec("ALTER TABLE scheduled_lessons ADD COLUMN warnings_json TEXT NOT NULL DEFAULT '[]'");
  }
  if (!lessonColumns.some((column) => column.name === "revision")) {
    db.exec("ALTER TABLE scheduled_lessons ADD COLUMN revision INTEGER NOT NULL DEFAULT 1");
  }
}

function seed(db: DatabaseInstance) {
  // Sample records help a new installation show a usable screen before real data
  // is imported. Once any teacher exists, never overwrite the user's database.
  const count = db.prepare("SELECT COUNT(*) AS count FROM teachers").get() as { count: number };
  if (count.count > 0) return;

  // Prepare the repeated insert statements once, then add all sample data atomically.
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
  // SQLite stores booleans as 0/1; the API exposes human-readable status text.
  return isActive ? "Active" : "Inactive";
}

function hashPassword(password: string) {
  // Scrypt is deliberately slow for attackers. A unique random salt means equal
  // passwords never produce equal stored values; plaintext is never persisted.
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}

function passwordMatches(password: string, stored: string) {
  // Recreate the saved scrypt value with its original salt, then use a timing-safe
  // comparison so password checks do not reveal which characters matched.
  const [salt, expectedHex] = stored.split(":");
  if (!salt || !expectedHex) return false;
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function sessionHash(token: string) {
  // Only a one-way digest of the bearer token is stored, limiting damage if the
  // local database is copied while an account is logged in.
  return createHash("sha256").update(token).digest("hex");
}

function createSession(db: DatabaseInstance, userId: string) {
  // Give the browser a random token but store only its hash in SQLite, limiting the
  // usefulness of a copied session table to anyone without the original cookie.
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
  db.prepare("INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(sessionHash(token), userId, expiresAt);
  return { token, expiresAt };
}

export function authenticationStatus(token?: string): { setupRequired: boolean; user: AppUserRecord | null } {
  // The login screen needs to know whether first-time setup is required and whether
  // a supplied session token still identifies an active user.
  const db = database();
  const count = db.prepare("SELECT COUNT(*) AS count FROM app_users").get() as { count: number };
  return { setupRequired: count.count === 0, user: token ? validateSession(token) : null };
}

export function validateSession(token: string): AppUserRecord | null {
  // Session validation joins the active account and checks expiry in one query so
  // disabled users and expired cookies lose access immediately.
  const db = database();
  db.prepare("DELETE FROM auth_sessions WHERE expires_at <= ?").run(new Date().toISOString());
  const row = db.prepare(`SELECT users.id, users.username, users.is_admin, users.is_active FROM auth_sessions sessions JOIN app_users users ON users.id = sessions.user_id WHERE sessions.token_hash = ? AND sessions.expires_at > ? AND users.is_active = 1`).get(sessionHash(token), new Date().toISOString()) as { id: string; username: string; is_admin: number; is_active: number } | undefined;
  return row ? { id: row.id, username: row.username, isAdmin: Boolean(row.is_admin), isActive: Boolean(row.is_active) } : null;
}

export function createInitialAdmin(username: string, password: string) {
  // First-run setup is allowed only while the account table is empty; creating the
  // administrator and its first session in one transaction avoids a half-setup state.
  const db = database();
  // The first-user check and insert share one transaction so two simultaneous setup
  // requests cannot both become separate bootstrap administrators.
  return db.transaction(() => {
    const count = db.prepare("SELECT COUNT(*) AS count FROM app_users").get() as { count: number };
    if (count.count > 0) throw new Error("Initial administrator has already been created.");
    const id = crypto.randomUUID();
    db.prepare("INSERT INTO app_users (id, username, password_hash, is_admin) VALUES (?, ?, ?, 1)").run(id, username, hashPassword(password));
    return { user: { id, username, isAdmin: true, isActive: true }, session: createSession(db, id) };
  })();
}

export function loginUser(username: string, password: string) {
  // Login accepts only active accounts with a matching password and returns a fresh
  // server-side session for the secure browser cookie.
  const db = database();
  const row = db.prepare("SELECT id, username, password_hash, is_admin, is_active FROM app_users WHERE username = ? COLLATE NOCASE").get(username) as { id: string; username: string; password_hash: string; is_admin: number; is_active: number } | undefined;
  if (!row || !row.is_active || !passwordMatches(password, row.password_hash)) return null;
  return { user: { id: row.id, username: row.username, isAdmin: Boolean(row.is_admin), isActive: true }, session: createSession(db, row.id) };
}

export function logoutSession(token: string) {
  // Logging out deletes only the hashed form of this browser's session token.
  return database().prepare("DELETE FROM auth_sessions WHERE token_hash = ?").run(sessionHash(token)).changes > 0;
}

export function listAppUsers(): AppUserRecord[] {
  // Administrators see account identity and status, never password hashes or sessions.
  const rows = database().prepare("SELECT id, username, is_admin, is_active FROM app_users ORDER BY username").all() as Array<{ id: string; username: string; is_admin: number; is_active: number }>;
  return rows.map((row) => ({ id: row.id, username: row.username, isAdmin: Boolean(row.is_admin), isActive: Boolean(row.is_active) }));
}

export function createAppUser(username: string, password: string): AppUserRecord {
  // New team members are scheduler accounts by default; only the initial account is
  // an administrator who can later create, disable or reset other accounts.
  const id = crypto.randomUUID();
  database().prepare("INSERT INTO app_users (id, username, password_hash, is_admin) VALUES (?, ?, ?, 0)").run(id, username, hashPassword(password));
  return { id, username, isAdmin: false, isActive: true };
}

export function changeOwnPassword(userId: string, currentPassword: string, newPassword: string) {
  // A signed-in user must prove the current password before replacing its hash, and
  // every session is revoked so the new password becomes the sole credential.
  const db = database();
  const user = db.prepare("SELECT password_hash FROM app_users WHERE id = ? AND is_active = 1").get(userId) as { password_hash: string } | undefined;
  if (!user || !passwordMatches(currentPassword, user.password_hash)) return false;
  // Password changes revoke every existing login, including other forgotten browsers.
  db.transaction(() => {
    db.prepare("UPDATE app_users SET password_hash = ? WHERE id = ?").run(hashPassword(newPassword), userId);
    db.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(userId);
  })();
  return true;
}

export function setAppUserStatus(userId: string, isActive: boolean) {
  // Account deactivation is reversible and removes existing sessions without
  // deleting the username or historical ownership context.
  const db = database();
  // Deactivation revokes active sessions immediately; reactivation does not create one.
  return db.transaction(() => {
    const changed = db.prepare("UPDATE app_users SET is_active = ? WHERE id = ? AND is_admin = 0").run(isActive ? 1 : 0, userId).changes > 0;
    if (changed && !isActive) db.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(userId);
    return changed;
  })();
}

export function resetAppUserPassword(userId: string, newPassword: string) {
  // Administrator reset replaces the stored hash and signs out every browser using
  // that account, forcing the owner to authenticate with the new password.
  const db = database();
  return db.transaction(() => {
    const changed = db.prepare("UPDATE app_users SET password_hash = ? WHERE id = ? AND is_admin = 0").run(hashPassword(newPassword), userId).changes > 0;
    if (changed) db.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(userId);
    return changed;
  })();
}

export function listTeachers(): TeacherRecord[] {
  // Count imported teaching allocations beside each teacher so the data screen
  // immediately shows how many sections that teacher has been assigned.
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
  // UUIDs allow a record to be created locally without relying on a database counter.
  const id = crypto.randomUUID();
  database().prepare("INSERT INTO teachers (id, name, staff_type) VALUES (?, ?, ?)").run(id, name, staffType);
  return { id, name, staffType, status: "Active", sections: 0 };
}

export function updateTeacher(id: string, input: { name: string; staffType: "FT" | "PT" }) {
  // Editing the existing row preserves every allocation, unavailable window and
  // scheduled lesson that already refers to this teacher's stable id.
  const result = database().prepare(`
    UPDATE teachers SET name = ?, staff_type = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(input.name, input.staffType, id);
  return result.changes > 0;
}

export function setTeacherStatus(id: string, isActive: boolean) {
  // Deactivating preserves old timetable history while hiding a teacher from future work.
  const result = database().prepare("UPDATE teachers SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(isActive ? 1 : 0, id);
  return result.changes > 0;
}

export function listStudentGroups(): StudentGroupRecord[] {
  // Order groups predictably for staff: year first, then programme, then class code.
  const rows = database().prepare("SELECT id, code, year, program FROM student_groups ORDER BY year ASC, program ASC, code ASC").all() as StudentGroupRecord[];
  return rows;
}

export function createStudentGroup(code: string, year: number, program: string): StudentGroupRecord {
  // Student groups are stable conflict-check identities; year and programme remain
  // editable attributes while the generated database id protects existing links.
  const id = crypto.randomUUID();
  database().prepare("INSERT INTO student_groups (id, code, year, program) VALUES (?, ?, ?, ?)").run(id, code, year, program);
  return { id, code, year, program };
}

export function updateStudentGroup(id: string, input: { code: string; year: number; program: string }) {
  // Keep the original group id so all section assignments survive a spelling,
  // programme or year correction made by the scheduling team.
  const db = database();
  const result = db.prepare(`
    UPDATE student_groups SET code = ?, year = ?, program = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(input.code, input.year, input.program, id);
  // Group labels appear inside conflict warnings, so refresh saved warnings as
  // soon as a linked group's details change.
  if (result.changes > 0) refreshAllScheduleWarnings(db);
  return result.changes > 0;
}

export function listRooms(): RoomRecord[] {
  // Convert separate database flags into a short list that the table can display.
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
  // Save room capacity and all facility flags together; Smart Classroom also implies
  // Multi Projector so later requirement checks see a consistent feature set.
  const id = crypto.randomUUID();
  // Room codes follow Block-Level-Room, so the first segment supports travel warnings later.
  const block = input.code.split("-")[0] || null;
  // A Smart Classroom is always also a Multi Projector room in this department.
  const hasMultiProjector = input.hasMultiProjector || input.isSmartClassroom;
  database().prepare("INSERT INTO rooms (id, code, block, capacity, has_multi_projector, is_lab, is_smart_classroom) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, input.code, block, input.capacity, hasMultiProjector ? 1 : 0, input.hasLab ? 1 : 0, input.isSmartClassroom ? 1 : 0);
  return { id, code: input.code, capacity: input.capacity, features: [input.hasLab ? "Lab" : "", hasMultiProjector ? "Multi projector" : "", input.isSmartClassroom ? "Smart classroom" : ""].filter(Boolean), status: "Active" };
}

export function updateRoom(id: string, input: { code: string; capacity: number; hasLab: boolean; hasMultiProjector: boolean; isSmartClassroom: boolean }) {
  // Recalculate Block whenever the room address changes because back-to-back travel
  // warnings must use the latest building rather than a stale imported value.
  const block = input.code.split("-")[0] || null;
  // Preserve the department rule that every Smart Classroom is also multi-projector.
  const hasMultiProjector = input.hasMultiProjector || input.isSmartClassroom;
  const db = database();
  const result = db.prepare(`
    UPDATE rooms SET code = ?, block = ?, capacity = ?, has_multi_projector = ?,
      is_lab = ?, is_smart_classroom = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(input.code, block, input.capacity, hasMultiProjector ? 1 : 0, input.hasLab ? 1 : 0, input.isSmartClassroom ? 1 : 0, id);
  if (result.changes > 0) refreshAllScheduleWarnings(db);
  return result.changes > 0;
}

export function setRoomStatus(id: string, isActive: boolean) {
  // Rooms are deactivated rather than deleted so existing timetable cards keep a
  // valid historical room reference while new candidate searches exclude them.
  const db = database();
  const result = db.prepare("UPDATE rooms SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(isActive ? 1 : 0, id);
  if (result.changes > 0) refreshAllScheduleWarnings(db);
  return result.changes > 0;
}

export function listUnavailableWindows(): UnavailableWindowRecord[] {
  // Combine teacher and year restrictions into one UI list while retaining their kind.
  const teachers = database().prepare(`SELECT windows.id, windows.teacher_id AS owner_id, teachers.name AS owner_label, windows.day_of_week, windows.start_hour, windows.end_hour FROM teacher_unavailable_windows windows JOIN teachers ON teachers.id = windows.teacher_id ORDER BY teachers.name, windows.day_of_week, windows.start_hour`).all() as Array<{ id: string; owner_id: string; owner_label: string; day_of_week: number; start_hour: number; end_hour: number }>;
  const years = database().prepare(`SELECT id, CAST(year AS TEXT) AS owner_id, 'Year ' || year AS owner_label, day_of_week, start_hour, end_hour FROM year_blocked_windows ORDER BY year, day_of_week, start_hour`).all() as Array<{ id: string; owner_id: string; owner_label: string; day_of_week: number; start_hour: number; end_hour: number }>;
  return [...teachers.map((row) => ({ id: row.id, kind: "Teacher" as const, ownerId: row.owner_id, ownerLabel: row.owner_label, dayOfWeek: row.day_of_week, startHour: row.start_hour, endHour: row.end_hour })), ...years.map((row) => ({ id: row.id, kind: "Year" as const, ownerId: row.owner_id, ownerLabel: row.owner_label, dayOfWeek: row.day_of_week, startHour: row.start_hour, endHour: row.end_hour }))];
}

export function createUnavailableWindow(input: { kind: "Teacher" | "Year"; ownerId: string; dayOfWeek: number; startHour: number; endHour: number }) {
  // Restrictions use half-open time ranges [start, end), matching lesson overlap logic.
  const id = crypto.randomUUID();
  const db = database();
  if (input.kind === "Teacher") db.prepare("INSERT INTO teacher_unavailable_windows (id, teacher_id, day_of_week, start_hour, end_hour) VALUES (?, ?, ?, ?, ?)").run(id, input.ownerId, input.dayOfWeek, input.startHour, input.endHour);
  else db.prepare("INSERT INTO year_blocked_windows (id, year, day_of_week, start_hour, end_hour) VALUES (?, ?, ?, ?, ?)").run(id, Number(input.ownerId), input.dayOfWeek, input.startHour, input.endHour);
  refreshAllScheduleWarnings(db);
  return id;
}

export function deleteUnavailableWindow(id: string, kind: "Teacher" | "Year") {
  // The kind selects the exact table, preventing a coincidental id match elsewhere.
  const table = kind === "Teacher" ? "teacher_unavailable_windows" : "year_blocked_windows";
  const db = database();
  const removed = db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id).changes > 0;
  if (removed) refreshAllScheduleWarnings(db);
  return removed;
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
  // Join the stable explanatory copy to the small persisted switch table in code,
  // keeping the database focused on values staff may change.
  const rows = database().prepare("SELECT rule_key, is_enabled FROM rule_settings").all() as Array<{ rule_key: string; is_enabled: number }>;
  const enabledByKey = new Map(rows.map((row) => [row.rule_key, Boolean(row.is_enabled)]));
  return ruleSettingDetails.map((rule) => ({ ...rule, enabled: enabledByKey.get(rule.key) ?? true }));
}

export function updateRuleSetting(key: string, enabled: boolean) {
  // Only registered policy keys can be changed; core collision checks deliberately
  // have no switch and therefore cannot be disabled by accident.
  if (!ruleSettingDetails.some((rule) => rule.key === key)) return false;
  const db = database();
  const changed = db.prepare("UPDATE rule_settings SET is_enabled = ? WHERE rule_key = ?").run(enabled ? 1 : 0, key).changes > 0;
  if (changed) refreshAllScheduleWarnings(db);
  return changed;
}

function readCycleSnapshot(db: DatabaseInstance): CycleSnapshot {
  // Explicit table lists make the backup boundary reviewable: only data cleared by
  // a new cycle enters the snapshot, never accounts or retained master data.
  return {
    courses: db.prepare("SELECT id, code, catalog, duration_hours, sessions_per_week, primary_year, minimum_room_capacity, requires_lab, requires_multi_projector, requires_smart_classroom, separate_sections_across_days, week_pattern, week_start, week_end, created_at, updated_at FROM courses ORDER BY id").all() as CourseSnapshotRow[],
    allocations: db.prepare("SELECT id, course_id, teacher_id, assigned_group_count FROM teaching_allocations ORDER BY id").all() as AllocationSnapshotRow[],
    sections: db.prepare("SELECT id, course_id, sequence, teacher_id FROM course_sections ORDER BY id").all() as SectionSnapshotRow[],
    sectionGroups: db.prepare("SELECT section_id, student_group_id FROM section_student_groups ORDER BY section_id, student_group_id").all() as SectionGroupSnapshotRow[],
    lessons: db.prepare("SELECT id, section_id, occurrence, day_of_week, start_hour, duration_hours, room_id, warnings_json, revision FROM scheduled_lessons ORDER BY id").all() as LessonSnapshotRow[],
  };
}

function backupSummary(id: string, createdAt: string, snapshot: CycleSnapshot) {
  // The cycle screen shows only counts and time, not the large JSON snapshot itself.
  return { id, createdAt, courses: snapshot.courses.length, sections: snapshot.sections.length, lessons: snapshot.lessons.length };
}

export function cycleStatus(): CycleStatusRecord {
  // Report current working totals and the newest emergency backup available for the
  // one supported undo operation after starting a new cycle.
  const db = database();
  // Only the newest emergency backup is exposed; this is not a browsable version
  // history and therefore stays aligned with the agreed first-release scope.
  const current = db.prepare("SELECT (SELECT COUNT(*) FROM courses) AS courses, (SELECT COUNT(*) FROM course_sections) AS sections, (SELECT COUNT(*) FROM scheduled_lessons) AS lessons").get() as { courses: number; sections: number; lessons: number };
  const backup = db.prepare("SELECT id, snapshot_json, created_at FROM schedule_backups ORDER BY created_at DESC LIMIT 1").get() as { id: string; snapshot_json: string; created_at: string } | undefined;
  if (!backup) return { ...current, backup: null };
  try {
    return { ...current, backup: backupSummary(backup.id, backup.created_at, JSON.parse(backup.snapshot_json) as CycleSnapshot) };
  } catch {
    // A damaged snapshot must never prevent staff from opening the cycle screen.
    return { ...current, backup: null };
  }
}

export function startNewCycle(): CycleStatusRecord {
  // Snapshot the current course work, then clear lessons, generated sections and
  // courses in one transaction while retaining people, rooms, rules and accounts.
  const db = database();
  const snapshot = readCycleSnapshot(db);
  if (snapshot.courses.length === 0) throw new Error("There is no current course cycle to clear.");
  const backupId = crypto.randomUUID();
  const createdAt = new Date().toISOString();

  // Save the complete snapshot and clear the current cycle atomically. A failure in
  // either step rolls back both, so staff never receive an incomplete empty system.
  const replaceCycle = db.transaction(() => {
    db.prepare("DELETE FROM schedule_backups").run();
    db.prepare("INSERT INTO schedule_backups (id, snapshot_json, created_at) VALUES (?, ?, ?)").run(backupId, JSON.stringify(snapshot), createdAt);
    db.prepare("DELETE FROM courses").run();
  });
  replaceCycle();
  return cycleStatus();
}

export function restoreLastCycleBackup(): CycleStatusRecord {
  // Replace current cycle work from the newest emergency JSON snapshot in a single
  // transaction, then recalculate warnings against retained rules and restrictions.
  const db = database();
  const backup = db.prepare("SELECT snapshot_json FROM schedule_backups ORDER BY created_at DESC LIMIT 1").get() as { snapshot_json: string } | undefined;
  if (!backup) throw new Error("No emergency cycle backup is available.");
  let snapshot: CycleSnapshot;
  try {
    snapshot = JSON.parse(backup.snapshot_json) as CycleSnapshot;
  } catch {
    throw new Error("The emergency backup is not valid.");
  }
  if (![snapshot.courses, snapshot.allocations, snapshot.sections, snapshot.sectionGroups, snapshot.lessons].every(Array.isArray)) throw new Error("The emergency backup is not valid.");

  // Restore in parent-to-child order so every foreign key is valid. Clearing and
  // rebuilding run in one transaction; missing retained master data would roll back.
  const restore = db.transaction(() => {
    db.prepare("DELETE FROM courses").run();
    const insertCourse = db.prepare(`INSERT INTO courses (id, code, catalog, duration_hours, sessions_per_week, primary_year, minimum_room_capacity, requires_lab, requires_multi_projector, requires_smart_classroom, separate_sections_across_days, week_pattern, week_start, week_end, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const row of snapshot.courses) {
      // Old backups contain only week_pattern; derive their numeric boundaries when
      // restoring after this schema upgrade.
      const weekStart = row.week_start ?? (row.week_pattern === "W1_4" ? 1 : row.week_pattern === "W5_8" ? 5 : null);
      const weekEnd = row.week_end ?? (row.week_pattern === "W1_4" ? 4 : row.week_pattern === "W5_8" ? 8 : null);
      insertCourse.run(row.id, row.code, row.catalog, row.duration_hours, row.sessions_per_week, row.primary_year, row.minimum_room_capacity, row.requires_lab, row.requires_multi_projector, row.requires_smart_classroom, row.separate_sections_across_days, row.week_pattern, weekStart, weekEnd, row.created_at, row.updated_at);
    }
    const insertAllocation = db.prepare("INSERT INTO teaching_allocations (id, course_id, teacher_id, assigned_group_count) VALUES (?, ?, ?, ?)");
    for (const row of snapshot.allocations) insertAllocation.run(row.id, row.course_id, row.teacher_id, row.assigned_group_count);
    const insertSection = db.prepare("INSERT INTO course_sections (id, course_id, sequence, teacher_id) VALUES (?, ?, ?, ?)");
    for (const row of snapshot.sections) insertSection.run(row.id, row.course_id, row.sequence, row.teacher_id);
    const insertSectionGroup = db.prepare("INSERT INTO section_student_groups (section_id, student_group_id) VALUES (?, ?)");
    for (const row of snapshot.sectionGroups) insertSectionGroup.run(row.section_id, row.student_group_id);
    const insertLesson = db.prepare("INSERT INTO scheduled_lessons (id, section_id, occurrence, day_of_week, start_hour, duration_hours, room_id, warnings_json, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const row of snapshot.lessons) insertLesson.run(row.id, row.section_id, row.occurrence, row.day_of_week, row.start_hour, row.duration_hours, row.room_id, row.warnings_json, row.revision);
  });
  restore();
  // Master data or policy settings may have changed since the emergency snapshot;
  // restore placements exactly, then evaluate them against the current retained rules.
  refreshAllScheduleWarnings(db);
  return cycleStatus();
}

export function listCourses(): CourseRecord[] {
  // Use separate subqueries so the section count and allocation total do not multiply
  // each other when a course has several teachers and several generated sections.
  const rows = database().prepare(`
    SELECT courses.id, courses.code, courses.catalog, courses.duration_hours, courses.sessions_per_week,
      courses.primary_year, courses.minimum_room_capacity, courses.requires_lab,
      courses.requires_multi_projector, courses.requires_smart_classroom,
      courses.separate_sections_across_days, courses.week_pattern, courses.week_start, courses.week_end,
      (SELECT COUNT(*) FROM course_sections WHERE course_sections.course_id = courses.id) AS configured_sections,
      (SELECT COALESCE(SUM(assigned_group_count), 0) FROM teaching_allocations WHERE teaching_allocations.course_id = courses.id) AS allocated_sections
    FROM courses
    ORDER BY courses.code ASC
  `).all() as Array<{ id: string; code: string; catalog: string | null; duration_hours: number | null; sessions_per_week: number; primary_year: number | null; minimum_room_capacity: number | null; requires_lab: number; requires_multi_projector: number; requires_smart_classroom: number; separate_sections_across_days: number; week_pattern: "ALL" | "W1_4" | "W5_8"; week_start: number | null; week_end: number | null; configured_sections: number; allocated_sections: number }>;
  return rows.map((row) => ({
    id: row.id,
    code: row.code,
    catalog: row.catalog,
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
    allocationVarianceCount: listCourseAllocationVariances(row.id).length,
  }));
}

export function createManualCourse(input: { code: string; catalog: string | null; sectionCount: number }): CourseRecord {
  // Manual creation covers modules omitted from Excel; generated sections begin
  // unassigned so staff can choose teachers and student groups explicitly.
  const db = database();
  // A manual course covers a missing Excel row without inventing a teaching
  // allocation. Its sections start unassigned so staff can choose teachers explicitly.
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
  // Reuse the normal projection so manually and spreadsheet-created courses always
  // have exactly the same API shape and downstream behaviour.
  const course = listCourses().find((item) => item.id === id);
  if (!course) throw new Error("The course was created but could not be read.");
  return course;
}

export function resizeCourseSections(courseId: string, sectionCount: number) {
  // Increasing adds the next numbered sections; decreasing removes only the highest
  // unscheduled sections so saved timetable work is never silently discarded.
  const db = database();
  // Resize only at the highest sequence numbers, preserving stable labels and all
  // assignments on LEAD_01 ... LEAD_N that remain within the requested count.
  const resize = db.transaction(() => {
    const course = db.prepare("SELECT id FROM courses WHERE id = ?").get(courseId) as { id: string } | undefined;
    if (!course) return false;
    const currentSections = db.prepare("SELECT id, sequence FROM course_sections WHERE course_id = ? ORDER BY sequence ASC").all(courseId) as Array<{ id: string; sequence: number }>;

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
        // A user must first return scheduled lessons to the tray and clear student
        // groups, preventing a count correction from silently discarding real work.
        if (hasScheduledLesson.get(section.id)) throw new Error(`${section.sequence} is already scheduled. Return that section to the tray before reducing the count.`);
        if (hasStudentGroup.get(section.id)) throw new Error(`${section.sequence} has student groups. Clear its assignments before reducing the count.`);
      }
      const removeSection = db.prepare("DELETE FROM course_sections WHERE id = ?");
      for (const section of removable) removeSection.run(section.id);
    }
    return true;
  });
  return resize();
}

export function updateCourseSetup(id: string, input: Omit<CourseRecord, "id" | "code" | "catalog" | "durationHours" | "weekPattern" | "allocatedSections" | "configuredSections" | "allocationVarianceCount"> & { durationHours: number }) {
  // Course requirements apply to every generated section, so they are saved once
  // on the course rather than duplicated 18 times for a course such as LEAD.
  const db = database();
  // Keep the business rule at the persistence boundary as well as the API, because
  // maintenance scripts may call this shared function directly in future releases.
  if (!Number.isInteger(input.durationHours) || input.durationHours < 2 || input.durationHours > 4) {
    throw new Error("Course duration must be 2 to 4 whole hours.");
  }
  if ((input.weekStart === null) !== (input.weekEnd === null) || (input.weekStart !== null && input.weekEnd !== null && (!Number.isInteger(input.weekStart) || !Number.isInteger(input.weekEnd) || input.weekStart < 1 || input.weekEnd < input.weekStart))) {
    throw new Error("Teaching weeks must be blank for all weeks or a valid positive start and end range.");
  }
  // Do not silently hide a second weekly meeting that staff have already scheduled.
  const scheduledExtra = db.prepare(`SELECT 1 FROM scheduled_lessons lessons JOIN course_sections sections ON sections.id = lessons.section_id WHERE sections.course_id = ? AND lessons.occurrence > ?`).get(id, input.sessionsPerWeek);
  if (scheduledExtra) throw new Error("Return the extra weekly sessions to the tray before reducing sessions per week.");
  const outsideGrid = db.prepare(`SELECT 1 FROM scheduled_lessons lessons JOIN course_sections sections ON sections.id = lessons.section_id WHERE sections.course_id = ? AND lessons.start_hour + ? > 18 LIMIT 1`).get(id, input.durationHours);
  if (outsideGrid) throw new Error("Move late lessons earlier before increasing this course duration.");
  const save = db.transaction(() => {
    const result = db.prepare(`
      UPDATE courses SET duration_hours = ?, sessions_per_week = ?, primary_year = ?,
        minimum_room_capacity = ?, requires_lab = ?, requires_multi_projector = ?,
        requires_smart_classroom = ?, separate_sections_across_days = ?, week_pattern = ?,
        week_start = ?, week_end = ?,
        updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(input.durationHours, input.sessionsPerWeek, input.primaryYear, input.minimumRoomCapacity, input.requiresLab ? 1 : 0, input.requiresMultiProjector ? 1 : 0, input.requiresSmartClassroom ? 1 : 0, input.separateSectionsAcrossDays ? 1 : 0, legacyWeekPattern(input.weekStart, input.weekEnd), input.weekStart, input.weekEnd, id);
    // Scheduled lessons copy duration for fast grid rendering; keep that denormalised
    // value synchronized whenever the shared course requirement changes.
    if (result.changes > 0) db.prepare("UPDATE scheduled_lessons SET duration_hours = ?, revision = revision + 1 WHERE section_id IN (SELECT id FROM course_sections WHERE course_id = ?)").run(input.durationHours, id);
    return result.changes > 0;
  });
  const changed = save();
  if (changed) refreshAllScheduleWarnings(db);
  return changed;
}

export function listCourseSections(courseId: string): CourseSectionRecord[] {
  // Aggregate student groups into one row per section so the browser can show its
  // complete conflict scope beside the teacher assignment.
  const rows = database().prepare(`
    SELECT course_sections.id, courses.code, course_sections.sequence, teachers.id AS teacher_id,
      teachers.name AS teacher_name, student_groups.id AS group_id, student_groups.code AS group_code
    FROM course_sections
    JOIN courses ON courses.id = course_sections.course_id
    LEFT JOIN teachers ON teachers.id = course_sections.teacher_id
    LEFT JOIN section_student_groups ON section_student_groups.section_id = course_sections.id
    LEFT JOIN student_groups ON student_groups.id = section_student_groups.student_group_id
    WHERE course_sections.course_id = ?
    ORDER BY course_sections.sequence ASC, student_groups.code ASC
  `).all(courseId) as Array<{ id: string; code: string; sequence: number; teacher_id: string | null; teacher_name: string | null; group_id: string | null; group_code: string | null }>;
  const sections = new Map<string, CourseSectionRecord>();
  for (const row of rows) {
    const section = sections.get(row.id) ?? { id: row.id, label: `${row.code}_${String(row.sequence).padStart(2, "0")}`, teacherId: row.teacher_id, teacherName: row.teacher_name, studentGroupIds: [], studentGroupCodes: [] };
    if (row.group_id && row.group_code) {
      section.studentGroupIds.push(row.group_id);
      section.studentGroupCodes.push(row.group_code);
    }
    sections.set(row.id, section);
  }
  return [...sections.values()];
}

export function listCourseAllocationVariances(courseId: string): AllocationVarianceRecord[] {
  // Compare imported teacher group counts with the current section assignments so
  // manual substitutions remain allowed but visible to the scheduler.
  const db = database();
  // Manual courses have no Teaching Members baseline, so their freely assigned
  // teachers must not be reported as a mismatch against a non-existent allocation.
  const hasAllocation = db.prepare("SELECT 1 FROM teaching_allocations WHERE course_id = ? LIMIT 1").get(courseId);
  if (!hasAllocation) return [];

  // Include both expected teachers and any substitute teacher currently assigned.
  // Correlated counts keep the calculation readable and are inexpensive at this scale.
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

export function updateCourseSection(id: string, teacherId: string | null, studentGroupIds: string[]) {
  // Save one teacher and all linked student groups together, then invalidate any
  // open lesson editors and refresh warnings affected by the assignment change.
  const db = database();
  // Replacing the join records in one transaction makes an edited cross-level class
  // immediately consistent for future conflict checks.
  const transaction = db.transaction(() => {
    const section = db.prepare("SELECT id, course_id FROM course_sections WHERE id = ?").get(id) as { id: string; course_id: string } | undefined;
    if (!section) return null;
    if (teacherId) {
      const teacher = db.prepare("SELECT id FROM teachers WHERE id = ? AND is_active = 1").get(teacherId);
      if (!teacher) throw new Error("Teacher not found");
    }
    db.prepare("UPDATE course_sections SET teacher_id = ? WHERE id = ?").run(teacherId, id);
    db.prepare("DELETE FROM section_student_groups WHERE section_id = ?").run(id);
    const addGroup = db.prepare("INSERT INTO section_student_groups (section_id, student_group_id) VALUES (?, ?)");
    for (const groupId of [...new Set(studentGroupIds)]) addGroup.run(id, groupId);
    // A timetable editor opened before this assignment change must not later
    // overwrite it with a stale save, so invalidate every scheduled occurrence.
    db.prepare("UPDATE scheduled_lessons SET revision = revision + 1 WHERE section_id = ?").run(id);
    return section.course_id;
  });
  const courseId = transaction();
  if (courseId) refreshAllScheduleWarnings(db);
  return courseId;
}

export function listScheduledLessons(year: number): ScheduledLessonRecord[] {
  // The master timetable is filtered by the course's primary year, while each lesson
  // still retains its cross-year student groups for conflict checks.
  const rows = database().prepare(`
    SELECT lessons.id, lessons.section_id, courses.code, sections.sequence, teachers.id AS teacher_id, teachers.name AS teacher_name,
      lessons.day_of_week, lessons.start_hour, lessons.duration_hours, lessons.room_id,
      lessons.warnings_json, lessons.occurrence, lessons.revision, courses.sessions_per_week,
      courses.week_start, courses.week_end,
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
    WHERE courses.primary_year = ? ORDER BY lessons.day_of_week, lessons.start_hour
  `).all(year) as Array<{ id: string; section_id: string; code: string; sequence: number; teacher_id: string | null; teacher_name: string | null; day_of_week: number; start_hour: number; duration_hours: number; room_id: string | null; warnings_json: string; occurrence: number; revision: number; sessions_per_week: number; week_start: number | null; week_end: number | null; room_code: string | null; student_groups: string | null }>;
  return rows.map((row) => {
    // Attach the highest issue level so the timetable card can use the same colour
    // standard as the consolidated issue list without reimplementing rule text.
    const warnings = JSON.parse(row.warnings_json) as string[];
    return { id: row.id, sectionId: row.section_id, sectionLabel: `${row.code}_${String(row.sequence).padStart(2, "0")}${row.sessions_per_week > 1 ? ` · Session ${row.occurrence}` : ""}${weekRangeSuffix(row.week_start, row.week_end)}`, courseCode: row.code, teacherId: row.teacher_id, teacherName: row.teacher_name, dayOfWeek: row.day_of_week, startHour: row.start_hour, durationHours: row.duration_hours, roomId: row.room_id, roomCode: row.room_code, studentGroups: row.student_groups ? row.student_groups.split(", ") : [], occurrence: row.occurrence, sessionsPerWeek: row.sessions_per_week, revision: row.revision, warnings, warningSeverity: highestIssueSeverity(warnings) };
  });
}

export function listPersonalScheduledLessons(kind: "Teacher" | "StudentGroup" | "Room", ownerId: string): ScheduledLessonRecord[] {
  // Personal views query the same lesson records across all three primary years;
  // no duplicate timetable copy is created for a teacher, group or room.
  const db = database();
  // Teacher and room schedules span all three master years. Student-group schedules
  // use the link table so a cross-level course appears for every participating class.
  const ownerFilter = kind === "Teacher"
    ? "sections.teacher_id = ?"
    : kind === "Room"
      ? "lessons.room_id = ?"
      : "EXISTS (SELECT 1 FROM section_student_groups personal_links WHERE personal_links.section_id = sections.id AND personal_links.student_group_id = ?)";
  const rows = db.prepare(`
    SELECT lessons.id, lessons.section_id, courses.code, sections.sequence,
      teachers.id AS teacher_id, teachers.name AS teacher_name, lessons.day_of_week,
      lessons.start_hour, lessons.duration_hours, lessons.room_id,
      lessons.warnings_json, lessons.occurrence, lessons.revision, courses.sessions_per_week,
      courses.week_start, courses.week_end,
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
    WHERE ${ownerFilter}
    ORDER BY lessons.day_of_week, lessons.start_hour, courses.code, sections.sequence
  `).all(ownerId) as Array<{ id: string; section_id: string; code: string; sequence: number; teacher_id: string | null; teacher_name: string | null; day_of_week: number; start_hour: number; duration_hours: number; room_id: string | null; warnings_json: string; occurrence: number; revision: number; sessions_per_week: number; week_start: number | null; week_end: number | null; room_code: string | null; student_groups: string | null }>;
  return rows.map((row) => {
    // Personal teacher, student and room views use the identical server-derived
    // issue level as the year master table.
    const warnings = JSON.parse(row.warnings_json) as string[];
    return { id: row.id, sectionId: row.section_id, sectionLabel: `${row.code}_${String(row.sequence).padStart(2, "0")}${row.sessions_per_week > 1 ? ` · Session ${row.occurrence}` : ""}${weekRangeSuffix(row.week_start, row.week_end)}`, courseCode: row.code, teacherId: row.teacher_id, teacherName: row.teacher_name, dayOfWeek: row.day_of_week, startHour: row.start_hour, durationHours: row.duration_hours, roomId: row.room_id, roomCode: row.room_code, studentGroups: row.student_groups ? row.student_groups.split(", ") : [], occurrence: row.occurrence, sessionsPerWeek: row.sessions_per_week, revision: row.revision, warnings, warningSeverity: highestIssueSeverity(warnings) };
  });
}

export function listUnscheduledSections(year: number): UnscheduledSectionRecord[] {
  // Only sections with a completed duration can be dragged to the grid. Sections
  // missing setup remain visible in Courses, where staff can finish configuring them.
  const rows = database().prepare(`
    SELECT sections.id, courses.code, sections.sequence, courses.duration_hours,
      courses.sessions_per_week, courses.week_start, courses.week_end, occurrences.occurrence,
      teachers.name AS teacher_name, teachers.staff_type, student_groups.code AS group_code
    FROM course_sections sections
    JOIN courses ON courses.id = sections.course_id
    JOIN (SELECT 1 AS occurrence UNION ALL SELECT 2) occurrences
      ON occurrences.occurrence <= courses.sessions_per_week
    LEFT JOIN teachers ON teachers.id = sections.teacher_id
    LEFT JOIN section_student_groups links ON links.section_id = sections.id
    LEFT JOIN student_groups ON student_groups.id = links.student_group_id
    WHERE courses.primary_year = ? AND courses.duration_hours IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM scheduled_lessons WHERE scheduled_lessons.section_id = sections.id AND scheduled_lessons.occurrence = occurrences.occurrence)
    ORDER BY CASE WHEN teachers.staff_type = 'PT' THEN 0 ELSE 1 END,
      courses.code, sections.sequence, occurrences.occurrence, student_groups.code
  `).all(year) as Array<{ id: string; code: string; sequence: number; duration_hours: number; sessions_per_week: number; week_start: number | null; week_end: number | null; occurrence: number; teacher_name: string | null; staff_type: "FT" | "PT" | null; group_code: string | null }>;
  const sections = new Map<string, UnscheduledSectionRecord>();
  for (const row of rows) {
    // One section can contribute two draggable cards when it meets twice per week.
    const occurrenceKey = `${row.id}:${row.occurrence}`;
    const section = sections.get(occurrenceKey) ?? { id: occurrenceKey, label: `${row.code}_${String(row.sequence).padStart(2, "0")}${row.sessions_per_week > 1 ? ` · Session ${row.occurrence}` : ""}${weekRangeSuffix(row.week_start, row.week_end)}`, teacherName: row.teacher_name, staffType: row.staff_type, durationHours: row.duration_hours, studentGroups: [], occurrence: row.occurrence, sessionsPerWeek: row.sessions_per_week };
    if (row.group_code) section.studentGroups.push(row.group_code);
    sections.set(occurrenceKey, section);
  }
  return [...sections.values()];
}

type DailyInterval = { startHour: number; durationHours: number; block: string | null };

function longestContinuousHours(intervals: DailyInterval[]) {
  // Adjacent lessons count as one continuous block; overlapping lessons are merged
  // so a warning reflects elapsed time rather than double-counting a conflict.
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
  // With whole-hour lessons, the 12:00–14:00 lunch window has a free hour when
  // either 12:00–13:00 or 13:00–14:00 is not covered by any lesson.
  const occupied = (hour: number) => intervals.some((interval) => interval.startHour <= hour && interval.startHour + interval.durationHours >= hour + 1);
  return !occupied(12) || !occupied(13);
}

function hasBackToBackBlockChange(intervals: DailyInterval[], proposed: DailyInterval) {
  // Travel is only checked for immediately adjacent lessons and when both rooms have blocks.
  if (!proposed.block) return false;
  const proposedEnd = proposed.startHour + proposed.durationHours;
  return intervals.some((interval) => interval.block && interval.block !== proposed.block && (interval.startHour + interval.durationHours === proposed.startHour || interval.startHour === proposedEnd));
}

function calculatePlacementWarnings(db: DatabaseInstance, input: { sectionId: string; lessonId?: string; teacherId: string | null; roomId: string | null; dayOfWeek: number; startHour: number; durationHours: number }) {
  // Every placement path uses this single warning engine, ensuring drag, edit and
  // future candidate suggestions all apply the same conflict definitions.
  const warnings: string[] = [];
  const lessonId = input.lessonId ?? "";
  const endHour = input.startHour + input.durationHours;
  // Optional policy rules can change between semesters. Core resource and timetable
  // collisions below remain unconditional and are intentionally absent from this set.
  const enabledRules = new Set((db.prepare("SELECT rule_key FROM rule_settings WHERE is_enabled = 1").all() as Array<{ rule_key: string }>).map((row) => row.rule_key));
  const courseRule = db.prepare(`SELECT courses.id, courses.code, courses.sessions_per_week, courses.separate_sections_across_days, courses.week_start, courses.week_end FROM courses JOIN course_sections ON course_sections.course_id = courses.id WHERE course_sections.id = ?`).get(input.sectionId) as { id: string; code: string; sessions_per_week: number; separate_sections_across_days: number; week_start: number | null; week_end: number | null };
  if (courseRule.sessions_per_week > 1 && enabledRules.has("separate_weekly_sessions")) {
    // Separate weekly meetings of one class should not be placed on the same day,
    // otherwise a nominally twice-weekly course becomes one long teaching day.
    const sameSectionDay = db.prepare("SELECT 1 FROM scheduled_lessons WHERE id <> ? AND section_id = ? AND day_of_week = ?").get(lessonId, input.sectionId, input.dayOfWeek);
    if (sameSectionDay) warnings.push(`${courseRule.code} weekly sessions should be scheduled on different days`);
  }
  if (courseRule.separate_sections_across_days) {
    const sameDay = db.prepare(`SELECT 1 FROM scheduled_lessons lessons JOIN course_sections sections ON sections.id = lessons.section_id WHERE lessons.id <> ? AND sections.course_id = ? AND lessons.day_of_week = ?`).get(lessonId, courseRule.id, input.dayOfWeek);
    if (sameDay) warnings.push(`${courseRule.code} sections should not be scheduled on the same day`);
  }
  // Null bounds mean all weeks. Two limited ranges overlap inclusively when each
  // starts on or before the other's end; touching at the same week is a conflict.
  const overlaps = db.prepare(`
    SELECT lessons.id, sections.teacher_id, lessons.room_id
    FROM scheduled_lessons lessons
    JOIN course_sections sections ON sections.id = lessons.section_id
    JOIN courses occupied_courses ON occupied_courses.id = sections.course_id
    WHERE lessons.id <> ? AND lessons.day_of_week = ?
      AND lessons.start_hour < ? AND lessons.start_hour + lessons.duration_hours > ?
      AND (? IS NULL OR occupied_courses.week_start IS NULL
        OR (occupied_courses.week_start <= ? AND ? <= occupied_courses.week_end))
  `).all(lessonId, input.dayOfWeek, endHour, input.startHour, courseRule.week_start, courseRule.week_end, courseRule.week_start) as Array<{ id: string; teacher_id: string | null; room_id: string | null }>;

  // Missing assignments are allowed during drafting, but remain visible as warnings.
  if (!input.teacherId) warnings.push("Teacher not assigned");
  else {
    if (overlaps.some((row) => row.teacher_id === input.teacherId)) warnings.push("Teacher conflict");
    const unavailable = db.prepare("SELECT 1 FROM teacher_unavailable_windows WHERE teacher_id = ? AND day_of_week = ? AND start_hour < ? AND end_hour > ?").get(input.teacherId, input.dayOfWeek, endHour, input.startHour);
    if (unavailable) warnings.push("Teacher is unavailable at this time");
  }
  if (!input.roomId) warnings.push("Room not assigned");
  else if (overlaps.some((row) => row.room_id === input.roomId)) warnings.push("Room conflict");

  // Match shared student-group ids across overlapping sections, including cross-level classes.
  const groupConflicts = db.prepare(`
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
  `).all(input.sectionId, lessonId, input.dayOfWeek, endHour, input.startHour, courseRule.week_start, courseRule.week_end, courseRule.week_start) as Array<{ code: string }>;
  if (groupConflicts.length) warnings.push(`Student group conflict (${groupConflicts.map((group) => group.code).join(", ")})`);
  const groupCount = db.prepare("SELECT COUNT(*) AS count FROM section_student_groups WHERE section_id = ?").get(input.sectionId) as { count: number };
  if (groupCount.count === 0) warnings.push("Student group not assigned");
  const affectedYears = db.prepare(`SELECT DISTINCT year FROM student_groups JOIN section_student_groups ON section_student_groups.student_group_id = student_groups.id WHERE section_student_groups.section_id = ? UNION SELECT primary_year AS year FROM courses JOIN course_sections ON course_sections.course_id = courses.id WHERE course_sections.id = ? AND primary_year IS NOT NULL`).all(input.sectionId, input.sectionId) as Array<{ year: number }>;
  for (const affected of affectedYears) {
    const blocked = db.prepare("SELECT 1 FROM year_blocked_windows WHERE year = ? AND day_of_week = ? AND start_hour < ? AND end_hour > ?").get(affected.year, input.dayOfWeek, endHour, input.startHour);
    if (blocked) warnings.push(`Year ${affected.year} is unavailable at this time`);
  }

  // A selected room must satisfy every course requirement; Smart Classroom already
  // implies Multi Projector when room master data is saved.
  if (input.roomId) {
    const suitability = db.prepare(`SELECT rooms.code, rooms.capacity, rooms.has_multi_projector, rooms.is_lab, rooms.is_smart_classroom, rooms.is_active, courses.minimum_room_capacity, courses.requires_multi_projector, courses.requires_lab, courses.requires_smart_classroom FROM rooms JOIN course_sections sections ON sections.id = ? JOIN courses ON courses.id = sections.course_id WHERE rooms.id = ?`).get(input.sectionId, input.roomId) as { code: string; capacity: number; has_multi_projector: number; is_lab: number; is_smart_classroom: number; is_active: number; minimum_room_capacity: number | null; requires_multi_projector: number; requires_lab: number; requires_smart_classroom: number } | undefined;
    if (!suitability || !suitability.is_active) warnings.push("Room is unavailable");
    else {
      if (suitability.minimum_room_capacity && suitability.capacity < suitability.minimum_room_capacity) warnings.push(`Room capacity too small (${suitability.capacity}/${suitability.minimum_room_capacity})`);
      if (suitability.requires_lab && !suitability.is_lab) warnings.push("Lab room required");
      if (suitability.requires_multi_projector && !suitability.has_multi_projector) warnings.push("Multi Projector required");
      if (suitability.requires_smart_classroom && !suitability.is_smart_classroom) warnings.push("Smart Classroom required");
    }
  }

  // The department prefers 09:00 starts; 08:00 remains available when needed.
  if (input.startHour === 8 && enabledRules.has("prefer_9am")) warnings.push("08:00 start is discouraged");

  const proposedRoom = input.roomId ? db.prepare("SELECT block FROM rooms WHERE id = ?").get(input.roomId) as { block: string | null } | undefined : undefined;
  const proposed = { startHour: input.startHour, durationHours: input.durationHours, block: proposedRoom?.block ?? null };
  if (input.teacherId) {
    const teacherDay = db.prepare(`
      SELECT lessons.start_hour, lessons.duration_hours, rooms.block
      FROM scheduled_lessons lessons
      JOIN course_sections sections ON sections.id = lessons.section_id
      JOIN courses occupied_courses ON occupied_courses.id = sections.course_id
      LEFT JOIN rooms ON rooms.id = lessons.room_id
      WHERE lessons.id <> ? AND sections.teacher_id = ? AND lessons.day_of_week = ?
        AND (? IS NULL OR occupied_courses.week_start IS NULL
          OR (occupied_courses.week_start <= ? AND ? <= occupied_courses.week_end))
    `).all(lessonId, input.teacherId, input.dayOfWeek, courseRule.week_start, courseRule.week_end, courseRule.week_start) as Array<{ start_hour: number; duration_hours: number; block: string | null }>;
    const existing = teacherDay.map((lesson) => ({ startHour: lesson.start_hour, durationHours: lesson.duration_hours, block: lesson.block }));
    const combined = [...existing, proposed];
    if (enabledRules.has("lunch_break") && !hasLunchHour(combined)) warnings.push("Teacher has no free lunch hour between 12:00 and 14:00");
    if (enabledRules.has("max_continuous") && longestContinuousHours(combined) > 4) warnings.push("Teacher has more than 4 continuous hours");
    if (enabledRules.has("teacher_daily_limit") && combined.reduce((total, lesson) => total + lesson.durationHours, 0) > 7) warnings.push("Teacher exceeds 7 teaching hours in one day");
    if (enabledRules.has("same_block") && hasBackToBackBlockChange(existing, proposed)) warnings.push("Teacher has back-to-back lessons in different blocks");
  }

  // Evaluate each associated student group separately because cross-level sections
  // can affect several year timetables through one placement.
  const proposedGroups = db.prepare("SELECT student_groups.id, student_groups.code FROM section_student_groups JOIN student_groups ON student_groups.id = section_student_groups.student_group_id WHERE section_id = ?").all(input.sectionId) as Array<{ id: string; code: string }>;
  for (const group of proposedGroups) {
    const groupDay = db.prepare(`
      SELECT DISTINCT lessons.id, lessons.start_hour, lessons.duration_hours, rooms.block
      FROM scheduled_lessons lessons
      JOIN course_sections sections ON sections.id = lessons.section_id
      JOIN courses occupied_courses ON occupied_courses.id = sections.course_id
      JOIN section_student_groups links ON links.section_id = lessons.section_id
      LEFT JOIN rooms ON rooms.id = lessons.room_id
      WHERE lessons.id <> ? AND links.student_group_id = ? AND lessons.day_of_week = ?
        AND (? IS NULL OR occupied_courses.week_start IS NULL
          OR (occupied_courses.week_start <= ? AND ? <= occupied_courses.week_end))
    `).all(lessonId, group.id, input.dayOfWeek, courseRule.week_start, courseRule.week_end, courseRule.week_start) as Array<{ id: string; start_hour: number; duration_hours: number; block: string | null }>;
    const existing = groupDay.map((lesson) => ({ startHour: lesson.start_hour, durationHours: lesson.duration_hours, block: lesson.block }));
    const combined = [...existing, proposed];
    if (enabledRules.has("lunch_break") && !hasLunchHour(combined)) warnings.push(`${group.code} has no free lunch hour between 12:00 and 14:00`);
    if (enabledRules.has("max_continuous") && longestContinuousHours(combined) > 4) warnings.push(`${group.code} has more than 4 continuous hours`);
    if (enabledRules.has("student_daily_limit") && combined.reduce((total, lesson) => total + lesson.durationHours, 0) > 6) warnings.push(`${group.code} exceeds 6 class hours in one day`);
    if (enabledRules.has("same_block") && hasBackToBackBlockChange(existing, proposed)) warnings.push(`${group.code} has back-to-back lessons in different blocks`);
  }
  return warnings;
}

function refreshAllScheduleWarnings(db: DatabaseInstance) {
  // Any changed lesson, assignment, room or rule can affect neighbouring cards.
  // Recalculate the small department timetable once after such a mutation so every
  // year and personal view reads one consistent warning snapshot.
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
      const warnings = calculatePlacementWarnings(db, { sectionId: lesson.section_id, lessonId: lesson.id, teacherId: lesson.teacher_id, roomId: lesson.room_id, dayOfWeek: lesson.day_of_week, startHour: lesson.start_hour, durationHours: lesson.duration_hours });
      saveWarnings.run(JSON.stringify(warnings), lesson.id);
      warningsByLesson.set(lesson.id, warnings);
    }
  });
  refresh();
  return warningsByLesson;
}

function describeIssue(message: string): Pick<ScheduleIssueRecord, "category" | "severity"> {
  // The summary labels help staff scan a long list without changing the underlying
  // rule behaviour: every issue remains a warning and never blocks saving.
  if (message.includes("not assigned")) return { category: "Assignment", severity: "Advisory" };
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
  // Reduce several rule messages to the colour of the most urgent one: red beats
  // yellow, yellow beats blue, and an empty message list has no issue colour.
  const severities = messages.map((message) => describeIssue(message).severity);
  if (severities.includes("High")) return "High";
  if (severities.includes("Warning")) return "Warning";
  if (severities.includes("Advisory")) return "Advisory";
  return null;
}

export function listScheduleIssues(): ScheduleIssueRecord[] {
  // Recalculate every lesson first, then expand its saved warning messages into the
  // sortable issue records used by both the global list and year inspector.
  const db = database();
  // Recalculate every saved lesson when the issue screen opens. This keeps the list
  // current after restrictions or neighbouring lessons change, even when the lesson
  // itself has not been opened in the editor again.
  const warningsByLesson = refreshAllScheduleWarnings(db);
  const rows = db.prepare(`
    SELECT lessons.id, lessons.section_id, lessons.day_of_week, lessons.start_hour,
      lessons.duration_hours, lessons.room_id, lessons.occurrence,
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
  `).all() as Array<{ id: string; section_id: string; day_of_week: number; start_hour: number; duration_hours: number; room_id: string | null; occurrence: number; teacher_id: string | null; sequence: number; code: string; primary_year: number; sessions_per_week: number; week_start: number | null; week_end: number | null; teacher_name: string | null; room_code: string | null; student_groups: string | null }>;

  const issues: ScheduleIssueRecord[] = [];
  for (const row of rows) {
    const warnings = warningsByLesson.get(row.id) ?? [];
    // Flatten one lesson with several warnings into independently filterable issue rows.
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

export function listCandidateSlots(sectionId: string, occurrence: number): { sectionLabel: string; occurrence: number; sessionsPerWeek: number; slots: CandidateSlotRecord[] } {
  // Candidate search is deliberately advisory: evaluate every valid room and hour,
  // returning only combinations that produce zero enabled-rule messages.
  const db = database();
  // Candidate search uses the section's saved teacher, student groups, duration and
  // course requirements. Incomplete sections therefore return no misleading options.
  const section = db.prepare(`
    SELECT sections.id, sections.sequence, sections.teacher_id, courses.code,
      courses.duration_hours, courses.sessions_per_week, courses.week_start, courses.week_end
    FROM course_sections sections
    JOIN courses ON courses.id = sections.course_id
    WHERE sections.id = ?
  `).get(sectionId) as { id: string; sequence: number; teacher_id: string | null; code: string; duration_hours: number | null; sessions_per_week: number; week_start: number | null; week_end: number | null } | undefined;
  if (!section) throw new Error("Course section not found.");
  if (!section.duration_hours) throw new Error("Configure the course duration before finding candidate slots.");
  if (!Number.isInteger(occurrence) || occurrence < 1 || occurrence > section.sessions_per_week) throw new Error("Choose a valid weekly session.");
  const alreadyScheduled = db.prepare("SELECT 1 FROM scheduled_lessons WHERE section_id = ? AND occurrence = ?").get(sectionId, occurrence);
  if (alreadyScheduled) throw new Error("Candidate slots are only available for an unscheduled weekly session.");

  // Try every active room at every valid whole-hour placement. The existing warning
  // engine is the single source of truth, and only placements with zero messages pass.
  const rooms = db.prepare("SELECT id, code, capacity, has_multi_projector, is_lab, is_smart_classroom FROM rooms WHERE is_active = 1 ORDER BY code").all() as Array<{ id: string; code: string; capacity: number; has_multi_projector: number; is_lab: number; is_smart_classroom: number }>;
  const slots: CandidateSlotRecord[] = [];
  const preferredStartRule = db.prepare("SELECT is_enabled FROM rule_settings WHERE rule_key = 'prefer_9am'").get() as { is_enabled: number } | undefined;
  for (let dayOfWeek = 1; dayOfWeek <= 5; dayOfWeek += 1) {
    // 08:00 becomes a valid candidate only when staff explicitly disable the
    // preferred 09:00-start policy; the warning engine remains the final filter.
    for (let startHour = preferredStartRule?.is_enabled === 0 ? 8 : 9; startHour + section.duration_hours <= 18; startHour += 1) {
      for (const room of rooms) {
        const warnings = calculatePlacementWarnings(db, { sectionId, teacherId: section.teacher_id, roomId: room.id, dayOfWeek, startHour, durationHours: section.duration_hours });
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

export function placeScheduledLesson(input: { sectionId: string; occurrence: number; dayOfWeek: number; startHour: number; roomId: string | null }): ScheduledLessonRecord {
  // Create the requested whole-hour lesson even when warnings exist, store those
  // warnings, and return the complete card data for immediate browser feedback.
  const db = database();
  const section = db.prepare(`SELECT sections.id, courses.code, sections.sequence, courses.duration_hours, courses.sessions_per_week, courses.week_start, courses.week_end, teachers.id AS teacher_id, teachers.name AS teacher_name FROM course_sections sections JOIN courses ON courses.id = sections.course_id LEFT JOIN teachers ON teachers.id = sections.teacher_id WHERE sections.id = ?`).get(input.sectionId) as { id: string; code: string; sequence: number; duration_hours: number | null; sessions_per_week: number; week_start: number | null; week_end: number | null; teacher_id: string | null; teacher_name: string | null } | undefined;
  if (!section || !section.duration_hours) throw new Error("Section must have a course duration before placement.");
  if (!Number.isInteger(input.occurrence) || input.occurrence < 1 || input.occurrence > section.sessions_per_week) throw new Error("Choose a valid weekly session before placement.");
  if (input.dayOfWeek < 1 || input.dayOfWeek > 5 || input.startHour < 8 || input.startHour + section.duration_hours > 18) throw new Error("Lessons must be placed Monday to Friday between 08:00 and 18:00.");
  const conflicts = calculatePlacementWarnings(db, { sectionId: input.sectionId, teacherId: section.teacher_id, roomId: input.roomId, dayOfWeek: input.dayOfWeek, startHour: input.startHour, durationHours: section.duration_hours });
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO scheduled_lessons (id, section_id, occurrence, day_of_week, start_hour, duration_hours, room_id, warnings_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, input.sectionId, input.occurrence, input.dayOfWeek, input.startHour, section.duration_hours, input.roomId, JSON.stringify(conflicts));
  const refreshedWarnings = refreshAllScheduleWarnings(db).get(id) ?? conflicts;
  const room = input.roomId ? db.prepare("SELECT code FROM rooms WHERE id = ?").get(input.roomId) as { code: string } | undefined : undefined;
  // Return the linked class codes with the saved card so the UI does not need a
  // second request before showing every resource assigned to the new lesson.
  const studentGroups = (db.prepare("SELECT groups.code FROM section_student_groups links JOIN student_groups groups ON groups.id = links.student_group_id WHERE links.section_id = ? ORDER BY groups.code").all(section.id) as Array<{ code: string }>).map((group) => group.code);
  return { id, sectionId: section.id, sectionLabel: `${section.code}_${String(section.sequence).padStart(2, "0")}${section.sessions_per_week > 1 ? ` · Session ${input.occurrence}` : ""}${weekRangeSuffix(section.week_start, section.week_end)}`, courseCode: section.code, teacherId: section.teacher_id, teacherName: section.teacher_name, dayOfWeek: input.dayOfWeek, startHour: input.startHour, durationHours: section.duration_hours, roomId: input.roomId, roomCode: room?.code ?? null, studentGroups, occurrence: input.occurrence, sessionsPerWeek: section.sessions_per_week, revision: 1, warnings: refreshedWarnings, warningSeverity: highestIssueSeverity(refreshedWarnings) };
}

export function updateScheduledLesson(id: string, input: { dayOfWeek: number; startHour: number; roomId: string | null; teacherId: string | null; revision: number }): ScheduledLessonRecord {
  // Revision checking prevents silent overwrites; teacher and placement changes are
  // saved together so recalculated conflicts always match the displayed card.
  const db = database();
  // The editor updates the section teacher and lesson placement together so the card
  // never briefly shows a teacher that differs from the conflict-check input.
  const lesson = db.prepare(`SELECT lessons.section_id, lessons.occurrence, lessons.revision, courses.code, sections.sequence, courses.duration_hours, courses.sessions_per_week, courses.week_start, courses.week_end FROM scheduled_lessons lessons JOIN course_sections sections ON sections.id = lessons.section_id JOIN courses ON courses.id = sections.course_id WHERE lessons.id = ?`).get(id) as { section_id: string; occurrence: number; revision: number; code: string; sequence: number; duration_hours: number; sessions_per_week: number; week_start: number | null; week_end: number | null } | undefined;
  if (!lesson) throw new Error("Scheduled lesson not found.");
  if (lesson.revision !== input.revision) throw new Error("This lesson was changed by another scheduler. Review the latest timetable and try again.");
  if (input.dayOfWeek < 1 || input.dayOfWeek > 5 || input.startHour < 8 || input.startHour + lesson.duration_hours > 18) throw new Error("Lessons must remain Monday to Friday between 08:00 and 18:00.");
  const teacher = input.teacherId ? db.prepare("SELECT id, name FROM teachers WHERE id = ? AND is_active = 1").get(input.teacherId) as { id: string; name: string } | undefined : undefined;
  if (input.teacherId && !teacher) throw new Error("Choose an active teacher.");
  const warnings = calculatePlacementWarnings(db, { sectionId: lesson.section_id, lessonId: id, teacherId: input.teacherId, roomId: input.roomId, dayOfWeek: input.dayOfWeek, startHour: input.startHour, durationHours: lesson.duration_hours });
  db.transaction(() => {
    db.prepare("UPDATE course_sections SET teacher_id = ? WHERE id = ?").run(input.teacherId, lesson.section_id);
    db.prepare("UPDATE scheduled_lessons SET day_of_week = ?, start_hour = ?, room_id = ?, warnings_json = ?, revision = revision + 1 WHERE id = ? AND revision = ?").run(input.dayOfWeek, input.startHour, input.roomId, JSON.stringify(warnings), id, input.revision);
  })();
  const refreshedWarnings = refreshAllScheduleWarnings(db).get(id) ?? warnings;
  const room = input.roomId ? db.prepare("SELECT code FROM rooms WHERE id = ?").get(input.roomId) as { code: string } | undefined : undefined;
  // Keep mutation responses identical to normal timetable reads. This lets the card
  // retain its student classes immediately after an edit without waiting for polling.
  const studentGroups = (db.prepare("SELECT groups.code FROM section_student_groups links JOIN student_groups groups ON groups.id = links.student_group_id WHERE links.section_id = ? ORDER BY groups.code").all(lesson.section_id) as Array<{ code: string }>).map((group) => group.code);
  return { id, sectionId: lesson.section_id, sectionLabel: `${lesson.code}_${String(lesson.sequence).padStart(2, "0")}${lesson.sessions_per_week > 1 ? ` · Session ${lesson.occurrence}` : ""}${weekRangeSuffix(lesson.week_start, lesson.week_end)}`, courseCode: lesson.code, teacherId: teacher?.id ?? null, teacherName: teacher?.name ?? null, dayOfWeek: input.dayOfWeek, startHour: input.startHour, durationHours: lesson.duration_hours, roomId: input.roomId, roomCode: room?.code ?? null, studentGroups, occurrence: lesson.occurrence, sessionsPerWeek: lesson.sessions_per_week, revision: input.revision + 1, warnings: refreshedWarnings, warningSeverity: highestIssueSeverity(refreshedWarnings) };
}

export function removeScheduledLesson(id: string, revision: number) {
  // Removing one lesson returns only that weekly session to the tray; the section's
  // other occurrence remains scheduled when a course meets twice per week.
  const db = database();
  const removed = db.prepare("DELETE FROM scheduled_lessons WHERE id = ? AND revision = ?").run(id, revision).changes > 0;
  if (removed) refreshAllScheduleWarnings(db);
  return removed;
}

export function importTeachingMembers(rows: TeachingMembersImportRow[], ignoredZeroRows: number): TeachingMembersImportSummary {
  // Convert the validated worksheet rows into one teacher list, course list and
  // allocation map before applying the full import transaction.
  const db = database();
  // Maps remove duplicates from the spreadsheet while preserving one record per
  // teacher, course, and course-teacher allocation pair.
  const teachers = new Map<string, { name: string; staffType: "FT" | "PT" }>();
  const courses = new Map<string, { code: string; catalog: string | null }>();
  const allocations = new Map<string, TeachingMembersImportRow>();

  for (const row of rows) {
    // Every valid workbook row contributes to the teacher master list, including a
    // teacher whose current allocation values are all zero.
    teachers.set(row.lecturer, { name: row.lecturer, staffType: row.staffType });
    // A confirmed zero means this teacher does not teach the module: do not create
    // the course-teacher allocation, the course, or an unscheduled section from it.
    if (row.groupCount === 0) continue;
    courses.set(row.mod, { code: row.mod, catalog: row.catalog });
    // The null separator cannot occur in normal course codes or names, so it makes
    // a safe composite key for repeated rows of the same allocation.
    const key = `${row.mod}\u0000${row.lecturer}`;
    const existing = allocations.get(key);
    allocations.set(key, existing ? { ...existing, groupCount: existing.groupCount + row.groupCount } : row);
  }

  const transaction = db.transaction(() => {
    // Keep the import all-or-nothing: staff never see a half-imported allocation.
    const findTeacher = db.prepare("SELECT id FROM teachers WHERE name = ?");
    const insertTeacher = db.prepare("INSERT INTO teachers (id, name, staff_type) VALUES (?, ?, ?)");
    const updateTeacher = db.prepare("UPDATE teachers SET staff_type = ?, is_active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?");
    const findCourse = db.prepare("SELECT id FROM courses WHERE code = ?");
    const insertCourse = db.prepare("INSERT INTO courses (id, code, catalog) VALUES (?, ?, ?)");
    const updateCourse = db.prepare("UPDATE courses SET catalog = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?");
    const courseIds = new Map<string, string>();
    const teacherIds = new Map<string, string>();

    for (const teacher of teachers.values()) {
      // Reuse matching manual teachers, otherwise create a new one from the file.
      const existing = findTeacher.get(teacher.name) as { id: string } | undefined;
      const id = existing?.id ?? crypto.randomUUID();
      if (existing) updateTeacher.run(teacher.staffType, id);
      else insertTeacher.run(id, teacher.name, teacher.staffType);
      teacherIds.set(teacher.name, id);
    }
    for (const course of courses.values()) {
      // Course setup fields are deliberately not replaced here; only the Excel catalog
      // is refreshed, so future duration and room settings survive a re-import.
      const existing = findCourse.get(course.code) as { id: string } | undefined;
      const id = existing?.id ?? crypto.randomUUID();
      if (existing) updateCourse.run(course.catalog, id);
      else insertCourse.run(id, course.code, course.catalog);
      courseIds.set(course.code, id);
    }

    // Rebuild only courses present in this workbook. This preserves a course that
    // staff added manually because it was omitted from Excel.
    const importedCourseIds = [...courseIds.values()];
    const findScheduledCourse = db.prepare(`SELECT 1 FROM scheduled_lessons lessons JOIN course_sections sections ON sections.id = lessons.section_id WHERE sections.course_id = ? LIMIT 1`);
    for (const courseId of importedCourseIds) {
      // Re-importing generated sections would cascade-delete their timetable work.
      // Require staff to use manual corrections after scheduling has begun instead.
      if (findScheduledCourse.get(courseId)) throw new Error("Teaching allocation cannot be re-imported after one of its courses has been scheduled. Use the manual course and section corrections, or start a new cycle first.");
    }
    const deleteCourseSections = db.prepare("DELETE FROM course_sections WHERE course_id = ?");
    const deleteCourseAllocations = db.prepare("DELETE FROM teaching_allocations WHERE course_id = ?");
    for (const courseId of importedCourseIds) {
      deleteCourseSections.run(courseId);
      deleteCourseAllocations.run(courseId);
    }
    const insertAllocation = db.prepare("INSERT INTO teaching_allocations (id, course_id, teacher_id, assigned_group_count) VALUES (?, ?, ?, ?)");
    const insertSection = db.prepare("INSERT INTO course_sections (id, course_id, sequence, teacher_id) VALUES (?, ?, ?, ?)");
    const sequenceByCourse = new Map<string, number>();
    for (const allocation of allocations.values()) {
      const courseId = courseIds.get(allocation.mod);
      const teacherId = teacherIds.get(allocation.lecturer);
      if (!courseId || !teacherId) continue;
      insertAllocation.run(crypto.randomUUID(), courseId, teacherId, allocation.groupCount);
      // Number sections continuously for each module: LEAD_01, LEAD_02, and so on.
      let sequence = sequenceByCourse.get(allocation.mod) ?? 0;
      for (let group = 0; group < allocation.groupCount; group += 1) {
        sequence += 1;
        insertSection.run(crypto.randomUUID(), courseId, sequence, teacherId);
      }
      sequenceByCourse.set(allocation.mod, sequence);
    }
  });
  transaction();

  // Return a compact audit summary for the upload confirmation message.
  return {
    courses: courses.size,
    teachers: teachers.size,
    allocations: allocations.size,
    sections: [...allocations.values()].reduce((total, allocation) => total + allocation.groupCount, 0),
    ignoredZeroRows,
  };
}
