import { findAdapter } from "./registry";
import type { CaptureIdentity, FillPlanInternal, PageAdapter } from "./types";
import type {
  CandidateSummary,
  CapturedQuestion,
  CaptureContext
} from "../shared/types";
import type { PageCommand, PageResponse } from "../shared/messages";
import { asPageFailure, isPageCommandMessage, parsePageCommand } from "../shared/messages";
import { readSelectionText } from "../capture/selection";
import { normalizeCapturedText } from "../capture/normalize";
import { randomId, randomToken } from "../shared/ids";
import { sha256Hex } from "../shared/sha256";
import { MAX_PLAN_AGE_MS, MAX_SELECTION_TEXT_LENGTH } from "../shared/limits";

/**
 * Page entry injected with chrome.scripting.executeScript as a short-lived ISOLATED world script.
 * It only answers the four fixed page commands, keeps capture state in page memory, and never
 * touches storage, cookies, network or page-wide text. It is installed at most once per document.
 */

interface Session {
  documentId: string;
  documentNonce: string | null;
  adapter: PageAdapter | null;
  captured: CapturedQuestion | null;
  containerIndex: number | null;
  candidates: CandidateSummary[];
  plan: FillPlanInternal | null;
  consumedNonces: Set<string>;
  planConsumed: boolean;
}

interface ForwardedMeta {
  tabId: number;
  frameId: number;
}

const GUARD_KEY = "__studyAssistantPageEntryV1Installed";

function readForwardedMeta(value: unknown): ForwardedMeta | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const meta = (value as { _meta?: unknown })._meta;
  if (typeof meta !== "object" || meta === null) {
    return null;
  }
  const record = meta as Record<string, unknown>;
  if (typeof record.tabId !== "number" || !Number.isInteger(record.tabId) || record.tabId < 1) {
    return null;
  }
  if (typeof record.frameId !== "number" || !Number.isInteger(record.frameId) || record.frameId < 0) {
    return null;
  }
  return { tabId: record.tabId, frameId: record.frameId };
}

function identityFor(session: Session, meta: ForwardedMeta, nonce: string): CaptureIdentity {
  return {
    tabId: meta.tabId,
    frameId: meta.frameId,
    documentId: session.documentId,
    documentNonce: nonce
  };
}

function captureIdentity(session: Session, meta: ForwardedMeta, nonce: string): CaptureContext {
  return {
    tabId: meta.tabId,
    frameId: meta.frameId,
    documentId: session.documentId,
    documentNonce: nonce,
    adapterId: "aux.selection",
    adapterVersion: "1.0.0",
    questionFingerprint: sha256Hex("selection"),
    capturedAt: Date.now()
  };
}

function selectContainerCommand(command: PageCommand, session: Session): number | null {
  if (command.type !== "CAPTURE_QUESTION") {
    return null;
  }
  return command.containerIndex ?? (session.candidates.length === 1 ? 0 : null);
}

