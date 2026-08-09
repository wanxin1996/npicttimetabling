import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";

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
  allocatedSections: number;
  configuredSections: number;
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

type DatabaseInstance = InstanceType<typeof Database>;

// Next.js reloads modules in development. Keeping one connection globally prevents
// a new SQLite connection from being opened each time a route is refreshed.
const globalForDatabase = globalThis as unknown as {
  timetableDatabase: DatabaseInstance | undefined;
};

function database() {
  // Even an existing connection must run the table setup: this safely adds tables
  // after the application has been upgraded with a new feature.
  if (globalForDatabase.timetableDatabase) {
    initializeTables(globalForDatabase.timetableDatabase);
    return globalForDatabase.timetableDatabase;
  }

  // Store development data inside the project, rather than in a temporary folder.
  const dataDirectory = path.join(process.cwd(), "data");
  mkdirSync(dataDirectory, { recursive: true });
  const db = new Database(path.join(dataDirectory, "timetabling.db"));
  db.pragma("foreign_keys = ON");
  initializeTables(db);
  seed(db);
  globalForDatabase.timetableDatabase = db;
  return db;
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
  `);

  // SQLite cannot add a new column through CREATE TABLE after the table already
  // exists. Check old local databases and upgrade this small prototype schema safely.
  const courseColumns = db.prepare("PRAGMA table_info(courses)").all() as Array<{ name: string }>;
  if (!courseColumns.some((column) => column.name === "primary_year")) {
    db.exec("ALTER TABLE courses ADD COLUMN primary_year INTEGER CHECK (primary_year IN (1, 2, 3))");
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
  const id = crypto.randomUUID();
  database().prepare("INSERT INTO student_groups (id, code, year, program) VALUES (?, ?, ?, ?)").run(id, code, year, program);
  return { id, code, year, program };
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
  const id = crypto.randomUUID();
  // Room codes follow Block-Level-Room, so the first segment supports travel warnings later.
  const block = input.code.split("-")[0] || null;
  // A Smart Classroom is always also a Multi Projector room in this department.
  const hasMultiProjector = input.hasMultiProjector || input.isSmartClassroom;
  database().prepare("INSERT INTO rooms (id, code, block, capacity, has_multi_projector, is_lab, is_smart_classroom) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, input.code, block, input.capacity, hasMultiProjector ? 1 : 0, input.hasLab ? 1 : 0, input.isSmartClassroom ? 1 : 0);
  return { id, code: input.code, capacity: input.capacity, features: [input.hasLab ? "Lab" : "", hasMultiProjector ? "Multi projector" : "", input.isSmartClassroom ? "Smart classroom" : ""].filter(Boolean), status: "Active" };
}

export function setRoomStatus(id: string, isActive: boolean) {
  const result = database().prepare("UPDATE rooms SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(isActive ? 1 : 0, id);
  return result.changes > 0;
}

export function listCourses(): CourseRecord[] {
  // Use separate subqueries so the section count and allocation total do not multiply
  // each other when a course has several teachers and several generated sections.
  const rows = database().prepare(`
    SELECT courses.id, courses.code, courses.catalog, courses.duration_hours, courses.sessions_per_week,
      courses.primary_year, courses.minimum_room_capacity, courses.requires_lab,
      courses.requires_multi_projector, courses.requires_smart_classroom,
      (SELECT COUNT(*) FROM course_sections WHERE course_sections.course_id = courses.id) AS configured_sections,
      (SELECT COALESCE(SUM(assigned_group_count), 0) FROM teaching_allocations WHERE teaching_allocations.course_id = courses.id) AS allocated_sections
    FROM courses
    ORDER BY courses.code ASC
  `).all() as Array<{ id: string; code: string; catalog: string | null; duration_hours: number | null; sessions_per_week: number; primary_year: number | null; minimum_room_capacity: number | null; requires_lab: number; requires_multi_projector: number; requires_smart_classroom: number; configured_sections: number; allocated_sections: number }>;
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
    allocatedSections: row.allocated_sections,
    configuredSections: row.configured_sections,
  }));
}

export function updateCourseSetup(id: string, input: Omit<CourseRecord, "id" | "code" | "catalog" | "allocatedSections" | "configuredSections">) {
  // Course requirements apply to every generated section, so they are saved once
  // on the course rather than duplicated 18 times for a course such as LEAD.
  const result = database().prepare(`
    UPDATE courses SET duration_hours = ?, sessions_per_week = ?, primary_year = ?,
      minimum_room_capacity = ?, requires_lab = ?, requires_multi_projector = ?,
      requires_smart_classroom = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(input.durationHours, input.sessionsPerWeek, input.primaryYear, input.minimumRoomCapacity, input.requiresLab ? 1 : 0, input.requiresMultiProjector ? 1 : 0, input.requiresSmartClassroom ? 1 : 0, id);
  return result.changes > 0;
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

export function updateCourseSection(id: string, teacherId: string | null, studentGroupIds: string[]) {
  const db = database();
  // Replacing the join records in one transaction makes an edited cross-level class
  // immediately consistent for future conflict checks.
  const transaction = db.transaction(() => {
    const section = db.prepare("SELECT id FROM course_sections WHERE id = ?").get(id) as { id: string } | undefined;
    if (!section) return false;
    if (teacherId) {
      const teacher = db.prepare("SELECT id FROM teachers WHERE id = ? AND is_active = 1").get(teacherId);
      if (!teacher) throw new Error("Teacher not found");
    }
    db.prepare("UPDATE course_sections SET teacher_id = ? WHERE id = ?").run(teacherId, id);
    db.prepare("DELETE FROM section_student_groups WHERE section_id = ?").run(id);
    const addGroup = db.prepare("INSERT INTO section_student_groups (section_id, student_group_id) VALUES (?, ?)");
    for (const groupId of [...new Set(studentGroupIds)]) addGroup.run(id, groupId);
    return true;
  });
  return transaction();
}

export function importTeachingMembers(rows: TeachingMembersImportRow[], ignoredZeroRows: number): TeachingMembersImportSummary {
  const db = database();
  // Maps remove duplicates from the spreadsheet while preserving one record per
  // teacher, course, and course-teacher allocation pair.
  const teachers = new Map<string, { name: string; staffType: "FT" | "PT" }>();
  const courses = new Map<string, { code: string; catalog: string | null }>();
  const allocations = new Map<string, TeachingMembersImportRow>();

  for (const row of rows) {
    teachers.set(row.lecturer, { name: row.lecturer, staffType: row.staffType });
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

    // The source file is the current teaching allocation, so rebuild its generated
    // sections and allocations together. Course configuration remains untouched.
    db.prepare("DELETE FROM course_sections").run();
    db.prepare("DELETE FROM teaching_allocations").run();
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
