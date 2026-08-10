import type { NextRequest } from "next/server";
import { sessionToken } from "@/lib/auth";
import { createVerifiedSystemBackup, validateSession } from "@/lib/database";

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
