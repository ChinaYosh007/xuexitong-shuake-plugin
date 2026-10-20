import { reactive } from "vue";
import type { SourceMode, StudyAnswer, StudyQuestion } from "@study/contracts";
import type {
  CandidateSummary,
  CapturedQuestion,
  FillResult,
  PlanPreview,
  PreconditionCheck,
  ReviewedAnswer
} from "../shared/types";
import type { LocalErrorCode } from "../shared/codes";
import { ERROR_GUIDANCE } from "../shared/codes";

export type FlowPhase =
  | "IDLE"
  | "CAPTURED"
  | "PREVIEWED"
  | "REQUESTING"
  | "ANSWER_READY"
  | "REVIEWED"
  | "REVALIDATING"
  | "FILLED"
  | "ERROR"
  | "STALE"
  | "BLOCKED";

export interface FlowFailure {
  code: string;
  title: string;
  hint: string;
  detail: string;
  checks: PreconditionCheck[];
}

export interface FlowState {
  phase: FlowPhase;
  question: StudyQuestion | null;
  questionRevision: number;
  capture: CapturedQuestion | null;
  sourceMode: SourceMode;
  candidates: CandidateSummary[];
  answer: StudyAnswer | null;
  reviewedAnswer: ReviewedAnswer | null;
  planPreview: PlanPreview | null;
  planId: string | null;
  questionRevisionAtPlan: number | null;
  fillResult: FillResult | null;
  failure: FlowFailure | null;
  notice: string | null;
  busy: boolean;
  configVersionAtSend: number | null;
}

const STALE_CODES = new Set<string>(["DOCUMENT_CHANGED", "QUESTION_CHANGED", "CONFIRMATION_EXPIRED"]);
const BLOCKED_CODES = new Set<string>([
  "ADAPTER_NOT_MATCHED",
  "PAGE_KIND_UNSUPPORTED",
  "FRAME_ACCESS_DENIED",
  "CONTROL_UNSUPPORTED",
  "UNTRUSTED_EVENT_REJECTED",
  "EVENT_SIDE_EFFECT_UNVERIFIED",
  "FIELD_READ_ONLY",
  "QUESTION_AMBIGUOUS"
]);

export function createFlowState(): FlowState {
  return reactive<FlowState>({
    phase: "IDLE",
    question: null,
    questionRevision: 0,
    capture: null,
    sourceMode: "PASTE",
    candidates: [],
    answer: null,
    reviewedAnswer: null,
    planPreview: null,
    planId: null,
    questionRevisionAtPlan: null,
    fillResult: null,
    failure: null,
    notice: null,
    busy: false,
    configVersionAtSend: null
  });
}

function cloneQuestion(question: StudyQuestion): StudyQuestion {
  return JSON.parse(JSON.stringify(question)) as StudyQuestion;
}

function clearDownstream(state: FlowState): void {
  state.answer = null;
  state.reviewedAnswer = null;
  state.planPreview = null;
  state.planId = null;
  state.questionRevisionAtPlan = null;
  state.fillResult = null;
  state.configVersionAtSend = null;
}

export function resetFlow(state: FlowState): void {
  state.phase = "IDLE";
  state.question = null;
  state.questionRevision = 0;
  state.capture = null;
  state.sourceMode = "PASTE";
  state.candidates = [];
  state.answer = null;
  state.reviewedAnswer = null;
  state.planPreview = null;
  state.planId = null;
  state.questionRevisionAtPlan = null;
  state.fillResult = null;
  state.failure = null;
  state.notice = null;
  state.busy = false;
  state.configVersionAtSend = null;
}

export function setCandidates(state: FlowState, candidates: CandidateSummary[]): void {
  state.candidates = candidates;
  state.phase = "IDLE";
  state.failure = null;
  state.notice = "页面有多个题目容器，请确认要读取的题目。";
}

export function applyCapture(state: FlowState, captured: CapturedQuestion): void {
  state.capture = captured;
  state.question = cloneQuestion(captured.question);
  state.questionRevision = 1;
  state.sourceMode = "ADAPTER";
  state.phase = "CAPTURED";
  clearDownstream(state);
  state.failure = null;
  state.notice = captured.fillEligible ? null : "本题可以发送给 AI 学习，但当前页面不满足回填条件。";
}

export function applySelectionText(state: FlowState, text: string): void {
  state.capture = null;
  state.question = {
    id: "q_manual",
    type: "UNKNOWN",
    stem: text,
    options: [],
    blanks: []
  };
  state.questionRevision = 1;
  state.sourceMode = "SELECTION";
  state.phase = "CAPTURED";
  clearDownstream(state);
  state.failure = null;
  state.notice = "已读取选中文本（辅助路径）；此来源不支持页面回填。";
}

export function startManualQuestion(state: FlowState): void {
  state.capture = null;
  state.question = { id: "q_manual", type: "UNKNOWN", stem: "", options: [], blanks: [] };
  state.questionRevision = 1;
  state.sourceMode = "PASTE";
  state.phase = "CAPTURED";
  clearDownstream(state);
  state.failure = null;
  state.notice = "手工输入为辅助路径；此来源不支持页面回填。";
}

