import type { StudyOption, StudyBlank, StudyQuestion, QuestionType } from "@study/contracts";
import {
  MAX_BLANKS,
  MAX_ID_LENGTH,
  MAX_OPTIONS,
  MAX_OPTION_TEXT_LENGTH,
  MAX_STEM_LENGTH,
  BOUNDED_RENDER_SETTLE_MS
} from "../shared/limits";
import type { LocalErrorCode } from "../shared/codes";
import type {
  CaptureContext,
  CapturedQuestion,
  CandidateSummary,
  ControlKind,
  FieldEvent,
  FillFieldResult,
  FillResult,
  PageKind,
  PlanFieldPreview,
  PlanPreview,
  PreconditionCheck,
  ReviewedAnswer
} from "../shared/types";
import { computeQuestionFingerprint, createCaptureContext } from "../capture/context";
import { normalizeCapturedText, truncateText } from "../capture/normalize";
import { buildPlannedFields } from "../review/plan";
import { digestReviewedAnswer } from "../review/guard";
import { sha256Hex } from "../shared/sha256";
import {
  detectControlKind,
  valueToText,
  valuesEqual,
  writerForKind,
  type ReviewedFieldValue
} from "../adapters/control-writers";
import type {
  CaptureIdentity,
  CaptureOutcome,
  FieldResolutionResult,
  FillPlanInternal,
  FixtureEventPolicy,
  PageAdapter,
  PageMatch,
  PlanBuildResult,
  PlanFieldInternal,
  RevalidationResult
} from "./types";

const ADAPTER_ID = "fixture.practice";
const ADAPTER_VERSION = "1.0.0";
const QUESTION_ID = "q_1";

/**
 * Synthetic Fixture fixture ids. This adapter deliberately only matches pages that opt in with
 * data-fixture markers. No real Xuexitong class names, ids or DOM paths are used or guessed.
 */
const SUPPORTED_FIXTURES = new Set([
  "practice",
  "graded",
  "changed-question",
  "prompt-injection",
  "no-paste",
  "selection-disabled",
  "controlled-input",
  "readonly-field",
  "autosubmit-field",
  "iframe-question"
]);
const FILLABLE_FIXTURES = new Set([
  "practice",
  "changed-question",
  "prompt-injection",
  "no-paste",
  "selection-disabled",
  "controlled-input",
  "readonly-field",
  "iframe-question"
]);
const VERIFIED_EVENTS: readonly FieldEvent[] = ["input", "change"];
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

interface ScopeResolution {
  topDocument: Document;
  scopeDocument: Document;
  fixture: string | null;
  viaFrame: boolean;
  denied: boolean;
  evidence: string[];
  deniedDetail: string;
}

interface ScopeState {
  resolution: ScopeResolution;
  pageKind: PageKind;
  eventPolicy: FixtureEventPolicy;
  matchEvidence: string[];
}

interface LastCapture {
  scope: ScopeState;
  container: Element;
  containerIndex: number;
  captured: CapturedQuestion;
}

function readFixture(document: Document): string | null {
  const rootValue = document.documentElement?.getAttribute("data-fixture");
  if (rootValue) {
    return rootValue;
  }
  const bodyValue = document.body?.getAttribute("data-fixture");
  if (bodyValue) {
    return bodyValue;
  }
  const meta = document.querySelector('meta[name="study-fixture"]');
  return meta?.getAttribute("content") ?? null;
}

function readPageKindAttribute(document: Document): PageKind | null {
  const raw = (
    document.documentElement?.getAttribute("data-page-kind") ??
    document.body?.getAttribute("data-page-kind") ??
    ""
  ).toUpperCase();
  if (raw === "PRACTICE" || raw === "GRADED" || raw === "UNKNOWN") {
    return raw;
  }
  return null;
}

function resolveScope(document: Document): ScopeResolution {
  const fixture = readFixture(document);
  if (fixture === "iframe-question") {
    const frameElement = document.querySelector("iframe#question-frame");
    if (!frameElement || frameElement.tagName !== "IFRAME") {
      return {
        topDocument: document,
        scopeDocument: document,
        fixture,
        viaFrame: false,
        denied: true,
        evidence: ["FRAME_ACCESS_DENIED", "iframe:#question-frame:missing"],
        deniedDetail: "the same-origin question frame is missing"
      };
    }
    let frameDocument: Document | null = null;
    try {
      frameDocument = (frameElement as HTMLIFrameElement).contentDocument;
    } catch {
      frameDocument = null;
    }
    if (!frameDocument || !frameDocument.documentElement) {
      return {
        topDocument: document,
        scopeDocument: document,
        fixture,
        viaFrame: false,
        denied: true,
        evidence: ["FRAME_ACCESS_DENIED", "iframe:#question-frame:not-readable"],
        deniedDetail: "the question frame has no same-origin document access"
      };
    }
    return {
      topDocument: document,
      scopeDocument: frameDocument,
      fixture,
      viaFrame: true,
      denied: false,
      evidence: ["iframe:same-origin:question-frame"],
      deniedDetail: ""
    };
  }
  return {
    topDocument: document,
    scopeDocument: document,
    fixture,
    viaFrame: false,
    denied: false,
    evidence: [],
    deniedDetail: ""
  };
}

