import { cp, mkdir, stat } from "node:fs/promises";
import path from "node:path";

const projectRoot = process.cwd();
const standaloneRoot = path.join(projectRoot, ".next", "standalone");

async function exists(sourcePath) {
  // `stat` is used instead of assuming a public folder exists, because Next.js
  // projects are allowed to omit it entirely.
  try {
    await stat(sourcePath);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function copyDirectory(sourcePath, destinationPath) {
  // Next.js traces server dependencies into the standalone folder but deliberately
  // leaves browser assets outside. Copy both directories so one artifact is runnable.
  if (!(await exists(sourcePath))) return;
  await mkdir(path.dirname(destinationPath), { recursive: true });
  await cp(sourcePath, destinationPath, { recursive: true, force: true });
}

// Compiled browser chunks must remain under `.next/static`, while files from the
// project's public directory are served directly from the standalone root.
await copyDirectory(path.join(projectRoot, ".next", "static"), path.join(standaloneRoot, ".next", "static"));
await copyDirectory(path.join(projectRoot, "public"), path.join(standaloneRoot, "public"));
