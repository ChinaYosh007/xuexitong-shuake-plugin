// @ts-expect-error jsdom ships no bundled type declarations in this workspace
import { JSDOM as JSDOMImport } from "jsdom";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { PracticeFixtureAdapter } from "../src/page/practice-fixture";
import type { CapturedQuestion, ReviewedAnswer } from "../src/shared/types";
import type { FillPlanInternal } from "../src/page/types";

const JSDOM = JSDOMImport as unknown as new (
  html: string,
  options: Record<string, unknown>
) => { window: Window & typeof globalThis & FixtureWindow };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(HERE, "../../../tests/fixtures");

interface FixtureCounters {
  input: number;
  change: number;
  paste: number;
  keydown: number;
  submit: number;
  fetch: number;
  xhr: number;
  copy: number;
}

interface FixtureWindow {
  __counters?: FixtureCounters;
  __injectionExecuted?: boolean;
}

function loadFixture(fileName: string): { document: Document; window: Window & FixtureWindow } {
  const html = readFileSync(path.join(FIXTURE_DIR, fileName), "utf8");
  const dom = new JSDOM(html, {
    url: `http://127.0.0.1:8080/fixtures/${fileName}`,
    runScripts: "dangerously",
    pretendToBeVisual: true
  });
  return { document: dom.window.document, window: dom.window as Window & FixtureWindow };
}

function counters(window: Window & FixtureWindow): FixtureCounters {
  const value = window.__counters;
  if (!value) {
    throw new Error("fixture counters were not installed");
  }
  return { ...value };
}

function zeroCounters(): FixtureCounters {
  return { input: 0, change: 0, paste: 0, keydown: 0, submit: 0, fetch: 0, xhr: 0, copy: 0 };
}

interface FillOutcome {
  captured: CapturedQuestion;
  plan: FillPlanInternal;
  result: Awaited<ReturnType<PracticeFixtureAdapter["apply"]>>;
}

let adapter: PracticeFixtureAdapter;
let documentIdCounter = 0;

beforeEach(() => {
  adapter = new PracticeFixtureAdapter();
  documentIdCounter += 1;
});

function fillQuestion(
  document: Document,
  index: number,
  answer: ReviewedAnswer
): FillOutcome {
  const nonce = `nonce_fixture_${documentIdCounter}_${index}_abcdef`;
  const identity = {
    tabId: 1,
    frameId: 0,
    documentId: `fixture-doc-${documentIdCounter}`,
    documentNonce: nonce
  };
  const capturedOutcome = adapter.captureSelectedQuestion(document, index, identity, nonce);
  if (!capturedOutcome.ok) {
    throw new Error(`capture failed: ${capturedOutcome.code} ${capturedOutcome.detail}`);
  }
  const planId = `plan_fixture_${documentIdCounter}_${index}`;
  const planOutcome = adapter.createFillPlan(capturedOutcome.captured, answer, planId);
  if (!planOutcome.ok) {
    throw new Error(`plan failed: ${planOutcome.code} ${planOutcome.detail}`);
  }
  const revalidation = adapter.revalidate(planOutcome.plan, identity, true);
  if (!revalidation.ok) {
    throw new Error(`revalidation failed: ${revalidation.code}`);
  }
  return {
    captured: capturedOutcome.captured,
    plan: planOutcome.plan,
    result: undefined as unknown as FillOutcome["result"]
  };
}

async function fillAndApply(
  document: Document,
  index: number,
  answer: ReviewedAnswer
): Promise<{ captured: CapturedQuestion; plan: FillPlanInternal; result: Awaited<ReturnType<PracticeFixtureAdapter["apply"]>> }> {
  const base = fillQuestion(document, index, answer);
  const result = await adapter.apply(base.plan);
  return { ...base, result };
}

function reviewed(overrides: Partial<ReviewedAnswer>): ReviewedAnswer {
  return {
    status: "ANSWERED",
    selectedOptionIds: [],
    blankAnswers: [],
    textAnswer: null,
    explanation: "fixture test",
    caveats: [],
    reviewedAt: Date.now(),
    ...overrides
  };
}

