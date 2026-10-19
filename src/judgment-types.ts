export type JudgmentKind = 'prediction' | 'idea';
export type JudgmentMode = 'public_event' | 'numeric' | 'private';
export type JudgmentStatus = 'observing' | 'verification' | 'evidence' | 'feedback' | 'resolved' | 'indeterminate' | 'withdrawn';
export type JudgmentOutcome = 'yes' | 'no' | 'indeterminate' | 'maintain' | 'revise' | 'shelve';
export type StockRule = {
  symbol: string; market: string; currency: string; baselineDate: string; baselineValue: number;
  targetDate: string; timeZone: string; priceType: 'close' | 'intraday'; adjustment: 'raw' | 'adjusted' | 'total_return';
  nonTradingDay: 'unresolved' | 'previous'; missing: 'unresolved'; suspension: 'unresolved'; corporateActions: 'unresolved' | 'source_adjusted';
};
export type NumericRule = { metric: string; unit: string; period: string; sourceUrl: string; comparator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq'; threshold: number; stock?: StockRule };
export type JudgmentInput = {
  projectId: string; kind: JudgmentKind; title: string; probability: number | null; deadlineAt: string | null;
  criteria: string; rationale: string; doubts: string; topic: string; mode: JudgmentMode;
  rule: NumericRule | null; autoResolve: boolean; checkAt: string; timeZone: string; synthetic: boolean; parentId?: string;
};
export type Judgment = {
  id: string; projectId: string; projectName: string; projectArchived: boolean; kind: JudgmentKind; title: string;
  probability: number | null; firstProbability: number | null; deadlineAt: string | null; criteria: string; rationale: string;
  doubts: string; topic: string; mode: JudgmentMode; rule: NumericRule | null; autoResolve: boolean; synthetic: boolean;
  status: JudgmentStatus; revision: number; createdAt: string; updatedAt: string; parentId: string | null;
  outcome: JudgmentOutcome | null; nextCheckAt: string | null;
};
export type JudgmentVersion = { id: string; number: number; probability: number | null; reason: string; snapshot: JudgmentInput | null; createdAt: string; actor: string; conversationId: string | null };
export type JudgmentEvidenceInput = { url: string; excerpt: string; observedAt: string; value?: number; unit?: string; period?: string; stock?: StockRule; complete: boolean; conflict: boolean; fileIds?: string[]; stockValidation?: { tradingDate:string; suspended:boolean; corporateAction:boolean; sourceAdjusted:boolean; targetNonTradingDay?:boolean; latestTradingDayVerified?:boolean } };
export type JudgmentEvidence = JudgmentEvidenceInput & { id: string; createdAt: string; conversationId: string | null; checkId: string | null };
export type JudgmentResult = { id: string; outcome: JudgmentOutcome; reason: string; candidate: boolean; evidenceIds: string[]; createdAt: string; actor: string; conversationId: string | null; supersedes: string | null };
export type JudgmentCheck = { id: string; taskId: string; at: string; timeZone: string; state: string; conversationId: string | null; taskStatus: string; reason: string | null; model: string; reasoningEffort: string };
export type JudgmentEvent = { id: string; kind: string; text: string; createdAt: string; conversationId: string | null };
export type JudgmentDetail = { judgment: Judgment; versions: JudgmentVersion[]; evidence: JudgmentEvidence[]; results: JudgmentResult[]; checks: JudgmentCheck[]; events: JudgmentEvent[]; availableConversations: string[] };
export type JudgmentStats = { scored: number; pending: number; withdrawn: number; indeterminate: number; firstBrier: number | null; lastBrier: number | null; synthetic: number };
export const judgmentStatusLabel: Record<JudgmentStatus,string> = { observing:'观察中', verification:'待核验', evidence:'待证据', feedback:'待我反馈', resolved:'已揭晓', indeterminate:'无法判定', withdrawn:'已撤回' };
export const judgmentOutcomeLabel: Record<JudgmentOutcome,string> = { yes:'成立', no:'不成立', indeterminate:'无法判定', maintain:'维持', revise:'修正', shelve:'搁置' };