function resolvePageKind(topDocument: Document, scopeDocument: Document, fixture: string | null): PageKind {
  return (
    readPageKindAttribute(scopeDocument) ??
    readPageKindAttribute(topDocument) ??
    (fixture === "graded" ? "GRADED" : fixture && SUPPORTED_FIXTURES.has(fixture) ? "PRACTICE" : "UNKNOWN")
  );
}

function readEventPolicy(topDocument: Document, scopeDocument: Document, fixture: string | null): FixtureEventPolicy {
  const evidence: string[] = [];
  const values = [
    scopeDocument.documentElement?.getAttribute("data-events-side-effect"),
    topDocument.documentElement?.getAttribute("data-events-side-effect"),
    scopeDocument.body?.getAttribute("data-events-side-effect"),
    topDocument.body?.getAttribute("data-events-side-effect")
  ];
  const firstContainer = scopeDocument.querySelector("[data-question-container]");
  if (firstContainer) {
    values.push(firstContainer.getAttribute("data-events-side-effect"));
  }
  if (values.some((value) => (value ?? "").toUpperCase() === "AUTOSUBMIT")) {
    evidence.push("events:autosubmit-marker");
    return { verified: false, events: [], evidence };
  }
  if (fixture === "autosubmit-field") {
    evidence.push("events:autosubmit-fixture");
    return { verified: false, events: [], evidence };
  }
  evidence.push("events:verified-fixture");
  return { verified: true, events: VERIFIED_EVENTS, evidence };
}

