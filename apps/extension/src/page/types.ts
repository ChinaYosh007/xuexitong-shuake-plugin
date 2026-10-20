import type { StudyQuestion } from "@study/contracts";
import type {
  CaptureContext,
  CapturedQuestion,
  CandidateSummary,
  ControlKind,
  FieldEvent,
  FillResult,
  PageKind,
  PlanPreview,
  PreconditionCheck,
  ReviewedAnswer
} from "../shared/types";
import type { LocalErrorCode } from "../shared/codes";
import type { ReviewedFieldValue } from "../adapters/control-writers";

export interface PageMatch {
  matched: boolean;
  pageKind: PageKind;
  evidence: string[];
}

export interface CaptureIdentity {
  tabId: number;
  frameId: number;
  documentId: string;
  documentNonce: string;
}

export interface PlanFieldInternal {
  fieldId: string;
  label: string;
  controlKind: ControlKind;
  value: ReviewedFieldValue;
  target: Element;
  optionId: string | null;
  blankId: string | null;
  originalValue: ReviewedFieldValue | null;
}

export interface FillPlanInternal {
  planId: string;
  adapterId: string;
  adapterVersion: string;
  context: CaptureContext;
  questionFingerprint: string;
  pageKind: PageKind;
  reviewedAnswer: ReviewedAnswer;
  reviewedAnswerDigest: string;
  planDigest: string;
  question: StudyQuestion;
  container: Element;
  containerIndex: number;
  /** Top-level document the content script runs in (iframe fixtures keep questions in a child document). */
  topDocument: Document;
  /** Document that actually owns the question container and controls. */
  document: Document;
  eventPolicy: "VERIFIED" | "UNVERIFIED";
  fields: PlanFieldInternal[];
  createdAt: number;
  consumed: boolean;
  blocked: boolean;
  blockCode: LocalErrorCode | null;
}

export type CaptureOutcome =
  | { ok: true; captured: CapturedQuestion }
  | { ok: false; code: LocalErrorCode; detail: string };

export type PlanBuildResult =
  | { ok: true; plan: FillPlanInternal }
  | { ok: false; code: LocalErrorCode; detail: string };

export interface RevalidationResult {
  ok: boolean;
  code: LocalErrorCode | null;
  checks: PreconditionCheck[];
}

/** Page adapter contract (architecture.md §8.1). Element references never leave the page world. */
export interface PageAdapter {
  id: string;
  version: string;
  match(document: Document): PageMatch;
  listCandidates(document: Document): CandidateSummary[];
  captureSelectedQuestion(
    document: Document,
    containerIndex: number,
    identity: CaptureIdentity,
    documentNonce: string
  ): CaptureOutcome;
  createFillPlan(
    captured: CapturedQuestion,
    reviewedAnswer: ReviewedAnswer,
    planId: string
  ): PlanBuildResult;
  toPlanPreview(plan: FillPlanInternal): PlanPreview;
  revalidate(
    plan: FillPlanInternal,
    identity: CaptureIdentity,
    confirmationAvailable: boolean
  ): RevalidationResult;
  apply(plan: FillPlanInternal): Promise<FillResult>;
}

export interface FieldResolution {
  ok: true;
  target: Element;
  controlKind: ControlKind;
  value: ReviewedFieldValue;
}

export interface FieldResolutionFailure {
  ok: false;
  code: LocalErrorCode;
  detail: string;
}

export type FieldResolutionResult = FieldResolution | FieldResolutionFailure;

export interface FixtureEventPolicy {
  verified: boolean;
  events: readonly FieldEvent[];
  evidence: string[];
}