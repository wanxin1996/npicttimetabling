import { readFile } from "node:fs/promises";

const resultsUrl = new URL("../../docs/UX_TASK_TEST_RESULTS.json", import.meta.url);
let results;

try {
  results = JSON.parse(await readFile(resultsUrl, "utf8"));
} catch (error) {
  console.error(
    `无法读取五人 UX 结果文件：${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}

const errors = [];
if (results.viewport !== "1024x768") {
  errors.push('viewport 必须是字符串 "1024x768"。');
}

if (!Array.isArray(results.participants) || results.participants.length !== 5) {
  errors.push("participants 必须恰好包含五名真实参与者。");
}

const participants = Array.isArray(results.participants) ? results.participants : [];
const requiredIds = ["P1", "P2", "P3", "P4", "P5"];
const participantIds = participants.map((participant) => participant?.id);
for (const id of requiredIds) {
  if (!participantIds.includes(id)) errors.push(`缺少参与者 ${id}。`);
}
if (new Set(participantIds).size !== participantIds.length) {
  errors.push("参与者 id 不可重复。");
}

for (const [index, participant] of participants.entries()) {
  const label = participant?.id || `第 ${index + 1} 条记录`;
  if (typeof participant?.role !== "string" || participant.role.trim() === "") {
    errors.push(`${label} 缺少真实角色说明。`);
  }
  if (typeof participant?.success !== "boolean") {
    errors.push(`${label} 的 success 必须明确填写 true 或 false。`);
  }
  if (
    typeof participant?.timeSeconds !== "number" ||
    !Number.isFinite(participant.timeSeconds) ||
    participant.timeSeconds <= 0
  ) {
    errors.push(`${label} 的 timeSeconds 必须是大于 0 的实测秒数。`);
  }
  if (typeof participant?.sawSaveFeedback !== "boolean") {
    errors.push(`${label} 的 sawSaveFeedback 必须明确填写 true 或 false。`);
  }
  if (typeof participant?.facilitatorIntervention !== "boolean") {
    errors.push(
      `${label} 的 facilitatorIntervention 必须明确填写 true 或 false。`,
    );
  }
  if (typeof participant?.notes !== "string") {
    errors.push(`${label} 的 notes 必须是字符串；没有补充也请填写空字符串。`);
  }

  // 成功样本必须同时满足任务协议：参与者看到了保存反馈，且主持人没有介入。
  if (participant?.success === true && participant.sawSaveFeedback !== true) {
    errors.push(`${label} 标记为成功，但没有看到保存反馈。`);
  }
  if (participant?.success === true && participant.facilitatorIntervention !== false) {
    errors.push(`${label} 标记为成功，但主持人发生了介入。`);
  }
  if (participant?.success === true && participant.timeSeconds > 180) {
    errors.push(`${label} 超过 180 秒，按任务协议不能标记为成功。`);
  }
}

if (errors.length > 0) {
  console.error("五人 UX 人工发布门槛未通过：");
  for (const error of errors) console.error(`- ${error}`);
  console.error(
    "\n请按 docs/UX_TASK_TEST.md 实测后如实填写结果；空模板和模拟数据都不能作为发布证据。",
  );
  process.exit(1);
}

const successCount = participants.filter((participant) => participant.success).length;
const successRate = successCount / participants.length;
const successfulTimes = participants
  .filter((participant) => participant.success)
  .map((participant) => participant.timeSeconds)
  .sort((a, b) => a - b);
const median =
  successfulTimes.length === 0
    ? Number.POSITIVE_INFINITY
    : successfulTimes[Math.floor(successfulTimes.length / 2)];

// 五人的离散样本无法刚好得到 90%，所以“至少 90%”实际上要求五人全部成功。
if (successRate < 0.9 || median > 60) {
  console.error("五人 UX 人工发布门槛未通过：");
  console.error(`- 成功率：${(successRate * 100).toFixed(0)}%（要求至少 90%）`);
  console.error(`- 成功样本中位时长：${median} 秒（要求不超过 60 秒）`);
  process.exit(1);
}

console.log("五人 UX 人工发布门槛通过。");
console.log(`成功率：${(successRate * 100).toFixed(0)}%；中位时长：${median} 秒。`);
