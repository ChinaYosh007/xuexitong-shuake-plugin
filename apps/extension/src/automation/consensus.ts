import type { StudyAnswer, StudyQuestion } from "@study/contracts";

export interface AnswerVote { answer: StudyAnswer; agreement: number; samples: number }
const textKey = (value: string) => value.trim().replace(/\s+/g, " ");
export function answerIsUncertain(answer: StudyAnswer): boolean {
  return answer.status !== "ANSWERED" || imageIsUnclear(answer) || /不确定|无法确定|不能确定|多种可能|多个候选|uncertain|not sure|ambiguous/i
    .test([answer.explanation, ...answer.caveats].join(" "));
}

export function imageIsUnclear(answer: StudyAnswer): boolean {
  if (answer.status === "ANSWERED" && !answer.caveats.length) return false;
  const detail = [answer.explanation, ...answer.caveats].join(" ");
  // Code-completion diagrams often elicit "missing program code/blank markers", rather
  // than "blurry image". Re-send original images before repeating the same partial input.
  if (answer.status === "NEEDS_CONTEXT" &&
      /(?:缺少|未提供|没有提供|未显示).{0,24}(?:程序代码|代码图|空白标记|空白编号)|(?:程序代码|代码图|空白标记|空白编号).{0,16}(?:缺失|未提供|未显示)/.test(detail)) return true;
  return /(?:图片|图像|图示).{0,20}(?:不清|模糊|无法|看不|缺失)|(?:看不清|无法看清|无法读取).{0,12}(?:图片|图像|图示)|blurr|unreadable|illegible|(?:image|diagram).{0,25}(?:unclear|missing|not\s+(?:clear|readable))/i
    .test(detail);
}

interface RankedAnswer { answer: StudyAnswer; count: number }

/** Count agreement on answer data, never on explanations or model-claimed confidence. */
function rankAnswers(question: StudyQuestion, answers: StudyAnswer[]): RankedAnswer[] {
  const groups = new Map<string, { answer: StudyAnswer; count: number }>();
  for (const answer of answers) {
    // Caveats are learner-facing notes, not a refusal: a consistent answer with caveats still counts.
    if (answer.status !== "ANSWERED") continue;
    const selected = [...answer.selectedOptionIds].sort();
    const blanks = [...answer.blankAnswers].sort((a, b) => a.blankId.localeCompare(b.blankId));
    if (["SINGLE_CHOICE", "MULTIPLE_CHOICE", "TRUE_FALSE"].includes(question.type)) {
      if (!selected.length || new Set(selected).size !== selected.length ||
          (question.type !== "MULTIPLE_CHOICE" && selected.length !== 1) ||
          selected.some(id => !question.options.some(option => option.id === id)) ||
          blanks.length || answer.textAnswer) continue;
    } else if (question.type === "FILL_BLANK") {
      if (!question.blanks.length || selected.length || answer.textAnswer || blanks.length !== question.blanks.length ||
          new Set(blanks.map(blank => blank.blankId)).size !== blanks.length ||
          blanks.some(blank => !textKey(blank.answer) || !question.blanks.some(expected => expected.id === blank.blankId))) continue;
    } else if (question.type === "SHORT_ANSWER") {
      if (selected.length || blanks.length || !answer.textAnswer?.trim()) continue;
    } else continue;
    const key = JSON.stringify([selected, blanks.map(blank => [blank.blankId, textKey(blank.answer)]), textKey(answer.textAnswer ?? "")]);
    const group = groups.get(key);
    if (group) group.count++; else groups.set(key, { answer: { ...answer, selectedOptionIds: selected,
      blankAnswers: blanks.map(blank => ({ ...blank, answer: blank.answer.trim() })),
      textAnswer: answer.textAnswer?.trim() ?? null }, count: 1 });
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

/** Ranked valid answers, used by the manual补答 panel to show candidates and their vote counts. */
export function rankAnswerCandidates(question: StudyQuestion, answers: StudyAnswer[]): RankedAnswer[] {
  return rankAnswers(question, answers);
}

/** Strict majority: used by the automatic pipeline (3 samples, needs 2 of 3). */
export function chooseAnswer(question: StudyQuestion, answers: StudyAnswer[]): AnswerVote {
  const ranked = rankAnswers(question, answers);
  const winner = ranked[0];
  const required = Math.floor(answers.length / 2) + 1;
  if (!winner || winner.count < required) {
    throw new Error(`本题 ${answers.length} 次结果没有可用的多数一致答案（需 ${required} 份）；图片不清、缺少上下文或三方分歧时不回填。`);
  }
  return { answer: winner.answer, agreement: winner.count, samples: answers.length };
}

/**
 * Plurality retry used only from the manual补答 panel: the user explicitly asks for
 * another concurrent round, and the answer hit most often wins.
 * A tie at the top (including every answer appearing once) is never guessed; it stays
 * unresolved for manual input. At least two hits are required so a single stray sample
 * cannot overwrite the page.
 */
export function choosePlurality(question: StudyQuestion, answers: StudyAnswer[]): AnswerVote {
  const ranked = rankAnswers(question, answers);
  const winner = ranked[0];
  if (!winner || winner.count < 2) {
    throw new Error(`重试后仍没有重复命中的答案（共 ${answers.length} 次有效样本），请手动输入。`);
  }
  if (ranked[1] && ranked[1].count === winner.count) {
    throw new Error(`重试后两个答案命中次数相同（各 ${winner.count} 次），无法判定，请手动输入。`);
  }
  return { answer: winner.answer, agreement: winner.count, samples: answers.length };
}
