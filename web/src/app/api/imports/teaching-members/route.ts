import { NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { importTeachingMembers, type TeachingMembersImportRow } from "@/lib/database";

export const runtime = "nodejs";

const requiredColumns = ["Mod", "Catalog", "Lecturer", "Staff Type", "# of grps teaching"];

function text(value: unknown) {
  return String(value ?? "").trim();
}

function staffType(value: unknown): "FT" | "PT" | null {
  const normalized = text(value).toUpperCase();
  if (normalized === "FT" || normalized === "FULL-TIME" || normalized === "FULL TIME") return "FT";
  if (normalized === "PT" || normalized === "PART-TIME" || normalized === "PART TIME") return "PT";
  return null;
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const file = formData.get("file");
  if (!file || typeof file === "string" || !file.name.toLowerCase().endsWith(".xlsx")) {
    return NextResponse.json({ error: "Please choose an .xlsx Teaching Members file." }, { status: 400 });
  }

  try {
    const workbook = XLSX.read(Buffer.from(await file.arrayBuffer()), { type: "buffer" });
    const worksheet = workbook.Sheets["Teaching Members"];
    if (!worksheet) return NextResponse.json({ error: "Sheet 'Teaching Members' was not found." }, { status: 400 });
    const sheetRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(worksheet, { defval: null });
    const headers = new Set(Object.keys(sheetRows[0] ?? {}));
    const missing = requiredColumns.filter((column) => !headers.has(column));
    if (missing.length) return NextResponse.json({ error: `Missing required columns: ${missing.join(", ")}.` }, { status: 400 });

    const rows: TeachingMembersImportRow[] = [];
    let ignoredZeroRows = 0;
    const errors: string[] = [];
    sheetRows.forEach((source, index) => {
      const mod = text(source.Mod).toUpperCase();
      const lecturer = text(source.Lecturer).toUpperCase();
      const groupCount = Number(source["# of grps teaching"] ?? 0);
      const type = staffType(source["Staff Type"]);
      if (!mod && !lecturer && !groupCount) return;
      if (groupCount === 0) {
        ignoredZeroRows += 1;
        return;
      }
      if (!mod || !lecturer || !type || !Number.isInteger(groupCount) || groupCount < 0) {
        errors.push(`Row ${index + 2}: Mod, Lecturer, Staff Type and a positive whole group count are required.`);
        return;
      }
      rows.push({ mod, catalog: text(source.Catalog) || null, lecturer, staffType: type, groupCount });
    });
    if (errors.length) return NextResponse.json({ error: errors.slice(0, 3).join(" ") }, { status: 400 });
    if (!rows.length) return NextResponse.json({ error: "No positive teaching allocations were found in this file." }, { status: 400 });

    return NextResponse.json(importTeachingMembers(rows, ignoredZeroRows));
  } catch (error) {
    console.error("Teaching Members import failed", error);
    return NextResponse.json({ error: "The file could not be read. Please use the Teaching Members export format." }, { status: 400 });
  }
}
