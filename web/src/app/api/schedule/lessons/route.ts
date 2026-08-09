import { listScheduledLessons, placeScheduledLesson } from "@/lib/database";

// Timetable placement is server-side because conflict checks must see every saved lesson.
export const runtime = "nodejs";

export async function GET(request: Request) {
  const year = Number(new URL(request.url).searchParams.get("year") ?? 1);
  if (![1, 2, 3].includes(year)) return Response.json({ error: "Year must be 1, 2 or 3." }, { status: 400 });
  return Response.json(listScheduledLessons(year));
}

export async function POST(request: Request) {
  // Warnings are returned with a successful save: the product requirement allows
  // staff to keep a difficult placement while making the issue visible immediately.
  const body = await request.json();
  if (typeof body.sectionId !== "string" || !Number.isInteger(body.occurrence) || !Number.isInteger(body.dayOfWeek) || !Number.isInteger(body.startHour) || !(body.roomId === null || typeof body.roomId === "string")) return Response.json({ error: "Section, weekly session, day, start hour and room are invalid." }, { status: 400 });
  try { return Response.json(placeScheduledLesson(body), { status: 201 }); } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Lesson could not be placed." }, { status: 400 }); }
}
