import type { StudyAnswer, StudyQuestion, QuestionType } from "@study/contracts";
import type { AnswerMode, AutomationCommand, AutomationResponse, PopupOutcome, ScrollOutcome, SeekOutcome, SectionTabsOutcome, TaskDiagnostics, TaskKind, TaskQuestion, TaskSnapshot } from "./protocol";
import { renderQuestion, extractOriginalImages } from "./render-question";
import { sha256Hex } from "../shared/sha256";
import { chooseAnswer } from "./consensus";
import { QuestionImageError } from "./question-image-error";
import { readQuestionSource, secretFontCss } from "./source-reader";
import { questionContentRoots } from "./question-roots";

function fail(detail: string): never { throw new Error(detail); }
function visible(el: Element): boolean {
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  return Boolean(el.getClientRects().length && style?.display !== "none" && style?.visibility !== "hidden");
}
export function accessibleDocuments(root: Document, depth = 0, result: Document[] = []): Document[] {
  if (depth > 5 || result.length >= 40 || result.includes(root)) return result;
  result.push(root);
  for (const frame of root.querySelectorAll("iframe")) {
    try { if (frame.contentDocument) accessibleDocuments(frame.contentDocument, depth + 1, result); } catch { /* No cross-origin access. */ }
  }
  return result;
}
/**
 * 独立作业/测验作答页（2026-10-20 用户授权纳入刷题自动运行）。
 * 用户提供的真实地址路径为 `/mooc-ans/mooc2/work/dowork`（chaoxing 课程域，带
 * courseId/classId/workId/answerId 参数）；仓库不保存该完整 URL 或任何课程标识。
 * 只接受这一条已确认的路径，其余页面仍按未知页面拒绝；正式考试路径另有单独拒绝。
 * 判定与侧边栏路由共用 `shared/pages.ts`，本模块继续导出以兼容既有测试。
 */
import { isCourseTaskPath, isDiscussionPageUrl, isExamPath, isWorkPagePath } from "../shared/pages";
export { isExamPath, isWorkPagePath };

/** Prefer the observed active #iframe; hidden retained frames cannot override it. */
function cardIndexOf(root: Document): string {
  const primary = loadedCardsNum(root);
  if (primary !== null) return String(primary);
  let index = "0";
  for (const doc of accessibleDocuments(root)) {
    for (const frame of doc.querySelectorAll("iframe")) {
      if (!visible(frame)) continue;
      const source = frame.getAttribute("src");
      if (!source) continue;
      let num: string | null = null;
      try {
        const url = new URL(source, doc.location.href);
        if (url.pathname !== "/mooc-ans/knowledge/cards") continue;
        num = url.searchParams.get("num");
      } catch {
        // about:blank card frames make relative URLs unparsable; fall back to the raw src.
        if (!/^\/mooc-ans\/knowledge\/cards\?/.test(source)) continue;
      }
      if (num === null || !/^\d+$/.test(num)) {
        const raw = /[?&]num=(\d+)/.exec(source);
        num = raw?.[1] ?? null;
      }
      if (num !== null) index = num;
    }
  }
  return index;
}

function markerCompleted(marker: Element): boolean {
  return /任务点已完成|Task\s*completed/i.test(marker.getAttribute("aria-label") ?? "") ||
    marker.closest(".ans-attach-ct")?.classList.contains("ans-job-finished") === true;
}
interface CourseModule { marker: Element; root: Document | null; kind: "VIDEO" | "QUIZ" | "RESOURCE" | "DISCUSSION" | "UNKNOWN"; }
/** Live Java course evidence: each marked .ans-attach-ct wraps exactly one module iframe.
 * Keep completion scoped to that wrapper, not to unrelated quizzes on the same card. */
function courseModules(docs: Document[]): CourseModule[] {
  const markers = docs.flatMap(doc => [...doc.querySelectorAll(".ans-job-icon")]);
  const modules: CourseModule[] = [];
  for (const marker of markers) {
    const wrapper = marker.closest(".ans-attach-ct");
    const frames = wrapper?.querySelectorAll<HTMLIFrameElement>("iframe");
    // Legacy/synthetic single-task layouts keep their existing adapter. Mixed unknown
    // layouts never acquire a permission to skip merely because their content is empty.
    if (!wrapper || wrapper.querySelectorAll(".ans-job-icon").length !== 1 || frames?.length !== 1) {
      // Preserve valid siblings, but keep malformed marked content as a blocking unknown task.
      // A legacy layout with no wrappers at all still uses the whole-card adapter.
      if (markers.every(item => !item.closest(".ans-attach-ct"))) return [];
      modules.push({ marker, root: null, kind: "UNKNOWN" });
      continue;
    }
    const frame = frames[0]!;
    let path = "";
    try { path = new URL(frame.getAttribute("src") ?? "", marker.ownerDocument.location.href).pathname; } catch { /* Unknown module. */ }
    let root: Document | null = null;
    try { root = frame.contentDocument; } catch { /* No cross-origin access. */ }
    const kind = path === "/ananas/modules/video/index.html" ? "VIDEO"
      : path === "/ananas/modules/work/index.html" ? "QUIZ"
      : path === "/ananas/modules/pdf/index.html" ? "RESOURCE"
      : path === "/ananas/modules/insertbbs/index.html" ? "DISCUSSION" : "UNKNOWN";
    modules.push({ marker, root, kind });
  }
  return modules;
}

/** Observed knowledge-card content (compatibility §2026-10-20): #pageDiv.ans-cc
 * contains only static headings, paragraphs and loaded images on the quote page.
 * Do not infer "optional" merely from missing task markers: a loading/unsupported
 * module can also have none. Only a fully loaded, frame-free static card qualifies.
 * Hidden translation/audio tools outside pageDiv are part of the site's chrome.
 */
function staticContentCard(doc: Document): boolean {
  if (doc.location.pathname !== "/mooc-ans/knowledge/cards" || doc.readyState !== "complete" ||
      doc.querySelector("iframe")) return false;
  const content = doc.querySelector<HTMLElement>("#pageDiv.ans-cc");
  if (!content || !visible(content)) return false;
  const staticTags = /^(?:DIV|P|SPAN|H[1-6]|BR|IMG|STRONG|B|EM|I|U|S|UL|OL|LI|BLOCKQUOTE|TABLE|THEAD|TBODY|TR|TH|TD)$/;
  if ([content, ...content.querySelectorAll("*")].some(el => !staticTags.test(el.tagName) ||
      el.hasAttribute("contenteditable") || el.hasAttribute("role"))) return false;
  const images = [...content.querySelectorAll("img")];
  if (images.some(image => !image.complete || image.naturalWidth === 0)) return false;
  return Boolean(content.textContent?.trim() || images.length);
}

function discussionEntries(docs: Document[]): HTMLElement[] {
  return docs.filter(doc => doc.location.pathname === "/mooc-ans/bbscircle/chapter")
    .flatMap(doc => [...doc.querySelectorAll<HTMLElement>('#topicMainDiv.PublicCardBox[onclick="openTopicUrl()"]')])
    .filter(visible);
}
function discussionIdentity(entry: HTMLElement): string {
  return sha256Hex(entry.getAttribute("data") ?? "");
}

/** The site player only attaches its source after its own play button is clicked. */
function sitePlayButton(video: HTMLVideoElement): HTMLElement | null {
  const doc = video.ownerDocument;
  const containers = [video.closest(".video-js"), doc.body].filter((node): node is Element => Boolean(node));
  for (const container of containers) {
    for (const selector of [".vjs-big-play-button", ".vjs-play-control", ".prism-big-play-btn", ".prism-play-btn",
      '[class*="big-play"]', '[class*="bigPlay"]', '[aria-label*="播放"]', '[aria-label*="Play"]',
      '[title*="播放"]', '[title*="Play"]']) {
      const candidate = container.querySelector<HTMLElement>(selector);
      if (candidate && visible(candidate)) return candidate;
    }
  }
  return null;
}

function waitForVideoMetadata(video: HTMLVideoElement, timeoutMs: number): Promise<void> {
  if (video.readyState >= 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener("loadedmetadata", loaded);
      video.removeEventListener("error", failed);
    };
    const loaded = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new Error("视频源加载失败，请检查课程页面。")); };
    const timer = setTimeout(() => { cleanup(); reject(new Error("视频源加载超时，请检查课程页面。")); }, timeoutMs);
    video.addEventListener("loadedmetadata", loaded, { once: true });
    video.addEventListener("error", failed, { once: true });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
function playFailureName(error: unknown): string {
  // Chrome rejects an un-gestured audible play() with NotAllowedError; name it so the run
  // error tells the learner whether the browser or the site blocked playback.
  const name = (error as { name?: unknown } | null)?.name;
  return typeof name === "string" && name ? name : error instanceof Error ? error.message : "未知原因";
}
/** A media element play() promise resolves once playback actually starts; keep the mapping here.
 * Real players can leave it pending forever (no selectable source, stuck pipeline), so the
 * wait is bounded — an unresponsive player becomes a concrete failure instead of a hung run. */
const PLAY_START_TIMEOUT_MS = 12000;
async function tryPlay(video: HTMLVideoElement): Promise<unknown | null> {
  try {
    await Promise.race([
      video.play(),
      new Promise((_, reject) => {
        // The failure name is what the run error shows; carry the reason in it directly.
        const timeout = new Error("开始播放超时");
        timeout.name = "开始播放超时";
        setTimeout(() => reject(timeout), PLAY_START_TIMEOUT_MS);
      })
    ]);
    return null;
  } catch (error) {
    return error;
  }
}

/**
 * Start the site player as close to a normal learner click as possible, and survive
 * Chrome's autoplay policy: audible playback started without a user gesture is rejected with
 * NotAllowedError, which left real course videos black with the site's play button showing.
 * A muted play() is still real playback (no seek, rate change or progress fabrication); once
 * it starts, the learner's original muted state is restored, and the site stays free to report
 * its own progress because the site's own play control is clicked while the media is muted.
 */
async function startVideo(video: HTMLVideoElement): Promise<void> {
  // Already playing: never click the site's play/pause control, which could pause a running video.
  if (video.ended || !video.paused) return;
  const originalMuted = video.muted;
  const lazy = video.readyState === 0 || !video.currentSrc || !(video.duration > 0);
  let button = sitePlayButton(video);
  if (lazy && button) {
    siteClick(button);
    // The site attaches its source lazily; a slow CDN must not turn into a hard failure,
    // the bounded play attempts below still report the concrete cause.
    await waitForVideoMetadata(video, 10000).catch(() => undefined);
  }
  if (!video.paused) return;
  const failures: string[] = [];
  // 1) Standard scripted playback, used when the site/media frame already allows autoplay.
  let failure = await tryPlay(video);
  if (!failure) return;
  failures.push(playFailureName(failure));
  // 2) Some site players only wire their media after their own control is clicked.
  button ??= sitePlayButton(video);
  if (button) {
    siteClick(button);
    await delay(300);
    if (!video.paused) return;
    failure = await tryPlay(video);
    if (!failure) return;
    failures.push(playFailureName(failure));
  }
  if (!video.paused || video.ended) return;
  // 3) Autoplay policy fallback: mute first, then click the site control so its own player
  //    state starts normally, then play. Audio state is restored right after the start.
  video.muted = true;
  try {
    button = sitePlayButton(video);
    if (button) siteClick(button);
    await delay(300);
    failure = video.paused ? await tryPlay(video) : null;
    if (failure) failures.push(playFailureName(failure));
  } finally {
    video.muted = originalMuted;
  }
  if (video.paused) fail(`自动播放失败（${failures.join("；")}），请在课程页手动点击一次播放。`);
}

