import { cp, mkdir, stat } from "node:fs/promises";
import path from "node:path";

const projectRoot = process.cwd();
const standaloneRoot = path.join(projectRoot, ".next", "standalone");

async function exists(sourcePath) {
  // 使用 stat 检查目录，而不是假设 public 一定存在，因为 Next.js 项目可以完全不提供它。
  try {
    await stat(sourcePath);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function copyDirectory(sourcePath, destinationPath) {
  // Next.js 会把服务器依赖追踪到 standalone 目录，却刻意把浏览器静态资源留在外部；
  // 因此这里复制所需目录，使单一构建产物能够直接运行。
  if (!(await exists(sourcePath))) return;
  await mkdir(path.dirname(destinationPath), { recursive: true });
  await cp(sourcePath, destinationPath, { recursive: true, force: true });
}

// 编译后的浏览器代码块必须保留在 .next/static 路径下；
// 项目 public 目录中的文件则从 standalone 根目录直接提供。
await copyDirectory(path.join(projectRoot, ".next", "static"), path.join(standaloneRoot, ".next", "static"));
await copyDirectory(path.join(projectRoot, "public"), path.join(standaloneRoot, "public"));
