import { NextResponse, type NextRequest } from "next/server";
import { attachSessionCookie } from "@/lib/auth";
import { loginUser } from "@/lib/database";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const body = await request.json();
  const result = typeof body.username === "string" && typeof body.password === "string" ? loginUser(body.username.trim(), body.password) : null;
  if (!result) return NextResponse.json({ error: "Username or password is incorrect." }, { status: 401 });
  const response = NextResponse.json({ user: result.user });
  attachSessionCookie(response, result.session.token, result.session.expiresAt);
  return response;
}
