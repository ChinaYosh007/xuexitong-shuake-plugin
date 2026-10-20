import { describe, expect, it } from "vitest";
import type { CapturedQuestion } from "../src/shared/types";
import {
  applyAnswer,
  applyCapture,
  applyFillResult,
  buildReviewedAnswer,
  canApprove,
  canReview,
  canSend,
  createFlowState,
  editAnswer,
  markReviewed,
  resetFlow,
  setPlanPreview,
  updateQuestion
} from "../src/sidepanel/flow";
import { reviewedAnswer, sampleQuestion } from "./helpers/fixtures";

function captured(question = sampleQuestion()): CapturedQuestion {
  return {
    question,
    context: {
      tabId: 1,
      frameId: 0,
      documentId: "doc-1",
      documentNonce: "nonce-1",
      adapterId: "fixture.practice",
      adapterVersion: "1.0.0",
      questionFingerprint: "fp-1",
      capturedAt: 1
    },
    pageKind: "PRACTICE",
    evidence: ["fixture:practice"],
    fillEligible: true,
    fillBlockCode: null,
    warnings: []
  };
}

const answer = {
  status: "ANSWERED" as const,
  selectedOptionIds: ["opt_1"],
  blankAnswers: [],
  textAnswer: null,
  explanation: "解析",
  caveats: []
};

describe("side panel state machine", () => {
  it("moves IDLE -> CAPTURED -> ANSWER_READY and invalidates on edits", () => {
    const flow = createFlowState();
    expect(flow.phase).toBe("IDLE");
    applyCapture(flow, captured());
    expect(flow.phase).toBe("CAPTURED");
    expect(canSend(flow)).toBe(true);
    expect(canReview(flow)).toBe(false);

    applyAnswer(flow, answer, 2);
    expect(flow.phase).toBe("ANSWER_READY");
    expect(canReview(flow)).toBe(true);

    const edited = { ...answer, selectedOptionIds: ["opt_2"] };
    editAnswer(flow, edited);
    expect(flow.phase).toBe("ANSWER_READY");

    markReviewed(flow, reviewedAnswer({ selectedOptionIds: ["opt_2"] }), null);
    expect(flow.phase).toBe("REVIEWED");
    expect(canApprove(flow)).toBe(false);

    updateQuestion(flow, sampleQuestion({ stem: "修改后的题干" }));
    expect(flow.phase).toBe("CAPTURED");
    expect(flow.answer).toBeNull();
    expect(flow.reviewedAnswer).toBeNull();
    expect(flow.planPreview).toBeNull();
    expect(flow.questionRevision).toBe(2);
  });

  it("requires a reviewed answer before the approval button is enabled", () => {
    const flow = createFlowState();
    applyCapture(flow, captured());
    applyAnswer(flow, answer, 2);
    const reviewed = buildReviewedAnswer(answer);
    expect(reviewed).not.toBeNull();
    if (!reviewed) {
      return;
    }
    markReviewed(flow, reviewed, null);
    expect(canApprove(flow)).toBe(false);
  });

  it("reports partial fill as an error with the written counts", () => {
    const flow = createFlowState();
    applyCapture(flow, captured());
    applyFillResult(flow, {
      status: "PARTIAL_FILL",
      code: "VALUE_REVERTED",
      writtenCount: 2,
      persistedCount: 1,
      totalCount: 2,
      fields: [],
      verifiedAt: 1,
      boundedCheckMs: 20
    });
    expect(flow.phase).toBe("ERROR");
    expect(flow.failure?.code).toBe("VALUE_REVERTED");
    expect(flow.failure?.hint).toContain("部分字段已写入");
  });

  it("resets all question and answer state", () => {
    const flow = createFlowState();
    applyCapture(flow, captured());
    applyAnswer(flow, answer, 2);
    resetFlow(flow);
    expect(flow.phase).toBe("IDLE");
    expect(flow.question).toBeNull();
    expect(flow.answer).toBeNull();
    expect(flow.capture).toBeNull();
  });
});