/**
 * Position a site video to its tail to prompt the site's OWN completion check (0.2.8 §3,
 * 2026-10-21 用户授权：站点允许拖动时定位到末尾). This is a pure, structural media primitive:
 * it only reads standard properties (duration/readyState/seekable) and writes
 * `video.currentTime` — it never dispatches synthetic mouse/pointer events, never fabricates
 * `ended` or `timeupdate`, and never touches the site's completion markers. When the media is
 * not ready or not seekable it reports `applied:false` and the runner falls back to full
 * playback. The caller (runner) decides when to probe and watches for the site's green mark.
 */
function seekToTail(video: HTMLVideoElement, tailLeadSeconds = 2): SeekOutcome {
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  const seekable = typeof video.seekable?.length === "number" ? video.seekable : null;
  const round = (value: number): number => Math.round(value * 10) / 10;
  if (!seekable || seekable.length === 0 || video.readyState < 1 || !(duration > 0)) {
    return { seekable: false, applied: false, currentTime: round(video.currentTime || 0),
      duration: round(duration), reason: "播放器尚未就绪或不支持定位" };
  }
  const end = Math.min(duration, seekable.end(seekable.length - 1));
  const target = Math.max(0, end - Math.max(0, tailLeadSeconds));
  if (target <= 0) {
    return { seekable: true, applied: false, currentTime: round(video.currentTime || 0),
      duration: round(duration), reason: "视频过短或末尾位置不可定位，无需拖动" };
  }
  try { video.currentTime = target; }
  catch { return { seekable: true, applied: false, currentTime: round(video.currentTime || 0), duration: round(duration), reason: "定位被播放器拒绝" }; }
  return { seekable: true, applied: true, currentTime: round(video.currentTime || target), duration: round(duration), reason: "" };
}

/**
 * Structurally find the scroll container inside a material document (0.2.8 §4.2, 不猜类名).
 * Prefer the document's own scrollingElement; otherwise take the largest layout element whose
 * overflow-y actually scrolls. Uses only standard DOM geometry — no site-specific selectors.
 */
function findScrollContainer(doc: Document): Element | null {
  const scrollableRange = (el: Element): number => el.scrollHeight - el.clientHeight;
  const scrolling = doc.scrollingElement;
  if (scrolling && scrollableRange(scrolling) > 8) return scrolling;
  const view = doc.defaultView;
  let best: Element | null = null;
  for (const el of [...(doc.body?.querySelectorAll("div,section,main,article") ?? [])]) {
    if (scrollableRange(el) <= 8) continue;
    const style = view?.getComputedStyle(el);
    if (!style || !/(auto|scroll)/.test(style.overflowY)) continue;
    if (!best || scrollableRange(el) > scrollableRange(best)) best = el;
  }
  return best;
}

/**
 * Scroll an opened PDF/PPT material module toward its bottom to prompt the site's own
 * completion (0.2.8 §4). Reads in 5 paced steps (~350ms apart) so it resembles a learner
 * scrolling rather than an instant jump; uses only standard scrollTop/scrollTo, never clicks
 * page-turn controls or mutates site state, and never fabricates reading time — the runner
 * still waits for the site's green mark. Cross-origin or non-scrollable frames are reported,
 * not guessed at.
 */
async function scrollMaterialToBottom(docs: Document[]): Promise<ScrollOutcome> {
  let containerFound = false, scrolled = false, reachedBottom = false, steps = 0;
  for (const doc of docs) {
    let container: Element | null;
    try { container = findScrollContainer(doc); }
    catch { container = null; }
    if (!container) continue;
    containerFound = true;
    const max = container.scrollHeight - container.clientHeight;
    if (max <= 8) { reachedBottom = true; continue; }
    for (let i = 1; i <= 5; i++) {
      try { container.scrollTo(0, Math.round((max * i) / 5)); } catch { /* some jsdom frames reject scrollTo */ }
      steps++;
      await delay(350);
    }
    scrolled = true;
    reachedBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 8;
    if (reachedBottom) break;
  }
  return { containerFound, scrolled, reachedBottom, steps };
}

/**
 * Some course pages use <a href="javascript:..."> as a visual placeholder and bind
 * their real handler with addEventListener. Letting the default action run makes the
 * browser report a CSP violation ("Running the JavaScript URL violates...") and can
 * abort the default action. Temporarily removing the placeholder href keeps the click
 * handler intact and restores the original markup on the next task.
 */
function siteClick(element: HTMLElement): void {
  const anchorElement = element.closest("a");
  const href = anchorElement?.getAttribute("href") ?? null;
  const placeholder = Boolean(anchorElement && href && /^\s*javascript:/i.test(href));
  if (anchorElement && placeholder) {
    anchorElement.removeAttribute("href");
  }
  try {
    element.click();
  } finally {
    if (anchorElement && placeholder) {
      setTimeout(() => {
        if (!anchorElement.hasAttribute("href")) {
          anchorElement.setAttribute("href", href!);
        }
      }, 0);
    }
  }
}

/**
 * 横向标签栏证据（compatibility §6.11，2026-10-21 用户授权处理横向标签）。章节内容页顶部
 * `ul.prev_ul` 内含 `li#dct1..dct5`（`role=option`），当前项 class 含 "active"，其余为 "c1..c5"。
 * 每项的 inline `onclick=changeDisplayContent(num,…)` 是站点自身的分区导航：它把内容 `#iframe`
 * 的 src 改写为 `/mooc-ans/knowledge/cards?…&num=(num-1)`（1 学习内容→num=0、2 讨论→num=1、
 * 3 教学课件→num=2、4 教学视频→num=3、5 评估测试→num=4）。这些分区是同源页面内的标签切换，
 * 不涉及跨源、不点击提交、不伪造完成——真正的任务内容仍以之后 INSPECT 的站点结构为准。
 */
function sectionTabItems(root: Document): HTMLElement[] {
  const bar = root.querySelector<HTMLElement>("ul.prev_ul");
  return bar ? [...bar.querySelectorAll<HTMLElement>("li")].filter(li => /^dct[1-5]$/.test(li.id)) : [];
}

function nextSectionIndex(root: Document): number | null {
  const items = sectionTabItems(root);
  const active = items[activeSectionIndex(items)];
  if (!active) return null;
  const target = items.find(li => Number(li.id.slice(3)) > Number(active.id.slice(3)) && visible(li) &&
    li.getAttribute("aria-disabled") !== "true" && !li.classList.contains("disable"));
  return target ? Number(target.id.slice(3)) : null;
}

function activeSectionIndex(items: HTMLElement[]): number {
  return items.findIndex(li => (li.className || "").split(/\s+/).includes("active"));
}

/** The content iframe's current cards `num`, or null when it is not a cards frame / unreadable. */
function loadedCardsNum(root: Document): number | null {
  const src = root.querySelector<HTMLIFrameElement>("#iframe")?.getAttribute("src");
  if (!src) return null;
  let num: string | null = null;
  try {
    const url = new URL(src, root.location.href);
    if (url.pathname !== "/mooc-ans/knowledge/cards") return null;
    num = url.searchParams.get("num");
  } catch {
    if (/^\/mooc-ans\/knowledge\/cards\?/.test(src)) num = /[?&]num=(\d+)/.exec(src)?.[1] ?? null;
  }
  if (num === null) num = /[?&]num=(\d+)/.exec(src)?.[1] ?? null;
  return num !== null && /^\d+$/.test(num) ? Number(num) : null;
}

function cardsLoading(root: Document): boolean {
  const frame = root.querySelector<HTMLIFrameElement>("#iframe");
  const expected = loadedCardsNum(root);
  if (!frame || expected === null) return false;
  try {
    const doc = frame.contentDocument;
    return !doc?.body || doc.readyState === "loading" || doc.location.pathname !== "/mooc-ans/knowledge/cards" ||
      new URLSearchParams(doc.location.search).get("num") !== String(expected);
  } catch { return true; }
}

/** A short generic section title from the site's own tab chrome, with the leading index digit
 * stripped and capped. Only structural chrome text ("讨论"/"教学视频"), never a course name. */
function sectionLabel(li: HTMLElement | undefined): string {
  if (!li) return "";
  return (li.textContent || "").replace(/\d+/, "").trim().slice(0, 12);
}

/**
 * Drive one horizontal tab switch through the site's own tab bar and confirm it moved. Clicks
 * `li#dct{index}` (firing `changeDisplayContent`), then polls (bounded) for the active class to
 * land on that tab AND the content iframe's cards `num` to equal `index-1`. Returns structural
 * counts only; `confirmed=false` when the site never moved, so the runner stops instead of
 * assuming a section became reachable. No completion is inferred here.
 */
async function switchSectionTab(root: Document, sectionIndex: number): Promise<SectionTabsOutcome> {
  const items = sectionTabItems(root);
  const tabs = items.length;
  const requested = sectionIndex;
  const expectedNum = sectionIndex - 1;
  const target = items.find(li => li.id === `dct${sectionIndex}`);
  if (!target) {
    const activeIndex = activeSectionIndex(items);
    return { tabs, requested, activeIndex, confirmed: false, loadedNum: loadedCardsNum(root),
      activeLabel: sectionLabel(items[activeIndex]) };
  }
  if (!visible(target) || target.getAttribute("aria-disabled") === "true" || target.classList.contains("disable")) {
    return { tabs, requested, activeIndex: activeSectionIndex(items), confirmed: false, loadedNum: loadedCardsNum(root), activeLabel: "" };
  }
  target.click();
  let activeIndex = activeSectionIndex(items);
  let loadedNum = loadedCardsNum(root);
  for (let attempt = 0; attempt < 30; attempt++) {
    activeIndex = activeSectionIndex(items);
    loadedNum = loadedCardsNum(root);
    if (items[activeIndex]?.id === target.id && loadedNum === expectedNum && !cardsLoading(root)) break;
    await delay(200);
  }
  activeIndex = activeSectionIndex(items);
  loadedNum = loadedCardsNum(root);
  const confirmed = items[activeIndex]?.id === target.id && loadedNum === expectedNum && !cardsLoading(root);
  return { tabs, requested, activeIndex, confirmed, loadedNum, activeLabel: sectionLabel(items[activeIndex]) };
}

/** Two retained site notice skins, verified from the course DOM (compatibility §6.7).
 * This handles only the unfinished-chapter notice, never a generic confirmation dialog.
 */
function nextNoticeControl(root: Document, skip: boolean): HTMLElement | null {
  const boxes = [...root.querySelectorAll<HTMLElement>(".jobFinishTip,#jobFinishTip")]
    .filter(box => visible(box) && /unfinished tasks in the current chapter|当前章节[\s\S]{0,40}未完成/.test(box.textContent ?? ""));
  if (boxes.length > 1) fail("未完成任务提示框不唯一，已停止。");
  if (!boxes.length) return null;
  const selector = skip ? ".nextChapter" : ".popMoveDele,.nextbutton";
  const label = skip ? /^(?:Next|下一章|下一节)$/i : /^(?:to learn|去学习|去完成|返回学习)$/i;
  const controls = [...boxes[0]!.querySelectorAll<HTMLElement>(selector)]
    .filter(control => visible(control) && label.test((control.textContent ?? "").trim()) &&
      !control.closest('[disabled],[aria-disabled="true"],[inert]'));
  if (controls.length !== 1) fail("无法唯一确认未完成任务提示框的导航按钮，已停止。");
  return controls[0]!;
}

/** Videos across same-origin frames; hidden template players are ignored when a visible one exists. */
function videoCandidates(root: Document): HTMLVideoElement[] {
  return accessibleDocuments(root).flatMap(doc => [...doc.querySelectorAll("video")]);
}

