import type { StudyAnswer, StudyQuestion } from "@study/contracts";
import { parseReviewedAnswer } from "../shared/messages";
import type { CommandFailureCode } from "../shared/types";

export type TaskKind = "QUIZ" | "VIDEO" | "RESOURCE" | "MATERIAL" | "DISCUSSION" | "COMPLETED" | "UNKNOWN";
/**
 * Redacted, DOM-structure-only diagnostics (0.2.8 §8 D1, M0). Every field is a count or a short
 * enum-like value: NO question text, answer, URL, HTML, cookie or course identifier ever enters
 * this object. It lets a failing machine paste one safe line back for analysis without leaking
 * private content (privacy.md). The runner page renders/copies it verbatim; nothing is uploaded.
 */
export interface TaskDiagnostics {
  documents: number;
  iframes: number;
  cardsFrames: number;
  cardNumPresent: boolean;
  modules: number;
  moduleKind: "VIDEO" | "QUIZ" | "RESOURCE" | "DISCUSSION" | "UNKNOWN" | "none";
  activeModule: number;
  anomalies: number;
  markerTotal: number;
  markerCompleted: number;
  markerUnreadable: number;
  videoCount: number;
  videoReadyState: number;
  videoSeekable: number;
  currentTime: number;
  duration: number;
  ended: boolean;
  paused: boolean;
  pdfReady: boolean;
  scrollableCandidates: number;
  submitCandidates: number;
}
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
  /** A separately opened discussion reply; publication requires its own result evidence. */
  discussionReply?: boolean;
  /** Structure-only diagnostic counters (0.2.8 §8 D1). Optional so fixtures can omit it. */
  diagnostics?: TaskDiagnostics;
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
export type AutomationAction = "INSPECT" | "READ_ONE" | "READ_ALL" | "CAPTURE" | "ADOPT_EXISTING" | "APPLY" | "SEND_WORK" | "CONFIRM_WORK" | "NEXT" | "CONFIRM_NEXT" | "PLAY" | "PAUSE_VIDEO" | "ENUM_POPUP" | "SEEK_TAIL" | "PLAY_FROM_START" | "SCROLL_MATERIAL" | "SWITCH_SECTION_TAB" | "OPEN_DISCUSSION" | "RELEASE";
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
/**
 * Result of a seek-to-tail attempt on a site video (0.2.8 §3, 2026-10-21 用户授权：站点允许
 * 拖动时定位到末尾以触发站点自己的完成判定). Only structural media facts are reported —
 * currentTime/duration numbers and a short reason — never any page text, and no synthetic
 * mouse/pointer events or fabricated `ended`/`timeupdate`. The runner treats `applied` as a
 * hint to start watching for the site's own green completion mark; a rolled-back currentTime
 * means the site refused seeking and the runner falls back to full playback.
 */
export interface SeekOutcome {
  seekable: boolean;
  applied: boolean;
  currentTime: number;
  duration: number;
  reason: string;
}
/**
 * Result of a structural scroll-to-bottom on an opened PDF/PPT material module (0.2.8 §4).
 * Only counters and booleans: whether a scrollable container was found, whether scrolling
 * actually moved, whether the bottom was reached, and how many steps ran. Reading duration is
 * never fabricated — completion still requires the site's own green mark.
 */
export interface ScrollOutcome {
  containerFound: boolean;
  scrolled: boolean;
  reachedBottom: boolean;
  steps: number;
}
/**
 * Result of switching one of the chapter's horizontal tabs (1 学习内容 / 2 讨论 / 3 教学课件 /
 * 4 教学视频 / 5 评估测试) via the site's own `changeDisplayContent`, which rewrites the content
 * iframe's `num` query parameter (0.2.8 §N, 2026-10-21 用户授权处理横向标签). Only structural
 * tab-bar facts are reported — tab count, the requested index, whether that tab is now marked
 * active, and the card `num` the content iframe now shows. `activeLabel` is the site's own short
 * section title (a generic UI-chrome word such as "讨论"), never a course name or task text.
 * `confirmed` is false when the site did not move the active class or the iframe never loaded the
 * requested section; the runner must then stop rather than assume the section is reachable.
 */