export function updateQuestion(state: FlowState, next: StudyQuestion): void {
  state.question = next;
  state.questionRevision += 1;
  state.phase = "CAPTURED";
  clearDownstream(state);
  state.failure = null;
  state.notice = null;
}

export function markRequesting(state: FlowState): void {
  if (state.phase !== "CAPTURED" && state.phase !== "PREVIEWED") {
    throw new Error(`cannot request from phase ${state.phase}`);
  }
  state.phase = "REQUESTING";
  state.busy = true;
  state.failure = null;
}

export function applyAnswer(state: FlowState, answer: StudyAnswer, configVersion: number): void {
  state.answer = answer;
  state.configVersionAtSend = configVersion;
  state.phase = "ANSWER_READY";
  state.busy = false;
  state.reviewedAnswer = null;
  state.planPreview = null;
  state.planId = null;
  state.questionRevisionAtPlan = null;
  state.fillResult = null;
  state.failure = null;
}

export function editAnswer(state: FlowState, answer: StudyAnswer): void {
  if (!state.answer) {
    return;
  }
  state.answer = answer;
  state.phase = "ANSWER_READY";
  state.reviewedAnswer = null;
  state.planPreview = null;
  state.planId = null;
  state.questionRevisionAtPlan = null;
  state.fillResult = null;
  state.failure = null;
}

export function markReviewed(
  state: FlowState,
  reviewed: ReviewedAnswer,
  plan: PlanPreview | null
): void {
  state.reviewedAnswer = reviewed;
  state.planPreview = plan;
  state.planId = plan?.planId ?? null;
  state.questionRevisionAtPlan = plan ? state.questionRevision : null;
  state.phase = "REVIEWED";
  state.failure = null;
}

export function markRevalidating(state: FlowState): void {
  state.phase = "REVALIDATING";
  state.busy = true;
  state.failure = null;
}

export function setPlanPreview(state: FlowState, plan: PlanPreview): void {
  state.planPreview = plan;
  state.planId = plan.planId;
  state.questionRevisionAtPlan = state.questionRevision;
  state.phase = "REVIEWED";
  state.failure = null;
}

export function applyFillResult(state: FlowState, result: FillResult): void {
  state.fillResult = result;
  state.busy = false;
  if (result.status === "FILLED") {
    state.phase = "FILLED";
    state.failure = null;
    state.notice = "回填完成并已回读验证；未提交。";
    return;
  }
  state.phase = "ERROR";
  const guidance = result.code ? ERROR_GUIDANCE[result.code] : null;
  state.failure = {
    code: result.code ?? "PARTIAL_FILL",
    title: guidance?.title ?? "回填未完成",
    hint:
      result.status === "PARTIAL_FILL"
        ? `部分字段已写入（${result.writtenCount} 个尝试，${result.persistedCount} 个通过回读），已停止，不会重试或提交。`
        : (guidance?.hint ?? "回填失败，未提交。"),
    detail: guidance?.hint ?? "",
    checks: []
  };
}

export function markBusy(state: FlowState, busy: boolean): void {
  state.busy = busy;
}

export function phaseForCode(code: string): FlowPhase {
  if (STALE_CODES.has(code)) {
    return "STALE";
  }
  if (BLOCKED_CODES.has(code)) {
    return "BLOCKED";
  }
  return "ERROR";
}

export function failureFor(code: string, detail: string, checks: PreconditionCheck[] = []): FlowFailure {
  if (code in ERROR_GUIDANCE) {
    const guidance = ERROR_GUIDANCE[code as LocalErrorCode];
    return { code, title: guidance.title, hint: guidance.hint, detail, checks };
  }
  return {
    code,
    title: "请求失败",
    hint: "请检查后端配置、登录状态与网络；扩展不会自动重试可能计费的请求。",
    detail,
    checks
  };
}

export function setFailure(
  state: FlowState,
  code: string,
  detail: string,
  checks: PreconditionCheck[] = []
): void {
  state.phase = phaseForCode(code);
  state.failure = failureFor(code, detail, checks);
  state.busy = false;
}

export function clearFailure(state: FlowState): void {
  state.failure = null;
}

export function setNotice(state: FlowState, notice: string | null): void {
  state.notice = notice;
}

export function buildReviewedAnswer(answer: StudyAnswer): ReviewedAnswer | null {
  if (answer.status !== "ANSWERED") {
    return null;
  }
  return {
    status: "ANSWERED",
    selectedOptionIds: [...answer.selectedOptionIds],
    blankAnswers: answer.blankAnswers.map((item) => ({ ...item })),
    textAnswer: answer.textAnswer,
    explanation: answer.explanation,
    caveats: [...answer.caveats],
    reviewedAt: Date.now()
  };
}

export function canSend(state: FlowState): boolean {
  if (state.question === null) {
    return false;
  }
  if (state.question.stem.trim().length === 0) {
    return false;
  }
  if (state.phase !== "CAPTURED" && state.phase !== "PREVIEWED") {
    return false;
  }
  return !state.busy;
}

export function canReview(state: FlowState): boolean {
  return state.phase === "ANSWER_READY" && state.answer !== null && !state.busy;
}

export function canApprove(state: FlowState): boolean {
  return (
    state.phase === "REVIEWED" &&
    state.planPreview !== null &&
    !state.planPreview.blocked &&
    state.reviewedAnswer !== null &&
    !state.busy
  );
}
