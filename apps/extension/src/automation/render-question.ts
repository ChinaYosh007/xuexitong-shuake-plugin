import { QuestionImageError } from "./question-image-error";
import { questionContentRoots, questionOptionRows } from "./question-roots";

/** How long a visible question image may take to load before the render is considered failed. */
const IMAGE_LOAD_MS = 3000;
/** Inline SVGs are rasterized from a serialized data URI; the same bound applies. */
const SVG_LOAD_MS = 3000;
/** Original-image extraction keeps at most this many images (largest first). */
const MAX_ORIGINAL_IMAGES = 3;

/**
 * Wait for a visible image to finish loading. Lazy/broken images must not make the whole
 * question unreadable by themselves: callers skip images that occupy no layout box, and only
 * a visible image that stays unloaded is a real failure.
 */
async function waitForImage(image: HTMLImageElement): Promise<void> {
  if (image.complete && image.naturalWidth) return;
  await new Promise<void>(resolve => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      image.removeEventListener("load", finish);
      image.removeEventListener("error", finish);
      resolve();
    };
    timer = setTimeout(finish, IMAGE_LOAD_MS);
    image.addEventListener("load", finish);
    image.addEventListener("error", finish);
  });
  if (!image.naturalWidth) throw new QuestionImageError("题目图片加载失败。");
}

/**
 * Rasterize an inline <svg> without executing page scripts. The serialized copy is loaded as a
 * normal image (no script, no external document) at its rendered size; CSS from the page is not
 * inherited, so a styled-only SVG can differ from the screen while formulas/charts still render.
 */
async function rasterizeSvg(svg: SVGSVGElement): Promise<HTMLImageElement> {
  const box = svg.getBoundingClientRect();
  const clone = svg.cloneNode(true) as SVGSVGElement;
  if (!clone.getAttribute("width")) clone.setAttribute("width", String(Math.max(1, Math.round(box.width))));
  if (!clone.getAttribute("height")) clone.setAttribute("height", String(Math.max(1, Math.round(box.height))));
  const xml = new XMLSerializer().serializeToString(clone);
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new QuestionImageError("题目内联 SVG 绘制超时。")), SVG_LOAD_MS);
    image.onload = () => { clearTimeout(timer); resolve(); };
    image.onerror = () => { clearTimeout(timer); reject(new QuestionImageError("题目内联 SVG 无法绘制（可能引用了外部资源）。")); };
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
  });
  return image;
}

/**
 * Render only the question's displayed text/diagrams using its loaded fonts; no screen capture.
 * `requireAllImages` is set when the source reader detected a diagram: non-paste content (image,
 * inline SVG, canvas) that cannot be drawn must fail the render instead of silently producing a
 * text-only picture the model could answer without the diagram.
 */