function isHidden(element: Element): boolean {
  let current: Element | null = element;
  while (current) {
    if (current.hasAttribute("hidden")) {
      return true;
    }
    const style = (current as HTMLElement).style;
    if (style && (style.display === "none" || style.visibility === "hidden")) {
      return true;
    }
    if (current.getAttribute("aria-hidden") === "true") {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}

function mapQuestionType(raw: string): QuestionType {
  switch ((raw || "UNKNOWN").toUpperCase()) {
    case "SINGLE_CHOICE":
      return "SINGLE_CHOICE";
    case "MULTIPLE_CHOICE":
      return "MULTIPLE_CHOICE";
    case "TRUE_FALSE":
      return "TRUE_FALSE";
    case "FILL_BLANK":
      return "FILL_BLANK";
    case "SHORT_ANSWER":
      return "SHORT_ANSWER";
    default:
      return "UNKNOWN";
  }
}

interface BuiltQuestion {
  question: StudyQuestion;
  unknownEditor: boolean;
}

type BuildQuestionResult =
  | { ok: true; built: BuiltQuestion }
  | { ok: false; code: LocalErrorCode; detail: string };

function buildQuestion(container: Element): BuildQuestionResult {
  const stemElement = container.querySelector("[data-question-stem]");
  const stem = normalizeCapturedText(stemElement?.textContent ?? "");
  if (!stem) {
    return { ok: false, code: "QUESTION_AMBIGUOUS", detail: "question stem is missing or empty" };
  }
  if (stem.length > MAX_STEM_LENGTH) {
    return { ok: false, code: "QUESTION_AMBIGUOUS", detail: "question stem exceeds the length limit" };
  }

  const options: StudyOption[] = [];
  for (const node of Array.from(container.querySelectorAll("[data-option]"))) {
    const optionId = node.getAttribute("data-option-id") ?? "";
    if (!ID_PATTERN.test(optionId) || optionId.length > MAX_ID_LENGTH) {
      return { ok: false, code: "QUESTION_AMBIGUOUS", detail: "option is missing a valid data-option-id" };
    }
    if (options.some((option) => option.id === optionId)) {
      return { ok: false, code: "QUESTION_AMBIGUOUS", detail: `duplicate option id ${optionId}` };
    }
    const textNode = node.querySelector("[data-option-text]");
    const text = normalizeCapturedText(textNode?.textContent ?? node.textContent ?? "");
    if (!text) {
      return { ok: false, code: "QUESTION_AMBIGUOUS", detail: `option ${optionId} has empty text` };
    }
    if (text.length > MAX_OPTION_TEXT_LENGTH) {
      return { ok: false, code: "QUESTION_AMBIGUOUS", detail: `option ${optionId} is too long` };
    }
    options.push({ id: optionId, text });
  }
  if (options.length > MAX_OPTIONS) {
    return { ok: false, code: "QUESTION_AMBIGUOUS", detail: "too many options" };
  }

  const blanks: StudyBlank[] = [];
  for (const node of Array.from(container.querySelectorAll("[data-blank], [data-answer-text]"))) {
    let blankId = node.getAttribute("data-blank-id") ?? "";
    if (!blankId && node.hasAttribute("data-answer-text")) {
      blankId = `blank_${blanks.length + 1}`;
    }
    if (!ID_PATTERN.test(blankId) || blankId.length > MAX_ID_LENGTH) {
      return { ok: false, code: "QUESTION_AMBIGUOUS", detail: "blank is missing a valid data-blank-id" };
    }
    if (blanks.some((blank) => blank.id === blankId)) {
      continue;
    }
    const label = normalizeCapturedText(
      node.getAttribute("data-blank-label") ??
        node.getAttribute("aria-label") ??
        node.getAttribute("placeholder") ??
        `空格 ${blanks.length + 1}`
    );
    blanks.push({ id: blankId, label: label || `空格 ${blanks.length + 1}` });
  }
  if (blanks.length > MAX_BLANKS) {
    return { ok: false, code: "QUESTION_AMBIGUOUS", detail: "too many blanks" };
  }

  const unknownEditor =
    container.matches("[contenteditable], [data-unknown-editor]") ||
    container.querySelector("[contenteditable], [data-unknown-editor]") !== null;
  const declaredType = mapQuestionType(container.getAttribute("data-question-type") ?? "UNKNOWN");
  const type = unknownEditor ? "UNKNOWN" : declaredType;

  if ((type === "SINGLE_CHOICE" || type === "TRUE_FALSE") && options.length === 0) {
    return { ok: false, code: "QUESTION_AMBIGUOUS", detail: "choice question has no options" };
  }
  if (type === "MULTIPLE_CHOICE" && options.length === 0) {
    return { ok: false, code: "QUESTION_AMBIGUOUS", detail: "multiple choice has no options" };
  }

  return {
    ok: true,
    built: {
      question: { id: QUESTION_ID, type, stem, options, blanks },
      unknownEditor
    }
  };
}

function optionIdOf(option: HTMLOptionElement): string {
  return option.getAttribute("data-option-id") ?? option.value;
}

function resolveBlankControls(container: Element, blankId: string): Element[] {
  const marked = Array.from(container.querySelectorAll("[data-blank-id]")).filter(
    (node) => node.getAttribute("data-blank-id") === blankId
  );
  const answerText = Array.from(container.querySelectorAll("[data-answer-text]")).filter(
    (node) => blankId === `blank_${Array.from(container.querySelectorAll("[data-answer-text]")).indexOf(node) + 1}`
  );
  const controls: Element[] = [];
  for (const node of [...marked, ...answerText]) {
    if (node.tagName === "INPUT" || node.tagName === "TEXTAREA") {
      controls.push(node);
      continue;
    }
    controls.push(...Array.from(node.querySelectorAll("input, textarea")));
  }
  return Array.from(new Set(controls));
}

function resolveOptionElement(container: Element, selector: string, optionId: string): Element[] {
  return Array.from(container.querySelectorAll(selector)).filter((node) => {
    if (node.tagName !== "INPUT") {
      return false;
    }
    return (node as HTMLInputElement).value === optionId;
  });
}

function resolveField(container: Element, planned: { controlKind: ControlKind; optionId: string | null; blankId: string | null }): FieldResolutionResult {
  switch (planned.controlKind) {
    case "TEXT_INPUT":
    case "TEXTAREA": {
      if (!planned.blankId) {
        return { ok: false, code: "QUESTION_AMBIGUOUS", detail: "text field has no blank id" };
      }
      const controls = resolveBlankControls(container, planned.blankId);
      if (controls.length === 0) {
        return { ok: false, code: "CONTROL_UNSUPPORTED", detail: `no writable control for blank ${planned.blankId}` };
      }
      if (controls.length > 1) {
        return { ok: false, code: "QUESTION_AMBIGUOUS", detail: `blank ${planned.blankId} is not unique` };
      }
      const target = controls[0]!;
      const kind = detectControlKind(target);
      if (kind !== "TEXT_INPUT" && kind !== "TEXTAREA") {
        return { ok: false, code: "CONTROL_UNSUPPORTED", detail: "blank does not resolve to a text control" };
      }
      return { ok: true, target, controlKind: kind, value: { kind: "TEXT", text: "" } };
    }
    case "RADIO": {
      if (!planned.optionId) {
        return { ok: false, code: "QUESTION_AMBIGUOUS", detail: "radio field has no option id" };
      }
      const radios = resolveOptionElement(container, 'input[type="radio"]', planned.optionId);
      if (radios.length === 1) {
        return {
          ok: true,
          target: radios[0]!,
          controlKind: "RADIO",
          value: { kind: "RADIO", optionId: planned.optionId }
        };
      }
      if (radios.length > 1) {
        return { ok: false, code: "QUESTION_AMBIGUOUS", detail: `option ${planned.optionId} has multiple radios` };
      }
      const selects = Array.from(container.querySelectorAll("select"));
      if (selects.length === 1) {
        const select = selects[0]!;
        const option = Array.from((select as HTMLSelectElement).options).find(
          (item) => optionIdOf(item) === planned.optionId
        );
        if (!option) {
          return { ok: false, code: "QUESTION_CHANGED", detail: "select option is missing" };
        }
        return {
          ok: true,
          target: select,
          controlKind: "SELECT",
          value: { kind: "SELECT", optionId: planned.optionId }
        };
      }
      if (selects.length > 1) {
        return { ok: false, code: "QUESTION_AMBIGUOUS", detail: "multiple select controls in the question" };
      }
      return { ok: false, code: "CONTROL_UNSUPPORTED", detail: "no radio or select control for this option" };
    }
    case "CHECKBOX": {
      if (!planned.optionId) {
        return { ok: false, code: "QUESTION_AMBIGUOUS", detail: "checkbox field has no option id" };
      }
      const checkboxes = resolveOptionElement(container, 'input[type="checkbox"]', planned.optionId);
      if (checkboxes.length === 0) {
        return { ok: false, code: "CONTROL_UNSUPPORTED", detail: "no checkbox for this option" };
      }
      if (checkboxes.length > 1) {
        return { ok: false, code: "QUESTION_AMBIGUOUS", detail: `option ${planned.optionId} has multiple checkboxes` };
      }
      return {
        ok: true,
        target: checkboxes[0]!,
        controlKind: "CHECKBOX",
        value: { kind: "CHECKBOX", optionId: planned.optionId, checked: planned.optionId !== "" }
      };
    }
    case "SELECT": {
      if (!planned.optionId) {
        return { ok: false, code: "QUESTION_AMBIGUOUS", detail: "select field has no option id" };
      }
      const selects = Array.from(container.querySelectorAll("select"));
      if (selects.length !== 1) {
        return { ok: false, code: "QUESTION_AMBIGUOUS", detail: "select control is not unique" };
      }
      return {
        ok: true,
        target: selects[0]!,
        controlKind: "SELECT",
        value: { kind: "SELECT", optionId: planned.optionId }
      };
    }
    case "CONTENTEDITABLE":
      return { ok: false, code: "CONTROL_UNSUPPORTED", detail: "contenteditable has no verified writer" };
    default:
      return { ok: false, code: "CONTROL_UNSUPPORTED", detail: "unsupported control kind" };
  }
}

function waitForRenderSettle(document: Document): Promise<number> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const view = document.defaultView;
    let finished = false;
    const finish = (): void => {
      if (!finished) {
        finished = true;
        resolve(Math.min(Date.now() - startedAt, 1000));
      }
    };
    const safety = setTimeout(finish, BOUNDED_RENDER_SETTLE_MS + 100);
    if (view && typeof view.requestAnimationFrame === "function") {
      view.requestAnimationFrame(() => {
        view.requestAnimationFrame(() => {
          clearTimeout(safety);
          finish();
        });
      });
    } else {
      clearTimeout(safety);
      setTimeout(finish, 16);
    }
  });
}

