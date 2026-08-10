import Database from "better-sqlite3";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

// 默认路径从 web 项目自身位置解析，而不是依赖调用命令时所在目录；
// 因此从仓库根目录或 web 目录运行时都会得到相同结果。
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const webDirectory = path.resolve(scriptDirectory, "..");
const defaultSourcePath = path.join(webDirectory, "data", "timetabling.db");
const defaultOutputPath = path.join(webDirectory, "data", "timetabling-acceptance.db");

function readOptions(argumentsList) {
  // 命令参数保持简单：源文件和输出文件都有默认值；若输出已存在，
  // 必须明确提供 --replace 安全开关才允许替换。
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
  // SQLite 文件结构完整性和外键关系完整性是两种不同保证；
  // 复制出的数据库必须同时通过两项检查，才可用于验收测试。
  const integrityRows = database.pragma("integrity_check");
  const integrityMessages = integrityRows.flatMap((row) => Object.values(row).map(String));
  if (integrityMessages.length !== 1 || integrityMessages[0].toLowerCase() !== "ok") throw new Error(`${label} failed SQLite integrity check.`);
  if (database.pragma("foreign_key_check").length > 0) throw new Error(`${label} failed foreign-key check.`);
}

function readSummary(database) {
  // 这些数量可用于确认复制的是同一套排课数据，同时不输出敏感源文件中的
  // 教师、账号、学生班级或教室名称。
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
  // 源路径必须已经是普通文件，而且源和输出不能解析到同一位置；
  // 原数据库被视为只读证据，准备脚本绝不能直接修改它。
  if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) throw new Error(`Source database does not exist: ${sourcePath}`);
  if (sourcePath === outputPath) throw new Error("Source and acceptance database paths must be different.");
  if (existsSync(outputPath) && !replace) throw new Error("Acceptance database already exists. Stop its server, review the path, then rerun with --replace to reset it.");

  // 出现 SQLite 辅助文件说明旧验收数据库可能仍有未完成或活跃写入；
  // 此时拒绝替换，避免陈旧 WAL 页面错误附着到新副本。
  const activeSidecars = ["-wal", "-shm", "-journal"].filter((suffix) => existsSync(`${outputPath}${suffix}`));
  if (activeSidecars.length > 0) throw new Error(`Acceptance database appears to be in use (${activeSidecars.join(", ")}). Stop the local server before replacing it.`);
}

const options = readOptions(process.argv.slice(2));
assertSafePaths(options.sourcePath, options.outputPath, options.replace);

// 临时副本建立在最终文件旁边，使最后一次重命名可在同一文件系统中原子完成。
// 随机文件名也让两个校验任务不会共享临时状态。
mkdirSync(path.dirname(options.outputPath), { recursive: true });
const temporaryPath = path.join(path.dirname(options.outputPath), `.acceptance-${randomUUID()}.db`);
let sourceDatabase;
let acceptanceDatabase;

try {
  // 只读和仅查询设置保证准备命令不能改动正式源数据库，
  // 即使以后有人在这里误加写入语句也会被 SQLite 拒绝。
  sourceDatabase = new Database(options.sourcePath, { readonly: true, fileMustExist: true });
  sourceDatabase.pragma("query_only = ON");
  sourceDatabase.pragma("foreign_keys = ON");
  assertHealthyDatabase(sourceDatabase, "Source database");
  const sourceSummary = readSummary(sourceDatabase);

  // SQLite 在线备份接口能生成同一时间点的一致副本，即使源应用刚刚使用过；
  // 普通文件复制则可能遗漏仍在 WAL 中的数据。
  await sourceDatabase.backup(temporaryPath);
  sourceDatabase.close();
  sourceDatabase = undefined;

  // 浏览器会话是临时登录凭证，不属于验收数据。先从副本删除会话并压缩文件，
  // 再校验最终真正要打开的数据库。
  acceptanceDatabase = new Database(temporaryPath);
  acceptanceDatabase.pragma("foreign_keys = ON");
  acceptanceDatabase.prepare("DELETE FROM auth_sessions").run();
  acceptanceDatabase.exec("VACUUM");
  assertHealthyDatabase(acceptanceDatabase, "Acceptance database");
  const acceptanceSummary = readSummary(acceptanceDatabase);
  acceptanceDatabase.close();
  acceptanceDatabase = undefined;

  // 业务记录数量必须与源数据库完全一致，而会话数必须为零；
  // 这能在不完整副本替换现有验收数据库之前将其拦截。
  for (const key of ["teachers", "courses", "sections", "lessons", "accounts"]) {
    if (acceptanceSummary[key] !== sourceSummary[key]) throw new Error(`Acceptance copy changed the ${key} count.`);
  }
  if (acceptanceSummary.sessions !== 0) throw new Error("Acceptance copy still contains browser sessions.");

  // 所有检查通过后才把临时文件重命名为正式验收副本，随后限制文件权限，
  // 让复制的账号和院系数据只能由当前操作系统用户读取。
  renameSync(temporaryPath, options.outputPath);
  chmodSync(options.outputPath, 0o600);

  console.log(`Acceptance database ready: ${options.outputPath}`);
  console.log(`Copied ${acceptanceSummary.teachers} teachers, ${acceptanceSummary.courses} courses, ${acceptanceSummary.sections} sections, ${acceptanceSummary.lessons} lessons and ${acceptanceSummary.accounts} accounts; active sessions: 0.`);
  console.log("Set TIMETABLING_DATABASE_PATH to this file before starting the local acceptance server.");
} finally {
  // 出错后关闭数据库句柄，并且只删除本次随机命名的未完成副本；
  // 清理逻辑绝不会删除此前已经验证过的验收数据库。
  acceptanceDatabase?.close();
  sourceDatabase?.close();
  rmSync(temporaryPath, { force: true });
}
