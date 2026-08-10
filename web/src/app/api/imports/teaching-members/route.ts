import { NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { importTeachingMembers, TeachingAllocationImportConflictError, type TeachingMembersImportRow } from "@/lib/database";

// SheetJS 和本地 SQLite 驱动都依赖 Node.js，因此导入必须在服务器运行环境执行。
export const runtime = "nodejs";

// 明确写出允许的表格结构：导出模板一旦变化就应清楚报错，
// 不能静默生成错误的教师分配和课程班次。
const requiredColumns = ["Mod", "Catalog", "Lecturer", "Staff Type", "# of grps teaching"];
const maximumWorkbookBytes = 20 * 1024 * 1024;
const maximumWorkbookRows = 5_000;

function text(value: unknown) {
  // 表格单元格可能为空、数字或文字，统一安全转换后再进行业务验证。
  return String(value ?? "").trim();
}

function staffType(value: unknown): "FT" | "PT" | null {
  // 接受 Excel 中常见的完整教师类型文字，但数据库只保存一种统一标准值。
  const normalized = text(value).toUpperCase();
  if (normalized === "FT" || normalized === "FULL-TIME" || normalized === "FULL TIME") return "FT";
  if (normalized === "PT" || normalized === "PART-TIME" || normalized === "PART TIME") return "PT";
  return null;
}

export async function POST(request: Request) {
  // 浏览器从 Courses 页面以 multipart 表单数据发送工作簿。
  const formData = await request.formData();
  const file = formData.get("file");
  if (!file || typeof file === "string" || !file.name.toLowerCase().endsWith(".xlsx")) {
    return NextResponse.json({ error: "Please choose an .xlsx Teaching Members file." }, { status: 400 });
  }
  // 已知工作簿约 16 MB；在分配完整内存缓冲区或让 SheetJS 解压之前，
  // 先拒绝异常大的文件，防止意外或恶意消耗服务器内存。
  if (file.size > maximumWorkbookBytes) {
    return NextResponse.json({ error: "The Teaching Members file must be 20 MB or smaller." }, { status: 413 });
  }

  try {
    // 只读取约定的工作表，文件中的其他工作表完全忽略，避免误导入不相关资料。
    const workbook = XLSX.read(Buffer.from(await file.arrayBuffer()), { type: "buffer" });
    const worksheet = workbook.Sheets["Teaching Members"];
    if (!worksheet) return NextResponse.json({ error: "Sheet 'Teaching Members' was not found." }, { status: 400 });
    const sheetRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(worksheet, { defval: null });
    // 院系教学分配通常只有数百行。这个较宽松上限不会影响正常学期，
    // 但能拦截意外膨胀或恶意构造的工作表。
    if (sheetRows.length > maximumWorkbookRows) return NextResponse.json({ error: "The Teaching Members sheet must contain 5,000 rows or fewer." }, { status: 400 });
    // 读取数据行前先验证表头，防止旧模板被错误解释并导入不正确资料。
    const headers = new Set(Object.keys(sheetRows[0] ?? {}));
    const missing = requiredColumns.filter((column) => !headers.has(column));
    if (missing.length) return NextResponse.json({ error: `Missing required columns: ${missing.join(", ")}.` }, { status: 400 });

    const rows: TeachingMembersImportRow[] = [];
    let ignoredZeroRows = 0;
    const errors: string[] = [];
    // 把有效工作表行转换为数据库导入器所需的简洁内部格式。
    sheetRows.forEach((source, index) => {
      const mod = text(source.Mod).toUpperCase();
      const lecturer = text(source.Lecturer).toUpperCase();
      const groupCount = Number(source["# of grps teaching"] ?? 0);
      const type = staffType(source["Staff Type"]);
      // Excel 导出文件末尾出现空行很常见，安全跳过即可。
      if (!mod && !lecturer && !groupCount) return;
      // 分配数量 0 是有效值，但教师资料仍必须完整，因为该工作簿也是约定的教师名单来源。
      if (!mod || !lecturer || !type || !Number.isInteger(groupCount) || groupCount < 0) {
        errors.push(`Row ${index + 2}: Mod, Lecturer, Staff Type and a non-negative whole group count are required.`);
        return;
      }
      // 保留数量为 0 的行以维护教师名单；数据库导入阶段会跳过其课程分配和班次生成。
      if (groupCount === 0) ignoredZeroRows += 1;
      rows.push({ mod, catalog: text(source.Catalog) || null, lecturer, staffType: type, groupCount });
    });
    // 只显示少量可操作的验证错误示例，避免一次输出过多信息让老师难以处理。
    if (errors.length) return NextResponse.json({ error: errors.slice(0, 3).join(" ") }, { status: 400 });
    if (!rows.some((row) => row.groupCount > 0)) return NextResponse.json({ error: "No positive teaching allocations were found in this file." }, { status: 400 });

    return NextResponse.json(importTeachingMembers(rows, ignoredZeroRows));
  } catch (error) {
    // 已知的资料保护冲突本身就是用户提示，因此保留原文并返回 409；
    // 它属于正常业务结果，不写错误堆栈，避免重复导入时污染服务器日志。
    if (error instanceof TeachingAllocationImportConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    // 未预期的解析或数据库错误只记录在服务器；浏览器收到安全的通用说明，
    // 不会暴露文件内容或 SQLite 内部细节。
    console.error("Teaching Members import failed", error);
    return NextResponse.json({ error: "The file could not be read. Please use the Teaching Members export format." }, { status: 400 });
  }
}