export class PracticeFixtureAdapter implements PageAdapter {
  readonly id = ADAPTER_ID;
  readonly version = ADAPTER_VERSION;

  private scope: ScopeState | null = null;
  private lastCapture: LastCapture | null = null;

  match(document: Document): PageMatch {
    const resolution = resolveScope(document);
    const pageKind = resolvePageKind(resolution.topDocument, resolution.scopeDocument, resolution.fixture);
    const eventPolicy = readEventPolicy(resolution.topDocument, resolution.scopeDocument, resolution.fixture);
    const evidence = [...resolution.evidence];

    if (resolution.denied) {
      evidence.push("FRAME_ACCESS_DENIED");
      this.scope = {
        resolution,
        pageKind: "UNKNOWN",
        eventPolicy,
        matchEvidence: evidence
      };
      return { matched: false, pageKind: "UNKNOWN", evidence };
    }
    if (!resolution.fixture || !SUPPORTED_FIXTURES.has(resolution.fixture)) {
      evidence.push(resolution.fixture ? `fixture:${resolution.fixture}` : "fixture:none", "NO_VERIFIED_ADAPTER");
      this.scope = { resolution, pageKind, eventPolicy, matchEvidence: evidence };
      return { matched: false, pageKind, evidence };
    }

    evidence.push(`fixture:${resolution.fixture}`, `pageKind:${pageKind}`, ...eventPolicy.evidence);
    if (pageKind !== "PRACTICE") {
      evidence.push("fill:disabled-by-page-kind");
    }
    if (resolution.viaFrame) {
      evidence.push("iframe:same-origin-only");
    }
    this.scope = { resolution, pageKind, eventPolicy, matchEvidence: evidence };
    return { matched: true, pageKind, evidence };
  }

