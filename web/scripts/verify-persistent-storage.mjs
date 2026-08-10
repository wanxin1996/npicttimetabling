import { accessSync, constants, mkdirSync } from "node:fs";
import path from "node:path";

// 本地生产模式检查可以刻意使用临时数据库路径而不设置 Railway 变量；
// 更严格的持久化磁盘要求只在 Railway 环境内部执行。
const isRailway = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_SERVICE_ID);
const configuredDatabasePath = process.env.TIMETABLING_DATABASE_PATH?.trim();
const railwayVolumePath = process.env.RAILWAY_VOLUME_MOUNT_PATH?.trim();

if (isRailway && !configuredDatabasePath && !railwayVolumePath) {
  throw new Error("Railway persistent volume is missing. Attach a volume before starting the timetable service.");
}

// 在服务器报告健康之前，先确认将存放 SQLite 的目录可写。
// 这样可防止部署使用临时或只读存储，却直到用户第一次编辑时才发现数据无法保存。
const storageDirectory = configuredDatabasePath
  ? path.dirname(configuredDatabasePath)
  : railwayVolumePath;

if (storageDirectory) {
  mkdirSync(storageDirectory, { recursive: true });
  accessSync(storageDirectory, constants.W_OK);
  console.log("Persistent SQLite storage is writable.");
}
