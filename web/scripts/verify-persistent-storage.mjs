import { accessSync, constants, mkdirSync } from "node:fs";
import path from "node:path";

// Local production checks may intentionally use a temporary database path without
// Railway variables. The stricter requirement applies only inside Railway itself.
const isRailway = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_SERVICE_ID);
const configuredDatabasePath = process.env.TIMETABLING_DATABASE_PATH?.trim();
const railwayVolumePath = process.env.RAILWAY_VOLUME_MOUNT_PATH?.trim();

if (isRailway && !configuredDatabasePath && !railwayVolumePath) {
  throw new Error("Railway persistent volume is missing. Attach a volume before starting the timetable service.");
}

// Confirm the directory that will contain SQLite is writable before the web server
// reports healthy. This prevents a deployment from accepting users with ephemeral
// or read-only storage and only discovering the problem during their first edit.
const storageDirectory = configuredDatabasePath
  ? path.dirname(configuredDatabasePath)
  : railwayVolumePath;

if (storageDirectory) {
  mkdirSync(storageDirectory, { recursive: true });
  accessSync(storageDirectory, constants.W_OK);
  console.log("Persistent SQLite storage is writable.");
}
