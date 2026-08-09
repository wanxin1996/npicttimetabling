import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../../generated/prisma/client";

// Keep Prisma's client reusable while its schema remains the planned production model.
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

// Use a local SQLite file during development; production will move this model to PostgreSQL.
const adapter = new PrismaBetterSqlite3({
  url: process.env.DATABASE_URL ?? "file:./prisma/dev.db",
});

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter,
  });

if (process.env.NODE_ENV !== "production") {
  // Next.js hot reload should reuse this client instead of opening another connection.
  globalForPrisma.prisma = prisma;
}
