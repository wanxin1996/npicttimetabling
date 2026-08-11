import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";

// 本地生产模式检查可以刻意使用临时数据库路径而不设置 Railway 变量；
// 更严格的持久化磁盘要求只在 Railway 环境内部执行。
const isRailway = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_SERVICE_ID);
const configuredDatabasePath = process.env.TIMETABLING_DATABASE_PATH?.trim();
const railwayVolumePath = process.env.RAILWAY_VOLUME_MOUNT_PATH?.trim();

if (isRailway && !railwayVolumePath) {
  throw new Error("Railway persistent volume is missing. Attach a volume before starting the timetable service.");
}

function isInsideDirectory(parentDirectory, candidatePath) {
  // path.relative 同时处理 `..` 与绝对路径边界；不能只用 startsWith，
  // 否则 `/data-copy` 会被误认为位于 `/data` 内。
  const relativePath = path.relative(parentDirectory, candidatePath);
  return relativePath === ""
    || (!path.isAbsolute(relativePath)
      && relativePath !== ".."
      && !relativePath.startsWith(`..${path.sep}`));
}

let storageDirectory;

if (isRailway) {
  // Railway 上不允许用 TIMETABLING_DATABASE_PATH 绕过 Volume：手工路径仍必须落在
  // 已挂载卷内。先 realpath Volume，避免把不存在的 `/data` 建在临时容器文件系统中。
  const volumeDirectory = path.resolve(railwayVolumePath);
  if (!existsSync(volumeDirectory) || !statSync(volumeDirectory).isDirectory()) {
    throw new Error("Railway persistent volume path is unavailable. Check the service volume mount.");
  }
  const realVolumeDirectory = realpathSync(volumeDirectory);
  accessSync(realVolumeDirectory, constants.W_OK);

  const databasePath = configuredDatabasePath
    ? path.resolve(configuredDatabasePath)
    : path.join(volumeDirectory, "timetabling.db");
  if (databasePath === volumeDirectory || !isInsideDirectory(volumeDirectory, databasePath)) {
    throw new Error("Railway SQLite database path must stay inside the attached persistent volume.");
  }

  storageDirectory = path.dirname(databasePath);
  // 在创建子目录之前先解析最近的既有祖先。若卷内某一层是指向卷外目录的链接，
  // 必须先拒绝，不能让 mkdirSync 即使最终报错也已在卷外留下目录。
  let existingAncestor = storageDirectory;
  while (!existsSync(existingAncestor)) {
    const parentDirectory = path.dirname(existingAncestor);
    if (parentDirectory === existingAncestor) break;
    existingAncestor = parentDirectory;
  }
  if (!isInsideDirectory(realVolumeDirectory, realpathSync(existingAncestor))) {
    throw new Error("Railway SQLite database directory resolves outside the attached persistent volume.");
  }
  mkdirSync(storageDirectory, { recursive: true });
  const realStorageDirectory = realpathSync(storageDirectory);
  if (!isInsideDirectory(realVolumeDirectory, realStorageDirectory)) {
    throw new Error("Railway SQLite database directory resolves outside the attached persistent volume.");
  }
  let databaseEntry;
  try {
    // lstat 能看见“目标尚不存在”的 dangling symlink；existsSync/realpath 看不见它，
    // SQLite 却会沿着链接在卷外创建新文件，因此必须在打开数据库前明确拒绝。
    databaseEntry = lstatSync(databasePath);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  if (databaseEntry?.isSymbolicLink()) {
    throw new Error("Railway SQLite database file must not be a symbolic link.");
  }
  if (databaseEntry && !databaseEntry.isFile()) {
    throw new Error("Railway SQLite database path must identify a regular file.");
  }
  if (databaseEntry && !isInsideDirectory(realVolumeDirectory, realpathSync(databasePath))) {
    throw new Error("Railway SQLite database file resolves outside the attached persistent volume.");
  }
} else if (configuredDatabasePath) {
  // 本地和隔离测试可以明确指定任意数据库文件；这里仍把相对路径规范化，
  // 保证可写性检查针对真正将被打开的目录。
  storageDirectory = path.dirname(path.resolve(configuredDatabasePath));
}

if (storageDirectory) {
  mkdirSync(storageDirectory, { recursive: true });
  accessSync(storageDirectory, constants.W_OK);
  console.log("Persistent SQLite storage is writable.");
}