export async function renderQuestion(element: HTMLElement, requireAllImages = false): Promise<string> {
  const doc = element.ownerDocument;
  await doc.fonts.ready;
  let rect = element.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1 || rect.width > 2400 || rect.height > 5000) {
    throw new QuestionImageError("题目尚不可见或尺寸超出限制。");
  }
  const optionRows = questionOptionRows(element);
  const width = rect.width + (optionRows.length ? 90 : 0);
  const scale = Math.min(1.5, 2000 / width);
  const canvas = doc.createElement("canvas");
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(rect.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new QuestionImageError("无法渲染题目图像。");
  ctx.scale(scale, scale);
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, width, rect.height);
  ctx.textBaseline = "top";
  const roots = questionContentRoots(element);
  if (!roots.length) throw new QuestionImageError("题目没有已验证的题干结构。");
  const at = (box: DOMRect): [number, number, number, number] =>
    [box.left - rect.left, box.top - rect.top, box.width, box.height];

  for (const root of roots) {
    // Audio, video and embedded frames cannot be rasterized into the question image. Failing with
    // a concrete reason lets the runner fall back to text or the manual summary instead of sending
    // an image that silently omits the media the question depends on.
    if (root.querySelector("video,audio,iframe,embed,object")) {
      throw new QuestionImageError("题目含音视频或嵌入框架，无法生成静态题图，请人工补答。");
    }
    // Non-paste diagrams: copy the already-rendered canvas pixels. A tainted canvas fails later
    // at toDataURL; an unsafe size fails here with the exact control named.
    for (const source of root.querySelectorAll<HTMLCanvasElement>("canvas")) {
      const box = source.getBoundingClientRect();
      if (!box.width || !box.height) {
        if (requireAllImages) throw new QuestionImageError("题目画布尚未完整显示，无法生成题图。");
        continue;
      }
      try { ctx.drawImage(source, ...at(box)); }
      catch { throw new QuestionImageError("题目画布无法安全绘制（可能含跨域内容），请人工补答。"); }
    }
    // Inline SVG (formulas, diagrams, charts) is part of the rendered question; rasterize it
    // instead of refusing the whole question.
    for (const source of root.querySelectorAll<SVGSVGElement>("svg")) {
      const box = source.getBoundingClientRect();
      if (!box.width || !box.height) {
        if (requireAllImages) throw new QuestionImageError("题目内联图示尚未完整显示，无法生成题图。");
        continue;
      }
      let image: HTMLImageElement;
      try { image = await rasterizeSvg(source); }
      catch (error) {
        if (requireAllImages || error instanceof QuestionImageError) throw error;
        continue;
      }
      try { ctx.drawImage(image, ...at(box)); }
      catch { throw new QuestionImageError("题目内联 SVG 无法安全绘制，请人工补答。"); }
    }
    for (const image of root.querySelectorAll("img")) {
      const src = image.currentSrc || image.src;
      const box = image.getBoundingClientRect();
      const style = doc.defaultView?.getComputedStyle(image);
      // Hidden/decorative images are not displayed content: skipping them must not fail a
      // question (a broken tracking icon used to make the whole render throw).
      if (!src || !image.getClientRects().length || style?.display === "none" || style?.visibility === "hidden") continue;
      // A displayed image with no layout box is a transient/undrawn diagram. For diagram
      // questions this is a real failure; text questions can still render without it.
      if (!box.width || !box.height) {
        if (requireAllImages) throw new QuestionImageError("题目图示尚未完整显示，无法生成题图。");
        continue;
      }
      await waitForImage(image);
      let source = image;
      if (new URL(src).protocol !== "data:" && new URL(src).origin !== doc.location.origin && !image.crossOrigin) {
        source = new Image();
        source.crossOrigin = "anonymous";
        const loaded = new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new QuestionImageError("题目图片跨域读取超时。")), 10000);
          source.onload = () => { clearTimeout(timer); resolve(); };
          source.onerror = () => { clearTimeout(timer); reject(new QuestionImageError("题目图片不允许跨域读取。")); };
        });
        source.src = src;
        await loaded;
      }
      if (box.width && box.height) ctx.drawImage(source, ...at(box));
    }
    // Text walk: includes open shadow roots (rendered content that a light-DOM walk would miss)
    // and skips nodes already rasterized (svg/canvas), form controls and MathJax's hidden copy.
    let drawn = 0;
    const walk = async (node: Node): Promise<void> => {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent ?? "";
        const parent = (node as Text).parentElement;
        const style = parent ? doc.defaultView?.getComputedStyle(parent) : null;
        if (!text || !parent || !style || style.display === "none" || style.visibility === "hidden") return;
        ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        ctx.fillStyle = "#111";
        let offset = 0;
        for (const char of text) {
          offset += char.length;
          if (!char.trim()) continue;
          if (++drawn > 14000) throw new QuestionImageError("题目文本过长。");
          if (drawn % 128 === 0) {
            await new Promise<void>(resolve => setTimeout(resolve, 0));
            const current = element.getBoundingClientRect();
            if (Math.abs(current.width - rect.width) > 1 || Math.abs(current.height - rect.height) > 1) {
              throw new QuestionImageError("题目布局在渲染期间发生变化，请重新读取题图。");
            }
            // Scrolling is allowed while rendering: keep viewport coordinates relative to
            // the current question position without shifting already drawn content.
            rect = current;
          }
          const range = doc.createRange();
          range.setStart(node, offset - char.length);
          range.setEnd(node, offset);
          const box = range.getBoundingClientRect();
          if (box.width && box.height) ctx.fillText(char, box.left - rect.left, box.top - rect.top);
        }
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const el = node as Element;
      if (el.matches("script,style,noscript,textarea,select,option,input,svg,canvas,mjx-assistive-mml")) return;
      const style = doc.defaultView?.getComputedStyle(el);
      if (style && (style.display === "none" || style.visibility === "hidden")) return;
      const shadow = (el as HTMLElement).shadowRoot;
      if (shadow) for (const child of shadow.childNodes) await walk(child);
      for (const child of el.childNodes) await walk(child);
    };
    for (const child of root.childNodes) await walk(child);
  }
  // A CSS-only option letter is invisible to DOM text rendering. Add stable IDs beside,
  // rather than over, the option images so the model can map even image-only choices.
  ctx.font = "bold 13px sans-serif"; ctx.fillStyle = "#111";
  optionRows.forEach((row, index) => {
    const box = row.getBoundingClientRect();
    if (box.width && box.height) ctx.fillText(`opt_${index + 1}`, rect.width + 8, box.top - rect.top);
  });
  let image: string;
  try { image = canvas.toDataURL("image/jpeg", 0.9); }
  catch { throw new QuestionImageError("题目图像无法安全读取（可能含跨域画布或图示），请人工补答。"); }
  if (!image.startsWith("data:image/")) throw new QuestionImageError("浏览器未能生成可用的题图。");
  return image;
}

