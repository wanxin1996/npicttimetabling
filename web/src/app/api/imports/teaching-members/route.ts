import { NextResponse } from "next/server";
import {
  importTeachingMembers,
  maximumTeachingGroupsPerCourse,
  maximumTeachingGroupsPerRow,
  maximumTeachingGroupsPerWorkbook,
  TeachingAllocationImportConflictError,
  TeachingAllocationImportInputError,
  type TeachingMembersImportRow,
} from "@/lib/database";
import { safeDatabaseFailureResponse } from "@/lib/database-response";
import {
  COURSE_CATALOG_MAX_LENGTH,
  COURSE_CODE_MAX_LENGTH,
  normalizeOptionalText,
  normalizeRequiredUppercaseText,
  TEACHER_NAME_MAX_LENGTH,
} from "@/lib/master-data-input";
import { parseTeachingMembersWorksheet, TeachingMembersWorkbookError } from "@/lib/teaching-members-workbook.mjs";

// SheetJS 和本地 SQLite 驱动都依赖 Node.js，因此导入必须在服务器运行环境执行。
export const runtime = "nodejs";

// 明确写出允许的表格结构：导出模板一旦变化就应清楚报错，
// 不能静默生成错误的教师分配和课程班次。
const requiredColumns = ["Mod", "Catalog", "Lecturer", "Staff Type", "# of grps teaching"];
const maximumWorkbookBytes = 20 * 1024 * 1024;

function staffType(value: unknown): "FT" | "PT" | null {
  // 接受 Excel 中常见的完整教师类型文字，但数据库只保存一种统一标准值。
  // 这里不把数字或布尔值转换成文字；Excel 原生字符串才能表达教师类别。
  const normalized = normalizeRequiredUppercaseText(value, 32);
  if (normalized === "FT" || normalized === "FULL-TIME" || normalized === "FULL TIME") return "FT";
  if (normalized === "PT" || normalized === "PART-TIME" || normalized === "PART TIME") return "PT";
  return null;
}

function cellIsBlank(value: unknown) {
  // 只有 null／undefined 或纯空白文字属于“没有填写”。数字 0 和文字 "0" 都是
  // 明确业务指令，绝不能和空白行一起被跳过。
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
}

function strictGroupCount(value: unknown) {
  // Excel 数值单元格必须是安全整数；文字单元格只接受普通十进制数字。
  // Boolean、空白、1e2／1.0 等字符串都拒绝，避免 Number() 的宽松转换改变原意。
  let parsed: number;
  if (typeof value === "number") {
    parsed = value;
  } else if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    parsed = Number(value.trim());
  } else {
    return null;
  }
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximumTeachingGroupsPerRow) return null;
  return parsed;
}

