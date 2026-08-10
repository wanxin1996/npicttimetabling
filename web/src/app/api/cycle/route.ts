import { cycleStatus, restoreLastCycleBackup, startNewCycle } from "@/lib/database";

export const runtime = "nodejs";

export function GET() {
  // The cycle page needs only counts and latest emergency-backup metadata.
  return Response.json(cycleStatus());
}

export async function POST(request: Request) {
  // One endpoint handles the two related high-risk actions; the action name and
  // exact confirmation phrase decide which database transaction may run.
  const body = await request.json();
  try {
    if (body.action === "start") {
      // An exact server-side phrase prevents bypassing the three confirmations by
      // calling the protected API directly with an accidental generic request.
      if (body.confirmation !== "START NEW CYCLE") return Response.json({ error: "Type START NEW CYCLE exactly to continue." }, { status: 400 });
      return Response.json(startNewCycle());
    }
    if (body.action === "restore") {
      if (body.confirmation !== "RESTORE LAST BACKUP") return Response.json({ error: "Type RESTORE LAST BACKUP exactly to continue." }, { status: 400 });
      return Response.json(restoreLastCycleBackup());
    }
    return Response.json({ error: "Choose a valid cycle action." }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "The cycle action could not be completed." }, { status: 409 });
  }
}