/**
 * Extract the question's original <img> bytes at natural size (2026-10-20 用户授权：文字无法
 * 读取、合成题图失败或模型看不清时，自动把原版图像数据发给模型——二次处理全自动)。
 *
 * Same safety rules as renderQuestion: only verified question roots are read, hidden/unloaded
 * images are skipped, media/embedded frames are refused, and cross-origin images must allow
 * anonymous reads. Images come back largest-first as PNG, with no encoded-size rejection.
 * Only an extreme canvas pixel allocation is bounded; ordinary images retain natural size.
 */
export async function extractOriginalImages(element: HTMLElement, maxImages = MAX_ORIGINAL_IMAGES): Promise<string[]> {
  const doc = element.ownerDocument;
  const roots = questionContentRoots(element);
  if (!roots.length) throw new QuestionImageError("题目没有已验证的题干结构。");
  if (roots.some(root => root.querySelector("video,audio,iframe,embed,object"))) {
    throw new QuestionImageError("题目含音视频或嵌入框架，无法提取原图。");
  }
  const candidates: Array<{ source: HTMLImageElement; width: number; height: number }> = [];
  for (const image of roots.flatMap(root => [...root.querySelectorAll<HTMLImageElement>("img")])) {
    const src = image.currentSrc || image.src;
    const style = doc.defaultView?.getComputedStyle(image);
    // Hidden/decorative images are not displayed content; skipping them must not fail extraction.
    if (!src || !image.getClientRects().length || style?.display === "none" || style?.visibility === "hidden") continue;
    try { await waitForImage(image); } catch { continue; }
    let source = image;
    if (new URL(src).protocol !== "data:" && new URL(src).origin !== doc.location.origin && !image.crossOrigin) {
      try {
        source = new Image();
        source.crossOrigin = "anonymous";
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("timeout")), 10000);
          source.onload = () => { clearTimeout(timer); resolve(); };
          source.onerror = () => { clearTimeout(timer); reject(new Error("denied")); };
          source.src = src;
        });
      } catch { continue; }
    }
    const width = source.naturalWidth || image.naturalWidth;
    const height = source.naturalHeight || image.naturalHeight;
    if (width && height) candidates.push({ source, width, height });
  }
  if (!candidates.length) throw new QuestionImageError("题目没有可读取的原图图像。");
  candidates.sort((a, b) => b.width * b.height - a.width * a.height);
  const images: string[] = [];
  for (const candidate of candidates) {
    if (images.length >= maxImages) break;
    // Preserve natural resolution unless the canvas would exceed the local pixel budget.
    // No encoded-byte cap, quality retry or downscale to satisfy the old backend body limit.
    const scale = Math.min(1, 16384 / candidate.width, 16384 / candidate.height,
      Math.sqrt(64_000_000 / (candidate.width * candidate.height)));
    const canvas = doc.createElement("canvas");
    canvas.width = Math.max(1, Math.round(candidate.width * scale));
    canvas.height = Math.max(1, Math.round(candidate.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) continue;
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(candidate.source, 0, 0, canvas.width, canvas.height);
    try {
      const data = canvas.toDataURL("image/png");
      if (data.startsWith("data:image/")) images.push(data);
    } catch { /* Unreadable cross-origin pixels remain refused. */ }
  }
  if (!images.length) throw new QuestionImageError("题目原图无法安全读取（可能含跨域内容或浏览器绘图失败）。");
  return images;
}
