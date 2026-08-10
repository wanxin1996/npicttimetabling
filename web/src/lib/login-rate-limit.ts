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

// 开发热重载和不同路由代码包可能多次执行这个模块。
// 把失败记录保存在进程级共享 Map 中，避免攻击者利用模块重新加载绕过限制。
const globalForLoginLimits = globalThis as unknown as {
  timetableLoginAttempts: Map<string, AttemptWindow> | undefined;
};
const attempts = globalForLoginLimits.timetableLoginAttempts ?? new Map<string, AttemptWindow>();
globalForLoginLimits.timetableLoginAttempts = attempts;

function clientAddress(request: NextRequest) {
  // 托管代理通常把原始客户端地址放在列表第一位；下方独立的地址级计数器
  // 还能识别同一来源不断更换候选用户名的尝试。
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip")?.trim() || "unknown";
}

function keysFor(request: NextRequest, username: string) {
  // 同一来源与账号组合失败五次后短暂封锁；更高的地址级上限用于阻止轮换用户名，
  // 同时避免共享办公室中某人输错五次就影响所有用户。
  const address = clientAddress(request);
  const normalizedUsername = username.trim().toLocaleLowerCase("en-US");
  return [
    { key: `pair:${address}:${normalizedUsername}`, maximumFailures: MAX_PAIR_FAILURES },
    { key: `address:${address}`, maximumFailures: MAX_ADDRESS_FAILURES },
  ];
}

function recentFailures(entry: AttemptWindow, now: number) {
  // 判断是否封锁前先忽略滚动保护窗口之外的旧尝试，使正常用户等待后能够再次登录。
  return entry.failures.filter((failedAt) => now - failedAt < WINDOW_MS);
}

function pruneExpiredEntries(now: number) {
  // 执行内存硬上限前先删除已不活跃记录；公开登录接口不能让任意用户名或转发地址
  // 永久累积并持续占用服务器内存。
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
  // 同时检查网络地址和用户名，防止重复猜测者只轮换其中一项就绕过短期封锁。
  const now = Date.now();
  pruneExpiredEntries(now);
  // 来源或账号任一被封锁时都返回最长剩余等待时间，避免客户端推断究竟触发了哪种限制。
  const retryAfterSeconds = keysFor(request, username).reduce((longest, limit) => {
    const entry = attempts.get(limit.key);
    return entry && entry.blockedUntil > now ? Math.max(longest, Math.ceil((entry.blockedUntil - now) / 1000)) : longest;
  }, 0);
  return { allowed: retryAfterSeconds === 0, retryAfterSeconds };
}

export function recordFailedLogin(request: NextRequest, username: string) {
  // 同一次失败同时记入账号组合和来源地址两个保护桶，并把更严格结果返回登录 API。
  const now = Date.now();
  // 最近第五次失败仍返回普通 401，之后的请求才在短暂冷却期内收到 429，
  // 避免响应差异直接泄露封锁临界点。
  for (const limit of keysFor(request, username)) {
    const current = attempts.get(limit.key) ?? { failures: [], blockedUntil: 0 };
    current.failures = [...recentFailures(current, now), now];
    if (current.failures.length >= limit.maximumFailures) current.blockedUntil = now + BLOCK_MS;
    attempts.delete(limit.key);
    attempts.set(limit.key, current);
  }
}

export function clearLoginFailures(request: NextRequest, username: string) {
  // 登录验证成功后清除两个计数器，避免旧输入错误影响同一老师或共享办公室网络的下次正常登录。
  for (const limit of keysFor(request, username)) attempts.delete(limit.key);
}
