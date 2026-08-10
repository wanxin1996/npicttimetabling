import * as XLSX from "xlsx";

// Teaching allocation 只能读取学校约定的工作表；名称和行数上限集中在这里，
// API 与自动化测试会调用同一个解析函数，避免测试复制一套不同的安全选项。
export const teachingMembersSheetName = "Teaching Members";
export const maximumTeachingMemberRows = 5_000;

export class TeachingMembersWorkbookError extends Error {
  // 缺少目标表或超过安全行数都是老师可以修正的文件问题，API 会把这类错误稳定映射为 400。
  constructor(message) {
    super(message);
    this.name = "TeachingMembersWorkbookError";
  }
}

export function parseTeachingMembersWorksheet(workbookBytes) {
  // sheets 只让目标工作表建立单元格对象；sheetRows 包含表头，因此读取上限加 2：
  // 1 行表头、最多 5,000 行业务资料，再多读 1 行用来明确判断超限。
  const workbook = XLSX.read(workbookBytes, {
    type: "buffer",
    sheets: [teachingMembersSheetName],
    sheetRows: maximumTeachingMemberRows + 2,
  });

  // 合法 Excel 若没有约定名称的工作表，也不能猜测其他工作表结构后继续导入。
  const worksheet = workbook.Sheets[teachingMembersSheetName];
  if (!worksheet) {
    throw new TeachingMembersWorkbookError(`Sheet '${teachingMembersSheetName}' was not found.`);
  }

  // 空单元格统一保留为 null，后续业务验证可以准确区分缺值与数字 0。
  const sheetRows = XLSX.utils.sheet_to_json(worksheet, { defval: null });
  // SheetJS 在 sheetRows 截断原始范围时写入 !fullref；即使截断区前有大量空行，
  // 也必须拒绝整份文件，不能把尾部真实资料静默遗漏。
  const workbookWasTruncated = Boolean(worksheet["!fullref"]);
  if (workbookWasTruncated || sheetRows.length > maximumTeachingMemberRows) {
    throw new TeachingMembersWorkbookError("The Teaching Members sheet must contain 5,000 rows or fewer.");
  }

  return {
    sheetRows,
    // 自动化测试读取同一次生产解析的对象名称，直接证明 Decoy 没有被建立成 Worksheet；
    // API 本身不依赖该诊断字段，因此不会影响实际导入摘要。
    parsedWorksheetNames: Object.keys(workbook.Sheets),
  };
}