export async function POST(request: Request) {
  // 浏览器从 Courses 页面以 multipart 表单数据发送工作簿。损坏的 multipart
  // 请求会让 formData() 抛出异常，所以在读取文件前先转换成可理解的 400 提示。
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "The upload request could not be read. Please choose the file again." }, { status: 400 });
  }

  // multipart 中只接受名为 file 的真实文件，并在调用 Excel 解析器前验证扩展名。
  const file = formData.get("file");
  if (!file || typeof file === "string" || !file.name.toLowerCase().endsWith(".xlsx")) {
    return NextResponse.json({ error: "Please choose an .xlsx Teaching Members file." }, { status: 400 });
  }
  // 已知工作簿约 16 MB；在复制文件到 Excel 解析缓冲区或让 SheetJS 解压之前，
  // 先拒绝异常大的文件，减少意外或恶意输入继续消耗服务器内存的机会。
  if (file.size > maximumWorkbookBytes) {
    return NextResponse.json({ error: "The Teaching Members file must be 20 MB or smaller." }, { status: 413 });
  }

  // 解析阶段只建立经过验证的内部资料，不在这里写数据库。这样能分别处理“文件有问题”
  // 和“数据库暂时保存失败”，不会把服务器故障错误地说成老师选错了 Excel 文件。
  const rows: TeachingMembersImportRow[] = [];
  let zeroAllocationRows = 0;
  try {
    // 共用解析器固定目标工作表、行数上限与 !fullref 截断检测；生产 API 和自动化
    // 回归不会各自维护一套容易漂移的 SheetJS 安全选项。
    const { sheetRows } = parseTeachingMembersWorksheet(Buffer.from(await file.arrayBuffer()));
    // 读取数据行前先验证表头，防止旧模板被错误解释并导入不正确资料。
    const headers = new Set(Object.keys(sheetRows[0] ?? {}));
    const missing = requiredColumns.filter((column) => !headers.has(column));
    if (missing.length) return NextResponse.json({ error: `Missing required columns: ${missing.join(", ")}.` }, { status: 400 });

    const errors: string[] = [];
    const groupCountByCourse = new Map<string, number>();
    const coursesOverLimit = new Set<string>();
    let workbookGroupCount = 0;
    // 把有效工作表行转换为数据库导入器所需的简洁内部格式。
    sheetRows.forEach((source, index) => {
      // SheetJS 通常会省略整行空白，这层判断仍保护含格式但没有业务值的导出行。
      // 只要任一单元格有内容，该行就必须完整通过验证，不能把空 count 猜成 0。
      if (Object.values(source).every(cellIsBlank)) return;
      const mod = normalizeRequiredUppercaseText(source.Mod, COURSE_CODE_MAX_LENGTH);
      const catalog = normalizeOptionalText(source.Catalog, COURSE_CATALOG_MAX_LENGTH);
      const lecturer = normalizeRequiredUppercaseText(source.Lecturer, TEACHER_NAME_MAX_LENGTH);
      const groupCount = strictGroupCount(source["# of grps teaching"]);
      const type = staffType(source["Staff Type"]);
      // 分配数量 0 是有效值，但教师和课程资料仍必须完整，因为 0 可能是在清除旧分配。
      if (!mod || !catalog.ok || !lecturer || !type || groupCount === null) {
        // 错误提示只包含行号和固定边界，不回显恶意单元格内容，也不会因一个巨大值
        // 产生同样巨大的 HTTP 响应。所有行验证完成前数据库仍然没有任何写入。
        errors.push(`Row ${index + 2}: Mod must be a plain string up to ${COURSE_CODE_MAX_LENGTH} characters, Catalog up to ${COURSE_CATALOG_MAX_LENGTH}, Lecturer up to ${TEACHER_NAME_MAX_LENGTH}, Staff Type must be valid, and group count must be a whole number from 0 to ${maximumTeachingGroupsPerRow}. Control characters are not allowed.`);
        return;
      }
      const nextCourseGroupCount = (groupCountByCourse.get(mod) ?? 0) + groupCount;
      groupCountByCourse.set(mod, nextCourseGroupCount);
      workbookGroupCount += groupCount;
      if (nextCourseGroupCount > maximumTeachingGroupsPerCourse && !coursesOverLimit.has(mod)) {
        coursesOverLimit.add(mod);
        errors.push(`${mod} exceeds the ${maximumTeachingGroupsPerCourse}-group course limit.`);
      }
      if (workbookGroupCount > maximumTeachingGroupsPerWorkbook && workbookGroupCount - groupCount <= maximumTeachingGroupsPerWorkbook) {
        errors.push(`The workbook exceeds the ${maximumTeachingGroupsPerWorkbook.toLocaleString("en-US")}-group safety limit.`);
      }
      // 保留数量为 0 的行：数据库会复用教师／课程 ID，并清除该课程旧 allocation
      // 与无保护的自动班次，而不是把 0 当成缺值静默忽略。
      if (groupCount === 0) zeroAllocationRows += 1;
      rows.push({ mod, catalog: catalog.value, lecturer, staffType: type, groupCount });
    });
    // 只显示少量可操作的验证错误示例，避免一次输出过多信息让老师难以处理。
    if (errors.length) return NextResponse.json({ error: errors.slice(0, 3).join(" ") }, { status: 400 });
    if (rows.length === 0) return NextResponse.json({ error: "At least one complete Teaching Members row is required." }, { status: 400 });
  } catch (error) {
    // 缺少目标表或超过 5,000 行属于可直接修正的工作簿问题，保留明确说明。
    if (error instanceof TeachingMembersWorkbookError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    // 解析器无法识别的文件只在服务器记录技术细节；浏览器收到安全且可操作的说明。
    console.error("Teaching Members workbook could not be parsed", error);
    return NextResponse.json({ error: "The file could not be read. Please use the Teaching Members export format." }, { status: 400 });
  }

  try {
    // 所有工作表验证通过后，才交给数据库事务一次性更新教师、课程、分配与班次。
    return NextResponse.json(importTeachingMembers(rows, zeroAllocationRows));
  } catch (error) {
    // 数据库入口会重复执行数量防线；若未来出现另一个调用方绕过上面的行验证，
    // 仍然把这类可修正输入稳定映射为 400。
    if (error instanceof TeachingAllocationImportInputError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    // 已知的资料保护冲突本身就是用户提示，因此保留原文并返回 409；
    // 它属于正常业务结果，不写错误堆栈，避免重复导入时污染服务器日志。
    if (error instanceof TeachingAllocationImportConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    // 未预期的数据库错误返回 500，提醒老师稍后重试；底层 SQL、触发器和文件内容
    // 只写入服务器日志，不会在浏览器响应中泄露。
    return safeDatabaseFailureResponse(
      error,
      "Teaching Members data could not be saved",
      "Teaching allocations could not be saved. Please try again.",
    );
  }
}
