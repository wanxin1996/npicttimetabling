import { NextResponse, type NextRequest } from "next/server";
import { sessionToken } from "@/lib/auth";
import { validateSession } from "@/lib/database";

// Every business API is protected centrally. Authentication endpoints stay public so
// a new installation can create its first administrator and logged-out users can sign in.
export function proxy(request: NextRequest) {
  // Hosting platforms need one exact unauthenticated endpoint to decide whether the
  // service and its persistent database are ready; all business data stays protected.
  if (request.nextUrl.pathname === "/api/health") return NextResponse.next();
  if (request.nextUrl.pathname.startsWith("/api/auth/")) return NextResponse.next();
  const token = sessionToken(request);
  if (!token || !validateSession(token)) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  return NextResponse.next();
}

export const config = { matcher: "/api/:path*" };
