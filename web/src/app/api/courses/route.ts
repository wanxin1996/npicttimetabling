import { NextResponse } from "next/server";
import { createManualCourse, listCourses } from "@/lib/database";

export const runtime = "nodejs";

export function GET() {
  // The Courses view uses this read-only endpoint after loading or importing data.
  return NextResponse.json(listCourses());
}

export async function POST(request: Request) {
  // Manual creation is the correction path when the allocation workbook omits a
  // course; it creates unassigned sections without fabricating allocation totals.
  const body = await request.json();
  const code = String(body.code ?? "").trim().toUpperCase();
  const catalog = String(body.catalog ?? "").trim() || null;
  const sectionCount = Number(body.sectionCount);
  if (!/^[A-Z0-9][A-Z0-9_-]*$/.test(code) || !Number.isInteger(sectionCount) || sectionCount < 1 || sectionCount > 999) {
    return NextResponse.json({ error: "Use a course code and a section count from 1 to 999." }, { status: 400 });
  }

  try {
    return NextResponse.json(createManualCourse({ code, catalog, sectionCount }), { status: 201 });
  } catch {
    return NextResponse.json({ error: "A course with this code already exists." }, { status: 409 });
  }
}
