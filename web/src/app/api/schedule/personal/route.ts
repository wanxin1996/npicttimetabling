import { listPersonalTimetableWorkspace } from "@/lib/database";
import { safeDatabaseFailureResponse } from "@/lib/database-response";

// 个人视图是三个年级总表共用排课记录的只读投影，不会产生可能彼此不一致的时间表副本。
export const runtime = "nodejs";

export async function GET(request: Request) {
  // 先读取所选对象类型和 ID，再从三个主要年级的共享时间表中投影其个人日程。
  const parameters = new URL(request.url).searchParams;
  const kind = parameters.get("kind");
  const ownerId = parameters.get("ownerId") ?? "";
  // 查询只允许教师、学生班级和教室三种受支持的只读时间表投影。
  if ((kind !== "Teacher" && kind !== "StudentGroup" && kind !== "Room") || !ownerId) return Response.json({ error: "Choose a teacher, student group or room." }, { status: 400 });
  try {
    return Response.json(listPersonalTimetableWorkspace(kind, ownerId));
  } catch (error) {
    // 个人视图读取失败时保留原来的成功 payload，只为故障补上统一 JSON 边界。
    return safeDatabaseFailureResponse(error, "Personal timetable load failed", "The personal timetable could not be loaded. Try again.");
  }
}
