import type {
  CaptureOutcome,
  CaptureIdentity,
  PageAdapter,
  PageMatch,
  PlanBuildResult,
  RevalidationResult
} from "./types";
import type {
  CandidateSummary,
  CapturedQuestion,
  FillResult,
  PlanPreview,
  ReviewedAnswer
} from "../shared/types";

/**
 * Xuexitong assessment detector (identification only).
 *
 * Scope and guarantees:
 * - Runs only on chaoxing.com hosts.
 * - Reads short leaf text nodes locally to look for assessment / scoring cues; nothing
 *   is stored, transmitted or written back. No question text is captured.
 * - Never returns a capturable question and never builds a fill plan, so graded pages
 *   are refused with PAGE_KIND_UNSUPPORTED before any write can happen.
 * - Same-origin child frames are inspected up to depth 2; cross-origin frames stay
 *   unreadable and are never granted extra permissions.
 *
 * Evidence for this adapter (2026-10-19, user-provided page, no question text):
 *   host mooc1.chaoxing.com, visible markers "本章在线测验", "Total score: 100.0",
 *   "Number of questions: 37", "任务点". Recorded in docs/compatibility.md.
 */
const ASSESSMENT_CUES: readonly RegExp[] = [
  /本章在线测验/,
  /章节测验/,
  /在线测验/,
  /课程测验/,
  /随堂测验/,
  /Chapter\s+Quiz/i,
  /\bquiz\b/i,
  /\bexam\b/i,
  /考试/,
  /作业/
];

const SCORING_CUES: readonly RegExp[] = [
  /Total\s+score/i,
  /总分/,
  /满分/,
  /成绩/,
  /Number\s+of\s+questions/i,
  /题目数/,
  /共\s*\d+\s*题/,
  /\d+\s*questions/i,
  /单选题/,
  /多选题/,
  /判断题/
];

const MAX_LEAF_TEXT = 160;
const MAX_LEAF_NODES = 6000;
const MAX_FRAME_DEPTH = 2;

function hostOf(document: Document): string {
  return (document.defaultView?.location?.hostname ?? "").toLowerCase();
}

function collectTexts(document: Document, depth = 0, out: string[] = []): string[] {
  if (out.length >= MAX_LEAF_NODES) {
    return out;
  }
  const visit = (element: Element): void => {
    if (out.length >= MAX_LEAF_NODES) {
      return;
    }
    if (element.children.length === 0) {
      const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();
      if (text && text.length <= MAX_LEAF_TEXT) {
        out.push(text);
      }
      return;
    }
    for (const child of Array.from(element.children)) {
      visit(child);
      if (out.length >= MAX_LEAF_NODES) {
        return;
      }
    }
  };
  if (document.body) {
    visit(document.body);
  }
  if (depth < MAX_FRAME_DEPTH) {
    for (const frame of Array.from(document.querySelectorAll("iframe, frame"))) {
      try {
        const child = (frame as HTMLIFrameElement).contentDocument;
        if (child) {
          collectTexts(child, depth + 1, out);
        }
      } catch {
        // Cross-origin frames are intentionally unreadable; no permission is expanded.
      }
    }
  }
  return out;
}

function matchesAny(values: readonly string[], cues: readonly RegExp[]): boolean {
  return values.some((value) => cues.some((cue) => cue.test(value)));
}

function previewOf(plan: {
  planId: string;
  adapterId: string;
  adapterVersion: string;
  pageKind: "PRACTICE" | "GRADED" | "UNKNOWN";
  questionFingerprint: string;
  context: CapturedQuestion["context"];
  createdAt: number;
  blocked: boolean;
  blockCode: string | null;
}, reviewed: ReviewedAnswer): PlanPreview {
  return {
    planId: plan.planId,
    adapterId: plan.adapterId,
    adapterVersion: plan.adapterVersion,
    pageKind: plan.pageKind,
    questionFingerprint: plan.questionFingerprint,
    context: plan.context,
    createdAt: plan.createdAt,
    fields: [],
    blocked: true,
    blockCode: plan.blockCode as PlanPreview["blockCode"],
    eventPolicy: "UNVERIFIED",
    reviewedAnswerDigest: String(reviewed.reviewedAt)
  };
}

export const xuexitongGradedAdapter: PageAdapter = {
  id: "xuexitong.graded",
  version: "1.0.0",

  match(document: Document): PageMatch {
    const host = hostOf(document);
    // Require a real chaoxing.com host: `endsWith("chaoxing.com")` would also accept
    // look-alike hosts such as "fakechaoxing.com".
    if (host !== "chaoxing.com" && !host.endsWith(".chaoxing.com")) {
      return { matched: false, pageKind: "UNKNOWN", evidence: [] };
    }
    const texts = collectTexts(document);
    const assessment = matchesAny(texts, ASSESSMENT_CUES);
    const scoring = matchesAny(texts, SCORING_CUES);
    const evidence = [`host:${host}`];
    if (assessment) {
      evidence.push("cue:assessment");
    }
    if (scoring) {
      evidence.push("cue:scoring");
    }
    if (assessment && scoring) {
      return { matched: true, pageKind: "GRADED", evidence };
    }
    return { matched: false, pageKind: "UNKNOWN", evidence };
  },

  listCandidates(): CandidateSummary[] {
    return [];
  },

  captureSelectedQuestion(
    _document: Document,
    _containerIndex: number,
    _identity: CaptureIdentity,
    _documentNonce: string
  ): CaptureOutcome {
    return { ok: false, code: "PAGE_KIND_UNSUPPORTED", detail: "计分/测验页面不提供题目采集与自动答题。" };
  },

  createFillPlan(_captured: CapturedQuestion, _reviewedAnswer: ReviewedAnswer, _planId: string): PlanBuildResult {
    return { ok: false, code: "PAGE_KIND_UNSUPPORTED", detail: "计分/测验页面不提供回填。" };
  },

  toPlanPreview(plan): PlanPreview {
    return previewOf(plan, plan.reviewedAnswer);
  },

  revalidate(): RevalidationResult {
    return { ok: false, code: "PAGE_KIND_UNSUPPORTED", checks: [] };
  },

  async apply(): Promise<FillResult> {
    return {
      status: "FAILED",
      code: "PAGE_KIND_UNSUPPORTED",
      writtenCount: 0,
      persistedCount: 0,
      totalCount: 0,
      fields: [],
      verifiedAt: Date.now(),
      boundedCheckMs: 0
    };
  }
};
