import { listUnscheduledSections } from "@/lib/database";

// 待排区需要读取本地 SQLite，因此在 Node 服务器端运行。
export const runtime = "nodejs";

export async function GET(request: Request) {
  // 每个年级拥有独立待排区，因为排课老师主要在各自负责的年级总表中工作。
  const year = Number(new URL(request.url).searchParams.get("year") ?? 1);
  if (![1, 2, 3].includes(year)) return Response.json({ error: "Year must be 1, 2 or 3." }, { status: 400 });
  return Response.json(listUnscheduledSections(year));
}
