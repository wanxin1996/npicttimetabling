import { createHash, timingSafeEqual } from "node:crypto";

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 64;
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 256;
const SETUP_TOKEN_MINIMUM_BYTES = 32;
const SETUP_TOKEN_MAXIMUM_BYTES = 512;

export function usernameHasValidLength(username: string) {
  // 用户名先 trim 再检查长度；64 字符上限必须在限流 key 和数据库查询之前执行，
  // 防止公开登录接口把攻击者提供的大字符串长期保存在进程内存中。
  return username.length >= USERNAME_MIN_LENGTH && username.length <= USERNAME_MAX_LENGTH;
}

export function passwordHasValidLength(password: string) {
  // Scrypt 是刻意昂贵的同步运算，所以密码长度边界必须在调用数据库认证函数前检查。
  // setup、账号创建、密码修改和登录共用同一范围，避免某个入口建立其他入口无法使用的密码。
  return password.length >= PASSWORD_MIN_LENGTH && password.length <= PASSWORD_MAX_LENGTH;
}

export type SetupTokenCheck = "valid" | "invalid" | "unavailable";

export function administratorSetupConfigurationAvailable() {
  const configuredToken = process.env.TIMETABLING_SETUP_TOKEN;
  // production 空库只有在配置长度位于安全范围内时才可进入 setup。上限同时保护环境
  // 配置错误：一个超大 token 不应让每次公开请求都执行无界摘要，也不能成为永远匹配不了的陷阱。
  if (!configuredToken) return process.env.NODE_ENV !== "production";
  const configuredBytes = Buffer.byteLength(configuredToken, "utf8");
  return configuredBytes >= SETUP_TOKEN_MINIMUM_BYTES && configuredBytes <= SETUP_TOKEN_MAXIMUM_BYTES;
}

export function verifyAdministratorSetupToken(providedToken: unknown): SetupTokenCheck {
  const configuredToken = process.env.TIMETABLING_SETUP_TOKEN;

  // 开发环境若完全没有配置 token，仍允许基础程序员直接初始化本机空库。
  // 只要进入 production，缺少或过短配置都必须关闭 setup，而不能退回公开抢注模式。
  if (!configuredToken) return process.env.NODE_ENV === "production" ? "unavailable" : "valid";
  if (!administratorSetupConfigurationAvailable()) return "unavailable";

  // 先把两侧都摘要为固定 32 bytes，再恒定时间比较。这样正确 token、错误 token 和长度
  // 不同的 token 都走相同的底层比较操作，不会因字符串逐字符提前退出而泄漏匹配前缀。
  const candidate = typeof providedToken === "string"
    && Buffer.byteLength(providedToken, "utf8") <= SETUP_TOKEN_MAXIMUM_BYTES
    ? providedToken
    : "";
  const expectedDigest = createHash("sha256").update(configuredToken, "utf8").digest();
  const candidateDigest = createHash("sha256").update(candidate, "utf8").digest();
  return timingSafeEqual(expectedDigest, candidateDigest) ? "valid" : "invalid";
}
