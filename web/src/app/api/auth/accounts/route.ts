import type { NextRequest } from "next/server";
import { sessionToken } from "@/lib/auth";
import { createAppUser, listAppUsers, resetAppUserPassword, setAppUserStatus, validateSession } from "@/lib/database";

export const runtime = "nodejs";

function administrator(request: NextRequest) {
  // Resolve the session once for each account operation and require the additional
  // administrator flag before reading or changing another user's account.
  const token = sessionToken(request);
  return token ? validateSession(token) : null;
}

export async function GET(request: NextRequest) {
  // Return the small account roster only to an authenticated administrator.
  const user = administrator(request);
  if (!user?.isAdmin) return Response.json({ error: "Only the administrator can manage accounts." }, { status: 403 });
  return Response.json(listAppUsers());
}

export async function POST(request: NextRequest) {
  // Validate the initial username and password before creating a scheduler account.
  const user = administrator(request);
  if (!user?.isAdmin) return Response.json({ error: "Only the administrator can create accounts." }, { status: 403 });
  const body = await request.json();
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (username.length < 3 || password.length < 10) return Response.json({ error: "Username needs 3 characters and password needs 10 characters." }, { status: 400 });
  try { return Response.json(createAppUser(username, password), { status: 201 }); } catch { return Response.json({ error: "That username already exists." }, { status: 409 }); }
}

export async function PATCH(request: NextRequest) {
  // The requested action selects either reversible activation or password reset;
  // both operations remain restricted to the administrator.
  const user = administrator(request);
  if (!user?.isAdmin) return Response.json({ error: "Only the administrator can manage accounts." }, { status: 403 });
  const body = await request.json();
  if (typeof body.userId !== "string") return Response.json({ error: "Choose an account." }, { status: 400 });
  if (body.action === "status" && typeof body.isActive === "boolean") {
    if (!setAppUserStatus(body.userId, body.isActive)) return Response.json({ error: "Only normal scheduler accounts can be changed." }, { status: 400 });
    return Response.json({ ok: true });
  }
  if (body.action === "resetPassword" && typeof body.password === "string" && body.password.length >= 10) {
    if (!resetAppUserPassword(body.userId, body.password)) return Response.json({ error: "Only normal scheduler accounts can be reset." }, { status: 400 });
    return Response.json({ ok: true });
  }
  return Response.json({ error: "Account action is invalid." }, { status: 400 });
}