describe("delivered synthetic fixtures", () => {
  it("practice.html: five containers can be filled field-by-field with zero submit/network", async () => {
    const { document, window } = loadFixture("practice.html");
    expect(adapter.match(document).matched).toBe(true);
    expect(adapter.listCandidates(document).map((candidate) => candidate.questionType)).toEqual([
      "SINGLE_CHOICE",
      "MULTIPLE_CHOICE",
      "SINGLE_CHOICE",
      "FILL_BLANK",
      "SHORT_ANSWER"
    ]);

    const single = await fillAndApply(document, 0, reviewed({ selectedOptionIds: ["opt_2"] }));
    expect(single.result.status).toBe("FILLED");
    expect(document.querySelector<HTMLInputElement>('input[value="opt_2"]')?.checked).toBe(true);

    const multiple = await fillAndApply(document, 1, reviewed({ selectedOptionIds: ["opt_1", "opt_3"] }));
    expect(multiple.result.status).toBe("FILLED");
    expect(document.querySelector<HTMLInputElement>('input[value="opt_1"][type="checkbox"]')?.checked).toBe(true);
    expect(document.querySelector<HTMLInputElement>('input[value="opt_2"][type="checkbox"]')?.checked).toBe(false);
    expect(document.querySelector<HTMLInputElement>('input[value="opt_3"][type="checkbox"]')?.checked).toBe(true);

    const select = await fillAndApply(document, 2, reviewed({ selectedOptionIds: ["opt_3"] }));
    expect(select.result.status).toBe("FILLED");
    expect(document.querySelector<HTMLSelectElement>("select")?.value).toBe("opt_3");

    const blanks = await fillAndApply(
      document,
      3,
      reviewed({
        blankAnswers: [
          { blankId: "blank_1", answer: "2" },
          { blankId: "blank_2", answer: "4" }
        ]
      })
    );
    expect(blanks.result.status).toBe("FILLED");
    expect(document.querySelector<HTMLInputElement>('[data-blank-id="blank_1"]')?.value).toBe("2");
    expect(document.querySelector<HTMLInputElement>('[data-blank-id="blank_2"]')?.value).toBe("4");

    const shortAnswer = await fillAndApply(document, 4, reviewed({ textAnswer: "两个数相加，交换位置结果不变" }));
    expect(shortAnswer.result.status).toBe("FILLED");
    expect(document.querySelector<HTMLTextAreaElement>("textarea")?.value).toContain("交换位置");

    const observed = counters(window);
    expect(observed.submit).toBe(0);
    expect(observed.fetch).toBe(0);
    expect(observed.xhr).toBe(0);
    expect(observed.paste).toBe(0);
    expect(observed.keydown).toBe(0);
    expect(observed.input).toBeGreaterThan(0);
    expect(observed.change).toBeGreaterThan(0);
  });

  it("controlled-input.html: synchronous revert is detected as VALUE_REVERTED / PARTIAL_FILL", async () => {
    const { document, window } = loadFixture("controlled-input.html");
    const outcome = await fillAndApply(
      document,
      0,
      reviewed({
        blankAnswers: [
          { blankId: "blank_1", answer: "答案1" },
          { blankId: "blank_2", answer: "答案2" }
        ]
      })
    );
    expect(outcome.result.status).toBe("PARTIAL_FILL");
    expect(outcome.result.code).toBe("VALUE_REVERTED");
    expect(outcome.result.writtenCount).toBe(1);
    expect(outcome.result.persistedCount).toBe(1);
    expect(document.querySelector<HTMLInputElement>("#controlled-blank-1")?.value).toBe("答案1");
    expect(document.querySelector<HTMLInputElement>("#controlled-blank-2")?.value).toBe("初始值（不可改）");
    const observed = counters(window);
    expect(observed.input).toBeGreaterThanOrEqual(2);
    expect(observed.change).toBeGreaterThanOrEqual(2);
    expect(observed.submit).toBe(0);
  });

  it("readonly-field.html: readonly and disabled controls are refused, attributes unchanged", async () => {
    const { document, window } = loadFixture("readonly-field.html");
    const nonce = `nonce_readonly_${documentIdCounter}_abcdef`;
    const identity = { tabId: 1, frameId: 0, documentId: `fixture-doc-${documentIdCounter}`, documentNonce: nonce };
    const captured = adapter.captureSelectedQuestion(document, 0, identity, nonce);
    expect(captured.ok).toBe(true);
    if (!captured.ok) {
      return;
    }
    const plan = adapter.createFillPlan(
      captured.captured,
      reviewed({
        blankAnswers: [
          { blankId: "blank_1", answer: "x" },
          { blankId: "blank_2", answer: "y" }
        ]
      }),
      "plan_readonly_01"
    );
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.code).toBe("FIELD_READ_ONLY");
    }
    const readonlyInput = document.querySelector<HTMLInputElement>("#readonly-blank-1");
    const disabledInput = document.querySelector<HTMLInputElement>("#readonly-blank-2");
    expect(readonlyInput?.readOnly).toBe(true);
    expect(readonlyInput?.value).toBe("只读原值");
    expect(disabledInput?.disabled).toBe(true);
    expect(disabledInput?.value).toBe("禁用原值");
    expect(counters(window)).toEqual(zeroCounters());
  });

  it("autosubmit-field.html: adapter refuses before any write or event", async () => {
    const { document, window } = loadFixture("autosubmit-field.html");
    const nonce = `nonce_autosubmit_${documentIdCounter}_abcdef`;
    const identity = { tabId: 1, frameId: 0, documentId: `fixture-doc-${documentIdCounter}`, documentNonce: nonce };
    const captured = adapter.captureSelectedQuestion(document, 0, identity, nonce);
    expect(captured.ok).toBe(true);
    if (!captured.ok) {
      return;
    }
    expect(captured.captured.fillEligible).toBe(false);
    expect(captured.captured.fillBlockCode).toBe("EVENT_SIDE_EFFECT_UNVERIFIED");
    const plan = adapter.createFillPlan(
      captured.captured,
      reviewed({ blankAnswers: [{ blankId: "blank_1", answer: "x" }] }),
      "plan_autosubmit_01"
    );
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.code).toBe("EVENT_SIDE_EFFECT_UNVERIFIED");
    }
    expect(document.body.getAttribute("data-auto-submit-triggered")).toBeNull();
    expect(counters(window)).toEqual(zeroCounters());
  });

  it("changed-question.html: revalidation rejects a changed question with zero writes", () => {
    const { document, window } = loadFixture("changed-question.html");
    const nonce = `nonce_changed_${documentIdCounter}_abcdef`;
    const identity = { tabId: 1, frameId: 0, documentId: `fixture-doc-${documentIdCounter}`, documentNonce: nonce };
    const captured = adapter.captureSelectedQuestion(document, 0, identity, nonce);
    expect(captured.ok).toBe(true);
    if (!captured.ok) {
      return;
    }
    const plan = adapter.createFillPlan(
      captured.captured,
      reviewed({ selectedOptionIds: ["opt_1"] }),
      "plan_changed_01"
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      return;
    }
    document.querySelector<HTMLButtonElement>("#simulate-question-change")?.click();
    expect(document.documentElement.getAttribute("data-question-changed")).toBe("1");
    const revalidation = adapter.revalidate(plan.plan, identity, true);
    expect(revalidation.ok).toBe(false);
    expect(revalidation.code).toBe("QUESTION_CHANGED");
    expect(document.querySelector<HTMLInputElement>('input[value="opt_1"]')?.checked).toBe(false);
    expect(counters(window)).toEqual(zeroCounters());
  });

  it("graded.html: graded pages never expose fill and never write", () => {
    const { document, window } = loadFixture("graded.html");
    expect(adapter.match(document).pageKind).toBe("GRADED");
    const nonce = `nonce_graded_${documentIdCounter}_abcdef`;
    const identity = { tabId: 1, frameId: 0, documentId: `fixture-doc-${documentIdCounter}`, documentNonce: nonce };
    const captured = adapter.captureSelectedQuestion(document, 0, identity, nonce);
    expect(captured.ok).toBe(false);
    if (!captured.ok) {
      expect(captured.code).toBe("PAGE_KIND_UNSUPPORTED");
    }
    expect(counters(window)).toEqual(zeroCounters());
  });

  it("no-paste.html: control writes work with the paste counter at zero", async () => {
    const { document, window } = loadFixture("no-paste.html");
    const outcome = await fillAndApply(
      document,
      0,
      reviewed({
        blankAnswers: [
          { blankId: "blank_1", answer: "12" },
          { blankId: "blank_2", answer: "5" }
        ]
      })
    );
    expect(outcome.result.status).toBe("FILLED");
    const values = Array.from(document.querySelectorAll<HTMLInputElement>("[data-blank]")).map(
      (node) => node.value
    );
    expect(values).toEqual(["12", "5"]);
    const observed = counters(window);
    expect(observed.paste).toBe(0);
    expect(observed.submit).toBe(0);
  });

  it("selection-disabled.html: radio can be filled without any Selection or copy", async () => {
    const { document, window } = loadFixture("selection-disabled.html");
    expect(window.getSelection()?.toString() ?? "").toBe("");
    const outcome = await fillAndApply(document, 0, reviewed({ selectedOptionIds: ["opt_1"] }));
    expect(outcome.result.status).toBe("FILLED");
    expect(document.querySelector<HTMLInputElement>('input[value="opt_1"]')?.checked).toBe(true);
    expect(counters(window).copy).toBe(0);
    expect(counters(window).submit).toBe(0);
  });

  it("prompt-injection.html: injected text is just data; unknown editor is unsupported", async () => {
    const { document, window } = loadFixture("prompt-injection.html");
    expect(window.__injectionExecuted).toBe(false);
    expect(document.querySelectorAll("[data-question-stem] script")).toHaveLength(0);

    const first = await fillAndApply(document, 0, reviewed({ selectedOptionIds: ["opt_1"] }));
    expect(first.result.status).toBe("FILLED");
    expect(first.captured.question.stem).toContain("<script>");
    expect(document.querySelector<HTMLInputElement>('input[value="opt_1"]')?.checked).toBe(true);
    expect(counters(window).submit).toBe(0);

    const nonce = `nonce_injection_${documentIdCounter}_abcdef`;
    const identity = { tabId: 1, frameId: 0, documentId: `fixture-doc-${documentIdCounter}`, documentNonce: nonce };
    const second = adapter.captureSelectedQuestion(document, 1, identity, nonce);
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.captured.fillEligible).toBe(false);
      expect(second.captured.fillBlockCode).toBe("CONTROL_UNSUPPORTED");
    }
    const editor = document.querySelector("[data-unknown-editor]");
    expect(editor?.textContent).toContain("未知编辑器初始内容");
    expect(editor?.textContent).not.toContain("<script");
  });

  it("iframe-question.html: same-origin frame question is captured and filled", async () => {
    const { document, window } = loadFixture("iframe-question.html");
    const frame = document.getElementById("question-frame") as HTMLIFrameElement;
    const frameHtml = readFileSync(path.join(FIXTURE_DIR, "iframe-question-frame.html"), "utf8");
    const frameDocument = frame.contentDocument;
    expect(frameDocument).not.toBeNull();
    if (!frameDocument) {
      return;
    }
    frameDocument.open();
    frameDocument.write(frameHtml);
    frameDocument.close();

    const outcome = await fillAndApply(document, 0, reviewed({ selectedOptionIds: ["opt_1"] }));
    expect(outcome.captured.question.stem).toContain("iframe 内的题目");
    expect(outcome.result.status).toBe("FILLED");
    expect(frameDocument.querySelector<HTMLInputElement>('input[value="opt_1"]')?.checked).toBe(true);
    const frameWindow = frame.contentWindow as (Window & FixtureWindow) | null;
    if (frameWindow?.__counters) {
      const frameCounters = counters(frameWindow);
      expect(frameCounters.input).toBeGreaterThan(0);
      expect(frameCounters.submit).toBe(0);
    }
    expect(counters(window).submit).toBe(0);
  });
});