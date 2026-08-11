import { NextResponse } from "next/server";
import { createManualCourse, listCourses, ManualCourseInputError, ManualCourseUniqueConflictError } from "@/lib/database";
import { safeDatabaseFailureResponse } from "@/lib/database-response";
import { parseManualCourseInput } from "@/lib/master-data-input";
import { readJsonObject } from "@/lib/request-json";

export const runtime = "nodejs";

export function GET() {
  // Courses 页面在初次加载或导入数据后，通过这个只读接口取得课程清单。
  try {
    return NextResponse.json(listCourses());
  } catch (error) {
    // 读取也会触发首次数据库初始化，因此必须和写接口一样返回受控 JSON。
    return safeDatabaseFailureResponse(error, "Course list failed", "The courses could not be loaded. Try again.");
  }
}

export async function POST(request: Request) {
  // 教学分配工作簿遗漏课程时可手动补录；系统会建立未分配班次，但不会虚构教师分配数量。
  const parsed = await readJsonObject(request, "Use a course code, optional catalog and a section count from 1 to 999.");
  if (!parsed.ok) return parsed.response;
  const input = parseManualCourseInput(parsed.value);
  if (!input.ok) return NextResponse.json({ error: input.error }, { status: 400 });

  try {
    return NextResponse.json(createManualCourse(input.value), { status: 201 });
  } catch (error) {
    if (error instanceof ManualCourseInputError) return NextResponse.json({ error: error.message }, { status: 400 });
    if (error instanceof ManualCourseUniqueConflictError) return NextResponse.json({ error: error.message }, { status: 409 });
    return safeDatabaseFailureResponse(error, "Manual course creation failed", "The course could not be created. Try again.");
  }
}
