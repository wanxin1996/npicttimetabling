import Database from "better-sqlite3";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Resolve defaults from the web project instead of the caller's current folder,
// so the same command behaves predictably from either the repository or web folder.
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const webDirectory = path.resolve(scriptDirectory, "..");
const defaultSourcePath = path.join(webDirectory, "data", "timetabling.db");
const defaultOutputPath = path.join(webDirectory, "data", "timetabling-acceptance.db");

function readOptions(argumentsList) {
  // Keep the command deliberately small: source and output are optional, while an
  // existing output requires the explicit --replace safety switch.
  const options = { sourcePath: defaultSourcePath, outputPath: defaultOutputPath, replace: false };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--replace") {
      options.replace = true;
      continue;
    }
    if (argument === "--source" || argument === "--output") {
      const value = argumentsList[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a file path.`);
      if (argument === "--source") options.sourcePath = path.resolve(value);
      if (argument === "--output") options.outputPath = path.resolve(value);
      index += 1;
      continue;
    }
    if (argument === "--help") {
      console.log("Usage: node scripts/prepare-local-acceptance.mjs [--source FILE] [--output FILE] [--replace]");
      process.exit(0);
    }
    throw new Error(`Unknown option: ${argument}`);
  }
  return { ...options, sourcePath: path.resolve(options.sourcePath), outputPath: path.resolve(options.outputPath) };
}

function assertHealthyDatabase(database, label) {
  // SQLite file integrity and relationship integrity are separate guarantees, so
  // both must pass before a copied database is considered safe for acceptance work.
  const integrityRows = database.pragma("integrity_check");
  const integrityMessages = integrityRows.flatMap((row) => Object.values(row).map(String));
  if (integrityMessages.length !== 1 || integrityMessages[0].toLowerCase() !== "ok") throw new Error(`${label} failed SQLite integrity check.`);
  if (database.pragma("foreign_key_check").length > 0) throw new Error(`${label} failed foreign-key check.`);
}

function readSummary(database) {
  // These counts identify the copied scheduling dataset without printing teacher,
  // account, class or room names from the department's sensitive source file.
  const count = (table) => database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
  return {
    teachers: count("teachers"),
    courses: count("courses"),
    sections: count("course_sections"),
    lessons: count("scheduled_lessons"),
    accounts: count("app_users"),
    sessions: count("auth_sessions"),
  };
}

function assertSafePaths(sourcePath, outputPath, replace) {
  // The source must already be a normal file, and source/output may never resolve
  // to the same location because the source is treated as read-only evidence.
  if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) throw new Error(`Source database does not exist: ${sourcePath}`);
  if (sourcePath === outputPath) throw new Error("Source and acceptance database paths must be different.");
  if (existsSync(outputPath) && !replace) throw new Error("Acceptance database already exists. Stop its server, review the path, then rerun with --replace to reset it.");

  // Sidecar files mean the old acceptance database may still have unfinished or
  // active writes. Refusing replacement avoids attaching stale WAL pages to a copy.
  const activeSidecars = ["-wal", "-shm", "-journal"].filter((suffix) => existsSync(`${outputPath}${suffix}`));
  if (activeSidecars.length > 0) throw new Error(`Acceptance database appears to be in use (${activeSidecars.join(", ")}). Stop the local server before replacing it.`);
}

const options = readOptions(process.argv.slice(2));
assertSafePaths(options.sourcePath, options.outputPath, options.replace);

// Build beside the final file so the last rename is atomic on the same filesystem.
// A random filename also allows two validation attempts without sharing temp state.
mkdirSync(path.dirname(options.outputPath), { recursive: true });
const temporaryPath = path.join(path.dirname(options.outputPath), `.acceptance-${randomUUID()}.db`);
let sourceDatabase;
let acceptanceDatabase;

try {
  // Read-only and query-only settings ensure this preparation command cannot alter
  // the formal source even if a later statement is accidentally added here.
  sourceDatabase = new Database(options.sourcePath, { readonly: true, fileMustExist: true });
  sourceDatabase.pragma("query_only = ON");
  sourceDatabase.pragma("foreign_keys = ON");
  assertHealthyDatabase(sourceDatabase, "Source database");
  const sourceSummary = readSummary(sourceDatabase);

  // SQLite's online backup API produces a consistent point-in-time copy even when
  // the source application was recently used; plain file copying could miss WAL data.
  await sourceDatabase.backup(temporaryPath);
  sourceDatabase.close();
  sourceDatabase = undefined;

  // Browser sessions are temporary credentials, not acceptance data. Remove them
  // from the copy, compact the file, then validate the exact database to be opened.
  acceptanceDatabase = new Database(temporaryPath);
  acceptanceDatabase.pragma("foreign_keys = ON");
  acceptanceDatabase.prepare("DELETE FROM auth_sessions").run();
  acceptanceDatabase.exec("VACUUM");
  assertHealthyDatabase(acceptanceDatabase, "Acceptance database");
  const acceptanceSummary = readSummary(acceptanceDatabase);
  acceptanceDatabase.close();
  acceptanceDatabase = undefined;

  // Business counts must remain identical while sessions must be zero. This catches
  // an incomplete copy before it can replace a known acceptance working database.
  for (const key of ["teachers", "courses", "sections", "lessons", "accounts"]) {
    if (acceptanceSummary[key] !== sourceSummary[key]) throw new Error(`Acceptance copy changed the ${key} count.`);
  }
  if (acceptanceSummary.sessions !== 0) throw new Error("Acceptance copy still contains browser sessions.");

  // Rename only after every check passes, then restrict the copied accounts and
  // department data to the current operating-system user.
  renameSync(temporaryPath, options.outputPath);
  chmodSync(options.outputPath, 0o600);

  console.log(`Acceptance database ready: ${options.outputPath}`);
  console.log(`Copied ${acceptanceSummary.teachers} teachers, ${acceptanceSummary.courses} courses, ${acceptanceSummary.sections} sections, ${acceptanceSummary.lessons} lessons and ${acceptanceSummary.accounts} accounts; active sessions: 0.`);
  console.log("Set TIMETABLING_DATABASE_PATH to this file before starting the local acceptance server.");
} finally {
  // Close handles and remove only the uniquely named unfinished copy after errors;
  // a previously valid acceptance database is never deleted by cleanup.
  acceptanceDatabase?.close();
  sourceDatabase?.close();
  rmSync(temporaryPath, { force: true });
}
