import type { NextRequest } from "next/server";
import { sessionToken } from "@/lib/auth";
import { createAppUser, listAppUsers, validateSession } from "@/lib/database";

export const runtime = "nodejs";

function administrator(request: NextRequest) {
  const token = sessionToken(request);
  return token ? validateSession(token) : null;
}

export async function GET(request: NextRequest) {
  const user = administrator(request);
  if (!user?.isAdmin) return Response.json({ error: "Only the administrator can manage accounts." }, { status: 403 });
  return Response.json(listAppUsers());
}

export async function POST(request: NextRequest) {
  const user = administrator(request);
  if (!user?.isAdmin) return Response.json({ error: "Only the administrator can create accounts." }, { status: 403 });
  const body = await request.json();
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (username.length < 3 || password.length < 10) return Response.json({ error: "Username needs 3 characters and password needs 10 characters." }, { status: 400 });
  try { return Response.json(createAppUser(username, password), { status: 201 }); } catch { return Response.json({ error: "That username already exists." }, { status: 409 }); }
}
