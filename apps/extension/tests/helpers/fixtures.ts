import type { StudyQuestion } from "@study/contracts";
import type { CaptureIdentity } from "../../src/page/types";
import type { ReviewedAnswer } from "../../src/shared/types";

export function resetPage(): void {
  document.documentElement.removeAttribute("data-fixture");
  document.documentElement.removeAttribute("data-page-kind");
  document.documentElement.removeAttribute("data-events-side-effect");
  document.body.innerHTML = "";
}

export function mountPage(
  fixture: string,
  body: string,
  pageKind: "PRACTICE" | "GRADED" | "UNKNOWN" = "PRACTICE"
): void {
  resetPage();
  document.documentElement.setAttribute("data-fixture", fixture);
  document.documentElement.setAttribute("data-page-kind", pageKind);
  document.body.innerHTML = body;
}

export function identity(nonce: string, overrides: Partial<CaptureIdentity> = {}): CaptureIdentity {
  return {
    tabId: 1,
    frameId: 0,
    documentId: "doc-test-1",
    documentNonce: nonce,
    ...overrides
  };
}

export function reviewedAnswer(overrides: Partial<ReviewedAnswer> = {}): ReviewedAnswer {
  return {
    status: "ANSWERED",
    selectedOptionIds: [],
    blankAnswers: [],
    textAnswer: null,
    explanation: "测试解析",
    caveats: [],
    reviewedAt: Date.now(),
    ...overrides
  };
}

export function practiceBody(): string {
  return `
    <form id="practice-form">
      <section data-question-container data-question-type="SINGLE_CHOICE" data-question-id="1">
        <h2 data-question-stem>1 + 1 等于多少？</h2>
        <label data-option data-option-id="opt_1"><input type="radio" name="q1" value="opt_1" /><span data-option-text>2</span></label>
        <label data-option data-option-id="opt_2"><input type="radio" name="q1" value="opt_2" /><span data-option-text>3</span></label>
      </section>
      <section data-question-container data-question-type="MULTIPLE_CHOICE" data-question-id="2">
        <h2 data-question-stem>下列哪些是偶数？</h2>
        <label data-option data-option-id="opt_1"><input type="checkbox" name="q2" value="opt_1" /><span data-option-text>2</span></label>
        <label data-option data-option-id="opt_2"><input type="checkbox" name="q2" value="opt_2" /><span data-option-text>3</span></label>
        <label data-option data-option-id="opt_3"><input type="checkbox" name="q2" value="opt_3" /><span data-option-text>4</span></label>
      </section>
      <section data-question-container data-question-type="SINGLE_CHOICE" data-question-id="3">
        <h2 data-question-stem>选择正确的一项</h2>
        <select name="q3">
          <option data-option data-option-id="opt_1" value="opt_1">A</option>
          <option data-option data-option-id="opt_2" value="opt_2">B</option>
        </select>
      </section>
      <section data-question-container data-question-type="FILL_BLANK" data-question-id="4">
        <h2 data-question-stem>填写结果</h2>
        <input data-blank data-blank-id="blank_1" aria-label="第一空" />
        <input data-blank data-blank-id="blank_2" aria-label="第二空" />
      </section>
      <section data-question-container data-question-type="SHORT_ANSWER" data-question-id="5">
        <h2 data-question-stem>简述你的理解</h2>
        <textarea data-blank data-blank-id="blank_1" data-answer-text aria-label="简答"></textarea>
      </section>
    </form>
  `;
}

export function singleRadioBody(): string {
  return `
    <section data-question-container data-question-type="SINGLE_CHOICE">
      <h2 data-question-stem>1 + 1 等于多少？</h2>
      <label data-option data-option-id="opt_1"><input type="radio" name="q1" value="opt_1" /><span data-option-text>2</span></label>
      <label data-option data-option-id="opt_2"><input type="radio" name="q1" value="opt_2" /><span data-option-text>3</span></label>
    </section>
  `;
}

export function sampleQuestion(overrides: Partial<StudyQuestion> = {}): StudyQuestion {
  return {
    id: "q_1",
    type: "SINGLE_CHOICE",
    stem: "1 + 1 等于多少？",
    options: [
      { id: "opt_1", text: "2" },
      { id: "opt_2", text: "3" }
    ],
    blanks: [],
    ...overrides
  };
}
