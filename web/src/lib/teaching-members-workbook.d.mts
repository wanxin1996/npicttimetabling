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
