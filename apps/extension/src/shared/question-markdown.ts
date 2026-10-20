import type { StudyQuestion } from "@study/contracts";

const TYPE_LABELS: Record<StudyQuestion["type"], string> = {
  SINGLE_CHOICE: "单选题",
  MULTIPLE_CHOICE: "多选题",
  TRUE_FALSE: "判断题",
  FILL_BLANK: "填空题",
  SHORT_ANSWER: "简答题",
  UNKNOWN: "未知题型"
};

/** One question of a whole-set export, as read from the course page. */
export interface QuestionExportItem {
  index: number;
  question: StudyQuestion;
  needsImage?: boolean;
  sourceReason?: string;
}

function pushOptionsAndBlanks(lines: string[], question: StudyQuestion, includeIds: boolean): void {
  if (question.options.length) {
    lines.push("**选项**：");
    question.options.forEach((option, index) => {
      const letter = String.fromCharCode(65 + index);
      lines.push(`${letter}. ${option.text.trim() || "（见图片）"}${includeIds ? `  _(id: ${option.id})_` : ""}`);
    });
    lines.push("");
  }
  if (question.blanks.length) {
    lines.push("**空格**：");
    question.blanks.forEach((blank, index) => lines.push(`${index + 1}. ${blank.label.trim() || "（未命名空格）"}`));
    lines.push("");
  }
}

/** Plain Markdown for copying the captured question into any other AI chat. */
export function questionToMarkdown(question: StudyQuestion, includeIds = false): string {
  const lines: string[] = [];
  lines.push("# 题目（学习通）", "");
  lines.push("**题型**：" + TYPE_LABELS[question.type] + (question.type === "MULTIPLE_CHOICE" ? "（可能有多项正确）" : ""), "");
  lines.push("**题干**：", "", question.stem.trim(), "");
  pushOptionsAndBlanks(lines, question, includeIds);
  lines.push("请直接给出答案" + (question.type === "MULTIPLE_CHOICE" ? "（全部正确选项）" : "") + "，并简要解释理由。", "");
  return lines.join("\n");
}

/** Whole-set Markdown: the full question document, numbered in page order, ready to paste into any other AI chat. */
export function questionsToMarkdown(items: readonly QuestionExportItem[], includeIds = false): string {
  const ordered = [...items].sort((a, b) => a.index - b.index);
  const lines: string[] = ["# 学习通题目（整份）", ""];
  lines.push(`共 ${ordered.length} 题 · 由扩展本地导出，可整份粘贴给其他 AI。`, "");
  ordered.forEach((item, position) => {
    const question = item.question;
    lines.push(`## ${position + 1}. ${TYPE_LABELS[question.type] ?? question.type}` + (question.type === "MULTIPLE_CHOICE" ? "（可能有多项正确）" : ""), "");
    if (item.needsImage) {
      lines.push(`> 注：图像兜底题${item.sourceReason ? "（" + item.sourceReason + "）" : ""}，源文字可能不可靠，建议以题目图片为准。`, "");
    }
    lines.push(question.stem.trim() || "（无题干）", "");
    pushOptionsAndBlanks(lines, question, includeIds);
  });
  lines.push("---", "", `请按题号依次给出答案${ordered.some(item => item.question.type === "MULTIPLE_CHOICE") ? "（多选请给出全部正确选项字母）" : ""}，并简要解释理由。`, "");
  return lines.join("\n");
}