  listCandidates(document: Document): CandidateSummary[] {
    if (!this.scope) {
      this.match(document);
    }
    const scope = this.scope;
    if (!scope || scope.resolution.denied) {
      return [];
    }
    const containers = Array.from(scope.resolution.scopeDocument.querySelectorAll("[data-question-container]"));
    return containers.map((container, index) => {
      const stem = normalizeCapturedText(
        container.querySelector("[data-question-stem]")?.textContent ?? ""
      );
      const unknownEditor =
        container.matches("[contenteditable], [data-unknown-editor]") ||
        container.querySelector("[contenteditable], [data-unknown-editor]") !== null;
      return {
        index,
        questionType: mapQuestionType(container.getAttribute("data-question-type") ?? "UNKNOWN"),
        stemPreview: truncateText(stem, 80),
        optionCount: container.querySelectorAll("[data-option]").length,
        blankCount: container.querySelectorAll("[data-blank], [data-answer-text]").length,
        unknownEditor
      };
    });
  }

  captureSelectedQuestion(
    document: Document,
    containerIndex: number,
    identity: CaptureIdentity,
    documentNonce: string
  ): CaptureOutcome {
    const match = this.match(document);
    const scope = this.scope;
    if (!scope || !scope.resolution.fixture || scope.resolution.denied) {
      if (scope?.resolution.denied) {
        return { ok: false, code: "FRAME_ACCESS_DENIED", detail: scope.resolution.deniedDetail };
      }
      if (match.pageKind === "GRADED") {
        return { ok: false, code: "PAGE_KIND_UNSUPPORTED", detail: "graded page blocks fill" };
      }
      return { ok: false, code: "ADAPTER_NOT_MATCHED", detail: "no verified adapter matched this page" };
    }
    if (match.pageKind === "GRADED") {
      return { ok: false, code: "PAGE_KIND_UNSUPPORTED", detail: "graded page blocks fill" };
    }
    const containers = Array.from(scope.resolution.scopeDocument.querySelectorAll("[data-question-container]"));
    if (containers.length === 0) {
      return { ok: false, code: "QUESTION_AMBIGUOUS", detail: "no question container found in the fixture" };
    }
    if (!Number.isInteger(containerIndex) || containerIndex < 0 || containerIndex >= containers.length) {
      return { ok: false, code: "QUESTION_AMBIGUOUS", detail: "question container index is out of range" };
    }
    const container = containers[containerIndex]!;
    if (isHidden(container)) {
      return { ok: false, code: "QUESTION_AMBIGUOUS", detail: "question container is hidden" };
    }
    const built = buildQuestion(container);
    if (!built.ok) {
      return { ok: false, code: built.code, detail: built.detail };
    }
    const question = built.built.question;
    const fingerprint = computeQuestionFingerprint(question);
    const context: CaptureContext = createCaptureContext({
      tabId: identity.tabId,
      frameId: identity.frameId,
      documentId: identity.documentId,
      documentNonce,
      adapterId: this.id,
      adapterVersion: this.version,
      questionFingerprint: fingerprint,
      capturedAt: Date.now()
    });

    let fillEligible = true;
    let fillBlockCode: LocalErrorCode | null = null;
    if (match.pageKind !== "PRACTICE") {
      fillEligible = false;
      fillBlockCode = "PAGE_KIND_UNSUPPORTED";
    } else if (!scope.eventPolicy.verified) {
      fillEligible = false;
      fillBlockCode = "EVENT_SIDE_EFFECT_UNVERIFIED";
    } else if (built.built.unknownEditor || question.type === "UNKNOWN") {
      fillEligible = false;
      fillBlockCode = "CONTROL_UNSUPPORTED";
    } else if (!scope.resolution.fixture || !FILLABLE_FIXTURES.has(scope.resolution.fixture)) {
      fillEligible = false;
      fillBlockCode = "ADAPTER_NOT_MATCHED";
    }

    const warnings: string[] = [
      "synthetic fixture only: no real Xuexitong DOM evidence exists for this adapter"
    ];
    if (scope.resolution.viaFrame) {
      warnings.push("question captured from a same-origin fixture iframe; cross-origin frames stay closed");
    }
    if (question.type === "UNKNOWN") {
      warnings.push("unknown question type: text learning only, fill disabled");
    }

    const captured: CapturedQuestion = {
      question,
      context,
      pageKind: match.pageKind,
      evidence: [...scope.matchEvidence],
      fillEligible,
      fillBlockCode,
      warnings
    };
    this.lastCapture = { scope, container, containerIndex, captured };
    return { ok: true, captured };
  }

