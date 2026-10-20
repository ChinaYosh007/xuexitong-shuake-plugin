import type { StudyQuestion } from "@study/contracts";
import type { LocalErrorCode } from "./codes";

export type PageKind = "PRACTICE" | "GRADED" | "UNKNOWN";

export type ControlKind =
  | "TEXT_INPUT"
  | "TEXTAREA"
  | "RADIO"
  | "CHECKBOX"
  | "SELECT"
  | "CONTENTEDITABLE";

export type FieldEvent = "input" | "change";

/**
 * Local fill context (architecture.md §8.2). Never uploaded to the backend.
 * tabId/frameId identify where the adapter captured the question; documentId/documentNonce
 * bind the plan to one live document and one capture.
 */
export interface CaptureContext {
  tabId: number;
  frameId: number;
  documentId: string;
  documentNonce: string;
  adapterId: string;
  adapterVersion: string;
  questionFingerprint: string;
  capturedAt: number;
}

export interface QuestionFingerprintInput {
  type: StudyQuestion["type"];
  stem: string;
  options: Array<{ id: string; text: string }>;
  blanks: Array<{ id: string; label: string }>;
}

export interface CandidateSummary {
  index: number;
  questionType: StudyQuestion["type"];
  stemPreview: string;
  optionCount: number;
  blankCount: number;
  unknownEditor: boolean;
}

export interface CapturedQuestion {
  question: StudyQuestion;
  context: CaptureContext;
  pageKind: PageKind;
  evidence: string[];
  fillEligible: boolean;
  fillBlockCode: LocalErrorCode | null;
  warnings: string[];
}

export interface ReviewedAnswer {
  status: "ANSWERED";
  selectedOptionIds: string[];
  blankAnswers: Array<{ blankId: string; answer: string }>;
  textAnswer: string | null;
  explanation: string;
  caveats: string[];
  reviewedAt: number;
}

export interface PlanFieldPreview {
  fieldId: string;
  label: string;
  controlKind: ControlKind;
  valueText: string;
  currentText: string;
  ready: boolean;
  code: LocalErrorCode | null;
}

export interface PlanPreview {
  planId: string;
  adapterId: string;
  adapterVersion: string;
  pageKind: PageKind;
  questionFingerprint: string;
  context: CaptureContext;
  createdAt: number;
  fields: PlanFieldPreview[];
  blocked: boolean;
  blockCode: LocalErrorCode | null;
  eventPolicy: "VERIFIED" | "UNVERIFIED";
  reviewedAnswerDigest: string;
}

export interface PreconditionCheck {
  id: string;
  label: string;
  ok: boolean;
  code: LocalErrorCode | null;
  detail: string;
}

export interface FillFieldResult {
  fieldId: string;
  label: string;
  status: "WRITTEN" | "REVERTED" | "NOT_ACCEPTED" | "SKIPPED" | "FAILED";
  errorCode: LocalErrorCode | null;
  expectedText: string;
  readBackText: string;
}

/** Result of a direct control-write fill attempt. Only reflects the bounded verification window. */
export interface FillResult {
  status: "FILLED" | "PARTIAL_FILL" | "FAILED";
  code: LocalErrorCode | null;
  writtenCount: number;
  persistedCount: number;
  totalCount: number;
  fields: FillFieldResult[];
  verifiedAt: number;
  boundedCheckMs: number;
}

export type CommandFailureCode = LocalErrorCode | "INVALID_COMMAND" | "TAB_UNAVAILABLE";