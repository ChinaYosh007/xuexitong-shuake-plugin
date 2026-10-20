import type { StudyQuestion } from "@study/contracts";
import type { ControlKind, ReviewedAnswer } from "../shared/types";
import type { LocalErrorCode } from "../shared/codes";
import { MAX_OPTIONS } from "../shared/limits";
import type { ReviewedFieldValue } from "../adapters/control-writers";
import { digestReviewedAnswer } from "./guard";
import { truncateText } from "../capture/normalize";
import { computeQuestionFingerprint } from "../capture/context";

export interface PlannedField {
  fieldId: string;
  label: string;
  controlKind: ControlKind;
  value: ReviewedFieldValue;
  optionId: string | null;
  blankId: string | null;
}

export type PlanBuildOutcome =
  | { ok: true; fields: PlannedField[] }
  | { ok: false; code: LocalErrorCode; detail: string };

function optionText(question: StudyQuestion, optionId: string): string {
  const option = question.options.find((item) => item.id === optionId);
  return option ? truncateText(option.text, 60) : optionId;
}

/**
 * Build the field-by-field local fill plan from a reviewed answer (architecture.md §8.3).
 * Pure data only: DOM targets are resolved by the page adapter. Model output never decides
 * selectors, events or write code.
 */
export function buildPlannedFields(question: StudyQuestion, answer: ReviewedAnswer): PlanBuildOutcome {
  if (question.type === "UNKNOWN") {
    return {
      ok: false,
      code: "CONTROL_UNSUPPORTED",
      detail: "unknown question type has no verified writer"
    };
  }
  if (question.options.length > MAX_OPTIONS) {
    return { ok: false, code: "QUESTION_AMBIGUOUS", detail: "too many options" };
  }

  for (const optionId of answer.selectedOptionIds) {
    if (!question.options.some((option) => option.id === optionId)) {
      return { ok: false, code: "QUESTION_CHANGED", detail: `answer references unknown option ${optionId}` };
    }
  }

  const optionsById = new Map(question.options.map((option) => [option.id, option]));
  const fields: PlannedField[] = [];

  switch (question.type) {
    case "SINGLE_CHOICE":
    case "TRUE_FALSE": {
      if (answer.selectedOptionIds.length !== 1 || question.options.length === 0) {
        return {
          ok: false,
          code: "QUESTION_AMBIGUOUS",
          detail: "single choice / true-false requires exactly one selected option"
        };
      }
      const optionId = answer.selectedOptionIds[0]!;
      const option = optionsById.get(optionId);
      if (!option) {
        return { ok: false, code: "QUESTION_CHANGED", detail: "selected option is missing" };
      }
      fields.push({
        fieldId: `option:${optionId}`,
        label: `选项：${truncateText(option.text, 60)}`,
        controlKind: "RADIO",
        value: { kind: "RADIO", optionId },
        optionId,
        blankId: null
      });
      break;
    }
    case "MULTIPLE_CHOICE": {
      if (answer.selectedOptionIds.length === 0) {
        return {
          ok: false,
          code: "QUESTION_AMBIGUOUS",
          detail: "multiple choice requires at least one selected option"
        };
      }
      if (question.options.length === 0) {
        return { ok: false, code: "QUESTION_AMBIGUOUS", detail: "multiple choice has no options" };
      }
      for (const option of question.options) {
        const checked = answer.selectedOptionIds.includes(option.id);
        fields.push({
          fieldId: `option:${option.id}`,
          label: `选项：${truncateText(option.text, 60)}`,
          controlKind: "CHECKBOX",
          value: { kind: "CHECKBOX", optionId: option.id, checked },
          optionId: option.id,
          blankId: null
        });
      }
      break;
    }
    case "FILL_BLANK": {
      if (question.blanks.length === 0) {
        return { ok: false, code: "QUESTION_AMBIGUOUS", detail: "fill-blank question has no blanks" };
      }
      const answerMap = new Map(answer.blankAnswers.map((item) => [item.blankId, item.answer]));
      for (const blank of question.blanks) {
        if (!answerMap.has(blank.id)) {
          return { ok: false, code: "QUESTION_AMBIGUOUS", detail: `missing answer for blank ${blank.id}` };
        }
        const text = answerMap.get(blank.id)!.trim();
        if (!text) {
          return { ok: false, code: "QUESTION_AMBIGUOUS", detail: `empty answer for blank ${blank.id}` };
        }
        fields.push({
          fieldId: `blank:${blank.id}`,
          label: `空格：${truncateText(blank.label, 60)}`,
          controlKind: "TEXT_INPUT",
          value: { kind: "TEXT", text },
          optionId: null,
          blankId: blank.id
        });
      }
      for (const blankId of answerMap.keys()) {
        if (!question.blanks.some((blank) => blank.id === blankId)) {
          return { ok: false, code: "QUESTION_CHANGED", detail: `answer references unknown blank ${blankId}` };
        }
      }
      break;
    }
    case "SHORT_ANSWER": {
      const text = (answer.textAnswer ?? "").trim();
      if (!text) {
        return { ok: false, code: "QUESTION_AMBIGUOUS", detail: "short answer requires non-empty text" };
      }
      const blankId = question.blanks[0]?.id ?? "blank_1";
      fields.push({
        fieldId: `blank:${blankId}`,
        label: "简答：文本答案",
        controlKind: "TEXTAREA",
        value: { kind: "TEXT", text },
        optionId: null,
        blankId
      });
      break;
    }
    default:
      return { ok: false, code: "CONTROL_UNSUPPORTED", detail: "unsupported question type" };
  }

  return { ok: true, fields };
}

export function planReviewDigest(question: StudyQuestion, answer: ReviewedAnswer): string {
  return digestReviewedAnswer(computeQuestionFingerprint(question), answer);
}

export function describePlannedValue(value: ReviewedFieldValue): string {
  switch (value.kind) {
    case "TEXT":
      return value.text;
    case "RADIO":
      return value.optionId;
    case "CHECKBOX":
      return value.checked ? `勾选 ${value.optionId}` : `取消勾选 ${value.optionId}`;
    case "SELECT":
      return value.optionId;
    default:
      return "(未知)";
  }
}