async function handleCommand(session: Session, raw: unknown): Promise<PageResponse> {
  const parsed = parsePageCommand(raw);
  if (!parsed.ok) {
    return asPageFailure("INVALID_COMMAND", parsed.detail);
  }
  const meta = readForwardedMeta(raw);
  if (!meta) {
    return asPageFailure("INVALID_COMMAND", "missing trusted tab/frame metadata");
  }
  const command = parsed.value;

  if (command.type === "CAPTURE_QUESTION") {
    const found = findAdapter(document);
    if (!found) {
      return asPageFailure("ADAPTER_NOT_MATCHED", "no verified adapter matched this page");
    }
    if (found.match.evidence.includes("FRAME_ACCESS_DENIED")) {
      return asPageFailure("FRAME_ACCESS_DENIED", "the question frame has no same-origin document access");
    }
    if (found.match.pageKind === "GRADED") {
      return asPageFailure("PAGE_KIND_UNSUPPORTED", "graded pages never expose fill");
    }
    if (!found.match.matched) {
      return asPageFailure("ADAPTER_NOT_MATCHED", "no verified adapter matched this page");
    }
    session.adapter = found.adapter;
    const candidates = found.adapter.listCandidates(document);
    session.candidates = candidates;
    if (candidates.length === 0) {
      return asPageFailure("QUESTION_AMBIGUOUS", "the fixture has no question containers");
    }
    const requested = selectContainerCommand(command, session);
    if (requested === null) {
      return { ok: true, kind: "CAPTURE_QUESTION", needsSelection: true, candidates };
    }
    const nonce = randomToken(24);
    const outcome = found.adapter.captureSelectedQuestion(
      document,
      requested,
      identityFor(session, meta, nonce),
      nonce
    );
    if (!outcome.ok) {
      return asPageFailure(outcome.code, outcome.detail);
    }
    session.captured = outcome.captured;
    session.documentNonce = nonce;
    session.containerIndex = requested;
    session.plan = null;
    session.planConsumed = false;
    session.consumedNonces.clear();
    return {
      ok: true,
      kind: "CAPTURE_QUESTION",
      needsSelection: false,
      captured: outcome.captured,
      candidates
    };
  }

  if (command.type === "CAPTURE_SELECTION") {
    const text = readSelectionText(document);
    if (!text || !text.trim()) {
      return asPageFailure("QUESTION_AMBIGUOUS", "no text is selected in the page");
    }
    const nonce = randomToken(24);
    const trimmed = normalizeCapturedText(text).slice(0, MAX_SELECTION_TEXT_LENGTH);
    const context = captureIdentity(session, meta, nonce);
    session.documentNonce = nonce;
    session.captured = null;
    session.plan = null;
    session.planConsumed = false;
    return { ok: true, kind: "CAPTURE_SELECTION", text: trimmed, context };
  }

  if (command.type === "REVALIDATE_FILL") {
    const captured = session.captured;
    const adapter = session.adapter;
    if (!captured || !adapter || !session.documentNonce) {
      return asPageFailure("DOCUMENT_CHANGED", "capture session no longer exists in this document");
    }
    const plan = adapter.createFillPlan(captured, command.reviewedAnswer, command.planId);
    if (!plan.ok) {
      return asPageFailure(plan.code, plan.detail);
    }
    session.plan = plan.plan;
    session.planConsumed = false;
    const identity = identityFor(session, meta, session.documentNonce);
    const result = adapter.revalidate(plan.plan, identity, true);
    const preview = adapter.toPlanPreview(plan.plan);
    if (!result.ok) {
      return asPageFailure(result.code ?? "PAGE_KIND_UNSUPPORTED", "fill preconditions failed", result.checks);
    }
    return { ok: true, kind: "REVALIDATE_FILL", plan: preview, checks: result.checks };
  }

  const plan = session.plan;
  if (!plan || plan.planId !== command.planId) {
    return asPageFailure("CONFIRMATION_EXPIRED", "fill plan is missing or no longer current");
  }
  if (plan.consumed || session.planConsumed) {
    return asPageFailure("CONFIRMATION_EXPIRED", "fill plan was already applied");
  }
  if (session.consumedNonces.has(command.confirmationNonce)) {
    return asPageFailure("CONFIRMATION_EXPIRED", "confirmation nonce was already used");
  }
  if (Date.now() - plan.createdAt > MAX_PLAN_AGE_MS) {
    return asPageFailure("CONFIRMATION_EXPIRED", "fill plan is too old");
  }
  const adapter = session.adapter;
  if (!adapter || !session.documentNonce) {
    return asPageFailure("DOCUMENT_CHANGED", "adapter session no longer exists");
  }
  const identity = identityFor(session, meta, session.documentNonce);
  const check = adapter.revalidate(plan, identity, true);
  if (!check.ok) {
    return asPageFailure(check.code ?? "PAGE_KIND_UNSUPPORTED", "fill preconditions failed", check.checks);
  }
  session.consumedNonces.add(command.confirmationNonce);
  session.planConsumed = true;
  plan.consumed = true;
  const result = await adapter.apply(plan);
  return { ok: true, kind: "APPLY_FILL", result, checks: check.checks };
}

function install(): void {
  const session: Session = {
    documentId: randomId(),
    documentNonce: null,
    adapter: null,
    captured: null,
    containerIndex: null,
    candidates: [],
    plan: null,
    consumedNonces: new Set<string>(),
    planConsumed: false
  };

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || !isPageCommandMessage(message)) {
      return false;
    }
    void handleCommand(session, message).then(
      (response) => sendResponse(response),
      (error: unknown) => {
        const detail = error instanceof Error ? error.message : "page adapter failed";
        sendResponse(asPageFailure("CONTROL_UNSUPPORTED", `page adapter failed: ${detail}`));
      }
    );
    return true;
  });
}

const globalRecord = globalThis as unknown as Record<string, unknown>;
if (globalRecord[GUARD_KEY] !== true) {
  globalRecord[GUARD_KEY] = true;
  install();
}
