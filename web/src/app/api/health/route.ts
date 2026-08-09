import { databaseHealth } from "@/lib/database";

export const runtime = "nodejs";

export function GET() {
  try {
    // Keep the public response deliberately small. A 200 means both the Next.js
    // process and configured SQLite volume accepted a real query.
    if (databaseHealth()) return Response.json({ status: "ok" });
    return Response.json({ status: "error" }, { status: 503 });
  } catch {
    // Do not return exception text because it can contain an internal file path or
    // another infrastructure detail that should remain private.
    return Response.json({ status: "error" }, { status: 503 });
  }
}
