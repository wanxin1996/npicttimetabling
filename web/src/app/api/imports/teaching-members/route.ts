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
  let ignoredZeroRows = 0;
  try {
    // 只把约定工作表解析成单元格对象，避免继续处理其他工作表记录。SheetJS 仍需打开
    // XLSX 压缩容器和共用资料，因此这个选项本身不能完全防止 ZIP 解压膨胀。
    // sheetRows 包含表头，因此读取 5,002 行：1 行表头、最多 5,000 行业务资料，
    // 再多读 1 行作为“确实超限”的证据，随后才能稳定区分 5,000 与 5,001 行。
    const workbook = XLSX.read(Buffer.from(await file.arrayBuffer()), {
      type: "buffer",
      sheets: ["Teaching Members"],
      sheetRows: maximumWorkbookRows + 2,
    });

    // 即使文件本身是合法 Excel，没有约定名称的工作表也不能继续导入。
    const worksheet = workbook.Sheets["Teaching Members"];
    if (!worksheet) return NextResponse.json({ error: "Sheet 'Teaching Members' was not found." }, { status: 400 });

    // 把已受解析上限保护的工作表转换成对象；空单元格保留为 null，便于统一验证。
    const sheetRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(worksheet, { defval: null });
    // 院系教学分配通常只有数百行。这个较宽松上限不会影响正常学期，且解析器
    // 已经只多读取一行，因此这里不会先把任意数量的工作表记录全部放进内存。
    // SheetJS 会在 sheetRows 截断了原始范围时写入 !fullref；同时检查它，避免前段
    // 含空行时转换结果未超过 5,000 行，却把后面的真实资料静默遗漏后继续导入。
    const workbookWasTruncated = Boolean(worksheet["!fullref"]);
    if (workbookWasTruncated || sheetRows.length > maximumWorkbookRows) {
      return NextResponse.json({ error: "The Teaching Members sheet must contain 5,000 rows or fewer." }, { status: 400 });
    }
    // 读取数据行前先验证表头，防止旧模板被错误解释并导入不正确资料。
    const headers = new Set(Object.keys(sheetRows[0] ?? {}));
    const missing = requiredColumns.filter((column) => !headers.has(column));
    if (missing.length) return NextResponse.json({ error: `Missing required columns: ${missing.join(", ")}.` }, { status: 400 });

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
  } catch (error) {
    // 解析器无法识别的文件只在服务器记录技术细节；浏览器收到安全且可操作的说明。
    console.error("Teaching Members workbook could not be parsed", error);
    return NextResponse.json({ error: "The file could not be read. Please use the Teaching Members export format." }, { status: 400 });
  }

  try {
    // 所有工作表验证通过后，才交给数据库事务一次性更新教师、课程、分配与班次。
    return NextResponse.json(importTeachingMembers(rows, ignoredZeroRows));
  } catch (error) {
    // 已知的资料保护冲突本身就是用户提示，因此保留原文并返回 409；
    // 它属于正常业务结果，不写错误堆栈，避免重复导入时污染服务器日志。
    if (error instanceof TeachingAllocationImportConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    // 未预期的数据库错误返回 500，提醒老师稍后重试；底层 SQL、触发器和文件内容
    // 只写入服务器日志，不会在浏览器响应中泄露。
    console.error("Teaching Members data could not be saved", error);
    return NextResponse.json({ error: "Teaching allocations could not be saved. Please try again." }, { status: 500 });
  }
}
