import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderQuestion, extractOriginalImages } from "../src/automation/render-question";
import { QuestionImageError } from "../src/automation/question-image-error";

/**
 * jsdom has no canvas backend, no CSS font loading set and no Range layout, so the renderer is
 * exercised against explicit stubs. The assertions stay behavioural: which elements reach
 * ctx.drawImage, which data URI is loaded for an inline <svg>, and which error surfaces when a
 * visible diagram cannot be drawn. No screen capture and no network are involved.
 */

interface StubContext {
  fillStyle: string;
  font: string;
  textBaseline: string;
  scale: ReturnType<typeof vi.fn>;
  fillRect: ReturnType<typeof vi.fn>;
  drawImage: ReturnType<typeof vi.fn>;
  fillText: ReturnType<typeof vi.fn>;
}

let context: StubContext;
let imageSources: string[];
let imageOutcome: "load" | "error";

const originalGetContext = HTMLCanvasElement.prototype.getContext;
const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
const originalImageSrc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
const originalImageComplete = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "complete");
const originalImageNaturalWidth = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "naturalWidth");
const originalImageNaturalHeight = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "naturalHeight");

function questionElement(inner: string): HTMLElement {
  document.body.innerHTML = `<div id="question1"><div class="TiMu">${inner}</div></div>`;
  return document.querySelector<HTMLElement>("#question1")!;
}

function installDomStubs(): void {
  context = {
    fillStyle: "",
    font: "",
    textBaseline: "",
    scale: vi.fn(),
    fillRect: vi.fn(),
    drawImage: vi.fn(),
    fillText: vi.fn()
  };
  HTMLCanvasElement.prototype.getContext = (() => context as unknown as CanvasRenderingContext2D) as unknown as
    typeof HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.toDataURL = (() => "data:image/jpeg;base64,rendered") as unknown as
    typeof HTMLCanvasElement.prototype.toDataURL;
  // jsdom exposes requestAnimationFrame but not the CSS Font Loading API.
  Object.defineProperty(document, "fonts", { configurable: true, value: { ready: Promise.resolve() } });
  // Layout boxes for the question and every diagram element.
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, 0, 700, 300));
  vi.spyOn(Element.prototype, "getClientRects").mockImplementation(
    () => [new DOMRect(0, 0, 700, 300)] as unknown as DOMRectList
  );
  // Renderer text drawing measures each character through a Range.
  Range.prototype.getBoundingClientRect = (() => new DOMRect(0, 0, 10, 10)) as typeof Range.prototype.getBoundingClientRect;
  Range.prototype.getClientRects = (() => [new DOMRect(0, 0, 10, 10)] as unknown as DOMRectList) as typeof Range.prototype.getClientRects;
}

function installImageStubs(): void {
  imageSources = [];
  imageOutcome = "load";
  if (originalImageSrc?.get && originalImageSrc.set) {
    Object.defineProperty(HTMLImageElement.prototype, "src", {
      configurable: true,
      get(this: HTMLImageElement) {
        return originalImageSrc.get!.call(this) as string;
      },
      set(this: HTMLImageElement, value: string) {
        originalImageSrc.set!.call(this, value);
        imageSources.push(String(value));
        const outcome = imageOutcome;
        const image = this;
        setTimeout(() => {
          if (image.src.startsWith("data:image/svg+xml") || image.src === "https://cdn.example.test/code.png") {
            // Only explicitly loaded test images emit network events; static <img> layouts do not.
            image.dispatchEvent(new Event(outcome === "load" ? "load" : "error"));
          }
        }, 0);
      }
    });
  }
  Object.defineProperty(HTMLImageElement.prototype, "complete", { configurable: true, get: () => true });
  Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", {
    configurable: true,
    get: () => (imageOutcome === "load" ? 10 : 0)
  });
  Object.defineProperty(HTMLImageElement.prototype, "naturalHeight", {
    configurable: true,
    get: () => (imageOutcome === "load" ? 20 : 0)
  });
}

