import { authenticationStatus } from "@/lib/database";
import { sessionToken } from "@/lib/auth";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  // This public endpoint tells the client whether to show first-time setup, login,
  // or the authenticated workspace without exposing password or session data.
  return Response.json(authenticationStatus(sessionToken(request)));
}
