import { CONFIRMATION_TTL_MS } from "../shared/limits";
import type { LocalErrorCode } from "../shared/codes";
import type {
  CaptureContext,
  PlanPreview,
  PreconditionCheck,
  ReviewedAnswer
} from "../shared/types";
import { sha256Hex } from "../shared/sha256";

export interface Confirmation {
  planId: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
}

export type GuardResult<T> = { ok: true; value: T } | { ok: false; code: LocalErrorCode; detail: string };

/**
 * Single-use confirmation nonce store. The nonce is created only when the user clicks
 * "审核并回填本题" and is consumed exactly once; it never leaves the extension.
 */
export class ConfirmationGuard {
  private readonly active = new Map<string, Confirmation>();
  private readonly consumed = new Set<string>();

  issue(planId: string, nonce: string, now = Date.now(), ttlMs = CONFIRMATION_TTL_MS): GuardResult<Confirmation> {
    if (!planId || !nonce) {
      return { ok: false, code: "CONFIRMATION_EXPIRED", detail: "planId or nonce is empty" };
    }
    const previous = this.active.get(planId);
    if (previous) {
      this.consumed.add(previous.nonce);
    }
    const confirmation: Confirmation = { planId, nonce, issuedAt: now, expiresAt: now + ttlMs };
    this.active.set(planId, confirmation);
    return { ok: true, value: confirmation };
  }

  peek(planId: string): Confirmation | null {
    return this.active.get(planId) ?? null;
  }

  consume(planId: string, nonce: string, now = Date.now()): GuardResult<true> {
    if (this.consumed.has(nonce)) {
      return { ok: false, code: "CONFIRMATION_EXPIRED", detail: "confirmation nonce was already used" };
    }
    const confirmation = this.active.get(planId);
    if (!confirmation || confirmation.nonce !== nonce) {
      return { ok: false, code: "CONFIRMATION_EXPIRED", detail: "confirmation nonce does not match this plan" };
    }
    if (now >= confirmation.expiresAt) {
      this.active.delete(planId);
      this.consumed.add(nonce);
      return { ok: false, code: "CONFIRMATION_EXPIRED", detail: "confirmation nonce expired" };
    }
    this.active.delete(planId);
    this.consumed.add(nonce);
    return { ok: true, value: true };
  }

  invalidate(planId: string): void {
    const confirmation = this.active.get(planId);
    if (confirmation) {
      this.consumed.add(confirmation.nonce);
      this.active.delete(planId);
    }
  }

  clear(): void {
    this.active.clear();
    this.consumed.clear();
  }
}

export interface PreconditionInput {
  capture: CapturedQuestionLike | null;
  planPreview: PlanPreview | null;
  reviewedAnswer: ReviewedAnswer | null;
  currentTabId: number | null;
  questionRevision: number;
  questionRevisionAtPlan: number | null;
  configVersionAtSend: number | null;
  currentConfigVersion: number | null;
  confirmationValid: boolean;
  planConsumed: boolean;
}

export interface CapturedQuestionLike {
  context: CaptureContext;
  fillEligible: boolean;
  pageKind: "PRACTICE" | "GRADED" | "UNKNOWN";
}

export interface PreconditionResult {
  ok: boolean;
  code: LocalErrorCode | null;
  checks: PreconditionCheck[];
}

function check(
  id: string,
  label: string,
  ok: boolean,
  code: LocalErrorCode,
  detail: string
): PreconditionCheck {
  return { id, label, ok, code: ok ? null : code, detail };
}

/**
 * Nine local preconditions before any page write (architecture.md §8.3 steps 6-12,
 * adaptation spec §5). The page adapter re-checks document identity, fingerprint and controls
 * against the live DOM; these checks guard the side-panel side plan and confirmation state.
 */
export function evaluatePreconditions(input: PreconditionInput): PreconditionResult {
  const preview = input.planPreview;
  const capture = input.capture;
  const checks: PreconditionCheck[] = [
    check(
      "PAGE_KIND_PRACTICE",
      "页面类型为受支持练习",
      preview !== null && !preview.blocked && preview.pageKind === "PRACTICE",
      "PAGE_KIND_UNSUPPORTED",
      preview ? `pageKind=${preview.pageKind}, blocked=${String(preview.blocked)}` : "缺少回填预览"
    ),
    check(
      "ADAPTER_MATCH",
      "适配器 ID 与版本一致",
      preview !== null && capture !== null && preview.adapterId === capture.context.adapterId &&
        preview.adapterVersion === capture.context.adapterVersion,
      "ADAPTER_NOT_MATCHED",
      "适配器与采集时的版本不一致"
    ),
    check(
      "DOCUMENT_IDENTITY",
      "tab、框架与文档标识一致",
      preview !== null &&
        capture !== null &&
        input.currentTabId !== null &&
        preview.context.tabId === input.currentTabId &&
        preview.context.tabId === capture.context.tabId &&
        preview.context.frameId === capture.context.frameId &&
        preview.context.documentId === capture.context.documentId &&
        preview.context.documentNonce === capture.context.documentNonce,
      "DOCUMENT_CHANGED",
      "标签页、框架或文档已变化"
    ),
    check(
      "QUESTION_FINGERPRINT",
      "题目指纹与编辑版本一致",
      preview !== null &&
        capture !== null &&
        preview.questionFingerprint === capture.context.questionFingerprint &&
        input.questionRevisionAtPlan !== null &&
        input.questionRevision === input.questionRevisionAtPlan,
      "QUESTION_CHANGED",
      "题目或选项在预览后被修改"
    ),
    check(
      "REVIEWED_ANSWER_CONSISTENT",
      "审核答案与回填计划一致",
      preview !== null &&
        input.reviewedAnswer !== null &&
        preview.reviewedAnswerDigest === digestReviewedAnswer(preview.questionFingerprint, input.reviewedAnswer),
      "QUESTION_CHANGED",
      "审核答案与当前回填计划不一致"
    ),
    check(
      "FIELDS_READY",
      "目标字段唯一、可见、启用且可编辑",
      preview !== null && preview.fields.length > 0 && preview.fields.every((field) => field.ready),
      "FIELD_READ_ONLY",
      "存在未就绪字段"
    ),
    check(
      "EVENT_POLICY_VERIFIED",
      "事件副作用已验证",
      preview !== null && preview.eventPolicy === "VERIFIED",
      "EVENT_SIDE_EFFECT_UNVERIFIED",
      "适配器未确认 input/change 事件无副作用"
    ),
    check(
      "CONFIG_VERSION",
      "发送与审核时配置版本一致",
      input.configVersionAtSend !== null &&
        input.currentConfigVersion !== null &&
        input.configVersionAtSend === input.currentConfigVersion,
      "QUESTION_CHANGED",
      "API 配置在生成后发生变化"
    ),
    check(
      "CONFIRMATION_VALID",
      "单次确认有效且未消费",
      input.confirmationValid && !input.planConsumed,
      "CONFIRMATION_EXPIRED",
      "确认已过期、已使用或计划已消费"
    )
  ];

  const failed = checks.find((item) => !item.ok);
  return {
    ok: failed === undefined,
    code: failed?.code ?? null,
    checks
  };
}

export function digestReviewedAnswer(questionFingerprint: string, answer: ReviewedAnswer): string {
  const canonical = JSON.stringify({
    questionFingerprint,
    selectedOptionIds: [...answer.selectedOptionIds].sort(),
    blankAnswers: [...answer.blankAnswers]
      .sort((left, right) => left.blankId.localeCompare(right.blankId)),
    textAnswer: answer.textAnswer,
    status: answer.status
  });
  return sha256Hex(canonical);
}