function isDisplayed(element: Element): boolean {
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  if (!style || style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
  // getClientRects is reliable for rendered elements; a zero-size check alone would drop
  // videos before layout has happened in some iframes.
  return element.getClientRects().length > 0;
}

/** Visible text with whitespace collapsed; text signatures avoid guessing site-specific classes. */
function visibleText(element: Element): string {
  return (element.textContent ?? "").replace(/\s+/g, " ").trim();
}

function controlLabel(control: HTMLElement): string {
  const value = (control as HTMLInputElement).value;
  return visibleText(control) || (typeof value === "string" ? value.trim() : "");
}

/** Leaf elements whose own text exactly matches a label; some skins style spans as buttons. */
function leafLabelMatches(box: HTMLElement, pattern: RegExp): HTMLElement[] {
  return [...box.querySelectorAll<HTMLElement>("*")].filter(element =>
    visible(element) && element.children.length === 0 && pattern.test(ownText(element)));
}

/** Only a text node's own words count, so large containers are not re-read for every prompt. */
function ownText(element: Element): string {
  return [...element.childNodes]
    .filter(node => node.nodeType === 3)
    .map(node => node.textContent ?? "")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

const CONFIRM_LABEL = /^(?:submit|ok|确定|确认|确认提交|确定提交|提交|交卷)$/i;
const CANCEL_LABEL = /^(?:cancel|取消|关闭)$/i;

/**
 * Submit confirmation dialogs are matched by visible text only, never by guessed class
 * names: a small visible box that asks a submit question and holds exactly one confirm
 * button plus one cancel button. The runner calls CONFIRM_WORK once per second only after
 * its own submit click, so unrelated "?" text elsewhere on the page is not a dialog: the
 * unique confirm+cancel pair inside one small box is the safety signature.
 */
function genericConfirmButton(doc: Document): HTMLElement | null {
  const prompts = [...doc.querySelectorAll<HTMLElement>("body *")].filter(element => {
    if (!visible(element)) return false;
    const text = ownText(element);
    if (!(text.length > 0 && text.length <= 40 && /[?？]/.test(text))) return false;
    if (!/(?:submit|ok|确定|确认|提交|交卷)/i.test(text)) return false;
    // Do not confirm a dialog that warns about unanswered questions: the hard rule is that
    // an incomplete task is never submitted, so a "还有 N 题未作答，确定提交吗？" prompt must
    // be left for the learner instead of being auto-confirmed.
    return !/未作答|未完成|还有|剩余|缺少|漏做|未答|尚未/.test(text);
  });
  for (const prompt of prompts) {
    let box: HTMLElement | null = prompt;
    for (let depth = 0; box && depth < 8; depth += 1, box = box.parentElement) {
      if (visibleText(box).length > 300) break;
      const controls = [...box.querySelectorAll<HTMLElement>(
        "button, a, input[type='button'], input[type='submit'], [role='button'], [onclick]"
      )].filter(control => visible(control));
      const confirm = controls.filter(control => CONFIRM_LABEL.test(controlLabel(control)));
      const cancel = controls.filter(control => CANCEL_LABEL.test(controlLabel(control)));
      if (confirm.length === 1 && cancel.length === 1) return confirm[0]!;
      // Some quiz skins draw dialog buttons as plain spans/divs with site handlers; the
      // same small box plus one exact confirm leaf and one exact cancel leaf is the guard.
      const leafConfirm = leafLabelMatches(box, CONFIRM_LABEL);
      const leafCancel = leafLabelMatches(box, CANCEL_LABEL);
      if (leafConfirm.length === 1 && leafCancel.length === 1) return leafConfirm[0]!;
    }
  }
  return null;
}

/** Prefer the DOM-verified skin, then the text-signature fallback; never click twice. */
function confirmButton(doc: Document): HTMLElement | null {
  const dialog = doc.querySelector<HTMLElement>("#confirmSubWin");
  if (dialog && visible(dialog)) {
    const buttons = [...dialog.querySelectorAll<HTMLElement>("a.bluebtn")].filter(visible);
    if (buttons.length === 1 && /^(OK|确定|确认提交)$/i.test(visibleText(buttons[0]!))) return buttons[0]!;
  }
  return genericConfirmButton(doc);
}

/**
 * 站点自己的提交控件：优先已记录的真实 DOM（唯一 `a.btnSubmit`），否则退回精确文案的
 * 可见控件（提交/交卷/…）。只用于点击与“页面是否已离开作答视图”的结构判断，不点击任何
 * 其他 Submit；文案正则与既有实现保持一致。
 */
function submitControls(doc: Document): HTMLElement[] {
  const primary = [...doc.querySelectorAll<HTMLElement>("a.btnSubmit")].filter(visible);
  if (primary.length) return primary;
  const candidates = [...doc.querySelectorAll<HTMLElement>(
    "button, a, input[type='button'], input[type='submit'], [role='button'], .btnSubmit, [class*='submit'], [class*='Submit']"
  )].filter(element => visible(element));
  return candidates.filter(element =>
    // `textContent` is "" (not null) for <input value="提交">, so `??` never reaches the
    // value attribute; use `||` or input-based submit buttons can never be recognized.
    /^(?:submit|提交|提交答案|交卷|确定提交)$/i.test((element.textContent || element.getAttribute("value") || "").trim()));
}

/** 题目文档优先、其余同源文档其后；与提交时的搜索顺序一致。 */
function submitSearchDocuments(root: Document): Document[] {
  const docs = accessibleDocuments(root);
  const work = docs.find(doc => questionElements(doc).length > 0);
  return work ? [work, ...docs.filter(doc => doc !== work)] : docs;
}

/**
 * 提交后的结果视图特征（2026-10-20，独立作业页）。只匹配明确的“已提交/看结果”文案，
 * 不把总分、题数等作答前也会出现的字样当作完成证据；只读可见文本节点，跳过 script/style
 * 等非渲染内容（页面脚本里也可能出现“提交成功”字样，不能据此判完成）。
 */
const SUBMITTED_CUES = /提交成功|已提交|提交完毕|交卷成功|查看答案|重新作答/;
/** Question containers must never supply the completion evidence: a stem can mention 查看答案. */
const QUESTION_CONTENT_SELECTOR = '[id^="question"], .TiMu, .Zy_TItle, .Zy_ulTop';
function submittedCue(docs: Document[]): boolean {
  for (const doc of docs) {
    const walker = doc.createTreeWalker(doc.body ?? doc.documentElement, 4 /* NodeFilter.SHOW_TEXT */);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || parent.closest("script,style,noscript,template,[hidden],[aria-hidden='true']")) continue;
      // Only rendered text counts: hidden result templates or display:none navigation can
      // contain 提交成功/查看答案 on the answer view without the page being submitted.
      if (!isDisplayed(parent) || parent.closest(QUESTION_CONTENT_SELECTOR)) continue;
      const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
      if (text && text.length <= 120 && SUBMITTED_CUES.test(text)) return true;
    }
  }
  return false;
}

/**
 * ---- 视频弹题（video popup question）----
 * 2026-10-19 用户授权：刷课途中出现的强制弹题允许免人工、不调模型，直接枚举页面自身
 * 选项作答（只有答对视频才会继续）。尚无真实弹题表单的脱敏 DOM 证据，因此这里只做
 * 结构性识别（可见小容器 + 互斥选项控件），不凭记忆编造学习通类名；识别不到即返回
 * 未发现，由调度器停止并声音告警，绝不猜测。
 */
interface PopupCandidate { box: HTMLElement; options: HTMLElement[]; }
/** Option rows must carry a letter delimiter ("A."、"（B）") or boolean wording; a bare leading letter is not enough. */
const POPUP_OPTION_LETTER = /^\s*[（(]?\s*[A-Ha-h]\s*[.、:：)）]/;
function popupOptionRow(element: HTMLElement): boolean {
  const text = ownText(element);
  if (!text || text.length > 80 || element.children.length > 2) return false;
  if (POPUP_OPTION_LETTER.test(text)) return true;
  if (/^[（(]?\s*[A-Ha-h]\s*[.、:：)）]?\s*$/.test(text)) return true;
  return booleanToken(text) !== null;
}
function smallestCommonAncestor(elements: HTMLElement[]): HTMLElement | null {
  if (!elements.length) return null;
  let box: HTMLElement | null = elements[0]!;
  for (const element of elements.slice(1)) {
    while (box && !box.contains(element)) box = box.parentElement;
  }
  return box;
}
/** The overlay box that hosts the options, or null when walking up escapes into the page body. */
function popupBoxOf(elements: HTMLElement[], doc: Document): HTMLElement | null {
  const common = smallestCommonAncestor(elements);
  if (!common || common === doc.body || !visible(common) || visibleText(common).length > 800) return null;
  // Options are often inside a list, with the confirm button in a sibling footer.
  // Stay inside a small overlay; never walk into the surrounding player or page controls.
  for (let box: HTMLElement | null = common; box && box !== doc.body; box = box.parentElement) {
    if (!visible(box) || visibleText(box).length > 800 || box.querySelector("video,iframe,[id^='question'],#prevNextFocusNext")) break;
    if (popupConfirmButton(box) || box.getAttribute("role") === "dialog") return box;
  }
  return common;
}
function popupCandidates(doc: Document): PopupCandidate[] {
  // Never touch chapter quiz questions from the popup path: those follow the reviewed pipeline.
  const outsideQuiz = (element: HTMLElement): boolean => !element.closest('[id^="question"]');
  // 1) A visible native radio group is the strongest forced-choice signal.
  const radios = [...doc.querySelectorAll<HTMLElement>('input[type="radio"]')].filter(radio => visible(radio) && outsideQuiz(radio));
  if (radios.length >= 2) {
    const box = popupBoxOf(radios, doc);
    if (box) return [{ box, options: radios }];
  }
  // 2) Skins that draw options as plain rows: letter-delimited or boolean-wording leaves
  //    that share one small visible parent box.
  const rows = [...doc.querySelectorAll<HTMLElement>("li, label, span, div, p, button, a")]
    .filter(element => visible(element) && outsideQuiz(element) && popupOptionRow(element));
  const byParent = new Map<HTMLElement, HTMLElement[]>();
  for (const row of rows) {
    const parent = row.parentElement;
    if (!parent) continue;
    byParent.set(parent, [...(byParent.get(parent) ?? []), row]);
  }
  for (const [, list] of byParent) {
    if (list.length < 2) continue;
    const box = popupBoxOf(list, doc);
    if (box) return [{ box, options: list }];
  }
  return [];
}
/** Commit control of the popup itself; scoped to the popup box only, never the page submit. */
const POPUP_CONFIRM_LABEL = /^(?:submit|ok|确定|确认|提交|提交答案|交卷)$/i;
function popupConfirmButton(box: HTMLElement): HTMLElement | null {
  const controls = [...box.querySelectorAll<HTMLElement>(
    "button, a, input[type='button'], input[type='submit'], [role='button'], [onclick]"
  )].filter(control => visible(control));
  const matches = controls.filter(control => POPUP_CONFIRM_LABEL.test(controlLabel(control)));
  if (matches.length === 1) return matches[0]!;
  const leaves = leafLabelMatches(box, POPUP_CONFIRM_LABEL);
  return leaves.length === 1 ? leaves[0]! : null;
}

function currentVideo(root: Document): HTMLVideoElement | null {
  const all = videoCandidates(root);
  const visible = all.filter(isDisplayed);
  const pool = visible.length ? visible : all;
  if (!pool.length) return null;
  const playing = pool.find(video => !video.paused && !video.ended);
  if (playing) return playing;
  return [...pool].sort((left, right) => {
    const a = left.getBoundingClientRect();
    const b = right.getBoundingClientRect();
    return b.width * b.height - a.width * a.height;
  })[0] ?? null;
}

