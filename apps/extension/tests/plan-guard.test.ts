import { describe, expect, it } from "vitest";
import { buildPlannedFields, planReviewDigest } from "../src/review/plan";
import { computeQuestionFingerprint } from "../src/capture/context";
import { ConfirmationGuard, digestReviewedAnswer, evaluatePreconditions } from "../src/review/guard";
import type { CaptureContext, PlanPreview } from "../src/shared/types";
import { reviewedAnswer, sampleQuestion } from "./helpers/fixtures";

describe("fill plan builder", () => {
  it("builds one radio field for single choice", () => {
    const result = buildPlannedFields(sampleQuestion(), reviewedAnswer({ selectedOptionIds: ["opt_1"] }));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.fields).toHaveLength(1);
    expect(result.fields[0]?.controlKind).toBe("RADIO");
    expect(result.fields[0]?.value).toEqual({ kind: "RADIO", optionId: "opt_1" });
  });

  it("builds explicit checked and unchecked checkbox fields", () => {
    const question = sampleQuestion({
      type: "MULTIPLE_CHOICE",
      options: [
        { id: "opt_1", text: "2" },
        { id: "opt_2", text: "3" },
        { id: "opt_3", text: "4" }
      ]
    });
    const result = buildPlannedFields(question, reviewedAnswer({ selectedOptionIds: ["opt_1", "opt_3"] }));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.fields).toHaveLength(3);
    expect(result.fields.find((field) => field.optionId === "opt_1")?.value).toEqual({
      kind: "CHECKBOX",
      optionId: "opt_1",
      checked: true
    });
    expect(result.fields.find((field) => field.optionId === "opt_2")?.value).toEqual({
      kind: "CHECKBOX",
      optionId: "opt_2",
      checked: false
    });
  });

  it("requires exactly one answer per blank and a non-empty short answer", () => {
    const fill = sampleQuestion({
      type: "FILL_BLANK",
      options: [],
      blanks: [
        { id: "blank_1", label: "第一空" },
        { id: "blank_2", label: "第二空" }
      ]
    });
    const missing = buildPlannedFields(fill, reviewedAnswer({ blankAnswers: [{ blankId: "blank_1", answer: "2" }] }));
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.code).toBe("QUESTION_AMBIGUOUS");
    }
    const complete = buildPlannedFields(
      fill,
      reviewedAnswer({
        blankAnswers: [
          { blankId: "blank_1", answer: "2" },
          { blankId: "blank_2", answer: "4" }
        ]
      })
    );
    expect(complete.ok).toBe(true);

    const short = sampleQuestion({ type: "SHORT_ANSWER", options: [], blanks: [{ id: "blank_1", label: "简答" }] });
    expect(buildPlannedFields(short, reviewedAnswer({ textAnswer: null })).ok).toBe(false);
    expect(buildPlannedFields(short, reviewedAnswer({ textAnswer: "我的理解" })).ok).toBe(true);
  });

  it("rejects unknown question types and unknown option ids", () => {
    const unknown = buildPlannedFields(sampleQuestion({ type: "UNKNOWN" }), reviewedAnswer());
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.code).toBe("CONTROL_UNSUPPORTED");
    }
    const invalid = buildPlannedFields(sampleQuestion(), reviewedAnswer({ selectedOptionIds: ["opt_missing"] }));
    expect(invalid.ok).toBe(false);
  });

  it("computes a stable review digest", () => {
    const question = sampleQuestion();
    const answer = reviewedAnswer({ selectedOptionIds: ["opt_1"] });
    expect(planReviewDigest(question, answer)).toBe(planReviewDigest(question, answer));
    expect(planReviewDigest(question, answer)).toBe(
      digestReviewedAnswer(computeQuestionFingerprint(question), answer)
    );
  });
});

