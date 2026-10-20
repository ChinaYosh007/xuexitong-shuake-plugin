import { describe, expect, it } from "vitest";
// @ts-expect-error jsdom ships no bundled type declarations in this workspace
import { JSDOM as JSDOMImport } from "jsdom";

import { xuexitongGradedAdapter } from "../src/page/xuexitong-graded";

const JSDOM = JSDOMImport as unknown as new (html: string, options: { url: string }) => { window: { document: Document } };

const GRADED_HTML = `<!doctype html><html><head><title>Chapter Quiz</title></head><body>
  <div class="chapter-head"><h2>本章在线测验</h2></div>
  <div class="score-box"><span>Total score: 100.0</span></div>
  <div class="count-box"><span>Number of questions: 37</span></div>
  <div class="section-title"><span>一、单选题（23 questions）</span></div>
</body></html>`;

const PRACTICE_HTML = `<!doctype html><html><body>
  <h2>练习题</h2>
  <p>1 + 1 等于多少？</p>
  <label><input type="radio" name="q" value="a" /> 2</label>
  <label><input type="radio" name="q" value="b" /> 3</label>
</body></html>`;

function documentAt(url: string, html: string): Document {
  return new JSDOM(html, { url }).window.document;
}

describe("xuexitong graded detector", () => {
  it("flags an assessment page on a chaoxing host as GRADED with cue evidence", () => {
    const doc = documentAt("https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=1", GRADED_HTML);
    const match = xuexitongGradedAdapter.match(doc);
    expect(match.matched).toBe(true);
    expect(match.pageKind).toBe("GRADED");
    expect(match.evidence).toContain("cue:assessment");
    expect(match.evidence).toContain("cue:scoring");
    expect(match.evidence.some((item) => item.startsWith("host:mooc1.chaoxing.com"))).toBe(true);
  });

  it("never matches outside chaoxing hosts even when the same words are present", () => {
    const match = xuexitongGradedAdapter.match(
      documentAt("https://example.com/course", GRADED_HTML)
    );
    expect(match.matched).toBe(false);
    expect(match.pageKind).toBe("UNKNOWN");
  });

  it("stays UNKNOWN when only an assessment word is present (no scoring cue)", () => {
    const html = "<html><body><h2>本章在线测验</h2><p>请阅读材料。</p></body></html>";
    const match = xuexitongGradedAdapter.match(
      documentAt("https://mooc1.chaoxing.com/course", html)
    );
    expect(match.matched).toBe(false);
    expect(match.pageKind).toBe("UNKNOWN");
    expect(match.evidence).toContain("cue:assessment");
  });

  it("stays UNKNOWN when only a scoring cue is present", () => {
    const html = "<html><body><h2>成绩单</h2><p>Total score: 88</p></body></html>";
    const match = xuexitongGradedAdapter.match(
      documentAt("https://mooc1.chaoxing.com/course", html)
    );
    expect(match.matched).toBe(false);
    expect(match.pageKind).toBe("UNKNOWN");
  });

  it("does not treat a plain practice page as graded", () => {
    const match = xuexitongGradedAdapter.match(
      documentAt("https://mooc1.chaoxing.com/course/practice", PRACTICE_HTML)
    );
    expect(match.matched).toBe(false);
  });

  it("refuses capture and fill on graded pages", () => {
    expect(xuexitongGradedAdapter.listCandidates(documentAt("https://mooc1.chaoxing.com/x", GRADED_HTML))).toEqual([]);
    const capture = xuexitongGradedAdapter.captureSelectedQuestion(
      documentAt("https://mooc1.chaoxing.com/x", GRADED_HTML),
      0,
      { tabId: 1, frameId: 0, documentId: "doc", documentNonce: "nonce" },
      "nonce"
    );
    expect(capture.ok).toBe(false);
    if (!capture.ok) {
      expect(capture.code).toBe("PAGE_KIND_UNSUPPORTED");
    }
    const plan = xuexitongGradedAdapter.createFillPlan(
      { question: { id: "q", type: "SINGLE_CHOICE", stem: "x", options: [], blanks: [] } } as never,
      { status: "ANSWERED", selectedOptionIds: [], blankAnswers: [], textAnswer: null, explanation: "", caveats: [], reviewedAt: 1 },
      "plan-1"
    );
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.code).toBe("PAGE_KIND_UNSUPPORTED");
    }
  });
});