function questionElements(doc: Document): HTMLElement[] {
  return [...doc.querySelectorAll<HTMLElement>('[id^="question"]')].filter(el => /^question\d+$/.test(el.id) && el.querySelector(".TiMu"));
}
function fingerprint(el: HTMLElement): string {
  return sha256Hex(el.id + questionContentRoots(el).map(n => n.textContent).join("|") +
    [...el.querySelectorAll("img")].filter(n => !n.closest(".blankItemInp")).map(n => n.currentSrc || n.src).join("|") + secretFontCss(el.ownerDocument) +
    JSON.stringify(answerFields(el).targets.map(target => [target.tagName, target.id, target.getAttribute("name"),
      target.ownerDocument.defaultView?.frameElement?.id ?? "", lazyBlank(target)?.saved.id ?? ""])) +
    JSON.stringify(optionControls(el).map(control => [control.getAttribute("data"), control.getAttribute("data-value"), control.id])));
}
function typeOf(el: HTMLElement): QuestionType {
  const title = typeLabelText(el);
  if (/多选|Multiple\s*Choice/i.test(title)) return "MULTIPLE_CHOICE";
  if (/单选|Single\s*Choice/i.test(title)) return "SINGLE_CHOICE";
  if (/判断|对错|是非|True\s*(?:or|\/|与)\s*False|T\s*\/\s*F|True\s*\/\s*False/i.test(title)) return "TRUE_FALSE";
  if (/填空|Fill\s*in\s*the\s*Blank/i.test(title)) return "FILL_BLANK";
  if (/简答|Short\s*Answer/i.test(title)) return "SHORT_ANSWER";
  return "UNKNOWN";
}
/**
 * Question types that are not answered by writing text into a field. They stay unsupported for
 * automatic writing (no DOM evidence for synthesizing drag/order/draw), but they are reported
 * concretely instead of as a generic "unrecognised question".
 */
const NON_TEXT_LABELS = /排序|连线|拖拽|匹配|归类|组合题|画图|绘图|完形|听力|口语|朗读|编程|代码题/;
/**
 * Only the explicit type label may decide the question type. `.Zy_TItle` also contains the
 * stem, and a stem that mentions 多选/判断/填空 would otherwise override the real label
 * (e.g. a Single Choice question whose wording says "以下判断正确的是").
 */
function typeLabelText(el: HTMLElement): string {
  const explicit = [...el.querySelectorAll(".newZy_TItle")]
    .map(node => node.textContent ?? "").join(" ").trim();
  if (explicit) return explicit.slice(0, 400);
  // Older skins put the label directly in .Zy_TItle (no separate .newZy_TItle node).
  return [...el.querySelectorAll(".Zy_TItle")]
    .map(node => node.textContent ?? "").join(" ").slice(0, 400);
}
function labelText(el: HTMLElement): string {
  return typeLabelText(el);
}
function optionControls(el: HTMLElement): HTMLElement[] {
  if (["FILL_BLANK", "SHORT_ANSWER"].includes(typeOf(el))) return [];
  const primary = [...el.querySelectorAll<HTMLElement>(".Zy_ulTop .num_option")];
  if (primary.length) return primary;
  // Other course skins theme the same list differently; fall back to the option-list rows
  // themselves. Never fall back to a bare `ul > li`: a stem's own rule/step list would then
  // be treated as options and receive synthetic clicks.
  for (const selector of [".Zy_ulTop > li", "[class*='ulTop'] > li"]) {
    const rows = [...el.querySelectorAll<HTMLElement>(selector)]
      .filter(row => (row.textContent ?? "").trim().length > 0 &&
        !row.querySelector('textarea,iframe[id^="ueditor_"],[contenteditable],.InpDIV,input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"])'));
    if (rows.length >= 2) return rows;
  }
  return [];
}
interface AnswerFields { mode: AnswerMode; targets: HTMLElement[] }
/** Observed .InpDIV + .textDIV pair: count logical blanks even when the editor is closed. */
function lazyBlank(target: HTMLElement): { slot: HTMLElement; saved: HTMLTextAreaElement } | null {
  if (!target.matches(".InpDIV")) return null;
  const slot = target.closest<HTMLElement>(".blankItemInp");
  if (!slot || slot.querySelectorAll(".InpDIV").length !== 1) return null;
  const saved = slot.querySelectorAll<HTMLTextAreaElement>('.textDIV textarea[id^="answerEditor"]');
  if (saved.length !== 1 || slot.querySelectorAll('iframe[id^="ueditor_"]').length > 1) return null;
  return { slot, saved: saved[0]! };
}
function lazyEditor(target: HTMLElement): { frame: HTMLIFrameElement; body: HTMLElement } | null {
  const frame = lazyBlank(target)?.slot.querySelector<HTMLIFrameElement>('iframe[id^="ueditor_"]');
  try {
    const body = frame?.contentDocument?.body;
    return frame && body && isWritableEditor(body) ? { frame, body } : null;
  } catch { return null; }
}
const WRITABLE_CONTENTEDITABLE = new Set(["", "true", "plaintext-only"]);
/** `contenteditable` may be bare, "true" or "plaintext-only"; only "false"/absent is not writable. */
function isWritableEditor(node: HTMLElement): boolean {
  const attribute = node.getAttribute("contenteditable");
  if (attribute === null) return false;
  const normalized = attribute.trim().toLowerCase();
  if (!WRITABLE_CONTENTEDITABLE.has(normalized)) return false;
  return (node as HTMLElement & { isContentEditable?: boolean }).isContentEditable !== false;
}
function textTypeForFields(fields: AnswerFields): "FILL_BLANK" | "SHORT_ANSWER" {
  return fields.mode === "LAZY_UEDITOR" || fields.targets.length > 1 ? "FILL_BLANK" : "SHORT_ANSWER";
}
const TEXT_FIELD_TYPES = new Set(["", "text", "search", "number", "email", "tel", "url"]);
/**
 * The learner-facing answer controls this question exposes, in DOM order. Non-paste questions
 * are not limited to the verified UEditor: a skin may use a plain input/textarea or a generic
 * contenteditable container. Unknown widgets (ordering, drag, draw, canvas, listening) expose
 * none of these and stay "NONE" instead of being guessed at.
 */
function answerFields(el: HTMLElement): AnswerFields {
  const slots = [...el.querySelectorAll<HTMLElement>(".blankItemInp")].filter(visible);
  if (slots.length) {
    const targets = slots.map(slot => slot.querySelector<HTMLElement>(".InpDIV"));
    // A partially recognised layout must never shrink a five-blank question to one blank.
    if (targets.some(target => !target || !lazyBlank(target))) return { mode: "NONE", targets: [] };
    return { mode: "LAZY_UEDITOR", targets: targets as HTMLElement[] };
  }
  const editors: HTMLElement[] = [];
  for (const frame of el.querySelectorAll<HTMLIFrameElement>('iframe[id^="ueditor_"]')) {
    try {
      const body = frame.contentDocument?.body;
      // Hidden editor templates must not shadow the visible controls of the question; the
      // iframe element itself carries the hidden state, so check the frame (a same-origin
      // editor body may have no layout box of its own in jsdom/early layout).
      if (body && isWritableEditor(body) && visible(frame)) editors.push(body);
    } catch { /* Editor must be same-origin. */ }
  }
  if (editors.length) return { mode: "UEDITOR", targets: editors };
  const rich: HTMLElement[] = [];
  for (const node of el.querySelectorAll<HTMLElement>("[contenteditable]")) {
    if (isWritableEditor(node) && visible(node)) rich.push(node);
  }
  if (rich.length) return { mode: "CONTENTEDITABLE", targets: rich };
  const fields: HTMLElement[] = [];
  for (const node of el.querySelectorAll<HTMLElement>("input, textarea")) {
    if (node.tagName === "INPUT") {
      const input = node as HTMLInputElement;
      if (!TEXT_FIELD_TYPES.has((input.type || "text").toLowerCase())) continue;
      if (input.id.startsWith("answer")) continue;
    }
    if (node.closest(".Zy_ulTop")) continue;
    if (visible(node)) fields.push(node);
  }
  return fields.length ? { mode: "TEXT_FIELD", targets: fields } : { mode: "NONE", targets: [] };
}
function fieldValue(target: HTMLElement): string {
  const lazy = lazyBlank(target);
  if (lazy) {
    const editor = lazyEditor(target);
    return editor ? editor.body.textContent ?? "" : lazy.saved.value;
  }
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA"
    ? (target as HTMLInputElement | HTMLTextAreaElement).value
    : (target.textContent ?? "");
}
/** Realm-safe native setter: a same-origin iframe document has its own constructors. */
function setNativeFieldValue(target: HTMLElement, value: string): boolean {
  const realm = target.ownerDocument.defaultView as
    { HTMLInputElement?: { prototype: object }; HTMLTextAreaElement?: { prototype: object } } | null;
  const proto = target.tagName === "TEXTAREA"
    ? (realm?.HTMLTextAreaElement?.prototype ?? HTMLTextAreaElement.prototype)
    : (realm?.HTMLInputElement?.prototype ?? HTMLInputElement.prototype);
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (!setter) return false;
  setter.call(target, value);
  return true;
}
/** Write one verified non-paste field and fire only the state events the page needs. */
function writeAnswerField(target: HTMLElement, value: string): void {
  if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") {
    const control = target as HTMLInputElement | HTMLTextAreaElement;
    if (control.readOnly || control.disabled) fail("答题输入框当前不可编辑。");
    if (!setNativeFieldValue(target, value)) fail("答题输入框不接受脚本赋值。");
  } else {
    if (!isWritableEditor(target)) fail("编辑器当前不可编辑。");
    // Verified plain-text strategy only: no model HTML, no browser edit command, no HTML sink.
    target.textContent = value;
  }
  target.dispatchEvent(new Event("input", { bubbles: true }));
  target.dispatchEvent(new Event("change", { bubbles: true }));
  target.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
}
async function writeFieldSlot(target: HTMLElement, value: string, beforeWrite: () => void): Promise<void> {
  if (!lazyBlank(target)) { writeAnswerField(target, value); return; }
  const lazy = lazyBlank(target)!;
  if (lazy.saved.readOnly || lazy.saved.disabled || target.closest('[inert],[aria-disabled="true"],[disabled]')) fail("空格输入位置当前不可编辑。");
  // Only the site's own activation may expose a lazy editor; never unhide or write hidden inputs.
  if (visible(target)) siteClick(target);
  const deadline = Date.now() + 2500;
  do {
    const editor = lazyEditor(target);
    if (editor && visible(editor.frame)) { beforeWrite(); writeAnswerField(editor.body, value); return; }
    await delay(50);
  } while (Date.now() < deadline);
  fail("空格编辑器尚未就绪，未写入；请重新读取后重试。");
}
/** True/false option markers across English and Chinese quiz skins. */
const TRUE_TOKENS = new Set(["true", "t", "1", "对", "正确", "是", "√", "✓", "yes", "y"]);
const FALSE_TOKENS = new Set(["false", "f", "0", "错", "错误", "否", "×", "✗", "no", "n"]);
function normalizedToken(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}
function booleanToken(value: string): "true" | "false" | null {
  // Accept "True", "A. 对", "（B）错误" and bare "true"/"false"/"1"/"0".
  const token = normalizedToken(value).replace(/^[（(]?\s*[a-h]\s*[.、:：)）]\s*/i, "").replace(/[\s.,。:：;；]/g, "");
  if (!token) return null;
  if (TRUE_TOKENS.has(token)) return "true";
  if (FALSE_TOKENS.has(token)) return "false";
  return null;
}
function optionRow(control: HTMLElement): HTMLElement {
  return control.closest("li, label, [class*='option'], [class*='Option']") ?? control;
}
interface OptionIdentity {
  id: string;
  letter: string;
  data: string;
  text: string;
  boolean: "true" | "false" | null;
}
/** Every way a quiz skin may identify one option: hidden letter, data value, label text, boolean wording. */
function optionIdentity(control: HTMLElement, index: number): OptionIdentity {
  const row = optionRow(control);
  const ownText = (control.textContent ?? "").trim();
  const text = ownText || (row === control ? "" : (row.textContent ?? "").trim());
  const data = (control.getAttribute("data") ?? control.getAttribute("data-value") ?? "").trim();
  let letter = data && /^[A-Za-z]$/.test(data) ? data.toUpperCase() : "";
  if (!letter) {
    const match = /^\s*[（(]?\s*([A-Ha-h])\s*[.、:：)）]/.exec(text);
    if (match) letter = match[1]!.toUpperCase();
  }
  if (!letter) letter = String.fromCharCode(65 + index);
  return { id: `opt_${index + 1}`, letter, data, text, boolean: booleanToken(data) ?? booleanToken(text) };
}
/** Hidden answer values observed on quiz skins: letters ("AB"), booleans ("true"/"false"), text or an index. */
function hiddenAnswer(el: HTMLElement): string {
  return el.querySelector<HTMLInputElement>('input[id^="answer"]')?.value.trim() ?? "";
}
/**
 * Map the site's hidden answer value onto option ids. Choice skins use letters; true/false
 * skins use booleans or wording like "True"/"对". Ambiguous tokens are never guessed.
 */
