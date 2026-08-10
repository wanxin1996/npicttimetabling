import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../../generated/prisma/client";

// 复用 Prisma 客户端连接；当前 Prisma schema 继续作为未来生产数据库模型的规划版本。
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

// 开发阶段使用本地 SQLite 文件；未来生产部署可把同一模型迁移到 PostgreSQL。
const adapter = new PrismaBetterSqlite3({
  url: process.env.DATABASE_URL ?? "file:./prisma/dev.db",
});

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter,
  });

if (process.env.NODE_ENV !== "production") {
  // Next.js 热重载时复用这个客户端，避免每次代码刷新都再打开一个数据库连接。
  globalForPrisma.prisma = prisma;
}
