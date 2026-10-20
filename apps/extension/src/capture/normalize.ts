/**
 * Capture text normalization (architecture.md §7.4, §8.2).
 * Only explicit newline and whitespace normalization is allowed. No semantic rewriting that could
 * change mathematical expressions or option meaning.
 */
const HORIZONTAL_WHITESPACE = /[ \t\f\v\u00a0]+/g;

export function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

export function normalizeCapturedText(value: string): string {
  if (typeof value !== "string") {
    return "";
  }
  const unified = normalizeLineEndings(value)
    .split("\n")
    .map((line) => line.replace(HORIZONTAL_WHITESPACE, " ").replace(/ +$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
  return unified.trim();
}

export function normalizeForFingerprint(value: string): string {
  return normalizeCapturedText(value);
}

/** Bounded text for local previews and option labels; never used for page-wide collection. */
export function truncateText(value: string, maxLength: number): string {
  const normalized = normalizeCapturedText(value);
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}
