import type { StudyAnswer, StudyQuestion } from "@study/contracts";
import { parseReviewedAnswer } from "../shared/messages";
import type { CommandFailureCode } from "../shared/types";

export type TaskKind = "QUIZ" | "VIDEO" | "RESOURCE" | "MATERIAL" | "COMPLETED" | "UNKNOWN";
export interface TaskSnapshot {
  courseKey: string;
  taskKey: string;
  kind: TaskKind;
  questionCount: number;
  completed: boolean;
  hasNext: boolean;
  video: { paused: boolean; ended: boolean; currentTime: number; duration: number; error: boolean } | null;
  /**
   * True for the standalone 作业/测验 answer page (`/mooc-ans/mooc2/work/dowork`, 2026-10-20
   * 用户授权纳入刷题自动运行). It is a single quiz with its own submit button and no task
   * chain: there is no next task to click, so the runner submits once and stops.
   */
  standalone?: boolean;
}
/**
 * How the page itself accepts the answer. Non-paste questions do not necessarily use a
 * rich-text editor: some use plain inputs, some only a custom widget with no readable value.
 * "NONE" means the page exposes no writable/readable control we have evidence for.
 */
export type AnswerMode = "UEDITOR" | "LAZY_UEDITOR" | "CONTENTEDITABLE" | "TEXT_FIELD" | "NONE";
export interface TaskQuestion {
  index: number;
  fingerprint: string;
  question: StudyQuestion;
  needsImage?: boolean;
  sourceReason?: string;
  /**
   * Which pipeline produced the attached image: the composite canvas render ("render") or the
   * original <img> bytes at natural size ("originals"). The originals pass is the automatic
   * secondary processing authorized on 2026-10-20 for pure-image questions.
   */
  imageSource?: "render" | "originals";
  /** Whole-question retry must never silently discard images for a text-only provider. */
  imageRequired?: boolean;
  /** Set for text-answer questions; undefined for choice questions. */
  answerMode?: AnswerMode;
  /** Learner-facing reason when answerMode is "NONE". */
  answerReason?: string;
  /**
   * True when readQuestionSource recovered usable stem text and option text, so the model can
   * still be asked without the rendered image. needsImage=true can coexist with this (a
   * question with a diagram whose text is readable); image-only/font-unknown questions cannot.
   */
  textUsable?: boolean;
}
export type AutomationAction = "INSPECT" | "READ_ONE" | "READ_ALL" | "CAPTURE" | "ADOPT_EXISTING" | "APPLY" | "SEND_WORK" | "CONFIRM_WORK" | "NEXT" | "CONFIRM_NEXT" | "PLAY" | "PAUSE_VIDEO" | "ENUM_POPUP" | "RELEASE";
export type NextNoticeOutcome = "LEARN_REMAINING" | "SKIP_CONFIRMED";
/**
 * Result of one bounded enumeration pass over a video popup question (弹题). Only counts are
 * reported: popup option text and answers never leave the page document, and no model is
 * called (2026-10-19 授权：只有答对视频才会继续，允许免人工枚举)。
 */
export interface PopupOutcome {
  found: boolean;
  resolved: boolean;
  attempts: number;
  options: number;
}
export interface AutomationCommand {
  action: AutomationAction;
  requestId: string;
  runId: string;
  courseKey?: string;
  taskKey?: string;
  index?: number;
  fingerprint?: string;
  answer?: StudyAnswer;
  /** CAPTURE only: render the question image even when decoded text looks usable. */
  forceImage?: boolean;
  /**
   * CAPTURE only: "originals" reads the original image bytes at natural size instead of the
   * composite render. Used for the automatic secondary processing when text cannot be read,
   * the composite render fails, or the model reports the composite image as unreadable.
   */
  imagePass?: "render" | "originals" | "whole";
  /** APPLY only: corrected question type when the page label was misread. */
  questionType?: StudyQuestion["type"];
  /**
   * NEXT/CONFIRM_NEXT only: an intentional skip of an unfinished task point — 刷题模式 (skipVideos) leaves a
   * VIDEO behind, 只刷课模式 (videosOnly) leaves a QUIZ or opened PDF/PPT RESOURCE behind. The page may advance only when the
   * caller states this explicitly; every other unfinished non-MATERIAL task stays refused.
   * Never set it for a task the runner is expected to complete.
   */
  allowSkipUnfinished?: boolean;
}
export type AutomationResponse =
  | { ok: true; snapshot?: TaskSnapshot; captured?: TaskQuestion; questions?: TaskQuestion[]; existingAccepted?: boolean; popup?: PopupOutcome; nextNotice?: NextNoticeOutcome }
  | { ok: false; code: CommandFailureCode; detail: string; questionIssue?: "IMAGE_UNREADABLE"; captured?: TaskQuestion };

