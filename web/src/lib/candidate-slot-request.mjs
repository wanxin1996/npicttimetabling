// 候选时段响应只有在请求序号和逻辑课次都仍然相同时才可写回页面。
// 把判断独立成纯函数，让真实页面与回归测试共用同一条竞态规则。
export function candidateSlotRequestMatches(currentRequest, responseRequest) {
  return currentRequest !== null
    && currentRequest.requestNumber === responseRequest.requestNumber
    && currentRequest.sectionId === responseRequest.sectionId
    && currentRequest.occurrence === responseRequest.occurrence;
}
