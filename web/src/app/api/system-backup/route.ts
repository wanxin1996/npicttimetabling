import type { NextRequest } from "next/server";
import { sessionToken } from "@/lib/auth";
import { createVerifiedSystemBackup, restoreVerifiedSystemBackup, SystemBackupValidationError, validateSession } from "@/lib/database";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  // 完整备份包含账号密码哈希和全部院系资料，因此普通排课账号不能下载。
  const token = sessionToken(request);
  const user = token ? validateSession(token) : null;
  if (!user?.isAdmin) return Response.json({ error: "Only the administrator can download a full system backup." }, { status: 403 });

  try {
    // 数据库层在发送任何字节前先生成并验证一致快照；
    // Content-Disposition 响应头为浏览器提供带日期的下载文件名。
    const backup = await createVerifiedSystemBackup();
    return new Response(new Uint8Array(backup.contents), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${backup.filename}"`,
        "Content-Length": String(backup.contents.byteLength),
        "Content-Type": "application/vnd.sqlite3",
      },
    });
  } catch (error) {
    // 不向浏览器暴露服务器文件路径或 SQLite 细节；固定消息只告知管理员未生成可信下载。
    console.error("System backup failed.", error);
    return Response.json({ error: "The database backup failed its safety checks. No backup was downloaded." }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  // 恢复会替换账号及全部时间表记录，因此和完整备份下载一样，只允许管理员执行。
  const token = sessionToken(request);
  const user = token ? validateSession(token) : null;
  if (!user?.isAdmin) return Response.json({ error: "Only the administrator can restore a full system backup." }, { status: 403 });

  let formData: FormData;
  try {
    // Route Handler 通过标准 Web FormData API 读取 multipart 字段；
    // 格式错误的请求会在任何文件或数据库操作开始前被拒绝。
    formData = await request.formData();
  } catch {
    return Response.json({ error: "Choose a valid SQLite backup file." }, { status: 400 });
  }

  // 两项勾选确认加准确短语，为“替换当前资料并退出所有浏览器”的高风险操作
  // 提供约定的重复确认保护。
  if (formData.get("understandReplace") !== "on" || formData.get("understandSignOut") !== "on" || formData.get("confirmation") !== "RESTORE FULL BACKUP") {
    return Response.json({ error: "Complete both confirmations and type RESTORE FULL BACKUP exactly." }, { status: 400 });
  }

  // 上传大小保持在认证代理 25 MB 请求上限以内。正常院系数据库远小于此值，
  // 上限可防止误选巨大文件。
  const uploadedFile = formData.get("backupFile");
  const maximumBytes = 20 * 1024 * 1024;
  if (!(uploadedFile instanceof File) || !uploadedFile.name.toLowerCase().endsWith(".sqlite") || uploadedFile.size < 16 || uploadedFile.size > maximumBytes) {
    return Response.json({ error: "Choose a .sqlite backup file between 16 bytes and 20 MB." }, { status: 400 });
  }

  // 有效 SQLite 3 文件以固定的 16 字节文件头开始；更深入的结构、表结构、
  // 外键关系和管理员检查仍由数据库层完成。
  const contents = Buffer.from(await uploadedFile.arrayBuffer());
  if (contents.subarray(0, 16).toString("utf8") !== "SQLite format 3\u0000") {
    return Response.json({ error: "The selected file is not a SQLite database." }, { status: 400 });
  }

  try {
    const result = await restoreVerifiedSystemBackup(contents);
    return Response.json({ restored: true, ...result });
  } catch (error) {
    // 已知验证消息可以安全展示且能指导修正；意外故障则返回固定响应，
    // 防止服务器路径和 SQL 细节进入浏览器。
    if (error instanceof SystemBackupValidationError) return Response.json({ error: error.message }, { status: 400 });
    console.error("System restore failed.", error);
    return Response.json({ error: "The system restore failed. Sign in again and verify the current data before retrying." }, { status: 500 });
  }
}