  createFillPlan(
    captured: CapturedQuestion,
    reviewedAnswer: ReviewedAnswer,
    planId: string
  ): PlanBuildResult {
    if (!captured.fillEligible) {
      return {
        ok: false,
        code: captured.fillBlockCode ?? "PAGE_KIND_UNSUPPORTED",
        detail: "captured question is not eligible for fill"
      };
    }
    const last = this.lastCapture;
    if (
      !last ||
      last.captured.context.questionFingerprint !== captured.context.questionFingerprint ||
      last.captured.context.documentId !== captured.context.documentId
    ) {
      return { ok: false, code: "QUESTION_CHANGED", detail: "capture session no longer matches the question" };
    }
    const planned = buildPlannedFields(captured.question, reviewedAnswer);
    if (!planned.ok) {
      return { ok: false, code: planned.code, detail: planned.detail };
    }

    const fields: PlanFieldInternal[] = [];
    for (const plannedField of planned.fields) {
      const resolved = resolveField(last.container, plannedField);
      if (!resolved.ok) {
        return { ok: false, code: resolved.code, detail: resolved.detail };
      }
      if (resolved.controlKind !== plannedField.controlKind) {
        if (
          !(
            (plannedField.controlKind === "TEXT_INPUT" && resolved.controlKind === "TEXTAREA") ||
            (plannedField.controlKind === "TEXTAREA" && resolved.controlKind === "TEXT_INPUT") ||
            (plannedField.controlKind === "RADIO" && resolved.controlKind === "SELECT") ||
            (plannedField.controlKind === "SELECT" && resolved.controlKind === "SELECT")
          )
        ) {
          return { ok: false, code: "CONTROL_UNSUPPORTED", detail: "resolved control type differs from the planned type" };
        }
      }
      const writer = writerForKind(resolved.controlKind);
      if (!writer) {
        return { ok: false, code: "CONTROL_UNSUPPORTED", detail: "no writer for the resolved control" };
      }
      const value = resolved.controlKind === plannedField.controlKind ? plannedField.value : resolved.value;
      const check = writer.validate(resolved.target, value);
      if (!check.ok) {
        return { ok: false, code: check.code ?? "CONTROL_UNSUPPORTED", detail: check.detail };
      }
      fields.push({
        fieldId: plannedField.fieldId,
        label: plannedField.label,
        controlKind: resolved.controlKind,
        value,
        target: resolved.target,
        optionId: plannedField.optionId,
        blankId: plannedField.blankId,
        originalValue: writer.readBack(resolved.target)
      });
    }
    if (fields.length === 0) {
      return { ok: false, code: "CONTROL_UNSUPPORTED", detail: "the reviewed answer produced no fields" };
    }

    const reviewedAnswerDigest = digestReviewedAnswer(captured.context.questionFingerprint, reviewedAnswer);
    const plan: FillPlanInternal = {
      planId,
      adapterId: this.id,
      adapterVersion: this.version,
      context: captured.context,
      questionFingerprint: captured.context.questionFingerprint,
      pageKind: captured.pageKind,
      reviewedAnswer,
      reviewedAnswerDigest,
      planDigest: sha256Hex(`${planId}|${captured.context.questionFingerprint}|${reviewedAnswerDigest}`),
      question: captured.question,
      container: last.container,
      containerIndex: last.containerIndex,
      topDocument: last.scope.resolution.topDocument,
      document: last.scope.resolution.scopeDocument,
      eventPolicy: last.scope.eventPolicy.verified ? "VERIFIED" : "UNVERIFIED",
      fields,
      createdAt: Date.now(),
      consumed: false,
      blocked: false,
      blockCode: null
    };
    return { ok: true, plan };
  }

  toPlanPreview(plan: FillPlanInternal): PlanPreview {
    const fields: PlanFieldPreview[] = plan.fields.map((field) => {
      const writer = writerForKind(field.controlKind);
      const check = writer ? writer.validate(field.target, field.value) : { ok: false, code: "CONTROL_UNSUPPORTED" as const, detail: "" };
      const current = writer ? writer.readBack(field.target) : null;
      return {
        fieldId: field.fieldId,
        label: field.label,
        controlKind: field.controlKind,
        valueText: this.describeValue(plan, field),
        currentText: valueToText(current),
        ready: check.ok,
        code: check.ok ? null : (check.code ?? "CONTROL_UNSUPPORTED")
      };
    });
    return {
      planId: plan.planId,
      adapterId: plan.adapterId,
      adapterVersion: plan.adapterVersion,
      pageKind: plan.pageKind,
      questionFingerprint: plan.questionFingerprint,
      context: plan.context,
      createdAt: plan.createdAt,
      fields,
      blocked: plan.blocked,
      blockCode: plan.blockCode,
      eventPolicy: plan.eventPolicy,
      reviewedAnswerDigest: plan.reviewedAnswerDigest
    };
  }