const QUESTION_TYPES: readonly string[] = ["SINGLE_CHOICE", "MULTIPLE_CHOICE", "TRUE_FALSE", "FILL_BLANK", "SHORT_ANSWER", "UNKNOWN"];
const ACTIONS: readonly string[] = ["INSPECT", "READ_ONE", "READ_ALL", "CAPTURE", "ADOPT_EXISTING", "APPLY", "SEND_WORK", "CONFIRM_WORK", "NEXT", "CONFIRM_NEXT", "PLAY", "PAUSE_VIDEO", "ENUM_POPUP", "RELEASE"];
const ID = /^[A-Za-z0-9_-]{1,128}$/;

export function parseAutomationCommand(value: unknown): AutomationCommand | null {
  if (typeof value !== "object" || value === null || JSON.stringify(value).length > 24000) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.action !== "string" || !ACTIONS.includes(v.action) ||
      typeof v.requestId !== "string" || !ID.test(v.requestId) ||
      typeof v.runId !== "string" || !ID.test(v.runId)) return null;
  if (v.action !== "INSPECT" &&
      (typeof v.courseKey !== "string" || !ID.test(v.courseKey) || typeof v.taskKey !== "string" || !ID.test(v.taskKey))) return null;
  if (["READ_ONE", "CAPTURE", "ADOPT_EXISTING", "APPLY"].includes(v.action) &&
      (typeof v.index !== "number" || !Number.isInteger(v.index) || v.index < 0 || v.index > 199)) return null;
  if (v.action === "APPLY") {
    if (typeof v.fingerprint !== "string" || !ID.test(v.fingerprint)) return null;
    if (v.questionType !== undefined && (typeof v.questionType !== "string" || !QUESTION_TYPES.includes(v.questionType))) return null;
    const parsed = parseReviewedAnswer({ ...(typeof v.answer === "object" && v.answer !== null ? v.answer : {}), reviewedAt: Date.now() });
    if (!parsed.ok) return null;
    return { action: "APPLY", requestId: v.requestId, runId: v.runId, courseKey: String(v.courseKey),
      taskKey: String(v.taskKey), index: Number(v.index), fingerprint: v.fingerprint, answer: parsed.value,
      ...(typeof v.questionType === "string" ? { questionType: v.questionType as StudyQuestion["type"] } : {}) };
  }
  return { action: v.action as AutomationAction, requestId: v.requestId, runId: v.runId,
    ...(typeof v.courseKey === "string" ? { courseKey: v.courseKey } : {}),
    ...(typeof v.taskKey === "string" ? { taskKey: v.taskKey } : {}),
    ...(typeof v.index === "number" ? { index: v.index } : {}),
    ...(v.action === "CAPTURE" && v.forceImage === true ? { forceImage: true } : {}),
    // The originals pass is a strict CAPTURE sub-mode; any other value or action drops it and
    // falls back to the composite render instead of inventing a page-side pipeline.
    ...(v.action === "CAPTURE" && (v.imagePass === "originals" || v.imagePass === "whole") ? { imagePass: v.imagePass } : {}),
    // Only explicit navigation commands may admit a mode-authorized unfinished task; a truthy string or a
    // value attached to another action is dropped instead of becoming a page-side skip permission.
    ...(["NEXT", "CONFIRM_NEXT"].includes(v.action as string) && v.allowSkipUnfinished === true ? { allowSkipUnfinished: true } : {}) };
}

export async function sendAutomationCommand(tabId: number, command: AutomationCommand): Promise<AutomationResponse> {
  const result: unknown = await chrome.runtime.sendMessage({ type: "AUTOMATION_COMMAND", tabId, command });
  if (typeof result !== "object" || result === null || typeof (result as Record<string, unknown>).ok !== "boolean") {
    return { ok: false, code: "INVALID_COMMAND", detail: "课程页面返回无效响应。" };
  }
  return result as AutomationResponse;
}
