import type { NextRequest } from "next/server";
import { sessionToken } from "@/lib/auth";
import { createVerifiedSystemBackup, restoreVerifiedSystemBackup, SystemBackupValidationError, validateSession } from "@/lib/database";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  // A full backup contains account password hashes and all department records, so
  // normal scheduler accounts must not be able to download it.
  const token = sessionToken(request);
  const user = token ? validateSession(token) : null;
  if (!user?.isAdmin) return Response.json({ error: "Only the administrator can download a full system backup." }, { status: 403 });

  try {
    // The database layer creates and verifies a consistent snapshot before any bytes
    // are sent. Content-Disposition supplies a dated filename to the browser.
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
    // Do not expose server file paths or SQLite details in the browser. The fixed
    // message tells the administrator that no trustworthy download was produced.
    console.error("System backup failed.", error);
    return Response.json({ error: "The database backup failed its safety checks. No backup was downloaded." }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  // Restoration replaces accounts and every timetable record, so it is restricted
  // to the one administrator just like full-backup download.
  const token = sessionToken(request);
  const user = token ? validateSession(token) : null;
  if (!user?.isAdmin) return Response.json({ error: "Only the administrator can restore a full system backup." }, { status: 403 });

  let formData: FormData;
  try {
    // Route Handlers expose multipart fields through the standard Web FormData API.
    // Malformed requests are rejected before any file or database operation begins.
    formData = await request.formData();
  } catch {
    return Response.json({ error: "Choose a valid SQLite backup file." }, { status: 400 });
  }

  // Two acknowledgements and an exact phrase provide the agreed repeated confirmation
  // for an operation that replaces current data and signs out every browser.
  if (formData.get("understandReplace") !== "on" || formData.get("understandSignOut") !== "on" || formData.get("confirmation") !== "RESTORE FULL BACKUP") {
    return Response.json({ error: "Complete both confirmations and type RESTORE FULL BACKUP exactly." }, { status: 400 });
  }

  // Keep uploads below the authenticated proxy's 25 MB request limit. The normal
  // department database is much smaller, while the cap prevents accidental huge files.
  const uploadedFile = formData.get("backupFile");
  const maximumBytes = 20 * 1024 * 1024;
  if (!(uploadedFile instanceof File) || !uploadedFile.name.toLowerCase().endsWith(".sqlite") || uploadedFile.size < 16 || uploadedFile.size > maximumBytes) {
    return Response.json({ error: "Choose a .sqlite backup file between 16 bytes and 20 MB." }, { status: 400 });
  }

  // A valid SQLite 3 file begins with this fixed 16-byte header. Deeper structural,
  // schema, relationship and administrator checks remain in the database layer.
  const contents = Buffer.from(await uploadedFile.arrayBuffer());
  if (contents.subarray(0, 16).toString("utf8") !== "SQLite format 3\u0000") {
    return Response.json({ error: "The selected file is not a SQLite database." }, { status: 400 });
  }

  try {
    const result = await restoreVerifiedSystemBackup(contents);
    return Response.json({ restored: true, ...result });
  } catch (error) {
    // Validation messages are safe and actionable; unexpected failures use a fixed
    // response because server paths and SQL details must not reach the browser.
    if (error instanceof SystemBackupValidationError) return Response.json({ error: error.message }, { status: 400 });
    console.error("System restore failed.", error);
    return Response.json({ error: "The system restore failed. Sign in again and verify the current data before retrying." }, { status: 500 });
  }
}
