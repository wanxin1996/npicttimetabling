import { isDatabaseBusyFailure } from "./database";

export function safeDatabaseFailureResponse(error: unknown, logContext: string, fallbackMessage: string) {
  // 多个认证端点既可能在数据库初始化时失败，也可能在另一进程短暂提交时 BUSY。
  // 统一转换可保证浏览器始终收到 JSON；底层 SQL、文件路径和错误堆栈只留在服务器日志。
  if (isDatabaseBusyFailure(error)) {
    return Response.json(
      { error: "Another scheduler is updating timetable data. Try again in a moment." },
      { status: 503, headers: { "Retry-After": "1" } },
    );
  }
  console.error(logContext, error);
  return Response.json({ error: fallbackMessage }, { status: 500 });
}