function hiddenSelection(controls: HTMLElement[], hidden: string): string[] {
  const raw = hidden.trim();
  if (!raw) return [];
  const identities = controls.map((control, index) => optionIdentity(control, index));
  const selected: string[] = [];
  const add = (id: string) => { if (!selected.includes(id)) selected.push(id); };
  const exact = (token: string): string[] => {
    const value = normalizedToken(token);
    if (!value) return [];
    return identities.filter(identity => normalizedToken(identity.data) === value ||
      normalizedToken(identity.text) === value || normalizedToken(identity.letter) === value).map(identity => identity.id);
  };
  const compact = raw.replace(/\s+/g, "");
  if (/^[A-Ha-h]{1,8}$/.test(compact)) {
    const letters = compact.toUpperCase().split("");
    const ids = letters.map(letter => identities.find(identity => identity.letter === letter)?.id);
    if (ids.every((id): id is string => Boolean(id))) { ids.forEach(add); return selected; }
  }
  for (const token of raw.split(/[,;|，、\s]+/).filter(Boolean)) {
    const matches = exact(token);
    if (matches.length === 1) { add(matches[0]!); continue; }
    if (matches.length > 1) return []; // Ambiguous token: do not guess a selection.
    const boolean = booleanToken(token);
    if (boolean) {
      const semantic = identities.filter(identity => identity.boolean === boolean).map(identity => identity.id);
      if (semantic.length === 1) { add(semantic[0]!); continue; }
    }
    if (/^\d+$/.test(token)) {
      const index = Number(token) - 1;
      if (index >= 0 && index < identities.length) { add(identities[index]!.id); continue; }
    }
    return [];
  }
  return selected;
}
/** Whether the page exposes a native input we can read back, or only custom rows/classes. */
function hasNativeSelectionControl(el: HTMLElement): boolean {
  return Boolean(el.querySelector('input[id^="answer"], input[type="radio"], input[type="checkbox"]'));
}

/** Clicks the interactive element of a choice row (real input/label when present). */
function clickOption(control: HTMLElement): void {
  const input = control.matches("input")
    ? (control as HTMLInputElement)
    : control.querySelector<HTMLInputElement>('input[type="radio"],input[type="checkbox"]');
  if (input) {
    siteClick(input);
    // Framework skins sometimes listen to change on the input; a native click fires it,
    // but dispatch explicitly as well so a swallowed default action cannot skip the write.
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }
  const target = control.querySelector<HTMLElement>("label, [role='radio'], [role='checkbox'], [class*='option'], [class*='Option']") ?? control;
  const view = control.ownerDocument.defaultView;
  const EventCtor = (view as (Window & typeof globalThis) | null)?.MouseEvent ?? MouseEvent;
  for (const type of ["pointerdown", "mousedown", "mouseup", "click"]) {
    target.dispatchEvent(new EventCtor(type, { bubbles: true, cancelable: true }));
  }
}

/** Selection state across the observed quiz layouts: real radio/checkbox, aria or explicit class state. */
function optionSelected(control: HTMLElement): boolean {
  const input = control.matches("input")
    ? (control as HTMLInputElement)
    : control.querySelector<HTMLInputElement>('input[type="radio"],input[type="checkbox"]');
  if (input) return input.checked;
  const row = optionRow(control);
  if (control.getAttribute("aria-checked") === "true" || row.getAttribute("aria-checked") === "true") return true;
  if (control.getAttribute("aria-selected") === "true" || row.getAttribute("aria-selected") === "true") return true;
  // Only explicit state classes count; "active/on" also mark hover/decoration on some skins
  // and would make the fill step skip the real click.
  const classes = ((row.className || "") + " " + (control.className || "")).toString();
  return /(?:^|\s)(?:checked|selected)(?:\s|$)/i.test(classes);
}

function readAnswer(el: HTMLElement, question: StudyQuestion): StudyAnswer {
  const options = optionControls(el);
  const hidden = hiddenSelection(options, hiddenAnswer(el));
  const selected = options.flatMap((control, index) =>
    hidden.includes(`opt_${index + 1}`) || optionSelected(control) ? [`opt_${index + 1}`] : []);
  const fields = answerFields(el);
  if (fields.mode !== "NONE") {
    return {
      status: "ANSWERED",
      selectedOptionIds: [...new Set(selected)],
      blankAnswers: question.type === "FILL_BLANK" ? fields.targets.map((target, i) => ({ blankId: `blank_${i + 1}`, answer: fieldValue(target).trim() })) : [],
      textAnswer: question.type === "SHORT_ANSWER" ? fieldValue(fields.targets[0]!).trim() : null,
      explanation: "", caveats: []
    };
  }
  // No verified control was found (ordering/drag/draw/canvas or an unknown editor). The site's
  // own hidden answer stays the single readable state: a learner who answered on the page can be
  // verified against it, while an empty value is never treated as answered.
  const saved = hiddenAnswer(el);
  return {
    status: "ANSWERED",
    selectedOptionIds: [...new Set(selected)],
    blankAnswers: [],
    textAnswer: question.type === "SHORT_ANSWER" || question.type === "FILL_BLANK" ? saved : null,
    explanation: "", caveats: []
  };
}
function answerDigest(answer: StudyAnswer): string {
  return sha256Hex(JSON.stringify([answer.selectedOptionIds.slice().sort(),
    answer.blankAnswers.slice().sort((a, b) => a.blankId.localeCompare(b.blankId)).map(blank => ({ ...blank, answer: blank.answer.trim() })),
    answer.textAnswer?.trim() ?? null]));
}
/** Non-sensitive shape of the page state, appended to a failed read-back so the next diagnosis is concrete. */
function readbackDetail(el: HTMLElement, question: StudyQuestion, expected: StudyAnswer): string {
  const raw = hiddenAnswer(el);
  const shape = !raw ? "无" : /^[A-Ha-h]{1,8}$/.test(raw.replace(/\s+/g, "")) ? "字母" : booleanToken(raw) ? "布尔" : /^\d+$/.test(raw) ? "数字" : "其他文本";
  const detected = readAnswer(el, question).selectedOptionIds.length;
  const native = hasNativeSelectionControl(el) ? "有" : "无";
  return `（选项 ${optionControls(el).length} 个；隐藏答案值：${shape}；原生选中控件：${native}；已识别选中 ${detected} 项，期望 ${expected.selectedOptionIds.length} 项）`;
}
/** Infer the question type from its controls when the page label is missing or unknown. */
function inferredType(el: HTMLElement, controls: HTMLElement[]): QuestionType {
  const identities = controls.map((control, index) => optionIdentity(control, index));
  // Boolean wording is checked before radio: 判断题 skins also use real radio inputs.
  if (controls.length === 2 && identities.every(identity => identity.boolean) &&
      new Set(identities.map(identity => identity.boolean)).size === 2) return "TRUE_FALSE";
  if (controls.length === 2 && booleanToken(hiddenAnswer(el))) return "TRUE_FALSE";
  if (controls.some(control => control.matches('input[type="checkbox"]') || control.querySelector('input[type="checkbox"]'))) return "MULTIPLE_CHOICE";
  if (controls.some(control => control.matches('input[type="radio"]') || control.querySelector('input[type="radio"]'))) return "SINGLE_CHOICE";
  return "UNKNOWN";
}
/** Corrected type from manual补答, else the page label, else the shape of the answer being written. */
function applyType(el: HTMLElement, answer: StudyAnswer, override?: StudyQuestion["type"]): QuestionType {
  if (override && override !== "UNKNOWN") return override;
  const labeled = typeOf(el);
  if (labeled !== "UNKNOWN") return labeled === "SHORT_ANSWER" ? textTypeForFields(answerFields(el)) : labeled;
  const controls = optionControls(el);
  const inferred = inferredType(el, controls);
  if (inferred !== "UNKNOWN") return inferred;
  const fields = answerFields(el);
  if (!controls.length && fields.mode !== "NONE") return textTypeForFields(fields);
  if (answer.selectedOptionIds.length > 1) return "MULTIPLE_CHOICE";
  if (answer.selectedOptionIds.length === 1) return "SINGLE_CHOICE";
  if (answer.textAnswer?.trim()) return "SHORT_ANSWER";
  if (answer.blankAnswers.length) return "FILL_BLANK";
  return "UNKNOWN";
}

/** A session belongs to one top-level document. Element references and answers stay in that document. */
/**
 * 0.2.8 §8 D1: build a fully redacted diagnostic snapshot (structure counts and short enum
 * values only — never question text, answer, URL, HTML or a course identifier) so a failing
 * machine can paste one safe line for analysis. It must never throw: any DOM surprise yields a
 * best-effort object, and an all-zero baseline is returned on a hard failure.
 */
function buildDiagnostics(args: {
  docs: Document[]; markers: Element[]; module?: CourseModule; moduleCount: number; activeModule: number;
  kind: TaskKind; video: HTMLVideoElement | null; videos: HTMLVideoElement[]; pdfPresent: boolean; root: Document;
}): TaskDiagnostics {
  const zero: TaskDiagnostics = {
    documents: 0, iframes: 0, cardsFrames: 0, cardNumPresent: false, modules: 0, moduleKind: "none", activeModule: -1,
    anomalies: 0, markerTotal: 0, markerCompleted: 0, markerUnreadable: 0, videoCount: 0, videoReadyState: 0,
    videoSeekable: 0, currentTime: 0, duration: 0, ended: false, paused: false, pdfReady: false,
    scrollableCandidates: -1, submitCandidates: -1
  };
  try {
    let iframes = 0; let cardsFrames = 0; let cardNumPresent = false;
    for (const doc of args.docs) {
      for (const frame of [...doc.querySelectorAll("iframe")]) {
        iframes += 1;
        const source = frame.getAttribute("src") ?? "";
        let isCards = false; let num: string | null = null;
        try { const url = new URL(source, doc.location.href); isCards = url.pathname === "/mooc-ans/knowledge/cards"; num = url.searchParams.get("num"); }
        catch { isCards = /^\/mooc-ans\/knowledge\/cards\?/.test(source); }
        if (isCards) {
          cardsFrames += 1;
          if (num === null || !/^\d+$/.test(num)) { const raw = /[?&]num=(\d+)/.exec(source); num = raw?.[1] ?? null; }
          if (num !== null && /^\d+$/.test(num)) cardNumPresent = true;
        }
      }
    }
    let anomalies = 0;
    for (const marker of args.markers) {
      const wrapper = marker.closest(".ans-attach-ct");
      const frames = wrapper?.querySelectorAll("iframe");
      if (!wrapper || wrapper.querySelectorAll(".ans-job-icon").length !== 1 || frames?.length !== 1) anomalies += 1;
    }
    const markerCompletedCount = args.markers.filter(marker => markerCompleted(marker)).length;
    const markerUnreadable = args.markers.filter(marker => marker.getAttribute("aria-label") === null).length;
    const video = args.video;
    // Heavy scans are sampled selectively to keep the every-2.5s video poll cheap.
    let scrollableCandidates = -1;
    if (args.pdfPresent) {
      scrollableCandidates = 0;
      const scope = args.module?.root ? accessibleDocuments(args.module.root) : [args.root];
      for (const doc of scope.slice(0, 40)) {
        for (const el of [...doc.querySelectorAll("*")].slice(0, 4000)) {
          const html = el as HTMLElement;
          if (html.scrollHeight - html.clientHeight > 8) scrollableCandidates += 1;
        }
      }
    }
    let submitCandidates = -1;
    if (args.kind !== "VIDEO") {
      submitCandidates = submitSearchDocuments(args.module?.root ?? args.root).flatMap(submitControls).length;
    }
    const pdfDoc = args.docs.find(doc => doc.location.pathname === "/ananas/modules/pdf/index.html");
    return {
      documents: args.docs.length, iframes, cardsFrames, cardNumPresent,
      modules: args.moduleCount,
      moduleKind: args.module?.kind ?? "none", activeModule: args.activeModule, anomalies,
      markerTotal: args.markers.length, markerCompleted: markerCompletedCount, markerUnreadable,
      videoCount: args.videos.length, videoReadyState: video?.readyState ?? 0,
      videoSeekable: typeof video?.seekable?.length === "number" ? video.seekable.length : 0,
      currentTime: video ? Math.round((video.currentTime || 0) * 10) / 10 : 0,
      duration: video && Number.isFinite(video.duration) ? Math.round(video.duration * 10) / 10 : 0,
      ended: video?.ended ?? false, paused: video?.paused ?? false,
      pdfReady: pdfDoc?.readyState === "complete", scrollableCandidates, submitCandidates
    };
  } catch {
    return zero;
  }
}

