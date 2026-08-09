import type { NextRequest } from "next/server";

type AttemptWindow = {
  failures: number[];
  blockedUntil: number;
};

const WINDOW_MS = 15 * 60 * 1000;
const BLOCK_MS = 15 * 60 * 1000;
const MAX_PAIR_FAILURES = 5;
const MAX_ADDRESS_FAILURES = 25;
const MAX_TRACKED_KEYS = 2_000;

// Development reloads and route bundles can evaluate this module more than once.
// Keep one process-wide map so a failed attempt cannot bypass the limit that way.
const globalForLoginLimits = globalThis as unknown as {
  timetableLoginAttempts: Map<string, AttemptWindow> | undefined;
};
const attempts = globalForLoginLimits.timetableLoginAttempts ?? new Map<string, AttemptWindow>();
globalForLoginLimits.timetableLoginAttempts = attempts;

function clientAddress(request: NextRequest) {
  // Hosting proxies put the original client first. The separate address-wide counter
  // below still catches one source rotating through many candidate usernames.
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip")?.trim() || "unknown";
}

function keysFor(request: NextRequest, username: string) {
  // Five failures block one source/account pair; a larger address-wide ceiling also
  // stops username rotation without letting five typos block an entire shared office.
  const address = clientAddress(request);
  const normalizedUsername = username.trim().toLocaleLowerCase("en-US");
  return [
    { key: `pair:${address}:${normalizedUsername}`, maximumFailures: MAX_PAIR_FAILURES },
    { key: `address:${address}`, maximumFailures: MAX_ADDRESS_FAILURES },
  ];
}

function recentFailures(entry: AttemptWindow, now: number) {
  return entry.failures.filter((failedAt) => now - failedAt < WINDOW_MS);
}

function pruneExpiredEntries(now: number) {
  // Remove inactive entries before enforcing a hard memory bound. A public endpoint
  // must not allow arbitrary usernames or forwarded addresses to grow memory forever.
  for (const [key, entry] of attempts) {
    const failures = recentFailures(entry, now);
    if (failures.length === 0 && entry.blockedUntil <= now) attempts.delete(key);
    else entry.failures = failures;
  }
  while (attempts.size >= MAX_TRACKED_KEYS) {
    const oldestKey = attempts.keys().next().value;
    if (typeof oldestKey !== "string") break;
    attempts.delete(oldestKey);
  }
}

export function loginRateLimitStatus(request: NextRequest, username: string) {
  const now = Date.now();
  pruneExpiredEntries(now);
  // If either the source or account is blocked, return the longest remaining wait so
  // the client does not reveal which of the two limits was reached.
  const retryAfterSeconds = keysFor(request, username).reduce((longest, limit) => {
    const entry = attempts.get(limit.key);
    return entry && entry.blockedUntil > now ? Math.max(longest, Math.ceil((entry.blockedUntil - now) / 1000)) : longest;
  }, 0);
  return { allowed: retryAfterSeconds === 0, retryAfterSeconds };
}

export function recordFailedLogin(request: NextRequest, username: string) {
  const now = Date.now();
  // The fifth recent failure finishes normally with a generic 401; the following
  // request receives 429 until the short cooling-off period expires.
  for (const limit of keysFor(request, username)) {
    const current = attempts.get(limit.key) ?? { failures: [], blockedUntil: 0 };
    current.failures = [...recentFailures(current, now), now];
    if (current.failures.length >= limit.maximumFailures) current.blockedUntil = now + BLOCK_MS;
    attempts.delete(limit.key);
    attempts.set(limit.key, current);
  }
}

export function clearLoginFailures(request: NextRequest, username: string) {
  // A verified login clears both counters so old typos do not penalize the next real
  // login from the same scheduler or shared office network.
  for (const limit of keysFor(request, username)) attempts.delete(limit.key);
}
