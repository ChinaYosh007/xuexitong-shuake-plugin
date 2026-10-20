import { describe, expect, it } from "vitest";
import type { StudyAnswer, StudyQuestion } from "@study/contracts";
import { chooseAnswer, choosePlurality, imageIsUnclear } from "../src/automation/consensus";

const question: StudyQuestion = { id: "q_1", type: "MULTIPLE_CHOICE", stem: "test", options: [
  { id: "opt_1", text: "A" }, { id: "opt_2", text: "B" }, { id: "opt_3", text: "C" }
], blanks: [] };
const a = (ids = ["opt_1"]): StudyAnswer => ({ status: "ANSWERED", selectedOptionIds: ids, blankAnswers: [], textAnswer: null, explanation: "", caveats: [] });

describe("three-sample answer voting", () => {
  it.each(["缺少程序代码或空白上下文", "未提供具体程序代码、空白标记或选项", "程序代码图片缺失"])
    ("recognises missing visual code context before another vote: %s", explanation => {
      expect(imageIsUnclear({ ...a([]), status: "NEEDS_CONTEXT", explanation })).toBe(true);
    });
  it("does not confuse an answered code caveat or a generic uncertainty with an unreadable image", () => {
    expect(imageIsUnclear({ ...a(), explanation: "未提供程序代码", caveats: ["只需回答选项"] })).toBe(false);
    expect(imageIsUnclear({ ...a([]), status: "NEEDS_CONTEXT", explanation: "答案存在两种解释，需要更多上下文" })).toBe(false);
  });
  it("counts selected answer sets independently of ordering or explanation", () => {
    expect(chooseAnswer(question, [a(["opt_2", "opt_1"]), { ...a(["opt_1", "opt_2"]), explanation: "other reasoning" }, a(["opt_3"])])).toMatchObject({ agreement: 2, samples: 3 });
  });
  it("allows two usable matching answers to outvote one NEEDS_CONTEXT response", () => {
    expect(chooseAnswer(question, [a(), { ...a(), status: "NEEDS_CONTEXT", caveats: ["blurred"] }, a()])).toMatchObject({ agreement: 2 });
  });
  it("stops on three-way disagreement, insufficient usable votes, or invalid IDs", () => {
    expect(() => chooseAnswer(question, [a(), a(["opt_2"]), a(["opt_3"])])).toThrow(/多数/);
    // Caveats no longer invalidate an otherwise consistent answer; two matching answers win.
    expect(chooseAnswer(question, [a(), { ...a(), caveats: ["uncertain"] }, { ...a(), status: "REFUSED" }])).toMatchObject({ agreement: 2 });
    expect(() => chooseAnswer(question, [a(["missing"]), a(["missing"]), a()])).toThrow();
  });
  it("requires valid cardinality and all named blanks, without silently dropping fields", () => {
    expect(() => chooseAnswer({ ...question, type: "SINGLE_CHOICE" }, [a(["opt_1", "opt_2"])] )).toThrow();
    const blankQuestion = { ...question, type: "FILL_BLANK" as const, options: [], blanks: [{ id: "blank_1", label: "1" }] };
    const blank = { ...a([]), blankAnswers: [{ blankId: "blank_1", answer: " x  y " }] };
    expect(chooseAnswer(blankQuestion, [blank, { ...blank, blankAnswers: [{ blankId: "blank_1", answer: "x y" }] }, a()]).agreement).toBe(2);
    expect(() => chooseAnswer(blankQuestion, [a([])])).toThrow();
  });
  it("uses exact text agreement with whitespace normalization, not invented semantic confidence", () => {
    const short = { ...question, type: "SHORT_ANSWER" as const, options: [] };
    const answer = { ...a([]), textAnswer: "value X" };
    expect(chooseAnswer(short, [answer, { ...answer, textAnswer: " value  X " }, { ...answer, textAnswer: "value x" }]).agreement).toBe(2);
    expect(() => chooseAnswer(short, [{ ...answer, textAnswer: "a" }, { ...answer, textAnswer: "b" }, { ...answer, textAnswer: "c" }])).toThrow();
  });
});
describe("plurality retry for manual items", () => {
  it("takes the answer hit most often across the combined samples", () => {
    expect(choosePlurality(question, [a(["opt_3"]), a(["opt_1"]), a(["opt_1"]), a(["opt_2"])]))
      .toMatchObject({ agreement: 2, samples: 4 });
    expect(choosePlurality(question, [a(["opt_2"]), a(["opt_2"]), a(["opt_2"]), a(["opt_1"]), a(["opt_1"]), a(["opt_3"])]).answer.selectedOptionIds)
      .toEqual(["opt_2"]);
  });
  it("refuses a top tie or a single stray hit instead of guessing", () => {
    expect(() => choosePlurality(question, [a(), a(["opt_2"])])).toThrow(/相同|并列|重复/);
    expect(() => choosePlurality(question, [a(), a(["opt_2"]), a(["opt_3"])])).toThrow(/重复命中/);
  });
  it("ignores invalid or uncertain samples when ranking", () => {
    const votes = choosePlurality(question, [a(), { ...a(), status: "NEEDS_CONTEXT" }, a(), { ...a(), caveats: ["不确定"] }]);
    expect(votes).toMatchObject({ agreement: 3, samples: 4 });
  });
});