export class CoursePage {
  private owner: string | null = null;
  private leaseAt = 0;
  private applied = new Map<number, { fingerprint: string; question: StudyQuestion; answer: string }>();
  private sendAttempted = false;
  private confirmAttempted = false;
  private confirmedNextControl: HTMLElement | null = null;
  private popupGeneration = 0;
  private priorTaskKey = "";
  private priorCardKey = "";
  private activeModule: number | null = null;
  private activeMarker: Element | null = null;
  private moduleIds = new WeakMap<Element, number>();
  private moduleSequence = 0;
  private modules: CourseModule[] = [];
  private skippedModules = new Set<Element>();
  private activeDiscussion: string | null = null;
  private advancedDiscussions = new Set<string>();
  private moduleRoot: Document | null | undefined;
  private startedVideos = new WeakSet<HTMLVideoElement>();
  constructor(private readonly root: Document) {}

  private taskDocuments(): Document[] {
    return this.moduleRoot === null ? [] : accessibleDocuments(this.moduleRoot ?? this.root);
  }
  /** A task may place its submit dialog in an ancestor document, outside its iframe. */
  private submissionDocuments(): Document[] {
    const docs = this.taskDocuments();
    let current: Document | null = this.moduleRoot ?? this.root;
    for (let depth = 0; current && current !== this.root && depth < 6; depth++) {
      let parent: Document | undefined;
      try { parent = current.defaultView?.frameElement?.ownerDocument; } catch { break; }
      if (!parent) break;
      current = parent;
      if (!docs.includes(current)) docs.push(current);
    }
    return docs;
  }
  private verifyApplied(): void {
    const questions = questionElements(this.work());
    if (!questions.length || this.applied.size !== questions.length) fail("尚未完整回填本任务，拒绝提交。");
    questions.forEach((el, i) => {
      const entry = this.applied.get(i);
      if (!entry || fingerprint(el) !== entry.fingerprint || answerDigest(readAnswer(el, entry.question)) !== entry.answer) fail("提交前回读不一致，已停止。");
    });
  }
  private taskVideo(): HTMLVideoElement | null {
    return this.moduleRoot === null ? null : currentVideo(this.moduleRoot ?? this.root);
  }
  private nextModule(): number {
    return this.modules.findIndex((module, index) => index !== this.activeModule &&
      !this.skippedModules.has(module.marker) && !markerCompleted(module.marker));
  }
  private nextDiscussion(): HTMLElement | undefined {
    return discussionEntries(this.taskDocuments()).find(entry => {
      const key = discussionIdentity(entry);
      return key !== this.activeDiscussion && !this.advancedDiscussions.has(key);
    });
  }
  private authorizedModuleSkips(): boolean {
    return this.skippedModules.size > 0 && this.nextModule() < 0 &&
      this.modules.every(module => markerCompleted(module.marker) || this.skippedModules.has(module.marker));
  }

  inspect(): TaskSnapshot {
    const host = this.root.location.hostname;
    const path = this.root.location.pathname;
    const fixture = this.root.body.dataset.automationFixture === "true" && ["localhost", "127.0.0.1", "[::1]"].includes(host);
    // 2026-10-20 用户授权：独立作业/测验作答页（dowork）纳入自动刷题；其余非课程任务页仍拒绝。
    // fixture 模式下用 body[data-automation-work] 模拟该页面，jsdom 无法改 location.pathname。
    const workPage = fixture ? this.root.body.dataset.automationWork === "true" : isWorkPagePath(path);
    if (!fixture && (host !== "chaoxing.com" && !host.endsWith(".chaoxing.com"))) fail("当前不是学习通课程页面。");
    if (!fixture && !workPage && !isCourseTaskPath(path)) fail("只允许在课程任务页面运行。");
    const docs = accessibleDocuments(this.root);
    if (docs.some(doc => isExamPath(doc.location.pathname))) fail("正式考试不在课程任务运行范围内。");
    const params = new URLSearchParams(this.root.location.search);
    if (workPage) {
      this.moduleRoot = undefined;
      // 独立作业页没有课程任务链：courseKey/taskKey 由页面自身参数派生（不读取题文、不落库）。
      const courseKey = fixture ? sha256Hex("fixture|work")
        : sha256Hex(`${params.get("courseId") ?? params.get("courseid") ?? ""}|${params.get("classId") ?? params.get("clazzid") ?? ""}`);
      const taskKey = fixture ? sha256Hex("fixture|work|task")
        : sha256Hex(`${courseKey}|${params.get("workId") ?? params.get("workid") ?? "work"}`);
      if (taskKey !== this.priorTaskKey) {
        this.applied.clear(); this.sendAttempted = false; this.confirmAttempted = false;
        this.priorTaskKey = taskKey;
      }
      const elements = docs.flatMap(doc => questionElements(doc));
      const submit = submitSearchDocuments(this.root).flatMap(submitControls);
      // 完成证据：明确的“已提交/查看答案”结果视图；或本页已点击提交且**作答视图已消失**
      // （题面与提交控件都不再出现）。仅隐藏提交按钮而题目仍在，不算完成（可能是提交中）。
      const completed = submittedCue(docs) || (this.sendAttempted && submit.length === 0 && elements.length === 0);
      const kind: TaskKind = completed ? "COMPLETED" : elements.length ? "QUIZ" : "UNKNOWN";
      const diagnostics = buildDiagnostics({ docs, markers: docs.flatMap(doc => [...doc.querySelectorAll(".ans-job-icon")]),
        module: undefined, moduleCount: 0, activeModule: -1, kind, video: null, videos: videoCandidates(this.root),
        pdfPresent: false, root: this.root });
      return { courseKey, taskKey, kind,
        completed, questionCount: elements.length, hasNext: false, video: null, standalone: true, diagnostics };
    }
    const cardIndex = cardIndexOf(this.root);
    const courseKey = sha256Hex(`${params.get("courseId") ?? params.get("courseid") ?? "fixture"}|${params.get("clazzid") ?? ""}`);
    let chapter = params.get("chapterId") ?? this.root.body.dataset.taskId ?? "current";
    const primarySource = this.root.querySelector<HTMLIFrameElement>("#iframe")?.getAttribute("src");
    if (primarySource && loadedCardsNum(this.root) !== null) {
      try { chapter = new URL(primarySource, this.root.location.href).searchParams.get("knowledgeid") ?? chapter; } catch { /* Legacy frame URL. */ }
    }
    const cardKey = sha256Hex(`${courseKey}|${chapter}|${cardIndex}`);
    if (cardKey !== this.priorCardKey) {
      this.activeModule = null; this.activeMarker = null; this.skippedModules.clear(); this.priorCardKey = cardKey;
      this.activeDiscussion = null; this.advancedDiscussions.clear();
    }
    if (cardsLoading(this.root)) {
      return { courseKey, taskKey: cardKey, kind: "UNKNOWN", completed: false, questionCount: 0, hasNext: false, video: null };
    }
    this.modules = courseModules(docs);
    this.activeModule = this.activeMarker ? this.modules.findIndex(module => module.marker === this.activeMarker) : null;
    if (this.activeModule === -1) this.activeModule = null;
    if (this.modules.length && this.activeModule === null) {
      const pending = this.modules.findIndex(module => !markerCompleted(module.marker));
      this.activeModule = pending < 0 ? 0 : pending;
    }
    const module = this.activeModule === null ? undefined : this.modules[this.activeModule];
    this.activeMarker = module?.marker ?? null;
    if (module && !this.moduleIds.has(module.marker)) this.moduleIds.set(module.marker, ++this.moduleSequence);
    this.moduleRoot = module ? module.root : undefined;
    let taskKey = module ? sha256Hex(`${cardKey}|module:${this.moduleIds.get(module.marker)}`) : cardKey;
    const markers = docs.flatMap(doc => [...doc.querySelectorAll(".ans-job-icon")]);
    const markedCompleted = module ? markerCompleted(module.marker) : markers.length > 0 && markers.every(markerCompleted);
    const taskDocs = this.taskDocuments();
    const discussions = discussionEntries(taskDocs);
    if (!discussions.some(entry => discussionIdentity(entry) === this.activeDiscussion)) this.activeDiscussion = null;
    if (this.activeDiscussion === null && discussions.length) {
      const pending = discussions.find(entry => !this.advancedDiscussions.has(discussionIdentity(entry))) ?? discussions[0]!;
      this.activeDiscussion = discussionIdentity(pending);
    }
    const work = taskDocs.find(doc => questionElements(doc).length > 0);
    const material = markers.length === 0 && docs.some(doc =>
      doc.location.pathname === "/ananas/modules/pdf/index.html" || staticContentCard(doc));
    const video = this.taskVideo();
    // Already-completed lessons need no replay. Once this run starts a video, however,
    // a site's 90%-watched marker must not cut off its final segment.
    const completed = markedCompleted && (!video || !this.startedVideos.has(video) || video.ended);
    const resource = module?.kind === "RESOURCE" && taskDocs.some(doc =>
      doc.location.pathname === "/ananas/modules/pdf/index.html" && doc.readyState === "complete");
    const next = this.root.querySelector<HTMLElement>("#prevNextFocusNext");
    const hasNext = Boolean(this.nextDiscussion()) || this.nextModule() >= 0 || nextSectionIndex(this.root) !== null ||
      Boolean(next && visible(next) && !next.classList.contains("disable") && next.getAttribute("aria-disabled") !== "true");
    const kind: TaskKind = completed ? "COMPLETED" : work || module?.kind === "QUIZ" ? "QUIZ" : video ? "VIDEO"
      : discussions.length > 0 ? "DISCUSSION"
      : resource ? "RESOURCE" : material ? "MATERIAL" : "UNKNOWN";
    if (discussions.length && !work && !video && (kind === "DISCUSSION" || kind === "COMPLETED")) {
      taskKey = sha256Hex(`${taskKey}|discussion:${this.activeDiscussion}`);
    }
    if (taskKey !== this.priorTaskKey) {
      this.applied.clear(); this.sendAttempted = false; this.confirmAttempted = false;
      this.priorTaskKey = taskKey;
    }
    const diagnostics = buildDiagnostics({ docs, markers, module, moduleCount: this.modules.length,
      activeModule: this.activeModule ?? -1, kind, video, videos: videoCandidates(this.root),
      pdfPresent: docs.some(doc => doc.location.pathname === "/ananas/modules/pdf/index.html"), root: this.root });
    return { courseKey, taskKey, kind,
      completed, questionCount: work ? questionElements(work).length : 0, hasNext,
      video: video ? { paused: video.paused, ended: video.ended, currentTime: video.currentTime,
        duration: Number.isFinite(video.duration) ? video.duration : 0, error: video.error !== null } : null,
      diagnostics };
  }