  private describeValue(plan: FillPlanInternal, field: PlanFieldInternal): string {
    if (field.value.kind === "TEXT") {
      return field.value.text;
    }
    if (field.value.kind === "CHECKBOX") {
      const optionText = plan.question.options.find((item) => item.id === field.optionId)?.text ?? "";
      return `${field.value.checked ? "勾选" : "取消勾选"} ${optionText || field.optionId || ""}`.trim();
    }
    const optionId = field.value.kind === "RADIO" || field.value.kind === "SELECT" ? field.value.optionId : "";
    const optionText = plan.question.options.find((item) => item.id === optionId)?.text ?? "";
    return optionText || optionId;
  }

  revalidate(
    plan: FillPlanInternal,
    identity: CaptureIdentity,
    confirmationAvailable: boolean
  ): RevalidationResult {
    const checks: PreconditionCheck[] = [];
    let firstCode: LocalErrorCode | null = null;
    const add = (id: string, label: string, ok: boolean, code: LocalErrorCode, detail: string): void => {
      checks.push({ id, label, ok, code: ok ? null : code, detail });
      if (!ok && firstCode === null) {
        firstCode = code;
      }
    };

    const documentOk =
      plan.context.tabId === identity.tabId &&
      plan.context.frameId === identity.frameId &&
      plan.context.documentId === identity.documentId &&
      plan.context.documentNonce === identity.documentNonce;
    add("DOCUMENT_IDENTITY", "tab、框架与文档标识一致", documentOk, "DOCUMENT_CHANGED", "document identity changed");

    const match = this.match(plan.topDocument);
    const pageKindOk = match.matched && match.pageKind === "PRACTICE" && plan.pageKind === "PRACTICE";
    add("PAGE_KIND_PRACTICE", "页面类型为受支持练习", pageKindOk, "PAGE_KIND_UNSUPPORTED", `pageKind=${match.pageKind}`);

    const containerOk = plan.container.isConnected && plan.document.contains(plan.container);
    add("CONTAINER_PRESENT", "题目容器仍然存在", containerOk, "DOCUMENT_CHANGED", "question container is detached");

    if (containerOk) {
      const recapture = this.captureSelectedQuestion(plan.topDocument, plan.containerIndex, identity, identity.documentNonce);
      if (recapture.ok && recapture.captured.context.documentId !== identity.documentId) {
        add("DOCUMENT_IDENTITY", "tab、框架与文档标识一致", false, "DOCUMENT_CHANGED", "capture document identity changed");
      }
      if (!recapture.ok) {
        add("QUESTION_FINGERPRINT", "题目指纹一致", false, recapture.code, recapture.detail);
      } else {
        const fingerprintOk = recapture.captured.context.questionFingerprint === plan.questionFingerprint;
        add(
          "QUESTION_FINGERPRINT",
          "题目指纹一致",
          fingerprintOk,
          "QUESTION_CHANGED",
          "question text, options or blank mapping changed"
        );
        const digestOk =
          digestReviewedAnswer(recapture.captured.context.questionFingerprint, plan.reviewedAnswer) ===
          plan.reviewedAnswerDigest;
        add("REVIEWED_ANSWER_CONSISTENT", "审核答案与回填计划一致", digestOk, "QUESTION_CHANGED", "reviewed answer digest changed");
      }
    }

    let fieldsOk = true;
    let fieldCode: LocalErrorCode | null = null;
    let fieldDetail = "";
    if (containerOk) {
      for (const field of plan.fields) {
        if (!field.target.isConnected) {
          fieldsOk = false;
          fieldCode = "DOCUMENT_CHANGED";
          fieldDetail = "field target is detached";
          break;
        }
        const resolved = resolveField(plan.container, {
          controlKind: field.controlKind,
          optionId: field.optionId,
          blankId: field.blankId
        });
        if (!resolved.ok) {
          fieldsOk = false;
          fieldCode = resolved.code;
          fieldDetail = resolved.detail;
          break;
        }
        if (resolved.target !== field.target) {
          fieldsOk = false;
          fieldCode = "QUESTION_AMBIGUOUS";
          fieldDetail = `field ${field.fieldId} no longer resolves to the same control`;
          break;
        }
        const writer = writerForKind(field.controlKind);
        const check = writer ? writer.validate(field.target, field.value) : { ok: false, code: "CONTROL_UNSUPPORTED" as const, detail: "" };
        if (!check.ok) {
          fieldsOk = false;
          fieldCode = check.code ?? "FIELD_READ_ONLY";
          fieldDetail = check.detail;
          break;
        }
      }
    } else {
      fieldsOk = false;
      fieldCode = "DOCUMENT_CHANGED";
      fieldDetail = "container is gone";
    }
    add("FIELDS_READY", "目标字段唯一、可见、启用且可编辑", fieldsOk, fieldCode ?? "FIELD_READ_ONLY", fieldDetail || "all fields ready");

    add(
      "EVENT_POLICY_VERIFIED",
      "事件副作用已验证",
      plan.eventPolicy === "VERIFIED",
      "EVENT_SIDE_EFFECT_UNVERIFIED",
      "event side effects are not verified for this fixture"
    );

    add(
      "CONFIRMATION_PENDING",
      "单次确认有效",
      confirmationAvailable && !plan.consumed,
      "CONFIRMATION_EXPIRED",
      "confirmation is missing, consumed or expired"
    );

    return { ok: firstCode === null, code: firstCode, checks };
  }