beforeEach(() => {
  installDomStubs();
  installImageStubs();
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
  Reflect.deleteProperty(document, "fonts");
  HTMLCanvasElement.prototype.getContext = originalGetContext;
  HTMLCanvasElement.prototype.toDataURL = originalToDataURL;
  if (originalImageSrc) Object.defineProperty(HTMLImageElement.prototype, "src", originalImageSrc);
  if (originalImageComplete) Object.defineProperty(HTMLImageElement.prototype, "complete", originalImageComplete);
  if (originalImageNaturalWidth) {
    Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", originalImageNaturalWidth);
  }
  if (originalImageNaturalHeight) {
    Object.defineProperty(HTMLImageElement.prototype, "naturalHeight", originalImageNaturalHeight);
  }
  Reflect.deleteProperty(Range.prototype as unknown as Record<string, unknown>, "getBoundingClientRect");
  Reflect.deleteProperty(Range.prototype as unknown as Record<string, unknown>, "getClientRects");
});

describe("question image rendering for non-image diagrams", () => {
  it("renders the full stem and every alternative image option with stable option IDs", async () => {
    const element = questionElement('<div class="Zy_TItle">Whole stem</div><ul class="theme-ulTop"><li>A<img id="imgA" src="data:image/png;base64,AAAA"></li><li>B<img id="imgB" src="data:image/png;base64,BBBB"></li></ul>');
    await renderQuestion(element, true);
    const images = context.drawImage.mock.calls.map(call => (call[0] as HTMLElement).id);
    expect(images).toEqual(["imgA", "imgB"]);
    const text = context.fillText.mock.calls.map(call => call[0]).join("");
    expect(text).toContain("Wholestem"); expect(text).toContain("opt_1"); expect(text).toContain("opt_2");
  });
  it("draws a visible canvas child with ctx.drawImage instead of rejecting it", async () => {
    const element = questionElement(
      '<div class="Zy_TItle"><span class="newZy_TItle">【Single Choice】</span><p>观察图示</p>' +
        '<canvas id="diagram" width="200" height="80"></canvas></div>' +
        '<ul class="Zy_ulTop"><li><span class="num_option" data="A">A</span>甲</li></ul>'
    );
    const canvas = element.querySelector<HTMLCanvasElement>("canvas")!;

    const image = await renderQuestion(element, true);

    expect(image).toMatch(/^data:image\//);
    expect(context.drawImage.mock.calls.some(call => call[0] === canvas)).toBe(true);
  });

  it("serializes an inline svg to a data URI image and draws it", async () => {
    const element = questionElement(
      '<div class="Zy_TItle"><span class="newZy_TItle">【Single Choice】</span><p>观察图示</p>' +
        '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60" viewBox="0 0 120 60">' +
        '<rect x="5" y="5" width="50" height="50" fill="#2da44e"></rect></svg></div>' +
        '<ul class="Zy_ulTop"><li><span class="num_option" data="A">A</span>甲</li></ul>'
    );

    const image = await renderQuestion(element, true);

    expect(image).toMatch(/^data:image\//);
    const svgSource = imageSources.find(source => source.startsWith("data:image/svg+xml"));
    expect(svgSource).toBeDefined();
    // The data URI must carry the serialized SVG markup, not an empty placeholder.
    expect(decodeURIComponent(svgSource!.split(",")[1] ?? "")).toContain("<svg");
    expect(context.drawImage.mock.calls.some(call => call[0] instanceof HTMLImageElement)).toBe(true);
  });

  it("throws a concrete QuestionImageError when a visible inline svg cannot load", async () => {
    imageOutcome = "error";
    const element = questionElement(
      '<div class="Zy_TItle"><span class="newZy_TItle">【Single Choice】</span><p>观察图示</p>' +
        '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60" viewBox="0 0 120 60">' +
        '<rect x="5" y="5" width="50" height="50" fill="#2da44e"></rect></svg></div>' +
        '<ul class="Zy_ulTop"><li><span class="num_option" data="A">A</span>甲</li></ul>'
    );

    const error = await renderQuestion(element, true).then(
      () => null,
      (reason: unknown) => reason
    );

    expect(error).toBeInstanceOf(QuestionImageError);
    expect((error as Error).message.length).toBeGreaterThan(0);
    // The failure must come from actually attempting the serialized SVG image.
    expect(imageSources.some(source => source.startsWith("data:image/svg+xml"))).toBe(true);
  });

  it("draws text found in open shadow roots and skips assistive/script/style/textarea content", async () => {
    const element = questionElement(
      '<div class="Zy_TItle"><span class="newZy_TItle">【Single Choice】</span><p>可见题干</p>' +
        '<div id="shadow-host"></div>' +
        '<mjx-assistive-mml>助读文字</mjx-assistive-mml>' +
        '<script>脚本文本</script><style>.x{color:red}</style><textarea>框内文本</textarea></div>' +
        '<ul class="Zy_ulTop"><li><span class="num_option" data="A">A</span>甲</li></ul>'
    );
    document.querySelector("#shadow-host")!.attachShadow({ mode: "open" }).innerHTML = "<p>影子文字</p>";

    await renderQuestion(element);

    const drawn = context.fillText.mock.calls.map(call => String(call[0]));
    expect(drawn).toContain("影");
    for (const skipped of ["助", "脚", "框"]) {
      expect(drawn).not.toContain(skipped);
    }
  });
});

describe("original image extraction for pure-image questions", () => {
  it("starts an anonymous cross-origin image load before awaiting its load event", async () => {
    const element = questionElement('<div class="Zy_TItle"><img src="https://cdn.example.test/code.png"></div>');
    const images = await extractOriginalImages(element);
    expect(images).toHaveLength(1);
    expect(imageSources).toContain("https://cdn.example.test/code.png");
    const reloaded = context.drawImage.mock.calls[0]![0] as HTMLImageElement;
    expect(reloaded.crossOrigin).toBe("anonymous");
  });
  it("extracts same-origin images at natural size without extra reloads", async () => {
    const element = questionElement(
      '<div class="Zy_TItle"><span class="newZy_TItle">【Single Choice】</span>' +
        '<img id="stem" src="/img/stem.png"></div>' +
        '<ul class="Zy_ulTop"><li><span class="num_option" data="A">A</span><img id="option" src="/img/option.png"></li></ul>'
    );
    const images = await extractOriginalImages(element);
    expect(images).toHaveLength(2);
    // Drawn at natural size (stubbed 10×20), not at the layout box the renderer would use.
    const stem = element.querySelector<HTMLImageElement>("#stem")!;
    expect(context.drawImage.mock.calls.some(call =>
      call[0] === stem && call[1] === 0 && call[2] === 0 && call[3] === 10 && call[4] === 20)).toBe(true);
  });

  it("skips hidden images and keeps extracting the visible ones", async () => {
    const element = questionElement(
      '<div class="Zy_TItle"><img src="/img/tracking.png" style="display:none">' +
        '<img id="ok" src="/img/ok.png"></div>' +
        '<ul class="Zy_ulTop"><li><span class="num_option" data="A">A</span></li></ul>'
    );
    const images = await extractOriginalImages(element);
    expect(images).toHaveLength(1);
  });

  it("reports a concrete error when no candidate image is readable at all", async () => {
    imageOutcome = "error";
    const element = questionElement(
      '<div class="Zy_TItle"><img src="/img/broken.png"></div>' +
        '<ul class="Zy_ulTop"><li><span class="num_option" data="A">A</span></li></ul>'
    );
    const error = await extractOriginalImages(element).then(() => null, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(QuestionImageError);
    expect((error as Error).message).toContain("原图");
  });

  it("refuses media-embedded questions exactly like the composite render", async () => {
    const element = questionElement(
      '<div class="Zy_TItle"><video src="/media/v.mp4"></video></div>' +
        '<ul class="Zy_ulTop"><li><span class="num_option" data="A">A</span></li></ul>'
    );
    const error = await extractOriginalImages(element).then(() => null, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(QuestionImageError);
    expect((error as Error).message).toContain("音视频");
  });

  it("keeps original size above the old per-image and total encoded caps", async () => {
    const large = "data:image/png;base64," + "A".repeat(700000);
    const encodes = vi.fn().mockReturnValue(large);
    HTMLCanvasElement.prototype.toDataURL = encodes as unknown as typeof HTMLCanvasElement.prototype.toDataURL;
    const element = questionElement('<div class="Zy_TItle"><img src="/img/big.png"><img src="/img/option.png"></div>');
    const images = await extractOriginalImages(element);
    expect(images).toEqual([large, large]);
    expect(encodes).toHaveBeenCalledTimes(2);
    expect(encodes.mock.calls.every(call => call[0] === "image/png")).toBe(true);
    expect(context.drawImage.mock.calls.every(call => call[3] === 10 && call[4] === 20)).toBe(true);
  });
  it("renders a composite larger than 400 KB without rejecting it", async () => {
    const large = "data:image/jpeg;base64," + "A".repeat(700000);
    HTMLCanvasElement.prototype.toDataURL = (() => large) as typeof HTMLCanvasElement.prototype.toDataURL;
    expect(await renderQuestion(questionElement('<div class="Zy_TItle">Complete question</div>'))).toBe(large);
  });

  it("reports unreadable originals when every encode throws (cross-origin taint)", async () => {
    HTMLCanvasElement.prototype.toDataURL = (() => {
      throw new Error("SecurityError");
    }) as unknown as typeof HTMLCanvasElement.prototype.toDataURL;
    const element = questionElement(
      '<div class="Zy_TItle"><img src="/img/remote.png"></div>' +
        '<ul class="Zy_ulTop"><li><span class="num_option" data="A">A</span></li></ul>'
    );
    const error = await extractOriginalImages(element).then(() => null, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(QuestionImageError);
    expect((error as Error).message).toContain("无法安全读取");
  });
});


describe("cooperative long-text rendering", () => {
  it("lets browser input tasks run before a long render finishes", async () => {
    const element = questionElement(`<div class="Zy_TItle">${"a".repeat(260)}</div>`);
    let inputHandled = false;
    const pending = renderQuestion(element);
    const timer = setTimeout(() => { inputHandled = true; }, 0);
    try {
      await pending;
      expect(inputHandled).toBe(true);
      expect(context.fillText).toHaveBeenCalledTimes(260);
    } finally { clearTimeout(timer); }
  });
  it("allows scrolling while retaining relative text coordinates", async () => {
    const element = questionElement(`<div class="Zy_TItle">${"a".repeat(260)}</div>`);
    let top = 0;
    vi.spyOn(element, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, top, 700, 300));
    Range.prototype.getBoundingClientRect = () => new DOMRect(10, top + 20, 10, 10);
    const pending = renderQuestion(element);
    const timer = setTimeout(() => { top = -100; }, 0);
    try {
      await pending;
      expect(context.fillText.mock.calls.every(call => call[1] === 10 && call[2] === 20)).toBe(true);
      expect(context.fillText).toHaveBeenCalledTimes(260);
    } finally { clearTimeout(timer); }
  });
  it("rejects a layout resize during the cooperative yield instead of sending a broken image", async () => {
    const element = questionElement(`<div class="Zy_TItle">${"a".repeat(260)}</div>`);
    const pending = renderQuestion(element);
    const timer = setTimeout(() => { vi.spyOn(element, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 650, 300)); }, 0);
    try { await expect(pending).rejects.toThrow("布局在渲染期间发生变化"); }
    finally { clearTimeout(timer); }
  });
});
