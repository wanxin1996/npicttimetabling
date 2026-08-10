import { NextResponse } from "next/server";
import { createManualCourse, listCourses } from "@/lib/database";

export const runtime = "nodejs";

export function GET() {
  // Courses 页面在初次加载或导入数据后，通过这个只读接口取得课程清单。
  return NextResponse.json(listCourses());
}

export async function POST(request: Request) {
  // 教学分配工作簿遗漏课程时可手动补录；系统会建立未分配班次，但不会虚构教师分配数量。
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
