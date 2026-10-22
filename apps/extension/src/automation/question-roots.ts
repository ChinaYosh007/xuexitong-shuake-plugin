/** Reuse the option-list variants already supported by the course adapter. No answer editors. */
export function questionContentRoots(element: HTMLElement): HTMLElement[] {
  // Observed discussion detail body only; peer replies and the reply editor are excluded.
  if (element.matches("#bbsTopicDetail .topicDetail_main .replyContent")) return [element];
  const roots = [...element.querySelectorAll<HTMLElement>(".Zy_TItle,.Zy_ulTop,[class*='ulTop']")];
  return roots.filter(root => !roots.some(other => other !== root && other.contains(root)));
}

/** Same option rows as the course reader, for explicit opt_N labels in the image margin. */
export function questionOptionRows(element: HTMLElement): HTMLElement[] {
  const primary = [...element.querySelectorAll<HTMLElement>(".Zy_ulTop .num_option")];
  if (primary.length) return primary.map(control => control.closest<HTMLElement>("li") ?? control);
  for (const selector of [".Zy_ulTop > li", "[class*='ulTop'] > li"]) {
    const rows = [...element.querySelectorAll<HTMLElement>(selector)].filter(row =>
      (row.textContent ?? "").trim().length > 0 &&
      !row.querySelector('textarea,iframe[id^="ueditor_"],[contenteditable],.InpDIV,input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"])'));
    if (rows.length >= 2) return rows;
  }
  return [];
}
