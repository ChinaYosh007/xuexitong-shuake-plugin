/** Hard limits for extension-local messages and captured questions (architecture.md §11.1, §7.6). */
export const MAX_PAGE_COMMAND_BYTES = 24 * 1024;
export const MAX_PAGE_RESPONSE_BYTES = 128 * 1024;
export const MAX_STEM_LENGTH = 8000;
export const MAX_OPTIONS = 20;
export const MAX_OPTION_TEXT_LENGTH = 1000;
export const MAX_BLANKS = 20;
export const MAX_ID_LENGTH = 64;
export const MAX_SELECTION_TEXT_LENGTH = 8000;
export const MAX_ANSWER_TEXT_LENGTH = 4000;
export const MAX_EXPLANATION_LENGTH = 8000;
export const MAX_CAVEATS = 5;
export const MAX_CAVEAT_LENGTH = 500;
export const MAX_PLAN_AGE_MS = 5 * 60 * 1000;
export const CONFIRMATION_TTL_MS = 90 * 1000;
export const BOUNDED_RENDER_CHECK_MS = 1000;
export const BOUNDED_RENDER_SETTLE_MS = 250;

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}
