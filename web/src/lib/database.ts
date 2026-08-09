import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";

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

type DatabaseInstance = InstanceType<typeof Database>;

const globalForDatabase = globalThis as unknown as {
  timetableDatabase: DatabaseInstance | undefined;
};

function database() {
  if (globalForDatabase.timetableDatabase) return globalForDatabase.timetableDatabase;

  const dataDirectory = path.join(process.cwd(), "data");
  mkdirSync(dataDirectory, { recursive: true });
  const db = new Database(path.join(dataDirectory, "timetabling.db"));
  db.pragma("foreign_keys = ON");
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
  `);
  seed(db);
  globalForDatabase.timetableDatabase = db;
  return db;
}

function seed(db: DatabaseInstance) {
  const count = db.prepare("SELECT COUNT(*) AS count FROM teachers").get() as { count: number };
  if (count.count > 0) return;

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
  return isActive ? "Active" : "Inactive";
}

export function listTeachers(): TeacherRecord[] {
  const rows = database().prepare("SELECT id, name, staff_type, is_active FROM teachers ORDER BY staff_type DESC, name ASC").all() as Array<{ id: string; name: string; staff_type: "FT" | "PT"; is_active: number }>;
  return rows.map((row) => ({ id: row.id, name: row.name, staffType: row.staff_type, status: activeStatus(row.is_active), sections: 0 }));
}

export function createTeacher(name: string, staffType: "FT" | "PT"): TeacherRecord {
  const id = crypto.randomUUID();
  database().prepare("INSERT INTO teachers (id, name, staff_type) VALUES (?, ?, ?)").run(id, name, staffType);
  return { id, name, staffType, status: "Active", sections: 0 };
}

export function setTeacherStatus(id: string, isActive: boolean) {
  const result = database().prepare("UPDATE teachers SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(isActive ? 1 : 0, id);
  return result.changes > 0;
}

export function listStudentGroups(): StudentGroupRecord[] {
  const rows = database().prepare("SELECT id, code, year, program FROM student_groups ORDER BY year ASC, program ASC, code ASC").all() as StudentGroupRecord[];
  return rows;
}

export function createStudentGroup(code: string, year: number, program: string): StudentGroupRecord {
  const id = crypto.randomUUID();
  database().prepare("INSERT INTO student_groups (id, code, year, program) VALUES (?, ?, ?, ?)").run(id, code, year, program);
  return { id, code, year, program };
}

export function listRooms(): RoomRecord[] {
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
  const block = input.code.split("-")[0] || null;
  const hasMultiProjector = input.hasMultiProjector || input.isSmartClassroom;
  database().prepare("INSERT INTO rooms (id, code, block, capacity, has_multi_projector, is_lab, is_smart_classroom) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, input.code, block, input.capacity, hasMultiProjector ? 1 : 0, input.hasLab ? 1 : 0, input.isSmartClassroom ? 1 : 0);
  return { id, code: input.code, capacity: input.capacity, features: [input.hasLab ? "Lab" : "", hasMultiProjector ? "Multi projector" : "", input.isSmartClassroom ? "Smart classroom" : ""].filter(Boolean), status: "Active" };
}

export function setRoomStatus(id: string, isActive: boolean) {
  const result = database().prepare("UPDATE rooms SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(isActive ? 1 : 0, id);
  return result.changes > 0;
}
