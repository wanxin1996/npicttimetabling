import { NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { importTeachingMembers, type TeachingMembersImportRow } from "@/lib/database";

// SheetJS and the local SQLite driver both require the Node.js server runtime.
export const runtime = "nodejs";

// Keep this contract explicit: a changed export template should fail clearly instead
// of silently creating incorrect teaching allocations.
const requiredColumns = ["Mod", "Catalog", "Lecturer", "Staff Type", "# of grps teaching"];

function text(value: unknown) {
  // Spreadsheet cells can be empty, numbers or text; convert all of them safely.
  return String(value ?? "").trim();
}

function staffType(value: unknown): "FT" | "PT" | null {
  // Accept common long labels from Excel but store one consistent value in the database.
  const normalized = text(value).toUpperCase();
  if (normalized === "FT" || normalized === "FULL-TIME" || normalized === "FULL TIME") return "FT";
  if (normalized === "PT" || normalized === "PART-TIME" || normalized === "PART TIME") return "PT";
  return null;
}

export async function POST(request: Request) {
  // The browser sends the workbook as multipart form data through the Courses screen.
  const formData = await request.formData();
  const file = formData.get("file");
  if (!file || typeof file === "string" || !file.name.toLowerCase().endsWith(".xlsx")) {
    return NextResponse.json({ error: "Please choose an .xlsx Teaching Members file." }, { status: 400 });
  }

  try {
    // Read only the approved worksheet; ignore the file's other sheets completely.
    const workbook = XLSX.read(Buffer.from(await file.arrayBuffer()), { type: "buffer" });
    const worksheet = workbook.Sheets["Teaching Members"];
    if (!worksheet) return NextResponse.json({ error: "Sheet 'Teaching Members' was not found." }, { status: 400 });
    const sheetRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(worksheet, { defval: null });
    // Check the headers before reading rows so an outdated template never imports wrongly.
    const headers = new Set(Object.keys(sheetRows[0] ?? {}));
    const missing = requiredColumns.filter((column) => !headers.has(column));
    if (missing.length) return NextResponse.json({ error: `Missing required columns: ${missing.join(", ")}.` }, { status: 400 });

    const rows: TeachingMembersImportRow[] = [];
    let ignoredZeroRows = 0;
    const errors: string[] = [];
    // Convert valid rows to the small internal format expected by the database importer.
    sheetRows.forEach((source, index) => {
      const mod = text(source.Mod).toUpperCase();
      const lecturer = text(source.Lecturer).toUpperCase();
      const groupCount = Number(source["# of grps teaching"] ?? 0);
      const type = staffType(source["Staff Type"]);
      // Empty trailing rows are normal in exported Excel files.
      if (!mod && !lecturer && !groupCount) return;
      if (groupCount === 0) {
        // The user confirmed that 0 means no allocation, not one unassigned section.
        ignoredZeroRows += 1;
        return;
      }
      if (!mod || !lecturer || !type || !Number.isInteger(groupCount) || groupCount < 0) {
        errors.push(`Row ${index + 2}: Mod, Lecturer, Staff Type and a positive whole group count are required.`);
        return;
      }
      rows.push({ mod, catalog: text(source.Catalog) || null, lecturer, staffType: type, groupCount });
    });
    // Show a short, actionable sample of validation errors instead of overwhelming staff.
    if (errors.length) return NextResponse.json({ error: errors.slice(0, 3).join(" ") }, { status: 400 });
    if (!rows.length) return NextResponse.json({ error: "No positive teaching allocations were found in this file." }, { status: 400 });

    return NextResponse.json(importTeachingMembers(rows, ignoredZeroRows));
  } catch (error) {
    // Keep detailed technical information in the server console while returning a
    // safe explanation that a scheduler can act on. Known scheduling-safety errors
    // are already written for users, so preserve those instead of hiding them.
    console.error("Teaching Members import failed", error);
    const message = error instanceof Error && error.message.startsWith("Teaching allocation cannot be re-imported")
      ? error.message
      : "The file could not be read. Please use the Teaching Members export format.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
