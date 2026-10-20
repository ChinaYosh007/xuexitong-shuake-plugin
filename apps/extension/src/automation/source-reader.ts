import reference from "./data/source-han-glyphs.json";
import { readTrueType } from "./true-type";
import { questionContentRoots } from "./question-roots";

const glyphReference: Record<string, string> = reference;
type Decoder = Map<number, string | null> | null;
const cache = new WeakMap<Document, { css: string; result: Promise<Decoder> }>();
export function secretFontCss(doc: Document): string {
  return [...doc.querySelectorAll("style")].map(style => style.textContent ?? "")
    .filter(text => text.includes("@font-face") && text.includes("font-cxsecret")).join("\n");
}
async function decoder(doc: Document): Promise<Decoder> {
  const css = secretFontCss(doc);
  const previous = cache.get(doc);
  if (previous?.css === css) return previous.result;
  const result = (async (): Promise<Decoder> => {
    try {
      if (css.length > 2000000) return null;
      const base64 = /base64,([A-Za-z0-9+/=]+)/.exec(css)?.[1];
      if (!base64) return null;
      const binary = atob(base64);
      const font = readTrueType(Uint8Array.from(binary, char => char.charCodeAt(0)));
      const result: Decoder = new Map();
      for (const [code, index] of font.mapping) {
        const glyph = font.glyph(index);
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(glyph)));
        const hash = [...digest.subarray(0, 16)].map(byte => byte.toString(16).padStart(2, "0")).join("");
        result.set(code, glyphReference[hash] ?? null);
      }
      return result;
    } catch { return null; }
  })();
  cache.set(doc, { css, result });
  return result;
}

/** Extract only question roots. Decode observed font substitution; never read page HTML or globals. */
export async function readQuestionSource(el: HTMLElement): Promise<{ stem: string; options: string[]; needsImage: boolean; reason: string }> {
  const font = el.querySelector(".font-cxsecret") || el.classList.contains("font-cxsecret") ? await decoder(el.ownerDocument) : null;
  let reliable = true, diagram = false, embedded = false;
  function text(root: Element): string {
    const parts: string[] = [];
    function visit(node: Node): void {
      if (node.nodeType === 3) {
        let value = node.textContent ?? "";
        if (node.parentElement?.closest(".font-cxsecret")) {
          if (!font) reliable = false;
          else value = [...value].map(char => {
            const code = char.codePointAt(0)!;
            if (!font.has(code)) return char;
            const decoded = font.get(code); if (!decoded) reliable = false;
            return decoded ?? char;
          }).join("");
        }
        parts.push(value); return;
      }
      if (node.nodeType !== 1) return;
      const element = node as Element;
      // MathJax keeps a hidden MathML copy of the formula; reading it would duplicate the stem.
      if (element.matches("script,style,textarea,input,select,option,noscript,mjx-assistive-mml,.newZy_TItle,.num_option")) return;
      if (element.matches("img,canvas,svg")) { diagram = true; return; }
      // Audio, video and embedded frames cannot be turned into a static question image; they are
      // reported as non-paste content instead of being silently omitted from the stem.
      if (element.matches("video,audio,iframe,embed,object")) { diagram = true; embedded = true; return; }
      // Open shadow roots are part of the rendered question but are not reachable through a plain
      // light-DOM traversal; read them once before the normal children. Closed roots stay invisible.
      const shadow = (element as HTMLElement).shadowRoot;
      if (shadow) for (const child of shadow.childNodes) visit(child);
      for (const child of element.childNodes) visit(child);
      if (element.matches("p,div,li,br")) parts.push("\n");
    }
    visit(root);
    return parts.join("").replace(/[\t\r ]+/g, " ").replace(/\n\s*\n/g, "\n").trim();
  }
  const title = el.querySelector(".Zy_TItle");
  const stem = title ? text(title) : "";
  const controls = [...el.querySelectorAll<HTMLElement>(".Zy_ulTop .num_option")];
  const options = controls.map(control => text(control.closest("li") ?? control.parentElement!));
  // Alternative option lists can contain image-only choices without .num_option markers.
  for (const root of questionContentRoots(el)) {
    if (root.querySelector("img,canvas,svg")) diagram = true;
    if (root.querySelector("video,audio,iframe,embed,object")) { diagram = true; embedded = true; }
  }
  const over = stem.length > 8000 || options.some(option => option.length > 1000);
  // Image-only choices (or choices whose text is hidden behind an unreadable font) must
  // fall back to the rendered image even when the stem itself decoded cleanly.
  // Image-only choices are already covered by the diagram flag; empty text alone is not
  // enough evidence (some layouts keep the option letter inside the control span).
  const usable = reliable && !over;
  const needsImage = !usable || diagram || !stem;
  const reason = embedded ? "题目含音视频或嵌入框架等非粘贴内容，无法转成静态题图，需人工核对"
    : !reliable ? "字体编码尚无法可靠还原"
    : diagram ? "题目含图示，文字之外还需图像"
    : !stem || over ? "源文字缺失或超出限制"
    : "已读取结构化源文字";
  return { stem: usable ? stem : "", options: usable ? options : [], needsImage, reason };
}
