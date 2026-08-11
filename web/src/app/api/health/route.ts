import { databaseHealth, isDatabaseBusyFailure } from "@/lib/database";

export const runtime = "nodejs";

export function GET() {
  // 托管平台健康检查只收到简单状态；真实数据库查询留在服务器端，
  // 不暴露院系数据数量或文件路径。
  try {
    // 公开响应刻意保持简短。HTTP 200 表示 Next.js 进程和已配置 SQLite 磁盘都成功执行了真实查询。
    if (databaseHealth()) return Response.json({ status: "ok" });
    return Response.json({ status: "error" }, { status: 503 });
  } catch (error) {
    // 健康探针刻意只有 ok/error 两种稳定正文，避免部署平台把一般数据库故障误判成应用路由契约变化。
    // 锁竞争仍给出短暂重试提示；详细错误仅写服务器日志，不返回文件路径、SQL 或堆栈。
    console.error("Database health check failed", error);
    return Response.json(
      { status: "error" },
      {
        status: 503,
        headers: isDatabaseBusyFailure(error) ? { "Retry-After": "1" } : undefined,
      },
    );
  }
}
