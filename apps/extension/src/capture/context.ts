import { sha256Hex } from "../shared/sha256";
import { normalizeForFingerprint } from "./normalize";
import type { CaptureContext, QuestionFingerprintInput } from "../shared/types";
import type { StudyQuestion } from "@study/contracts";

/**
 * Deterministic serialization for question fingerprints (architecture.md §8.2).
 * Covers stem, question type, option ids + texts, and blank field mapping. Field order is fixed
 * and object keys are emitted explicitly, so equal questions fingerprint equally.
 */
export function fingerprintInput(question: StudyQuestion): QuestionFingerprintInput {
  return {
    type: question.type,
    stem: normalizeForFingerprint(question.stem),
    options: question.options.map((option) => ({
      id: option.id,
      text: normalizeForFingerprint(option.text)
    })),
    blanks: question.blanks.map((blank) => ({
      id: blank.id,
      label: normalizeForFingerprint(blank.label)
    }))
  };
}

export function deterministicQuestionSerialization(question: StudyQuestion): string {
  const input = fingerprintInput(question);
  return JSON.stringify({
    type: input.type,
    stem: input.stem,
    options: input.options,
    blanks: input.blanks
  });
}

export function computeQuestionFingerprint(question: StudyQuestion): string {
  return sha256Hex(deterministicQuestionSerialization(question));
}

export function createCaptureContext(input: {
  tabId: number;
  frameId: number;
  documentId: string;
  documentNonce: string;
  adapterId: string;
  adapterVersion: string;
  questionFingerprint: string;
  capturedAt: number;
}): CaptureContext {
  return {
    tabId: input.tabId,
    frameId: input.frameId,
    documentId: input.documentId,
    documentNonce: input.documentNonce,
    adapterId: input.adapterId,
    adapterVersion: input.adapterVersion,
    questionFingerprint: input.questionFingerprint,
    capturedAt: input.capturedAt
  };
}
