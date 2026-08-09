import { NextResponse } from "next/server";
import { listCourses } from "@/lib/database";

export const runtime = "nodejs";

export function GET() {
  return NextResponse.json(listCourses());
}
