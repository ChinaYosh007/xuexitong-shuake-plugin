import {
  MAX_ANSWER_TEXT_LENGTH,
  MAX_CAVEATS,
  MAX_CAVEAT_LENGTH,
  MAX_EXPLANATION_LENGTH,
  MAX_ID_LENGTH,
  MAX_OPTIONS,
  MAX_PAGE_COMMAND_BYTES,
  MAX_BLANKS,
  utf8ByteLength
} from "./limits";
import type {
  CaptureContext,
  CandidateSummary,
  CapturedQuestion,
  CommandFailureCode,
  FillResult,
  PlanPreview,
  PreconditionCheck,
  ReviewedAnswer
} from "./types";
import type { LocalErrorCode } from "./codes";

/** Only these four page command types are allowed (architecture.md §7.6). No generic fetch/execute/call. */
export type PageCommand =
  | { type: "CAPTURE_SELECTION"; requestId: string }
  | { type: "CAPTURE_QUESTION"; requestId: string; containerIndex?: number }
  | {
      type: "REVALIDATE_FILL";
      requestId: string;
      planId: string;
      reviewedAnswer: ReviewedAnswer;
    }
  | { type: "APPLY_FILL"; requestId: string; planId: string; confirmationNonce: string };

export interface ExtensionCommandRequest {
  type: "PAGE_COMMAND";
  tabId: number;
  frameId?: number;
  command: PageCommand;
}

export interface CaptureCandidatesResponse {
  ok: true;
  kind: "CAPTURE_QUESTION";
  needsSelection: true;
  candidates: CandidateSummary[];
}

export interface CaptureQuestionResponse {
  ok: true;
  kind: "CAPTURE_QUESTION";
  needsSelection: false;
  captured: CapturedQuestion;
  candidates: CandidateSummary[];
}

export interface CaptureSelectionResponse {
  ok: true;
  kind: "CAPTURE_SELECTION";
  text: string;
  context: CaptureContext;
}

export interface RevalidateFillResponse {
  ok: true;
  kind: "REVALIDATE_FILL";
  plan: PlanPreview;
  checks: PreconditionCheck[];
}

export interface ApplyFillResponse {
  ok: true;
  kind: "APPLY_FILL";
  result: FillResult;
  checks: PreconditionCheck[];
}

export type PageSuccessResponse =
  | CaptureCandidatesResponse
  | CaptureQuestionResponse
  | CaptureSelectionResponse
  | RevalidateFillResponse
  | ApplyFillResponse;

export interface PageFailureResponse {
  ok: false;
  code: CommandFailureCode;
  detail: string;
  checks?: PreconditionCheck[];
}

export type PageResponse = PageSuccessResponse | PageFailureResponse;

export function isHostPermissionFailure(response: PageResponse): boolean {
  return !response.ok && response.code === "FRAME_ACCESS_DENIED" && response.detail.startsWith("permission: ");
}

const PAGE_COMMAND_TYPES = ["CAPTURE_SELECTION", "CAPTURE_QUESTION", "REVALIDATE_FILL", "APPLY_FILL"] as const;
export function isPageCommandMessage(input: unknown): boolean {
  return isRecord(input) && typeof input.type === "string" &&
    (PAGE_COMMAND_TYPES as readonly string[]).includes(input.type);
}
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const PLAN_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

type ParseOk<T> = { ok: true; value: T };
type ParseError = { ok: false; detail: string };
type ParseResult<T> = ParseOk<T> | ParseError;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max;
}

