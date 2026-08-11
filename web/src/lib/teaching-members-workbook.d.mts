// 这一份声明文件为同名 JavaScript 工作簿解析器提供 TypeScript 边界。运行时实现保留在
// `.mjs`，让独立 Node 验证脚本和 Next.js 路由共用完全相同的 ZIP／Excel 防护；这里仅
// 描述它会返回的资料和公开上限，修改任一导出时必须同步检查同名实现与导入回归。
export type TeachingMembersWorksheetRow = Record<string, unknown>;

export class TeachingMembersWorkbookError extends Error {
  constructor(message: string);
}

export const teachingMembersSheetName: "Teaching Members";
export const maximumTeachingMemberRows: 5_000;
export const maximumTeachingMembersZipEntries: 2_048;
export const maximumTeachingMembersUncompressedBytes: number;
export const maximumTeachingMembersCompressionRatio: 200;

export function parseTeachingMembersWorksheet(workbookBytes: Buffer): {
  sheetRows: TeachingMembersWorksheetRow[];
  parsedWorksheetNames: string[];
};