export interface SectionTabsOutcome {
  tabs: number;
  requested: number;
  activeIndex: number;
  confirmed: boolean;
  loadedNum: number | null;
  activeLabel: string;
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
  /**
   * SWITCH_SECTION_TAB only: the 1-based horizontal tab to activate
   * (1 学习内容 / 2 讨论 / 3 教学课件 / 4 教学视频 / 5 评估测试). The page maps the click
   * to the site's own `changeDisplayContent`, so an out-of-range or non-integer value is
   * rejected rather than turning into a page-side navigation to an unknown section.
   */
  sectionIndex?: number;
}
export type AutomationResponse =
  | { ok: true; snapshot?: TaskSnapshot; captured?: TaskQuestion; questions?: TaskQuestion[]; existingAccepted?: boolean; popup?: PopupOutcome; seek?: SeekOutcome; scroll?: ScrollOutcome; section?: SectionTabsOutcome; discussionTabId?: number; discussionUrl?: string; nextNotice?: NextNoticeOutcome }
  | { ok: false; code: CommandFailureCode; detail: string; questionIssue?: "IMAGE_UNREADABLE"; captured?: TaskQuestion };

const QUESTION_TYPES: readonly string[] = ["SINGLE_CHOICE", "MULTIPLE_CHOICE", "TRUE_FALSE", "FILL_BLANK", "SHORT_ANSWER", "UNKNOWN"];
const ACTIONS: readonly string[] = ["INSPECT", "READ_ONE", "READ_ALL", "CAPTURE", "ADOPT_EXISTING", "APPLY", "SEND_WORK", "CONFIRM_WORK", "NEXT", "CONFIRM_NEXT", "PLAY", "PAUSE_VIDEO", "ENUM_POPUP", "SEEK_TAIL", "PLAY_FROM_START", "SCROLL_MATERIAL", "SWITCH_SECTION_TAB", "OPEN_DISCUSSION", "RELEASE"];
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
    ...(["NEXT", "CONFIRM_NEXT"].includes(v.action as string) && v.allowSkipUnfinished === true ? { allowSkipUnfinished: true } : {}),
    // SWITCH_SECTION_TAB maps a 1-based horizontal tab (1..5) to the page-side 0-based index. An
    // out-of-range, non-integer or action-mismatched value is dropped so the adapter never navigates
    // to an unknown section; the page then reports a missing sectionIndex rather than guessing.
    ...(v.action === "SWITCH_SECTION_TAB" && typeof v.sectionIndex === "number" && Number.isInteger(v.sectionIndex) &&
      v.sectionIndex >= 1 && v.sectionIndex <= 5 ? { sectionIndex: v.sectionIndex } : {}) };
}

/**
 * Relay one automation command to the course tab through the trusted service worker.
 * 0.2.8 §P8 (M0): a hung content script must not stall the runner forever, so the round trip is
 * bounded by a hard timeout. The default 30s is generous for read/submit while still recovering
 * from a wedged page; the timeout is returned as a structured failure, never thrown.
 */
export async function sendAutomationCommand(tabId: number, command: AutomationCommand, timeoutMs = 30000): Promise<AutomationResponse> {
  const request: Promise<unknown> = chrome.runtime.sendMessage({ type: "AUTOMATION_COMMAND", tabId, command });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("COMMAND_TIMEOUT")), Math.max(1000, timeoutMs)); });
  try {
    const result: unknown = await Promise.race([request, timeout]);
    if (typeof result !== "object" || result === null || typeof (result as Record<string, unknown>).ok !== "boolean") {
      return { ok: false, code: "INVALID_COMMAND", detail: "课程页面返回无效响应。" };
    }
    return result as AutomationResponse;
  } catch (error) {
    if (error instanceof Error && error.message === "COMMAND_TIMEOUT") {
      return { ok: false, code: "COMMAND_TIMEOUT", detail: "课程页面无响应（命令超时）。请确认课程标签仍在该页面。" };
    }
    return { ok: false, code: "TAB_UNAVAILABLE", detail: "课程页面通信失败，请检查标签是否已关闭或正在导航。" };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
