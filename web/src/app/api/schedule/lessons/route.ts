import { listScheduledLessons, placeScheduledLesson } from "@/lib/database";

// 排课操作在服务器端执行，因为冲突检查必须看到数据库中所有已保存课程。
export const runtime = "nodejs";

export async function GET(request: Request) {
  // 年级总表读取只返回所选主要年级，但冲突计算仍会考虑其他所有年级的课程。
  const year = Number(new URL(request.url).searchParams.get("year") ?? 1);
  if (![1, 2, 3].includes(year)) return Response.json({ error: "Year must be 1, 2 or 3." }, { status: 400 });
  return Response.json(listScheduledLessons(year));
}

export async function POST(request: Request) {
  // 保存成功时同时返回警告；产品要求允许老师保留困难排法，
  // 但必须立即清楚显示其中的问题。
  const body = await request.json();
  if (typeof body.sectionId !== "string" || !Number.isInteger(body.occurrence) || !Number.isInteger(body.dayOfWeek) || !Number.isInteger(body.startHour) || !(body.roomId === null || typeof body.roomId === "string")) return Response.json({ error: "Section, weekly session, day, start hour and room are invalid." }, { status: 400 });
  try { return Response.json(placeScheduledLesson(body), { status: 201 }); } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Lesson could not be placed." }, { status: 400 }); }
}