export function parseReviewedAnswer(input: unknown): ParseResult<ReviewedAnswer> {
  if (!isRecord(input)) {
    return { ok: false, detail: "reviewedAnswer must be an object" };
  }
  if (input.status !== "ANSWERED") {
    return { ok: false, detail: "reviewedAnswer.status must be ANSWERED" };
  }
  const selected = input.selectedOptionIds;
  if (!Array.isArray(selected) || selected.length > MAX_OPTIONS) {
    return { ok: false, detail: "selectedOptionIds must be an array within limits" };
  }
  const selectedIds: string[] = [];
  for (const item of selected) {
    if (!isBoundedString(item, 1, MAX_ID_LENGTH) || !ID_PATTERN.test(item)) {
      return { ok: false, detail: "selectedOptionIds contains an invalid id" };
    }
    if (selectedIds.includes(item)) {
      return { ok: false, detail: "selectedOptionIds contains duplicates" };
    }
    selectedIds.push(item);
  }

  const rawBlanks = input.blankAnswers;
  if (!Array.isArray(rawBlanks) || rawBlanks.length > MAX_BLANKS) {
    return { ok: false, detail: "blankAnswers must be an array within limits" };
  }
  const blankAnswers: Array<{ blankId: string; answer: string }> = [];
  for (const item of rawBlanks) {
    if (!isRecord(item)) {
      return { ok: false, detail: "blankAnswers item must be an object" };
    }
    if (!isBoundedString(item.blankId, 1, MAX_ID_LENGTH) || !ID_PATTERN.test(item.blankId)) {
      return { ok: false, detail: "blankAnswers contains an invalid blankId" };
    }
    if (!isBoundedString(item.answer, 1, MAX_ANSWER_TEXT_LENGTH)) {
      return { ok: false, detail: "blankAnswers contains an invalid answer" };
    }
    if (blankAnswers.some((existing) => existing.blankId === item.blankId)) {
      return { ok: false, detail: "blankAnswers contains duplicate blankId" };
    }
    blankAnswers.push({ blankId: item.blankId, answer: item.answer });
  }

  let textAnswer: string | null = null;
  if (input.textAnswer !== null && input.textAnswer !== undefined) {
    if (!isBoundedString(input.textAnswer, 1, MAX_ANSWER_TEXT_LENGTH)) {
      return { ok: false, detail: "textAnswer must be a bounded string or null" };
    }
    textAnswer = input.textAnswer;
  }

  if (!isBoundedString(input.explanation, 0, MAX_EXPLANATION_LENGTH)) {
    return { ok: false, detail: "explanation must be a bounded string" };
  }
  if (!Array.isArray(input.caveats) || input.caveats.length > MAX_CAVEATS) {
    return { ok: false, detail: "caveats must be an array within limits" };
  }
  const caveats: string[] = [];
  for (const caveat of input.caveats) {
    if (!isBoundedString(caveat, 0, MAX_CAVEAT_LENGTH)) {
      return { ok: false, detail: "caveats contains an invalid item" };
    }
    caveats.push(caveat);
  }

  const reviewedAt = input.reviewedAt;
  if (typeof reviewedAt !== "number" || !Number.isFinite(reviewedAt) || reviewedAt <= 0) {
    return { ok: false, detail: "reviewedAt must be a positive timestamp" };
  }

  return {
    ok: true,
    value: {
      status: "ANSWERED",
      selectedOptionIds: selectedIds,
      blankAnswers,
      textAnswer,
      explanation: input.explanation,
      caveats,
      reviewedAt
    }
  };
}

