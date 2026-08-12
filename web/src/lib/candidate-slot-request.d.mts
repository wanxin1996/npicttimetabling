// 这个声明文件为页面实际导入的纯 JavaScript helper 提供 TypeScript 合同；请求号
// 与稳定班次身份必须同时相同，才能接受可能迟到的候选时段响应。
export type CandidateSlotRequestIdentity = {
  requestNumber: number;
  sectionId: string;
  occurrence: number;
};

export function candidateSlotRequestMatches(
  currentRequest: CandidateSlotRequestIdentity | null,
  responseRequest: CandidateSlotRequestIdentity,
): boolean;
