export type CandidateSlotRequestIdentity = {
  requestNumber: number;
  sectionId: string;
  occurrence: number;
};

export function candidateSlotRequestMatches(
  currentRequest: CandidateSlotRequestIdentity | null,
  responseRequest: CandidateSlotRequestIdentity,
): boolean;