export function parsePageCommand(input: unknown): ParseResult<PageCommand> {
  if (!isRecord(input)) {
    return { ok: false, detail: "page command must be an object" };
  }
  if (utf8ByteLength(JSON.stringify(input)) > MAX_PAGE_COMMAND_BYTES) {
    return { ok: false, detail: "page command exceeds the byte limit" };
  }
  const type = input.type;
  if (!isPageCommandMessage(input)) {
    return { ok: false, detail: "unsupported page command type" };
  }
  const commandType = type as PageCommand["type"];
  if (!isBoundedString(input.requestId, 1, 64) || !ID_PATTERN.test(input.requestId)) {
    return { ok: false, detail: "invalid requestId" };
  }

  if (commandType === "CAPTURE_SELECTION") {
    return { ok: true, value: { type: commandType, requestId: input.requestId } };
  }

  if (commandType === "CAPTURE_QUESTION") {
    let containerIndex: number | undefined;
    if (input.containerIndex !== undefined) {
      if (
        typeof input.containerIndex !== "number" ||
        !Number.isInteger(input.containerIndex) ||
        input.containerIndex < 0 ||
        input.containerIndex > 99
      ) {
        return { ok: false, detail: "invalid containerIndex" };
      }
      containerIndex = input.containerIndex;
    }
    return containerIndex === undefined
      ? { ok: true, value: { type: commandType, requestId: input.requestId } }
      : { ok: true, value: { type: commandType, requestId: input.requestId, containerIndex } };
  }

  if (!isBoundedString(input.planId, 8, 64) || !PLAN_ID_PATTERN.test(input.planId)) {
    return { ok: false, detail: "invalid planId" };
  }

  if (commandType === "REVALIDATE_FILL") {
    const reviewed = parseReviewedAnswer(input.reviewedAnswer);
    if (!reviewed.ok) {
      return { ok: false, detail: reviewed.detail };
    }
    return {
      ok: true,
      value: { type: commandType, requestId: input.requestId, planId: input.planId, reviewedAnswer: reviewed.value }
    };
  }

  if (!isBoundedString(input.confirmationNonce, 16, 128) || !NONCE_PATTERN.test(input.confirmationNonce)) {
    return { ok: false, detail: "invalid confirmationNonce" };
  }
  return {
    ok: true,
    value: {
      type: commandType,
      requestId: input.requestId,
      planId: input.planId,
      confirmationNonce: input.confirmationNonce
    }
  };
}

export function parseExtensionCommandRequest(input: unknown): ParseResult<ExtensionCommandRequest> {
  if (!isRecord(input)) {
    return { ok: false, detail: "request must be an object" };
  }
  if (input.type !== "PAGE_COMMAND") {
    return { ok: false, detail: "unsupported request type" };
  }
  if (utf8ByteLength(JSON.stringify(input)) > MAX_PAGE_COMMAND_BYTES) {
    return { ok: false, detail: "request exceeds the byte limit" };
  }
  if (
    typeof input.tabId !== "number" ||
    !Number.isInteger(input.tabId) ||
    input.tabId < 1 ||
    input.tabId > 2_147_483_647
  ) {
    return { ok: false, detail: "invalid tabId" };
  }
  if (
    input.frameId !== undefined &&
    (typeof input.frameId !== "number" ||
      !Number.isInteger(input.frameId) ||
      input.frameId < 0 ||
      input.frameId > 99)
  ) {
    return { ok: false, detail: "invalid frameId" };
  }
  const command = parsePageCommand(input.command);
  if (!command.ok) {
    return { ok: false, detail: command.detail };
  }
  return {
    ok: true,
    value: {
      type: "PAGE_COMMAND",
      tabId: input.tabId,
      ...(input.frameId === undefined ? {} : { frameId: input.frameId }),
      command: command.value
    }
  };
}

/**
 * Trusted extension pages are exactly the side panel and the options page of this extension.
 * Background only accepts page commands from these surfaces, never from content scripts or web pages.
 */
export function isTrustedExtensionPageUrl(url: string | undefined, extensionId: string): boolean {
  if (!url || !extensionId) {
    return false;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "chrome-extension:" || parsed.host !== extensionId) {
      return false;
    }
    return parsed.pathname === "/sidepanel.html" || parsed.pathname === "/options.html";
  } catch {
    return false;
  }
}

export function asPageFailure(
  code: CommandFailureCode,
  detail: string,
  checks?: PreconditionCheck[]
): PageFailureResponse {
  const failure: PageFailureResponse = { ok: false, code, detail };
  if (checks) {
    failure.checks = checks;
  }
  return failure;
}

export function isLocalErrorCodeResponse(code: CommandFailureCode): code is LocalErrorCode {
  return code !== "INVALID_COMMAND" && code !== "TAB_UNAVAILABLE";
}