  async apply(plan: FillPlanInternal): Promise<FillResult> {
    const fieldResults: FillFieldResult[] = plan.fields.map((field) => ({
      fieldId: field.fieldId,
      label: field.label,
      status: "SKIPPED",
      errorCode: null,
      expectedText: "",
      readBackText: ""
    }));
    const written: Array<{ field: PlanFieldInternal; writer: NonNullable<ReturnType<typeof writerForKind>> }> = [];
    let errorCode: LocalErrorCode | null = null;
    let boundedCheckMs = 0;

    for (let index = 0; index < plan.fields.length; index += 1) {
      const field = plan.fields[index]!;
      const result = fieldResults[index]!;
      result.expectedText = valueToText(field.value);
      if (!field.target.isConnected || !plan.document.contains(field.target)) {
        errorCode = "DOCUMENT_CHANGED";
        result.status = "FAILED";
        result.errorCode = errorCode;
        break;
      }
      const writer = writerForKind(field.controlKind);
      if (!writer) {
        errorCode = "CONTROL_UNSUPPORTED";
        result.status = "FAILED";
        result.errorCode = errorCode;
        break;
      }
      const check = writer.validate(field.target, field.value);
      if (!check.ok) {
        errorCode = check.code ?? "FIELD_READ_ONLY";
        result.status = "FAILED";
        result.errorCode = errorCode;
        break;
      }
      const before = writer.readBack(field.target);
      const outcome = writer.write(field.target, field.value, { events: VERIFIED_EVENTS });
      if (!outcome.ok) {
        errorCode = outcome.code;
        result.status = "FAILED";
        result.errorCode = errorCode;
        break;
      }
      const immediate = writer.readBack(field.target);
      if (!valuesEqual(field.value, immediate)) {
        const reverted = before !== null && valuesEqual(before, immediate);
        errorCode = reverted ? "VALUE_REVERTED" : "VALUE_NOT_ACCEPTED";
        result.status = reverted ? "REVERTED" : "NOT_ACCEPTED";
        result.errorCode = errorCode;
        result.readBackText = valueToText(immediate);
        break;
      }
      result.status = "WRITTEN";
      result.readBackText = valueToText(immediate);
      written.push({ field, writer });
    }

    if (errorCode === null && written.length > 0) {
      boundedCheckMs = await waitForRenderSettle(plan.document);
      for (const fieldResult of fieldResults) {
        if (fieldResult.status !== "WRITTEN") {
          continue;
        }
        const entry = written.find((item) => item.field.fieldId === fieldResult.fieldId);
        if (!entry) {
          continue;
        }
        const actual = entry.writer.readBack(entry.field.target);
        fieldResult.readBackText = valueToText(actual);
        if (!valuesEqual(entry.field.value, actual)) {
          if (!entry.field.target.isConnected) {
            errorCode = "DOCUMENT_CHANGED";
            fieldResult.status = "FAILED";
          } else {
            const reverted = entry.field.originalValue !== null && valuesEqual(entry.field.originalValue, actual);
            errorCode = reverted ? "VALUE_REVERTED" : "VALUE_NOT_ACCEPTED";
            fieldResult.status = reverted ? "REVERTED" : "NOT_ACCEPTED";
          }
          fieldResult.errorCode = errorCode;
        }
      }
    }

    let persistedCount = 0;
    for (const fieldResult of fieldResults) {
      if (fieldResult.status === "WRITTEN" || fieldResult.status === "REVERTED" || fieldResult.status === "NOT_ACCEPTED") {
        const entry = written.find((item) => item.field.fieldId === fieldResult.fieldId);
        if (entry && valuesEqual(entry.field.value, entry.writer.readBack(entry.field.target))) {
          persistedCount += 1;
          if (fieldResult.status !== "WRITTEN") {
            fieldResult.status = "WRITTEN";
            fieldResult.errorCode = null;
          }
        }
      }
    }

    const status: FillResult["status"] =
      errorCode === null
        ? persistedCount === plan.fields.length
          ? "FILLED"
          : "PARTIAL_FILL"
        : persistedCount > 0
          ? "PARTIAL_FILL"
          : "FAILED";

    return {
      status,
      code: errorCode,
      writtenCount: written.length,
      persistedCount,
      totalCount: plan.fields.length,
      fields: fieldResults,
      verifiedAt: Date.now(),
      boundedCheckMs
    };
  }
}

export const practiceFixtureAdapter = new PracticeFixtureAdapter();