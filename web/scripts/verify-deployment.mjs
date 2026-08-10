// 公共网址可放在 -- 后传入，也可通过环境变量提供。
// 同一套检查仍支持 localhost，便于部署前在本地完整验证。
const rawBaseUrl = process.argv[2] || process.env.TIMETABLING_DEPLOYMENT_URL || "http://127.0.0.1:3000";
const baseUrl = new URL(rawBaseUrl);
const isLocalhost = ["127.0.0.1", "localhost", "::1"].includes(baseUrl.hostname);

if (!isLocalhost && baseUrl.protocol !== "https:") {
  throw new Error("A public deployment must use an https:// URL.");
}

// 下面两个可选变量让脚本能够验证真实账号；它们必须同时提供，
// 而且脚本不会打印或保存其内容。
const username = process.env.TIMETABLING_SMOKE_USERNAME?.trim();
const password = process.env.TIMETABLING_SMOKE_PASSWORD;

if (Boolean(username) !== Boolean(password)) {
  throw new Error("Set both TIMETABLING_SMOKE_USERNAME and TIMETABLING_SMOKE_PASSWORD, or neither.");
}

// 较短超时可防止部署失败或 DNS 故障让验收命令无限期等待。
async function request(pathname, options = {}) {
  return fetch(new URL(pathname, baseUrl), {
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    ...options,
  });
}

// 每个断言都明确说明缺失的安全或功能保证，使部署失败时无需阅读脚本
// 或猜测请求过程，就能定位需要修复的项目。
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertSecurityHeaders(response, label) {
  // 这些响应头保护所有页面和 API，防止协议降级、页面嵌套、内容嗅探、
  // 引用来源泄露以及不必要的浏览器权限。
  assert(response.headers.get("strict-transport-security")?.includes("max-age="), `${label}: HSTS header is missing.`);
  assert(response.headers.get("x-content-type-options") === "nosniff", `${label}: nosniff header is missing.`);
  assert(response.headers.get("x-frame-options") === "DENY", `${label}: frame protection is missing.`);
  assert(response.headers.get("referrer-policy") === "no-referrer", `${label}: referrer policy is incorrect.`);
  assert(response.headers.get("permissions-policy")?.includes("camera=()"), `${label}: permissions policy is missing.`);
}

async function readJson(response, label) {
  // 当托管代理返回 HTML 错误页时，受控的 JSON 错误比默认解析异常更容易理解和排查。
  try {
    return await response.json();
  } catch {
    throw new Error(`${label}: expected JSON but received another response format.`);
  }
}

// 健康检查不仅验证网页进程在线，也证明它能够打开并查询 SQLite 数据库。
const healthResponse = await request("/api/health");
assert(healthResponse.status === 200, `Health check returned HTTP ${healthResponse.status}.`);
assertSecurityHeaders(healthResponse, "Health check");
assert(healthResponse.headers.get("cache-control")?.includes("no-store"), "Health check: no-store cache protection is missing.");
const healthBody = await readJson(healthResponse, "Health check");
assert(healthBody.status === "ok", "Health check did not return status=ok.");
console.log("✓ Application and SQLite health check passed.");

// 登录页面需要访问公开状态接口；没有会话时，该接口只能返回空用户和首次初始化标记。
const statusResponse = await request("/api/auth/status");
assert(statusResponse.status === 200, `Authentication status returned HTTP ${statusResponse.status}.`);
assertSecurityHeaders(statusResponse, "Authentication status");
const statusBody = await readJson(statusResponse, "Authentication status");
assert(typeof statusBody.setupRequired === "boolean", "Authentication status is missing setupRequired=true/false.");
assert(statusBody.user === null, "Logged-out authentication status unexpectedly exposed a user.");
console.log(`✓ Public authentication status is valid (setupRequired=${statusBody.setupRequired}).`);

// 即使健康和登录接口必须公开给托管平台及登录页，退出状态的请求也绝不能读取基础资料。
const protectedResponse = await request("/api/teachers");
assert(protectedResponse.status === 401, `Protected teacher API returned HTTP ${protectedResponse.status} instead of 401.`);
assertSecurityHeaders(protectedResponse, "Protected API");
assert(protectedResponse.headers.get("cache-control")?.includes("no-store"), "Protected API: no-store cache protection is missing.");
console.log("✓ Logged-out access to business data is blocked.");

if (username && password) {
  // 可选真实账号检查会验证 Cookie 安全属性和登录后访问权限；
  // 它只创建短期会话，并在脚本退出前将其删除。
  const loginResponse = await request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  assert(loginResponse.status === 200, `Smoke-test login returned HTTP ${loginResponse.status}.`);
  const sessionCookie = loginResponse.headers.get("set-cookie") || "";
  const cookiePair = sessionCookie.split(";", 1)[0];
  assert(cookiePair.includes("="), "Login response did not include a usable session cookie.");

  // 账号检查错误先暂存到退出登录之后再抛出，确保 Cookie 或 API 断言失败时，
  // 短期服务器会话仍会被清理。
  let accountCheckError;
  try {
    assert(/HttpOnly/i.test(sessionCookie), "Session cookie is missing HttpOnly.");
    assert(/Secure/i.test(sessionCookie), "Session cookie is missing Secure.");
    assert(/SameSite=Strict/i.test(sessionCookie), "Session cookie is missing SameSite=Strict.");

    // 直接发送返回的 Cookie，使检查也能针对独立 HTTP localhost 服务器运行，
    // 即使生产环境 Cookie 本身要求 HTTPS。
    const authenticatedResponse = await request("/api/teachers", { headers: { Cookie: cookiePair } });
    assert(authenticatedResponse.status === 200, `Authenticated teacher API returned HTTP ${authenticatedResponse.status}.`);
    assert(Array.isArray(await readJson(authenticatedResponse, "Authenticated teacher API")), "Authenticated teacher API did not return a list.");
  } catch (error) {
    accountCheckError = error;
  }

  // 无论检查结果如何都删除临时服务器会话，防止部署验证在正式 SQLite 数据库中
  // 留下一个多余的活跃登录。
  const logoutResponse = await request("/api/auth/logout", { method: "POST", headers: { Cookie: cookiePair } });
  assert(logoutResponse.status === 200, `Smoke-test logout returned HTTP ${logoutResponse.status}.`);
  if (accountCheckError) throw accountCheckError;
  console.log("✓ Login, secure cookie, authenticated access and logout passed.");
} else {
  console.log("• Account check skipped; provide the two TIMETABLING_SMOKE_* variables after creating an account.");
}

console.log(`Deployment verification passed for ${baseUrl.origin}.`);