  private work(): Document { return this.taskDocuments().find(doc => questionElements(doc).length) ?? fail("题目文档已变化。"); }
  private element(index: number): HTMLElement { return questionElements(this.work())[index] ?? fail("题目已变化。"); }

  private async describe(index: number): Promise<TaskQuestion> {
    const el = this.element(index);
    const controls = optionControls(el);
    const labeled = typeOf(el);
    let type: QuestionType = labeled !== "UNKNOWN" ? labeled : inferredType(el, controls);
    // An unrecognised type no longer aborts the whole task: it is captured for the manual
    // summary, where the user can pick the correct type before补答.
    // Lazy blanks expose stable logical slots. Opening every editor while capturing causes
    // the site to close earlier editors and makes unrelated captures change the fingerprint.
    if (answerFields(el).mode !== "LAZY_UEDITOR") {
      for (const placeholder of el.querySelectorAll<HTMLElement>(".InpDIV")) {
        if (visible(placeholder)) siteClick(placeholder);
      }
    }
    const options = controls.map((control, i) => {
      const identity = optionIdentity(control, i);
      return { id: identity.id, text: identity.text || identity.data || identity.letter };
    });
    const fields = answerFields(el);
    if (controls.some(control => !visible(control) || control.closest('[inert],[aria-disabled="true"],[disabled]'))) fail("选项当前不可交互。");
    // Non-paste answer controls: the verified UEditor is not the only way a skin stores text.
    // Plain inputs and generic contenteditable get per-control writers; an unknown widget is
    // captured as a text question so the model can still propose an answer, but it is never
    // reported as writable and never silently guessed at.
    let answerMode: AnswerMode | undefined;
    let answerReason: string | undefined;
    if (type === "FILL_BLANK" || type === "SHORT_ANSWER") {
      if (fields.mode === "NONE") {
        answerReason = "页面答题控件不是已适配的编辑器、纯输入框或富文本（可能是排序/连线/拖拽/画图等非文本控件），无法自动回填；已按文字题请求候选，请在网页作答后点核验。";
        type = "SHORT_ANSWER";
      } else if (type === "SHORT_ANSWER") {
        // A short-answer label with several editable regions is a blank layout, not a failure.
        type = textTypeForFields(fields);
      }
      answerMode = fields.mode;
    } else if (type === "UNKNOWN" && fields.mode !== "NONE" && options.length === 0) {
      // Resource Analysis and other unknown labels can expose multiple numbered blanks.
      // Keep the same field cardinality in READ_ALL, CAPTURE and the APPLY schema.
      type = textTypeForFields(fields);
      answerMode = fields.mode;
    } else if (type === "UNKNOWN" && NON_TEXT_LABELS.test(labelText(el))) {
      answerReason = "页面题型不是可自动填写的文本题（排序/连线/拖拽/画图等非粘贴控件），无法自动回填；已按文字题请求候选，请在网页作答后点核验。";
      type = "SHORT_ANSWER";
      answerMode = "NONE";
    }
    const blanks = type === "FILL_BLANK" ? fields.targets.map((_, i) => ({ id: `blank_${i + 1}`, label: `第 ${i + 1} 空` })) : [];
    const source = await readQuestionSource(el);
    return { index, fingerprint: fingerprint(el), needsImage: source.needsImage, sourceReason: source.reason,
      // Empty source.stem means readQuestionSource could not recover trustworthy text (font code
      // unknown, image-only stem or over the limit), so only the rendered image could answer it.
      textUsable: source.stem.length > 0,
      ...(answerMode ? { answerMode } : {}),
      ...(answerReason ? { answerReason } : {}),
      question: { id: `q_${index + 1}`, type,
        stem: source.stem || "请解答附带图像中的本题，返回定义的选项/空格 ID；无法看清时返回 NEEDS_CONTEXT。",
        options: options.map((option, i) => ({ ...option, text: source.options[i] || option.text })), blanks } };
  }

  async capture(index: number, forceImage = false, imagePass: "render" | "originals" | "whole" = "render"): Promise<TaskQuestion> {
    const captured = await this.describe(index);
    if (imagePass === "originals") {
      // 2026-10-20 用户授权（纯图片题全自动）：文字读不出、合成题图失败或模型看不清时，
      // 自动改发原图原版数据（原尺寸、按需有界降尺度），不新增权限、不绕过 CORS。
      const originals = await extractOriginalImages(this.element(index));
      captured.question.imageDataUrl = originals[0]!;
      if (originals.length > 1) captured.question.extraImageDataUrls = originals.slice(1, 3);
      captured.imageSource = "originals";
      return captured;
    }
    if (!captured.needsImage && !forceImage && imagePass !== "whole") return captured;
    // Diagrams detected by the source reader are required: do not silently render text only.
    try { captured.question.imageDataUrl = await renderQuestion(this.element(index), captured.needsImage || imagePass === "whole"); }
    catch (error) {
      if (error instanceof QuestionImageError) throw new QuestionImageError(error.message, captured);
      throw error;
    }
    captured.imageSource = "render";
    if (imagePass === "whole") captured.imageRequired = true;
    return captured;
  }

  private async adoptExisting(index: number): Promise<{ captured: TaskQuestion; existingAccepted: boolean }> {
    const captured = await this.describe(index);
    let answer: StudyAnswer;
    try { answer = chooseAnswer(captured.question, [readAnswer(this.element(index), captured.question)]).answer; }
    catch { return { captured, existingAccepted: false }; }
    this.applied.set(index, { fingerprint: captured.fingerprint, question: captured.question, answer: answerDigest(answer) });
    return { captured, existingAccepted: true };
  }