describe("single-use confirmation guard", () => {
  it("allows exactly one consumption and rejects replay", () => {
    const guard = new ConfirmationGuard();
    const issued = guard.issue("plan_12345678", "nonce_abcdef0123456789", 1000, 5000);
    expect(issued.ok).toBe(true);
    expect(guard.consume("plan_12345678", "nonce_abcdef0123456789", 1200).ok).toBe(true);
    const replay = guard.consume("plan_12345678", "nonce_abcdef0123456789", 1300);
    expect(replay.ok).toBe(false);
    if (!replay.ok) {
      expect(replay.code).toBe("CONFIRMATION_EXPIRED");
    }
  });

  it("rejects expired or mismatched confirmations", () => {
    const guard = new ConfirmationGuard();
    guard.issue("plan_12345678", "nonce_abcdef0123456789", 1000, 1000);
    const expired = guard.consume("plan_12345678", "nonce_abcdef0123456789", 3000);
    expect(expired.ok).toBe(false);
    guard.issue("plan_abcdefgh", "nonce_ffffffffffffffff", 3000, 5000);
    expect(guard.consume("plan_abcdefgh", "nonce_eeeeeeeeeeeeeeee", 3100).ok).toBe(false);
  });
});

describe("nine local preconditions", () => {
  const context: CaptureContext = {
    tabId: 1,
    frameId: 0,
    documentId: "doc-1",
    documentNonce: "nonce-1",
    adapterId: "fixture.practice",
    adapterVersion: "1.0.0",
    questionFingerprint: "fp-1",
    capturedAt: 1000
  };
  const capture = { context, fillEligible: true, pageKind: "PRACTICE" as const };
  const reviewed = reviewedAnswer({ selectedOptionIds: ["opt_1"] });
  const preview: PlanPreview = {
    planId: "plan_12345678",
    adapterId: "fixture.practice",
    adapterVersion: "1.0.0",
    pageKind: "PRACTICE",
    questionFingerprint: "fp-1",
    context,
    createdAt: 1000,
    fields: [
      {
        fieldId: "option:opt_1",
        label: "选项：2",
        controlKind: "RADIO",
        valueText: "2",
        currentText: "(空)",
        ready: true,
        code: null
      }
    ],
    blocked: false,
    blockCode: null,
    eventPolicy: "VERIFIED",
    reviewedAnswerDigest: digestReviewedAnswer("fp-1", reviewed)
  };

  it("passes when all nine preconditions hold", () => {
    const result = evaluatePreconditions({
      capture,
      planPreview: preview,
      reviewedAnswer: reviewed,
      currentTabId: 1,
      questionRevision: 3,
      questionRevisionAtPlan: 3,
      configVersionAtSend: 4,
      currentConfigVersion: 4,
      confirmationValid: true,
      planConsumed: false
    });
    expect(result.ok).toBe(true);
    expect(result.checks).toHaveLength(9);
    expect(result.checks.every((item) => item.ok)).toBe(true);
  });

  it("fails with precise codes when document, question or confirmation change", () => {
    const documentChanged = evaluatePreconditions({
      capture,
      planPreview: preview,
      reviewedAnswer: reviewed,
      currentTabId: 2,
      questionRevision: 3,
      questionRevisionAtPlan: 3,
      configVersionAtSend: 4,
      currentConfigVersion: 4,
      confirmationValid: true,
      planConsumed: false
    });
    expect(documentChanged.ok).toBe(false);
    expect(documentChanged.code).toBe("DOCUMENT_CHANGED");

    const questionChanged = evaluatePreconditions({
      capture,
      planPreview: preview,
      reviewedAnswer: reviewed,
      currentTabId: 1,
      questionRevision: 4,
      questionRevisionAtPlan: 3,
      configVersionAtSend: 4,
      currentConfigVersion: 4,
      confirmationValid: true,
      planConsumed: false
    });
    expect(questionChanged.code).toBe("QUESTION_CHANGED");

    const expired = evaluatePreconditions({
      capture,
      planPreview: preview,
      reviewedAnswer: reviewed,
      currentTabId: 1,
      questionRevision: 3,
      questionRevisionAtPlan: 3,
      configVersionAtSend: 4,
      currentConfigVersion: 4,
      confirmationValid: false,
      planConsumed: false
    });
    expect(expired.code).toBe("CONFIRMATION_EXPIRED");

    const graded = evaluatePreconditions({
      capture,
      planPreview: { ...preview, pageKind: "GRADED", blocked: true },
      reviewedAnswer: reviewed,
      currentTabId: 1,
      questionRevision: 3,
      questionRevisionAtPlan: 3,
      configVersionAtSend: 4,
      currentConfigVersion: 4,
      confirmationValid: true,
      planConsumed: false
    });
    expect(graded.code).toBe("PAGE_KIND_UNSUPPORTED");
  });
});