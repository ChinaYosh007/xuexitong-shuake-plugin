import { afterEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import fixture from "./helpers/source-font.json";
import { readQuestionSource } from "../src/automation/source-reader";
import { readTrueType } from "../src/automation/true-type";

afterEach(() => { document.body.replaceChildren(); document.head.replaceChildren(); vi.unstubAllGlobals(); });
function question(stem: string, options = "answer"): HTMLElement {
  document.body.innerHTML = `<div id="question1"><div class="Zy_TItle"><span class="newZy_TItle">Single Choice</span><p>${stem}</p></div><ul class="Zy_ulTop"><li><span class="num_option">A</span>${options}</li></ul></div>`;
  return document.querySelector<HTMLElement>("#question1")!;
}
describe("structured question source before image fallback", () => {
  it("requires images for choices inside an alternate option list", async () => {
    const element = question("Readable stem");
    element.querySelector(".Zy_ulTop")!.className = "theme-ulTop";
    element.querySelector("li")!.insertAdjacentHTML("beforeend", '<img src="option.png">');
    expect((await readQuestionSource(element)).needsImage).toBe(true);
  });
  it("reads plain source and option text without type labels or option-control prefixes", async () => {
    expect(await readQuestionSource(question("1 + 1?", "2"))).toMatchObject({ stem: "1 + 1?", options: ["2"], needsImage: false });
  });
  it("decodes a substituted glyph against an exact reference outline rather than trusting encoded CJK", async () => {
    vi.stubGlobal("crypto", webcrypto);
    document.head.innerHTML = `<style>@font-face{font-family:font-cxsecret;src:url(data:application/font-ttf;base64,${fixture.font})}</style>`;
    const result = await readQuestionSource(question('<span class="font-cxsecret">\ue001</span> + text'));
    expect(result.stem).toBe("中 + text"); expect(result.needsImage).toBe(false);
  });
  it("falls back for an unknown encoded font and for diagrams, retaining readable source alongside images", async () => {
    expect((await readQuestionSource(question('<span class="font-cxsecret">encoded</span>'))).needsImage).toBe(true);
    expect(await readQuestionSource(question('diagram <img src="test.png">'))).toMatchObject({ stem: "diagram", needsImage: true });
  });
  it("treats image-only choice content as an image question", async () => {
    const imageOnly = question("多选：以下正确的是（ ）", '<img src="option.png">');
    expect((await readQuestionSource(imageOnly)).needsImage).toBe(true);
    expect((await readQuestionSource(question("多选：以下正确的是（ ）", '<canvas></canvas>'))).needsImage).toBe(true);
  });
  it("rejects malformed font bytes and excessive table counts without network/font downloads", () => {
    expect(() => readTrueType(new Uint8Array(4))).toThrow();
    const bytes = new Uint8Array(12); const view = new DataView(bytes.buffer);
    view.setUint32(0, 0x00010000); view.setUint16(4, 129);
    expect(() => readTrueType(bytes)).toThrow();
  });
  it("reads stem text from an open shadow root without treating it as an image question", async () => {
    const element = question("可见题干");
    const host = document.createElement("div");
    document.querySelector("#question1 .Zy_TItle")!.append(host);
    host.attachShadow({ mode: "open" }).innerHTML = "<p>影子题干文字</p>";
    const result = await readQuestionSource(element);
    expect(result.stem).toContain("可见题干");
    expect(result.stem).toContain("影子题干文字");
    expect(result.needsImage).toBe(false);
    expect(result.reason).toBe("已读取结构化源文字");
  });
  it("flags inline svg stems as diagrams that need the rendered image", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20"></rect></svg>';
    expect(await readQuestionSource(question(`图示 ${svg}`))).toMatchObject({ needsImage: true });
  });
  it("flags audio/video/embedded frames as non-paste content that cannot be a static image", async () => {
    for (const tag of ["video", "audio", "iframe", "embed", "object"]) {
      const result = await readQuestionSource(question(`媒体题干 <${tag}></${tag}>`));
      expect(result.needsImage, tag).toBe(true);
      expect(result.reason, tag).toContain("非粘贴");
    }
  });
});
