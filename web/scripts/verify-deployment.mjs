// The public URL can be passed after `--` or through an environment variable.
// Localhost remains available so the exact same checks can run before deployment.
const rawBaseUrl = process.argv[2] || process.env.TIMETABLING_DEPLOYMENT_URL || "http://127.0.0.1:3000";
const baseUrl = new URL(rawBaseUrl);
const isLocalhost = ["127.0.0.1", "localhost", "::1"].includes(baseUrl.hostname);

if (!isLocalhost && baseUrl.protocol !== "https:") {
  throw new Error("A public deployment must use an https:// URL.");
}

// These optional variables allow the same script to verify a real account. Both
// must be present together, and they are never printed or stored by this script.
const username = process.env.TIMETABLING_SMOKE_USERNAME?.trim();
const password = process.env.TIMETABLING_SMOKE_PASSWORD;

if (Boolean(username) !== Boolean(password)) {
  throw new Error("Set both TIMETABLING_SMOKE_USERNAME and TIMETABLING_SMOKE_PASSWORD, or neither.");
}

// A short timeout prevents a failed deployment or DNS problem from leaving the
// acceptance command running indefinitely.
async function request(pathname, options = {}) {
  return fetch(new URL(pathname, baseUrl), {
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    ...options,
  });
}

// Every assertion names the exact missing guarantee so a deployment failure can
// be fixed without reading this script or guessing which request failed.
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertSecurityHeaders(response, label) {
  // These headers protect all pages and APIs against protocol downgrade, framing,
  // content sniffing, referrer leakage and unneeded browser permissions.
  assert(response.headers.get("strict-transport-security")?.includes("max-age="), `${label}: HSTS header is missing.`);
  assert(response.headers.get("x-content-type-options") === "nosniff", `${label}: nosniff header is missing.`);
  assert(response.headers.get("x-frame-options") === "DENY", `${label}: frame protection is missing.`);
  assert(response.headers.get("referrer-policy") === "no-referrer", `${label}: referrer policy is incorrect.`);
  assert(response.headers.get("permissions-policy")?.includes("camera=()"), `${label}: permissions policy is missing.`);
}

async function readJson(response, label) {
  // A controlled JSON failure is clearer than the default parser exception when a
  // hosting proxy returns an HTML error page.
  try {
    return await response.json();
  } catch {
    throw new Error(`${label}: expected JSON but received another response format.`);
  }
}

// Health proves that the web process can also open and query the SQLite database.
const healthResponse = await request("/api/health");
assert(healthResponse.status === 200, `Health check returned HTTP ${healthResponse.status}.`);
assertSecurityHeaders(healthResponse, "Health check");
assert(healthResponse.headers.get("cache-control")?.includes("no-store"), "Health check: no-store cache protection is missing.");
const healthBody = await readJson(healthResponse, "Health check");
assert(healthBody.status === "ok", "Health check did not return status=ok.");
console.log("✓ Application and SQLite health check passed.");

// The public status endpoint is needed by the login screen. Without a session it
// must expose only a null user and the first-time setup flag.
const statusResponse = await request("/api/auth/status");
assert(statusResponse.status === 200, `Authentication status returned HTTP ${statusResponse.status}.`);
assertSecurityHeaders(statusResponse, "Authentication status");
const statusBody = await readJson(statusResponse, "Authentication status");
assert(typeof statusBody.setupRequired === "boolean", "Authentication status is missing setupRequired=true/false.");
assert(statusBody.user === null, "Logged-out authentication status unexpectedly exposed a user.");
console.log(`✓ Public authentication status is valid (setupRequired=${statusBody.setupRequired}).`);

// A logged-out request must never reveal master data, even though health and login
// endpoints are public for the hosting platform and the sign-in screen.
const protectedResponse = await request("/api/teachers");
assert(protectedResponse.status === 401, `Protected teacher API returned HTTP ${protectedResponse.status} instead of 401.`);
assertSecurityHeaders(protectedResponse, "Protected API");
assert(protectedResponse.headers.get("cache-control")?.includes("no-store"), "Protected API: no-store cache protection is missing.");
console.log("✓ Logged-out access to business data is blocked.");

if (username && password) {
  // An optional real-account check verifies cookie flags and authenticated access.
  // It creates only a short-lived session and removes that session before exiting.
  const loginResponse = await request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  assert(loginResponse.status === 200, `Smoke-test login returned HTTP ${loginResponse.status}.`);
  const sessionCookie = loginResponse.headers.get("set-cookie") || "";
  const cookiePair = sessionCookie.split(";", 1)[0];
  assert(cookiePair.includes("="), "Login response did not include a usable session cookie.");

  // Keep any account-check error until after logout. This guarantees that a failed
  // cookie or API assertion still removes the short-lived server-side session.
  let accountCheckError;
  try {
    assert(/HttpOnly/i.test(sessionCookie), "Session cookie is missing HttpOnly.");
    assert(/Secure/i.test(sessionCookie), "Session cookie is missing Secure.");
    assert(/SameSite=Strict/i.test(sessionCookie), "Session cookie is missing SameSite=Strict.");

    // Sending the returned cookie directly also allows this check to work against an
    // isolated HTTP localhost server even though production cookies require HTTPS.
    const authenticatedResponse = await request("/api/teachers", { headers: { Cookie: cookiePair } });
    assert(authenticatedResponse.status === 200, `Authenticated teacher API returned HTTP ${authenticatedResponse.status}.`);
    assert(Array.isArray(await readJson(authenticatedResponse, "Authenticated teacher API")), "Authenticated teacher API did not return a list.");
  } catch (error) {
    accountCheckError = error;
  }

  // Always remove the temporary server-side session so a deployment check does not
  // leave an extra active login behind in the production SQLite database.
  const logoutResponse = await request("/api/auth/logout", { method: "POST", headers: { Cookie: cookiePair } });
  assert(logoutResponse.status === 200, `Smoke-test logout returned HTTP ${logoutResponse.status}.`);
  if (accountCheckError) throw accountCheckError;
  console.log("✓ Login, secure cookie, authenticated access and logout passed.");
} else {
  console.log("• Account check skipped; provide the two TIMETABLING_SMOKE_* variables after creating an account.");
}

console.log(`Deployment verification passed for ${baseUrl.origin}.`);
