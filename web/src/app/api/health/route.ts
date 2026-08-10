import { databaseHealth } from "@/lib/database";

export const runtime = "nodejs";

export function GET() {
  // 托管平台健康检查只收到简单状态；真实数据库查询留在服务器端，
  // 不暴露院系数据数量或文件路径。
  try {
    // 公开响应刻意保持简短。HTTP 200 表示 Next.js 进程和已配置 SQLite 磁盘都成功执行了真实查询。
    if (databaseHealth()) return Response.json({ status: "ok" });
    return Response.json({ status: "error" }, { status: 503 });
  } catch {
    // 不返回异常原文，因为其中可能包含内部文件路径或其他应保密的基础设施信息。
    return Response.json({ status: "error" }, { status: 503 });
  }
}
