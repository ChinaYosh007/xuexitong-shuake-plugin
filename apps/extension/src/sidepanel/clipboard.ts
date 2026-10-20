/**
 * User-triggered copy-out from trusted extension pages (side panel / course runner).
 * The clipboard is touched only here and only after a user click; page scripts never
 * see clipboard access (see tests/security-static.test.ts).
 */

export type TextCopyResult = "copied" | "fallback";

async function withWindowFocus<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch {
    // Chrome side panels sometimes reject the first clipboard write with
    // "document is not focused" even right after a click. Focusing this
    // window once and retrying inside the same user gesture fixes it.
    window.focus();
    return await run();
  }
}

/** Copies plain text; resolves "fallback" when the browser still refuses,
 *  so the caller can show a pre-selected textarea for manual Ctrl+C. */
export async function copyText(text: string): Promise<TextCopyResult> {
  try {
    await withWindowFocus(() => navigator.clipboard.writeText(text));
    return "copied";
  } catch {
    return "fallback";
  }
}

/** Copies a PNG blob; resolves false when the browser refuses image writes. */
export async function copyPng(png: Blob): Promise<boolean> {
  try {
    await withWindowFocus(() => navigator.clipboard.write([new ClipboardItem({ "image/png": png })]));
    return true;
  } catch {
    return false;
  }
}
