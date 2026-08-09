import { NextResponse } from "next/server";
import { listCourses } from "@/lib/database";

export const runtime = "nodejs";

export function GET() {
  // The Courses view uses this read-only endpoint after loading or importing data.
  return NextResponse.json(listCourses());
}
