import { MAX_SELECTION_TEXT_LENGTH } from "../shared/limits";
import { normalizeCapturedText } from "./normalize";

/**
 * Optional auxiliary path: read text the user explicitly selected in the page.
 * This never reads the whole page and never replaces the primary single-question adapter capture.
 */
export function readSelectionText(document: Document, maxLength = MAX_SELECTION_TEXT_LENGTH): string | null {
  const view = document.defaultView;
  const selection = view?.getSelection() ?? document.getSelection?.() ?? null;
  if (!selection || selection.isCollapsed) {
    return null;
  }
  const text = normalizeCapturedText(selection.toString());
  if (!text) {
    return null;
  }
  return text.slice(0, maxLength);
}
