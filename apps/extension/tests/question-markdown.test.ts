import { describe, expect, it } from "vitest";
import { questionToMarkdown, questionsToMarkdown } from "../src/shared/question-markdown";

describe("question markdown export", () => {
  it("renders stem, lettered options and a request that can be pasted into another AI", () => {
    const markdown = questionToMarkdown({
      id: "q_1", type: "MULTIPLE_CHOICE", stem: "以下哪些属于分类任务？",
      options: [{ id: "opt_1", text: "预测明天是否下雨" }, { id: "opt_2", text: "判断邮件是否为垃圾邮件" }], blanks: []
    });
    expect(markdown).toContain("**题型**：多选题（可能有多项正确）");
    expect(markdown).toContain("A. 预测明天是否下雨");
    expect(markdown).toContain("B. 判断邮件是否为垃圾邮件");
    expect(markdown).toContain("全部正确选项");
    expect(markdown).not.toContain("opt_1");
  });
  it("lists blanks and can optionally include local ids for debugging", () => {
    const markdown = questionToMarkdown({
      id: "q_2", type: "FILL_BLANK", stem: "1 + 1 = ____",
      options: [], blanks: [{ id: "blank_1", label: "第 1 空" }]
    }, true);
    expect(markdown).toContain("1. 第 1 空");
  });
});

describe("whole-set markdown export", () => {
  const choice = {
    id: "q_1", type: "MULTIPLE_CHOICE" as const, stem: "以下哪些属于分类任务？",
    options: [{ id: "opt_1", text: "预测明天是否下雨" }, { id: "opt_2", text: "判断邮件是否为垃圾邮件" }], blanks: []
  };
  const blank = {
    id: "q_2", type: "FILL_BLANK" as const, stem: "1 + 1 = ____",
    options: [], blanks: [{ id: "blank_1", label: "第 1 空" }]
  };

  it("exports every question as one numbered document in page order", () => {
    const markdown = questionsToMarkdown([
      { index: 1, question: choice },
      { index: 0, question: blank }
    ]);
    expect(markdown).toContain("共 2 题");
    expect(markdown).toContain("## 1. 填空题");
    expect(markdown).toContain("## 2. 多选题");
    expect(markdown.indexOf("## 1. 填空题")).toBeLessThan(markdown.indexOf("## 2. 多选题"));
    expect(markdown).toContain("A. 预测明天是否下雨");
    expect(markdown).toContain("请按题号依次给出答案");
    expect(markdown).toContain("全部正确选项字母");
    expect(markdown).not.toContain("opt_1");
  });

  it("marks image-fallback questions so pasted readers know the text may be unreliable", () => {
    const markdown = questionsToMarkdown([
      { index: 0, question: blank, needsImage: true, sourceReason: "字形无法还原" }
    ]);
    expect(markdown).toContain("图像兜底题");
    expect(markdown).toContain("字形无法还原");
    expect(markdown).toContain("以题目图片为准");
  });
});