  private async apply(index: number, expected: string, answer: StudyAnswer, override?: StudyQuestion["type"]): Promise<void> {
    const el = this.element(index);
    if (fingerprint(el) !== expected) fail("题目内容已变化，拒绝写入。");
    // Consensus already decided this answer is safe to write; learner-facing caveats do not
    // block it (docs/course-automation.md), unlike a non-ANSWERED status.
    if (answer.status !== "ANSWERED") fail("模型答案不可直接写入，已暂停。");
    const type = applyType(el, answer, override);
    if (type === "UNKNOWN") fail("题型未知且答案形态无法判断，拒绝写入；请在汇总里选择题型后补答。");
    const options = optionControls(el);
    const fields = answerFields(el);
    if (options.some(control => !visible(control) || control.closest('[inert],[aria-disabled="true"],[disabled]'))) fail("选项当前不可交互。");
    const question: StudyQuestion = { id: `q_${index + 1}`, type, stem: "本题",
      options: options.map((_, i) => ({ id: `opt_${i + 1}`, text: "" })),
      blanks: type === "FILL_BLANK" ? fields.targets.map((_, i) => ({ id: `blank_${i + 1}`, label: "" })) : [] };
    const expectedDigest = answerDigest(answer);
    const fillText = async (target: HTMLElement): Promise<void> => {
      // An unknown widget (ordering/drag/draw/unknown editor) has no verified writer: stop with a
      // concrete reason instead of pretending the answer was written.
      if (fields.mode === "NONE") {
        fail("页面答题控件不是已适配的编辑器、纯输入框或富文本（可能是排序/连线/拖拽/画图等非文本控件），无法自动回填；请在网页作答后点核验。");
      }
      const values = type === "SHORT_ANSWER" ? [answer.textAnswer ?? ""] : question.blanks.map(blank => answer.blankAnswers.find(a => a.blankId === blank.id)?.answer ?? "");
      const live = answerFields(target);
      if (live.mode === "NONE" || live.targets.length !== values.length) fail("答题控件在回填前发生变化，已停止。");
      if (!values.length || values.some(value => !value.trim())) fail("模型空格/文本答案不完整。");
      for (let i = 0; i < live.targets.length; i++) {
        if (fingerprint(this.element(index)) !== expected) fail("题目内容在回填期间已变化，已停止。");
        const slot = live.targets[i]!;
        await writeFieldSlot(slot, values[i]!, () => {
          const current = this.element(index);
          if (!current.contains(slot) || fingerprint(current) !== expected) fail("题目内容在编辑器加载期间已变化，未写入。");
        });
      }
    };
    if (["SINGLE_CHOICE", "TRUE_FALSE", "MULTIPLE_CHOICE"].includes(type)) {
      if (!answer.selectedOptionIds.length || new Set(answer.selectedOptionIds).size !== answer.selectedOptionIds.length ||
          (type !== "MULTIPLE_CHOICE" && answer.selectedOptionIds.length !== 1) ||
          answer.selectedOptionIds.some(id => !question.options.some(option => option.id === id))) fail("模型选项映射不完整。");
      const current = readAnswer(el, question).selectedOptionIds;
      for (let i = 0; i < options.length; i++) {
        const id = `opt_${i + 1}`;
        if (type === "MULTIPLE_CHOICE" ? current.includes(id) !== answer.selectedOptionIds.includes(id) :
            answer.selectedOptionIds.includes(id) && !current.includes(id)) clickOption(options[i]!);
      }
    } else {
      await fillText(el);
    }
    // Quiz skins update hidden answers and custom rows asynchronously (and some re-render
    // the question element after a click). Read back until the page settles instead of
    // trusting a single fixed delay, then report the concrete shape of a real mismatch.
    const startedAt = Date.now();
    const deadline = startedAt + 2500;
    let retriedClick = false;
    let rewroteText = false;
    let detail = "";
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 150));
      let currentEl: HTMLElement;
      try { currentEl = this.element(index); }
      catch { fail("题目文档在回填后已变化，已停止；不会提交。"); }
      if (currentEl.id !== el.id) fail("回填后页面切换了题目，已停止；不会提交。");
      const digest = answerDigest(readAnswer(currentEl, question));
      if (digest === expectedDigest) {
        if (fingerprint(currentEl) === expected) {
          this.applied.set(index, { fingerprint: expected, question, answer: expectedDigest });
          return;
        }
        detail = "题目内容在回填后发生变化";
      } else {
        detail = "页面没有保留回填结果（回读不一致）" + readbackDetail(currentEl, question, answer);
      }
      const elapsed = Date.now() - startedAt;
      // Some custom rows swallow the first synthetic click; retry once, but never toggle a
      // checkbox twice (that would deselect the expected multiple-choice option).
      if (!retriedClick && elapsed >= 900 && type !== "MULTIPLE_CHOICE" &&
          readAnswer(currentEl, question).selectedOptionIds.length === 0) {
        retriedClick = true;
        const currentControls = optionControls(currentEl);
        if (currentControls.length === options.length) {
          for (let i = 0; i < currentControls.length; i++) {
            if (answer.selectedOptionIds.includes(`opt_${i + 1}`)) clickOption(currentControls[i]!);
          }
        }
      }
      // A re-render may recreate rich-text editors or inputs empty; write the same plain text once more.
      if (!rewroteText && elapsed >= 900 && (type === "FILL_BLANK" || type === "SHORT_ANSWER") &&
          answerFields(currentEl).targets.every(target => !fieldValue(target).trim())) {
        rewroteText = true;
        await fillText(currentEl);
      }
    }
    fail(`第 ${index + 1} 题${detail || "回填后无法确认页面状态"}。`);
  }

  /**
   * Enumerate one video popup question (弹题) end to end: click the site's own option rows in
   * DOM order, commit through the popup's own confirm control when it has exactly one, and
   * take the first option after which the popup closes or the video resumes. Bounded to
   * ≤12 options and ~4.8s per option. Returns counts only — option text and answers never
   * leave the page document, and no model is called (2026-10-19 免人工枚举授权).
   */
  private async enumVideoPopup(command: AutomationCommand): Promise<PopupOutcome> {
    const video = this.taskVideo();
    if (!video || !video.paused || video.ended || this.inspect().kind !== "VIDEO") {
      return { found: false, resolved: false, attempts: 0, options: 0 };
    }
    const generation = this.popupGeneration;
    const check = () => {
      const snapshot = this.inspect();
      if (generation !== this.popupGeneration || this.owner !== command.runId ||
          snapshot.courseKey !== command.courseKey || snapshot.taskKey !== command.taskKey) fail("弹题处理已取消或任务已变化。");
    };
    const find = () => this.taskDocuments().flatMap(doc => popupCandidates(doc))
      .filter(candidate => candidate.options.length >= 2 && candidate.options.length <= 12);
    const candidates = find();
    if (!candidates.length) return { found: false, resolved: false, attempts: 0, options: 0 };
    if (candidates.length !== 1) fail("视频弹题不唯一，已停止。");
    let popup = candidates[0]!;
    const options = popup.options.length;
    const signature = (candidate: PopupCandidate) => candidate.options.map(option =>
      visibleText(option.closest("label") ?? option) + "|" + (option.getAttribute("value") ?? "")).join("\n");
    const original = signature(popup);
    const refresh = (): boolean => {
      check();
      const current = find();
      if (!current.length) return false;
      if (current.length !== 1 || signature(current[0]!) !== original) fail("视频弹题选项已变化，已停止。");
      popup = current[0]!;
      return true;
    };
    const passed = (attempt: number): PopupOutcome => ({ found: true, resolved: true, attempts: attempt, options });
    for (let index = 0; index < options; index++) {
      if (!refresh()) return passed(index);
      clickOption(popup.options[index]!);
      await delay(300);
      if (!refresh()) return passed(index + 1);
      const confirm = popupConfirmButton(popup.box);
      if (confirm) siteClick(confirm);
      const deadline = Date.now() + 4500;
      while (Date.now() < deadline) {
        await delay(250);
        if (!refresh()) return passed(index + 1);
        if (video && !video.paused && !video.ended) return passed(index + 1);
      }
    }
    return { found: true, resolved: false, attempts: options, options };
  }

  async handle(command: AutomationCommand): Promise<AutomationResponse> {
    try {
      const snapshot = this.inspect();
      if (command.action === "RELEASE") {
        if (this.owner && this.owner !== command.runId) fail("此课程标签由另一个调度器持有。");
        this.popupGeneration++;
        if (this.owner === command.runId && command.courseKey === snapshot.courseKey && command.taskKey === snapshot.taskKey) {
          for (const video of accessibleDocuments(this.root).flatMap(doc => [...doc.querySelectorAll("video")])) video.pause();
        }
        // A task change may cancel a pipeline. Its owner must still be able to release
        // the old lease, without touching a newly navigated task's media controls.
        this.owner = null; this.leaseAt = 0; this.confirmedNextControl = null;
        this.activeModule = null; this.activeMarker = null; this.skippedModules.clear();
        this.activeDiscussion = null; this.advancedDiscussions.clear();
        this.startedVideos = new WeakSet<HTMLVideoElement>();
        return { ok: true };
      }
      if (command.courseKey && (command.courseKey !== snapshot.courseKey || command.taskKey !== snapshot.taskKey)) fail("课程或任务已变化，请重新启动。");
      if (this.owner && this.owner !== command.runId && Date.now() - this.leaseAt < 120000) fail("此课程标签已有另一个调度器运行。");
      this.owner = command.runId; this.leaseAt = Date.now();
      if (command.action === "INSPECT") return { ok: true, snapshot };
      if (command.action === "READ_ONE") return { ok: true, captured: await this.describe(command.index!) };
      if (command.action === "READ_ALL") {
        const elements = questionElements(this.work());
        if (!elements.length || elements.length > 200) fail("任务题目数量不受支持。");
        const questions: TaskQuestion[] = [];
        for (let index = 0; index < elements.length; index++) questions.push(await this.describe(index));
        return { ok: true, questions };
      }
      if (command.action === "CAPTURE") return { ok: true, captured: await this.capture(command.index!, command.forceImage === true, command.imagePass ?? "render") };
      if (command.action === "ADOPT_EXISTING") return { ok: true, ...await this.adoptExisting(command.index!) };
      if (command.action === "APPLY") { await this.apply(command.index!, command.fingerprint!, command.answer!, command.questionType); return { ok: true }; }
      if (command.action === "SEND_WORK") {
        if (this.sendAttempted) fail("此任务已尝试提交，不自动重复提交。");
        this.verifyApplied();
        const taskDocs = this.taskDocuments();
        // A restarted run can inherit an already-open confirmation. The site may render that
        // dialog in an ancestor page outside the task iframe, so adopt it (searching ancestors)
        // only after complete answer verification, without re-clicking the underlying submit.
        if (this.submissionDocuments().some(doc => confirmButton(doc))) { this.sendAttempted = true; return { ok: true }; }
        // The real submit control lives in the task frame; keep the uniqueness search scoped to
        // task documents so an unrelated Submit in the parent page can never widen the candidate set.
        const buttons = [...new Set(taskDocs.flatMap(submitControls))];
        if (buttons.length !== 1) fail(`无法唯一确认站点提交按钮（候选 ${buttons.length} 个，已搜索 ${taskDocs.length} 个同源文档）。`);
        this.sendAttempted = true;
        siteClick(buttons[0]!);
      } else if (command.action === "CONFIRM_WORK") {
        if (!this.sendAttempted || this.confirmAttempted) return { ok: true };
        const buttons = [...new Set(this.submissionDocuments().map(confirmButton).filter((button): button is HTMLElement => Boolean(button)))];
        if (buttons.length > 1) fail("提交确认框不唯一，已停止。");
        const button = buttons[0];
        if (button) {
          this.verifyApplied();
          this.confirmAttempted = true;
          siteClick(button);
        }
      } else if (command.action === "CONFIRM_NEXT") {
        const skip = this.authorizedModuleSkips() && snapshot.completed || command.allowSkipUnfinished === true &&
          (snapshot.kind === "VIDEO" || snapshot.kind === "QUIZ" || snapshot.kind === "RESOURCE" || snapshot.kind === "DISCUSSION");
        const button = nextNoticeControl(this.root, skip);
        if (!button) { this.confirmedNextControl = null; return { ok: true }; }
        if (button === this.confirmedNextControl) return { ok: true };
        this.confirmedNextControl = button;
        siteClick(button);
        return { ok: true, nextNotice: skip ? "SKIP_CONFIRMED" : "LEARN_REMAINING" };
      } else if (command.action === "NEXT") {
        // Intentional skips carry their own authorization: 刷题模式 (skipVideos) leaves an
        // unfinished VIDEO behind; 只刷课模式 leaves a QUIZ or an opened PDF/PPT RESOURCE
        // behind. Unknown/unloaded modules still block the jump.
        const skipUnfinished = command.allowSkipUnfinished === true &&
          (snapshot.kind === "VIDEO" || snapshot.kind === "QUIZ" || snapshot.kind === "RESOURCE" || snapshot.kind === "DISCUSSION");
        if (!snapshot.completed && snapshot.kind !== "MATERIAL" && !skipUnfinished) fail("站点尚未确认本任务完成，拒绝跳转。");
        // Several optional discussions can share one horizontal card without job markers.
        // Advance within that list before leaving the module, tab or chapter.
        if (snapshot.kind === "DISCUSSION" && this.activeDiscussion !== null) {
          this.advancedDiscussions.add(this.activeDiscussion);
          const upcoming = this.nextDiscussion();
          if (upcoming) { this.activeDiscussion = discussionIdentity(upcoming); return { ok: true }; }
        }
        if (this.activeModule !== null && this.modules[this.activeModule]) {
          if (skipUnfinished && !snapshot.completed) this.skippedModules.add(this.modules[this.activeModule]!.marker);
          const upcoming = this.nextModule();
          if (upcoming >= 0) {
            this.taskVideo()?.pause();
            this.popupGeneration++; this.activeModule = upcoming; this.activeMarker = this.modules[upcoming]!.marker;
            return { ok: true };
          }
        }
        const sectionIndex = nextSectionIndex(this.root);
        if (sectionIndex !== null) {
          this.taskVideo()?.pause();
          this.popupGeneration++;
          const section = await switchSectionTab(this.root, sectionIndex);
          if (!section.confirmed) fail("横向标签切换未得到站点确认，已停止。");
          return { ok: true, section };
        }
        const next = this.root.querySelector<HTMLElement>("#prevNextFocusNext");
        if (!snapshot.hasNext || !next) fail("没有可用的下一个任务。");
        this.confirmedNextControl = null;
        siteClick(next);
      } else if (command.action === "OPEN_DISCUSSION") {
        if (snapshot.kind !== "DISCUSSION") fail("当前不是已适配的讨论入口。");
        const entry = discussionEntries(this.taskDocuments()).find(candidate => discussionIdentity(candidate) === this.activeDiscussion);
        if (!entry) fail("无法确认当前讨论入口。");
        // The real entry exposes its destination in `data`. Return it to the trusted
        // background instead of relying on an ungestured window.open and popup discovery.
        const discussionUrl = entry.getAttribute("data") ?? "";
        if (!isDiscussionPageUrl(discussionUrl)) fail("讨论入口缺少已适配的目标地址。");
        return { ok: true, discussionUrl };
      } else if (command.action === "ENUM_POPUP") {
        return { ok: true, popup: await this.enumVideoPopup(command) };
      } else if (command.action === "SEEK_TAIL") {
        if (snapshot.kind !== "VIDEO") fail("当前任务不是视频，无法定位到末尾。");
        const video = this.taskVideo();
        if (!video) fail("页面上没有可操作的播放器。");
        return { ok: true, seek: seekToTail(video) };
      } else if (command.action === "PLAY_FROM_START") {
        if (snapshot.kind !== "VIDEO") fail("当前任务不是视频，无法从头播放。");
        const video = this.taskVideo();
        if (!video) fail("页面上没有可操作的播放器。");
        this.popupGeneration++;
        try { video.currentTime = 0; } catch { /* 播放器拒绝定位时仍继续完整播放 */ }
        await startVideo(video);
      } else if (command.action === "SCROLL_MATERIAL") {
        if (snapshot.kind !== "RESOURCE") fail("当前任务不是已打开的资料页，无法滚动。");
        return { ok: true, scroll: await scrollMaterialToBottom(this.taskDocuments()) };
      } else if (command.action === "SWITCH_SECTION_TAB") {
        if (typeof command.sectionIndex !== "number") fail("缺少要切换的横向标签序号。");
        if (snapshot.standalone === true) fail("独立作业页没有章节横向标签栏。");
        if ((!snapshot.completed && snapshot.kind !== "MATERIAL") || this.nextModule() >= 0) fail("当前卡片仍有未处理任务，拒绝切换横向标签。");
        const section = await switchSectionTab(this.root, command.sectionIndex);
        // The active knowledge card changes with the tab, so drop any in-flight per-task pipeline;
        // the next INSPECT recomputes cardKey/activeModule from the newly loaded section. We never
        // claim success when the site did not move the tab — the runner stops on confirmed=false.
        this.popupGeneration++;
        this.applied.clear(); this.sendAttempted = false; this.confirmAttempted = false;
        this.priorTaskKey = ""; this.priorCardKey = "";
        return { ok: true, section };
      } else if (command.action === "PLAY" || command.action === "PAUSE_VIDEO") {
        const video = this.taskVideo();
        if (!video) fail("页面上没有可操作的播放器。");
        if (command.action === "PAUSE_VIDEO") { this.popupGeneration++; video.pause(); }
        else { this.startedVideos.add(video); await startVideo(video); }
      }
      return { ok: true };
    } catch (error) {
      if (error instanceof QuestionImageError) return { ok: false, code: "CONTROL_UNSUPPORTED", detail: error.message,
        questionIssue: "IMAGE_UNREADABLE", captured: error.captured };
      return { ok: false, code: "CONTROL_UNSUPPORTED", detail: error instanceof Error ? error.message : "课程任务操作失败。" };
    }
  }
}
