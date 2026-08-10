export type TeachingMembersWorksheetRow = Record<string, unknown>;

export class TeachingMembersWorkbookError extends Error {
  constructor(message: string);
}

export const teachingMembersSheetName: "Teaching Members";
export const maximumTeachingMemberRows: 5_000;

export function parseTeachingMembersWorksheet(workbookBytes: Buffer): {
  sheetRows: TeachingMembersWorksheetRow[];
  parsedWorksheetNames: string[];
};
