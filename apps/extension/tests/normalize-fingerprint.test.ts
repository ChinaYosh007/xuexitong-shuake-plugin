import { describe, expect, it } from "vitest";
import {
  normalizeCapturedText,
  normalizeLineEndings,
  truncateText
} from "../src/capture/normalize";
import {
  computeQuestionFingerprint,
  deterministicQuestionSerialization
} from "../src/capture/context";
import { sampleQuestion } from "./helpers/fixtures";

describe("normalizeCapturedText", () => {
  it("normalizes CRLF and local whitespace only", () => {
    expect(normalizeLineEndings("a\r\nb\rc")).toBe("a\nb\nc");
    expect(normalizeCapturedText("  1 + 1   等于   2  ")).toBe("1 + 1 等于 2");
    expect(normalizeCapturedText("第一行\r\n\r\n\r\n\r\n第二行")).toBe("第一行\n\n第二行");
  });

  it("does not rewrite mathematical characters", () => {
    const source = "x² + 1/2 ≤ 3 ⇒ x ∈ [0, 1]";
    expect(normalizeCapturedText(source)).toBe(source);
  });

  it("keeps CJK punctuation and newline layout bounded", () => {
    expect(normalizeCapturedText("选项A：正确，选项B：错误。")).toBe("选项A：正确，选项B：错误。");
    expect(truncateText("a".repeat(20), 10)).toHaveLength(10);
  });
});

describe("question fingerprint", () => {
  it("is stable across serialization order but changes with content", () => {
    const question = sampleQuestion();
    const reordered = {
      blanks: question.blanks,
      options: question.options,
      stem: question.stem,
      type: question.type,
      id: question.id
    } as unknown as typeof question;
    expect(computeQuestionFingerprint(reordered)).toBe(computeQuestionFingerprint(question));

    const changedOption = sampleQuestion({
      options: [
        { id: "opt_1", text: "2" },
        { id: "opt_2", text: "四" }
      ]
    });
    expect(computeQuestionFingerprint(changedOption)).not.toBe(computeQuestionFingerprint(question));
  });

  it("covers option ids and blank mapping", () => {
    const base = sampleQuestion({ type: "FILL_BLANK", options: [], blanks: [{ id: "blank_1", label: "第一空" }] });
    const changedId = sampleQuestion({ type: "FILL_BLANK", options: [], blanks: [{ id: "blank_2", label: "第一空" }] });
    const changedLabel = sampleQuestion({ type: "FILL_BLANK", options: [], blanks: [{ id: "blank_1", label: "第二空" }] });
    expect(computeQuestionFingerprint(base)).not.toBe(computeQuestionFingerprint(changedId));
    expect(computeQuestionFingerprint(base)).not.toBe(computeQuestionFingerprint(changedLabel));
  });

  it("ignores whitespace-only differences through normalization", () => {
    const a = sampleQuestion({ stem: "1 + 1 等于多少？" });
    const b = sampleQuestion({ stem: "  1 + 1   等于多少？\r\n" });
    expect(computeQuestionFingerprint(a)).toBe(computeQuestionFingerprint(b));
    expect(deterministicQuestionSerialization(a)).toBe(deterministicQuestionSerialization(b));
  });
});
