import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoursePage, isExamPath, isWorkPagePath } from "../src/automation/course-page";
import type { AutomationCommand, TaskSnapshot } from "../src/automation/protocol";
import { renderQuestion, extractOriginalImages } from "../src/automation/render-question";
import { QuestionImageError } from "../src/automation/question-image-error";

vi.mock("../src/automation/render-question", () => ({
  renderQuestion: vi.fn(async () => "data:image/jpeg;base64,/9j/AAAA"),
  extractOriginalImages: vi.fn(async () => ["data:image/png;base64,iVBORAA", "data:image/png;base64,iVBORBB", "data:image/png;base64,iVBORCC"])
}));

describe("course page adapter", () => {
  let page: CoursePage;
  let snapshot: TaskSnapshot;
  let sends = 0;
  let confirms = 0;
  let next = 0;
  function command(action: AutomationCommand["action"], extra: Partial<AutomationCommand> = {}): AutomationCommand {
    return { action, requestId: "request_1", runId: "run_1", courseKey: snapshot.courseKey, taskKey: snapshot.taskKey, ...extra };
  }
  beforeEach(() => {
    vi.mocked(renderQuestion).mockClear();
    vi.mocked(extractOriginalImages).mockClear();
    vi.mocked(extractOriginalImages).mockImplementation(async () => ["data:image/png;base64,iVBORAA", "data:image/png;base64,iVBORBB", "data:image/png;base64,iVBORCC"]);
    sends = confirms = next = 0;
    document.body.innerHTML = `<div class="ans-job-icon" aria-label="任务点未完成"></div>
      <div id="question1"><div class="TiMu"><div class="Zy_TItle"><span class="newZy_TItle">【Single Choice】</span>Question</div>
      <ul class="Zy_ulTop"><li><span class="num_option" data="A">A</span></li><li><span class="num_option" data="B">B</span></li></ul>
      <input type="hidden" id="answer1" value="B"></div></div>
      <a class="btnSubmit">Submit</a><div id="confirmSubWin" style="display:none"><a class="bluebtn">OK</a></div>
      <div id="prevNextFocusNext">Next</div>`;
    document.body.dataset.automationFixture = "true";
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([new DOMRect(0, 0, 100, 40)] as unknown as DOMRectList);
    for (const option of document.querySelectorAll<HTMLElement>(".num_option")) {
      option.addEventListener("click", () => { document.querySelector<HTMLInputElement>("#answer1")!.value = option.getAttribute("data")!; });
    }
    document.querySelector(".btnSubmit")!.addEventListener("click", () => { sends++; document.querySelector<HTMLElement>("#confirmSubWin")!.style.display = "block"; });
    document.querySelector(".bluebtn")!.addEventListener("click", () => { confirms++; document.querySelector(".ans-job-icon")!.setAttribute("aria-label", "任务点已完成"); });
    document.querySelector("#prevNextFocusNext")!.addEventListener("click", () => { next++; });
    page = new CoursePage(document); snapshot = page.inspect();
  });
  afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); delete document.body.dataset.automationFixture; delete document.body.dataset.automationWork; });

  async function filled(): Promise<void> {
    const captured = await page.handle(command("CAPTURE", { index: 0 }));
    if (!captured.ok || !captured.captured) throw new Error("capture failed");
    const result = await page.handle(command("APPLY", { index: 0, fingerprint: captured.captured.fingerprint,
      answer: { status: "ANSWERED", selectedOptionIds: ["opt_1"], blankAnswers: [], textAnswer: null, explanation: "", caveats: [] } }));
    expect(result.ok).toBe(true);
  }
  it("reads one bound question without rendering, writing, or submitting", async () => {
    const result = await page.handle(command("READ_ONE", { index: 0 }));
    expect(result).toMatchObject({ ok: true, captured: { index: 0, question: { type: "SINGLE_CHOICE" } } });
    expect(renderQuestion).not.toHaveBeenCalled(); expect(sends).toBe(0);
    expect(document.querySelector<HTMLInputElement>("#answer1")!.value).toBe("B");
    expect((await page.handle(command("READ_ONE", { index: 1 }))).ok).toBe(false);
    expect((await page.handle(command("READ_ONE", { index: 0, taskKey: "changed" }))).ok).toBe(false);
  });
  it("requires a complete image for a whole-question retry even when the source looks textual", async () => {
    const captured = await page.handle(command("CAPTURE", { index: 0, imagePass: "whole" }));
    expect(captured).toMatchObject({ ok: true, captured: { imageRequired: true, imageSource: "render", question: { imageDataUrl: expect.stringMatching(/^data:image\//) } } });
    expect(renderQuestion).toHaveBeenCalledWith(document.querySelector("#question1"), true);
  });
  it("reads letter-based option rows without num_option and verifies the hidden answer by letter", async () => {
    const list = document.querySelector(".Zy_ulTop")!;
    list.innerHTML = '<li><span class="letter">A</span>选项一</li><li><span class="letter">B</span>选项二</li>';
    const hidden = document.querySelector<HTMLInputElement>("#answer1")!;
    hidden.value = "";
    list.querySelectorAll("li").forEach((row, index) => {
      row.addEventListener("click", () => { hidden.value = String.fromCharCode(65 + index); });
    });
    const captured = await page.handle(command("CAPTURE", { index: 0 }));
    if (!captured.ok || !captured.captured) throw new Error("capture failed");
    expect(captured.captured.question.options).toHaveLength(2);
    const result = await page.handle(command("APPLY", { index: 0, fingerprint: captured.captured.fingerprint,
      answer: { status: "ANSWERED", selectedOptionIds: ["opt_1"], blankAnswers: [], textAnswer: null, explanation: "", caveats: [] } }));
    expect(result.ok).toBe(true);
    expect(hidden.value).toBe("A");
    expect((await page.handle(command("SEND_WORK"))).ok).toBe(true);
  });
  it("reads and verifies a quiz layout that uses real radio inputs instead of a hidden answer string", async () => {
    document.querySelector("#answer1")!.remove();
    const list = document.querySelector(".Zy_ulTop")!;
    list.innerHTML = '<li><label><input type="radio" name="q1" value="A" /> 推理期</label></li>' +
      '<li><label><input type="radio" name="q1" value="B" /> 知识期</label></li>';
    const captured = await page.handle(command("CAPTURE", { index: 0 }));
    if (!captured.ok || !captured.captured) throw new Error("capture failed");
    const result = await page.handle(command("APPLY", { index: 0, fingerprint: captured.captured.fingerprint,
      answer: { status: "ANSWERED", selectedOptionIds: ["opt_2"], blankAnswers: [], textAnswer: null, explanation: "", caveats: [] },
      questionType: "SINGLE_CHOICE" }));
    expect(result.ok).toBe(true);
    expect(document.querySelector<HTMLInputElement>('input[value="B"]')!.checked).toBe(true);
    expect((await page.handle(command("SEND_WORK"))).ok).toBe(true);
  });
  it("reads and verifies a true/false skin whose hidden answer is true/false instead of letters", async () => {
    document.querySelector(".newZy_TItle")!.textContent = "【True or False】";
    const list = document.querySelector(".Zy_ulTop")!;
    list.innerHTML = '<li><span class="num_option" data="true">True</span></li><li><span class="num_option" data="false">False</span></li>';
    const hidden = document.querySelector<HTMLInputElement>("#answer1")!;
    hidden.value = "";
    for (const option of document.querySelectorAll<HTMLElement>(".num_option")) {
      option.addEventListener("click", () => { hidden.value = option.getAttribute("data")!; });
    }
    const captured = await page.handle(command("CAPTURE", { index: 0 }));
    if (!captured.ok || !captured.captured) throw new Error("capture failed");
    expect(captured.captured.question.type).toBe("TRUE_FALSE");
    const result = await page.handle(command("APPLY", { index: 0, fingerprint: captured.captured.fingerprint,
      answer: { status: "ANSWERED", selectedOptionIds: ["opt_2"], blankAnswers: [], textAnswer: null, explanation: "", caveats: [] } }));
    expect(result.ok).toBe(true);
    expect(hidden.value).toBe("false");
    expect((await page.handle(command("SEND_WORK"))).ok).toBe(true);
  });
  it("verifies a judgement question whose option rows carry boolean text and no data attribute", async () => {
    document.querySelector(".newZy_TItle")!.textContent = "判断题";
    const list = document.querySelector(".Zy_ulTop")!;
    list.innerHTML = "<li><span class=\"num_option\">对</span></li><li><span class=\"num_option\">错</span></li>";
    const hidden = document.querySelector<HTMLInputElement>("#answer1")!;
    hidden.value = "";
    list.querySelectorAll<HTMLElement>(".num_option").forEach((option, index) => {
      option.addEventListener("click", () => { hidden.value = index === 0 ? "true" : "false"; });
    });
    const captured = await page.handle(command("CAPTURE", { index: 0 }));
    if (!captured.ok || !captured.captured) throw new Error("capture failed");
    const result = await page.handle(command("APPLY", { index: 0, fingerprint: captured.captured.fingerprint,
      answer: { status: "ANSWERED", selectedOptionIds: ["opt_1"], blankAnswers: [], textAnswer: null, explanation: "", caveats: [] } }));
    expect(result.ok).toBe(true);
    expect(hidden.value).toBe("true");
  });
  it("waits for a delayed hidden answer update instead of failing on a single read", async () => {
    document.querySelector(".newZy_TItle")!.textContent = "True or False";
    const list = document.querySelector(".Zy_ulTop")!;
    list.innerHTML = '<li><span class="num_option" data="true">True</span></li><li><span class="num_option" data="false">False</span></li>';
    const hidden = document.querySelector<HTMLInputElement>("#answer1")!;
    hidden.value = "";
    for (const option of document.querySelectorAll<HTMLElement>(".num_option")) {
      option.addEventListener("click", () => {
        setTimeout(() => { hidden.value = option.getAttribute("data")!; }, 600);
      });
    }
    const captured = await page.handle(command("CAPTURE", { index: 0 }));
    if (!captured.ok || !captured.captured) throw new Error("capture failed");
    const result = await page.handle(command("APPLY", { index: 0, fingerprint: captured.captured.fingerprint,
      answer: { status: "ANSWERED", selectedOptionIds: ["opt_2"], blankAnswers: [], textAnswer: null, explanation: "", caveats: [] } }));
    expect(result.ok).toBe(true);
    expect(hidden.value).toBe("false");
  });
  it("re-reads the question after the skin replaces its option rows", async () => {
    const list = document.querySelector(".Zy_ulTop")!;
    const markup = list.innerHTML;
    const hidden = document.querySelector<HTMLInputElement>("#answer1")!;
    hidden.value = "";
    list.querySelectorAll<HTMLElement>(".num_option").forEach((option, index) => {
      option.addEventListener("click", () => {
        setTimeout(() => {
          list.innerHTML = markup;
          hidden.value = index === 0 ? "A" : "B";
        }, 200);
      });
    });
    const captured = await page.handle(command("CAPTURE", { index: 0 }));
    if (!captured.ok || !captured.captured) throw new Error("capture failed");
    const result = await page.handle(command("APPLY", { index: 0, fingerprint: captured.captured.fingerprint,
      answer: { status: "ANSWERED", selectedOptionIds: ["opt_2"], blankAnswers: [], textAnswer: null, explanation: "", caveats: [] } }));
    expect(result.ok).toBe(true);
    expect((await page.handle(command("SEND_WORK"))).ok).toBe(true);
  });
  it("infers true/false from boolean option labels when the type label is missing", async () => {
    document.querySelector(".newZy_TItle")!.textContent = "";
    const list = document.querySelector(".Zy_ulTop")!;
    list.innerHTML = "<li><span class=\"num_option\">True</span></li><li><span class=\"num_option\">False</span></li>";
    const hidden = document.querySelector<HTMLInputElement>("#answer1")!;
    hidden.value = "";
    list.querySelectorAll<HTMLElement>(".num_option").forEach((option, index) => {
      option.addEventListener("click", () => { hidden.value = index === 0 ? "true" : "false"; });
    });
    const captured = await page.handle(command("CAPTURE", { index: 0 }));
    if (!captured.ok || !captured.captured) throw new Error("capture failed");
    expect(captured.captured.question.type).toBe("TRUE_FALSE");
    const result = await page.handle(command("APPLY", { index: 0, fingerprint: captured.captured.fingerprint,
      answer: { status: "ANSWERED", selectedOptionIds: ["opt_1"], blankAnswers: [], textAnswer: null, explanation: "", caveats: [] } }));
    expect(result.ok).toBe(true);
  });
  it("keeps an unrecognised question readable for manual correction instead of aborting the task", async () => {
    document.querySelector(".newZy_TItle")!.textContent = "";
    const list = document.querySelector(".Zy_ulTop")!;
    list.innerHTML = "<li><span class=\"num_option\">红色</span></li><li><span class=\"num_option\">蓝色</span></li>";
    const hidden = document.querySelector<HTMLInputElement>("#answer1")!;
    hidden.value = "";
    list.querySelectorAll<HTMLElement>(".num_option").forEach((option, index) => {
      option.addEventListener("click", () => { hidden.value = index === 0 ? "A" : "B"; });
    });
    const captured = await page.handle(command("CAPTURE", { index: 0 }));
    if (!captured.ok || !captured.captured) throw new Error("capture failed");
    expect(captured.captured.question.type).toBe("UNKNOWN");
    expect(captured.captured.question.options).toHaveLength(2);
    const result = await page.handle(command("APPLY", { index: 0, fingerprint: captured.captured.fingerprint, questionType: "SINGLE_CHOICE",
      answer: { status: "ANSWERED", selectedOptionIds: ["opt_1"], blankAnswers: [], textAnswer: null, explanation: "", caveats: [] } }));
    expect(result.ok).toBe(true);
  });
  it.each(["【Resource Analysis】", "【资料题】", "【Short Answer】"])
    ("keeps two numbered fields as blanks from capture through apply: %s", async label => {
      document.querySelector(".newZy_TItle")!.textContent = label;
      document.querySelector(".Zy_ulTop")!.remove(); document.querySelector("#answer1")!.remove();
      document.querySelector(".Zy_TItle")!.insertAdjacentHTML("beforeend", '<p><img src="code.png"></p>');
      document.querySelector(".TiMu")!.insertAdjacentHTML("beforeend", '<label>No.1:<input type="text" name="first"></label><label>No.2:<textarea name="second"></textarea></label>');
      const inventory = await page.handle(command("READ_ALL"));
      if (!inventory.ok || !inventory.questions) throw new Error("inventory failed");
      expect(inventory.questions[0]).toMatchObject({ needsImage: true, answerMode: "TEXT_FIELD",
        question: { type: "FILL_BLANK", blanks: [{ id: "blank_1" }, { id: "blank_2" }] } });
      const result = await page.handle(command("CAPTURE", { index: 0 }));
      if (!result.ok || !result.captured) throw new Error("capture failed");
      expect(result.captured.question).toMatchObject({ type: "FILL_BLANK", imageDataUrl: "data:image/jpeg;base64,/9j/AAAA" });
      expect(renderQuestion).toHaveBeenCalledWith(document.querySelector("#question1"), true);
      expect((await page.handle(command("APPLY", { index: 0, fingerprint: result.captured.fingerprint,
        answer: { status: "ANSWERED", selectedOptionIds: [], blankAnswers: [
          { blankId: "blank_2", answer: "second value" }, { blankId: "blank_1", answer: "first value" }
        ], textAnswer: null, explanation: "", caveats: [] } }))).ok).toBe(true);
      expect(document.querySelector<HTMLInputElement>('[name="first"]')!.value).toBe("first value");
      expect(document.querySelector<HTMLTextAreaElement>('[name="second"]')!.value).toBe("second value");
      expect((await page.handle(command("SEND_WORK"))).ok).toBe(true);
    });
  it("keeps an unknown label with one text field as a short answer", async () => {
    document.querySelector(".newZy_TItle")!.textContent = "【Resource Analysis】";
    document.querySelector(".Zy_ulTop")!.remove(); document.querySelector("#answer1")!.remove();
    document.querySelector(".TiMu")!.insertAdjacentHTML("beforeend", '<textarea></textarea>');
    const result = await page.handle(command("READ_ALL"));
    expect(result).toMatchObject({ ok: true, questions: [{ question: { type: "SHORT_ANSWER", blanks: [] } }] });
  });
  it.each(["【Resource Analysis】", "【Fill in the Blank】"])("does not treat numbered blank rows as choices: %s", async label => {
    document.querySelector(".newZy_TItle")!.textContent = label;
    document.querySelector(".Zy_ulTop")!.remove(); document.querySelector("#answer1")!.remove();
    document.querySelector(".TiMu")!.insertAdjacentHTML("beforeend", '<ul><li>No.1:<textarea name="first"></textarea></li><li>No.2:<textarea name="second"></textarea></li></ul>');
    expect(await page.handle(command("READ_ALL"))).toMatchObject({ ok: true, questions: [{ question: {
      type: "FILL_BLANK", options: [], blanks: [{ id: "blank_1" }, { id: "blank_2" }]
    } }] });
  });
  it("rejects reordered blank controls with unchanged stem text before writing any value", async () => {
    document.querySelector(".newZy_TItle")!.textContent = "【Fill in the Blank】";
    document.querySelector(".Zy_ulTop")!.remove(); document.querySelector("#answer1")!.remove();
    const box = document.querySelector(".TiMu")!;
    box.insertAdjacentHTML("beforeend", '<textarea name="first"></textarea><textarea name="second"></textarea>');
    const capture = await page.handle(command("CAPTURE", { index: 0 }));
    if (!capture.ok || !capture.captured) throw new Error("capture failed");
    box.append(box.querySelector("textarea")!);
    expect((await page.handle(command("APPLY", { index: 0, fingerprint: capture.captured.fingerprint,
      answer: { status: "ANSWERED", selectedOptionIds: [], textAnswer: null, explanation: "", caveats: [],
        blankAnswers: [{ blankId: "blank_1", answer: "first" }, { blankId: "blank_2", answer: "second" }] } }))).ok).toBe(false);
    expect([...box.querySelectorAll("textarea")].every(field => field.value === "")).toBe(true);
  });
  it("counts all lazy blanks without activating editors and keeps their fingerprint when the active editor changes", async () => {
    const box = document.querySelector("#question1")!;
    box.innerHTML = '<div class="TiMu"><div class="Zy_TItle"><span class="newZy_TItle">【Resource Analysis】</span>程序有五个空①②③④⑤</div></div>';
    const slots: HTMLElement[] = [];
    for (let i = 0; i < 5; i++) {
      const slot = document.createElement("div"); slot.className = "blankItemInp";
      slot.innerHTML = `<div class="InpDIV" id="inpDiv_${i}"></div><div class="textDIV" style="display:none"><textarea id="answerEditor_${i}" style="display:none"></textarea></div>`;
      box.querySelector(".TiMu")!.append(slot); slots.push(slot);
    }
    const clicks = vi.fn(); slots.forEach(slot => slot.querySelector(".InpDIV")!.addEventListener("click", clicks));
    const capture = await page.handle(command("CAPTURE", { index: 0 }));
    if (!capture.ok || !capture.captured) throw new Error("capture failed");
    expect(capture.captured.question.type).toBe("FILL_BLANK");
    expect(capture.captured.question.blanks).toHaveLength(5);
    expect(clicks).not.toHaveBeenCalled();
    slots[0]!.querySelector<HTMLElement>(".InpDIV")!.style.display = "none";
    slots[0]!.querySelector<HTMLElement>(".textDIV")!.style.display = "block";
    const editor = document.createElement("iframe"); editor.id = "ueditor_new";
    slots[0]!.querySelector(".textDIV")!.append(editor);
    editor.contentDocument!.body.setAttribute("contenteditable", "true");
    const icon = document.createElement("img"); icon.src = "toolbar.png"; slots[0]!.append(icon);
    const later = await page.handle(command("CAPTURE", { index: 0 }));
    expect(later).toMatchObject({ ok: true, captured: { fingerprint: capture.captured.fingerprint, question: { type: "FILL_BLANK" } } });
    slots[1]!.before(slots[2]!);
    const changed = await page.handle(command("CAPTURE", { index: 0 }));
    expect(changed.ok && changed.captured?.fingerprint).not.toBe(capture.captured.fingerprint);
  });
  it.each(["readonly", "changed-during-load"])("refuses a lazy blank before writing when %s", async condition => {
    const box = document.querySelector("#question1")!;
    box.innerHTML = '<div class="TiMu"><div class="Zy_TItle"><span class="newZy_TItle">【Fill in the Blank】</span>Test blank</div><div class="blankItemInp"><div class="InpDIV" id="inpDiv_test"></div><div class="textDIV" style="display:none"><textarea id="answerEditor_test" style="display:none"></textarea></div></div></div>';
    const saved = box.querySelector<HTMLTextAreaElement>("textarea")!;
    saved.readOnly = condition === "readonly";
    let editor: HTMLIFrameElement | undefined;
    box.querySelector(".InpDIV")!.addEventListener("click", () => {
      setTimeout(() => {
        box.querySelector(".Zy_TItle")!.append(" changed");
        const wrapper = box.querySelector<HTMLElement>(".textDIV")!; wrapper.style.display = "block";
        editor = document.createElement("iframe"); editor.id = "ueditor_test"; wrapper.append(editor);
        editor.contentDocument!.body.setAttribute("contenteditable", "true");
      }, 10);
    });
    const capture = await page.handle(command("CAPTURE", { index: 0 }));
    if (!capture.ok || !capture.captured) throw new Error("capture failed");
    const result = await page.handle(command("APPLY", { index: 0, fingerprint: capture.captured.fingerprint,
      answer: { status: "ANSWERED", selectedOptionIds: [], textAnswer: null, explanation: "", caveats: [],
        blankAnswers: [{ blankId: "blank_1", answer: "must not be written" }] } }));
    expect(result).toMatchObject({ ok: false });
    expect(saved.value).toBe(""); expect(editor?.contentDocument?.body.textContent ?? "").toBe("");
    expect((await page.handle(command("SEND_WORK"))).ok).toBe(false);
  });
  it("still refuses a genuinely changed field count instead of distributing one answer across several fields", async () => {
    document.querySelector(".newZy_TItle")!.textContent = "【Resource Analysis】";
    document.querySelector(".Zy_ulTop")!.remove(); document.querySelector("#answer1")!.remove();
    document.querySelector(".TiMu")!.insertAdjacentHTML("beforeend", '<textarea></textarea>');
    const captured = await page.handle(command("CAPTURE", { index: 0 }));
    if (!captured.ok || !captured.captured) throw new Error("capture failed");
    document.querySelector(".TiMu")!.insertAdjacentHTML("beforeend", '<textarea></textarea>');
    expect((await page.handle(command("APPLY", { index: 0, fingerprint: captured.captured.fingerprint,
      answer: { status: "ANSWERED", selectedOptionIds: [], blankAnswers: [], textAnswer: "one value", explanation: "", caveats: [] } }))).ok).toBe(false);
    expect([...document.querySelectorAll("textarea")].every(field => field.value === "")).toBe(true);
    expect((await page.handle(command("SEND_WORK"))).ok).toBe(false);
  });
  it("recognises an existing true/false answer instead of re-asking the model", async () => {
    document.querySelector(".newZy_TItle")!.textContent = "判断题";
    const list = document.querySelector(".Zy_ulTop")!;
    list.innerHTML = '<li><span class="num_option" data="true">True</span></li><li><span class="num_option" data="false">False</span></li>';
    document.querySelector<HTMLInputElement>("#answer1")!.value = "true";
    expect(await page.handle(command("ADOPT_EXISTING", { index: 0 }))).toMatchObject({ ok: true, existingAccepted: true });
    expect((await page.handle(command("SEND_WORK"))).ok).toBe(true);
  });
  it("reports the hidden-answer shape when a write is not retained", async () => {
    document.querySelector(".newZy_TItle")!.textContent = "判断题";
    const list = document.querySelector(".Zy_ulTop")!;
    list.innerHTML = "<li><span class=\"num_option\">对</span></li><li><span class=\"num_option\">错</span></li>";
    document.querySelector<HTMLInputElement>("#answer1")!.value = "";
    for (const option of list.querySelectorAll<HTMLElement>(".num_option")) option.addEventListener("click", () => undefined);
    const captured = await page.handle(command("CAPTURE", { index: 0 }));
    if (!captured.ok || !captured.captured) throw new Error("capture failed");
    const result = await page.handle(command("APPLY", { index: 0, fingerprint: captured.captured.fingerprint,
      answer: { status: "ANSWERED", selectedOptionIds: ["opt_1"], blankAnswers: [], textAnswer: null, explanation: "", caveats: [] } }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.detail).toContain("回读不一致");
      expect(result.detail).toContain("选项 2 个");
      expect(result.detail).toContain("隐藏答案值：无");
    }
  });
  it("applies a corrected multiple-choice type when the page label was misread", async () => {
    const hidden = document.querySelector<HTMLInputElement>("#answer1")!;
    hidden.value = "";
    const letters: string[] = [];
    document.querySelectorAll<HTMLElement>(".num_option").forEach((option, index) => {
      option.addEventListener("click", () => {
        letters.push(String.fromCharCode(65 + index));
        hidden.value = letters.join("");
      });
    });
    const captured = await page.handle(command("CAPTURE", { index: 0 }));
    if (!captured.ok || !captured.captured) throw new Error("capture failed");
    const result = await page.handle(command("APPLY", { index: 0, fingerprint: captured.captured.fingerprint,
      answer: { status: "ANSWERED", selectedOptionIds: ["opt_1", "opt_2"], blankAnswers: [], textAnswer: null, explanation: "", caveats: [] },
      questionType: "MULTIPLE_CHOICE" }));
    expect(result.ok).toBe(true);
    expect(hidden.value).toBe("AB");
    expect((await page.handle(command("SEND_WORK"))).ok).toBe(true);
  });
  it("detects multiple choice from a .Zy_TItle-only label and fills more than one option", async () => {
    document.querySelector(".Zy_TItle")!.innerHTML = "【Multiple Choice】以下哪些正确？";
    const hidden = document.querySelector<HTMLInputElement>("#answer1")!;
    hidden.value = "";
    const letters: string[] = [];
    document.querySelectorAll<HTMLElement>(".num_option").forEach((option, index) => {
      option.addEventListener("click", () => {
        letters.push(String.fromCharCode(65 + index));
        hidden.value = [...new Set(letters)].join("");
      });
    });
    const captured = await page.handle(command("CAPTURE", { index: 0 }));
    if (!captured.ok || !captured.captured) throw new Error("capture failed");
    expect(captured.captured.question.type).toBe("MULTIPLE_CHOICE");
    const applied = await page.handle(command("APPLY", { index: 0, fingerprint: captured.captured.fingerprint,
      answer: { status: "ANSWERED", selectedOptionIds: ["opt_1", "opt_2"], blankAnswers: [], textAnswer: null, explanation: "", caveats: [] } }));
    expect(applied.ok).toBe(true);
    expect(hidden.value).toBe("AB");
  });
  it("finds the submit button in another same-origin document than the questions", async () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const submit = document.querySelector(".btnSubmit")!;
    frame.contentDocument!.body.append(submit);
    await filled();
    expect((await page.handle(command("SEND_WORK"))).ok).toBe(true);
    expect(sends).toBe(1);
  });
  it("clicks a real Submit button on quiz skins without a.btnSubmit", async () => {
    const legacy = document.querySelector(".btnSubmit")!;
    const replacement = document.createElement("button");
    replacement.textContent = "Submit";
    replacement.addEventListener("click", () => { sends++; document.querySelector<HTMLElement>("#confirmSubWin")!.style.display = "block"; });
    legacy.replaceWith(replacement);
    await filled();
    expect((await page.handle(command("SEND_WORK"))).ok).toBe(true);
    expect(sends).toBe(1);
  });
  it("confirms a new-skin Tip dialog with Cancel/Submit text buttons exactly once", async () => {
    document.querySelector("#confirmSubWin")!.remove();
    let dialog: HTMLElement | null = null;
    const submit = document.createElement("button");
    submit.textContent = "Submit";
    submit.addEventListener("click", () => {
      sends += 1;
      dialog = document.createElement("div");
      dialog.innerHTML = '<div class="tip-title">Tip</div><div class="tip-body">Submit?</div>' +
        '<button type="button" class="tip-cancel">Cancel</button><button type="button" class="tip-submit">Submit</button>';
      dialog.querySelector(".tip-cancel")!.addEventListener("click", () => { dialog?.remove(); });
      dialog.querySelector(".tip-submit")!.addEventListener("click", () => {
        confirms += 1;
        document.querySelector(".ans-job-icon")!.setAttribute("aria-label", "任务点已完成");
      });
      document.body.append(dialog);
    });
    document.querySelector(".btnSubmit")!.replaceWith(submit);
    await filled();
    expect((await page.handle(command("SEND_WORK"))).ok).toBe(true);
    expect(sends).toBe(1);
    expect((await page.handle(command("CONFIRM_WORK"))).ok).toBe(true);
    expect(confirms).toBe(1);
    // The generic text fallback must not click the page Submit again for the same task.
    expect(sends).toBe(1);
    expect((await page.handle(command("CONFIRM_WORK"))).ok).toBe(true);
    expect(confirms).toBe(1);
  });
  it("confirms a text-styled dialog whose buttons are plain spans", async () => {
    document.querySelector("#confirmSubWin")!.remove();
    const submit = document.createElement("button");
    submit.textContent = "Submit";
    submit.addEventListener("click", () => {
      sends += 1;
      const dialog = document.createElement("div");
      dialog.innerHTML = '<div>Tip</div><div>Submit?</div>' +
        '<span class="tip-cancel">Cancel</span><span class="tip-submit">Submit</span>';
      dialog.querySelector(".tip-cancel")!.addEventListener("click", () => { dialog.remove(); });
      dialog.querySelector(".tip-submit")!.addEventListener("click", () => {
        confirms += 1;
        document.querySelector(".ans-job-icon")!.setAttribute("aria-label", "任务点已完成");
      });
      document.body.append(dialog);
    });
    document.querySelector(".btnSubmit")!.replaceWith(submit);
    await filled();
    expect((await page.handle(command("SEND_WORK"))).ok).toBe(true);
    expect((await page.handle(command("CONFIRM_WORK"))).ok).toBe(true);
    expect(confirms).toBe(1);
    expect(sends).toBe(1);
  });
  it("does not click a dialog when the confirm button is ambiguous", async () => {
    document.querySelector("#confirmSubWin")!.remove();
    const submit = document.createElement("button");
    submit.textContent = "Submit";
    submit.addEventListener("click", () => {
      sends += 1;
      const dialog = document.createElement("div");
      dialog.innerHTML = '<div>Submit?</div><button type="button">Cancel</button>' +
        '<button type="button">Submit</button><button type="button">Submit</button>';
      for (const button of dialog.querySelectorAll("button")) {
        if (button.textContent === "Submit") button.addEventListener("click", () => { confirms += 1; });
      }
      document.body.append(dialog);
    });
    document.querySelector(".btnSubmit")!.replaceWith(submit);
    await filled();
    expect((await page.handle(command("SEND_WORK"))).ok).toBe(true);
    expect((await page.handle(command("CONFIRM_WORK"))).ok).toBe(true);
    expect(confirms).toBe(0);
  });
  it("does not treat a question stem that asks about submitting as a confirmation dialog", async () => {
    document.querySelector("#confirmSubWin")!.remove();
    const replacement = document.createElement("button");
    replacement.textContent = "Submit";
    replacement.addEventListener("click", () => { sends += 1; });
    document.querySelector(".btnSubmit")!.replaceWith(replacement);
    document.querySelector(".Zy_TItle")!.append("确定要提交？");
    await filled();
    expect((await page.handle(command("SEND_WORK"))).ok).toBe(true);
    expect((await page.handle(command("CONFIRM_WORK"))).ok).toBe(true);
    expect(confirms).toBe(0);
  });
  it("switches a single-choice answer once and verifies the site-bound value", async () => {
    await filled();
    expect(document.querySelector<HTMLInputElement>("#answer1")!.value).toBe("A");
  });
  it("reads the full source inventory without rendering, and uses images only for diagram questions", async () => {
    const inventory = await page.handle(command("READ_ALL"));
    expect(inventory).toMatchObject({ ok: true, questions: [{ index: 0, needsImage: false, question: { stem: "Question" } }] });
    expect(renderQuestion).not.toHaveBeenCalled();
    expect((await page.capture(0)).question.imageDataUrl).toBeUndefined();
    document.querySelector(".Zy_TItle")!.append(document.createElement("img"));
    expect((await page.capture(0)).question.imageDataUrl).toMatch(/^data:image/);
    expect(renderQuestion).toHaveBeenCalledTimes(1);
    // 图示题必须用严格渲染：显示中的题图未完整绘制时不能静默生成缺图题图。
    expect(renderQuestion).toHaveBeenCalledWith(expect.any(HTMLElement), true);
  });
  it("renders a question image on demand even when the decoded source is usable", async () => {
    vi.mocked(renderQuestion).mockClear();
    expect((await page.handle(command("CAPTURE", { index: 0 }))).ok).toBe(true);
    expect(renderQuestion).not.toHaveBeenCalled();
    const forced = await page.handle(command("CAPTURE", { index: 0, forceImage: true }));
    expect(forced.ok).toBe(true);
    expect(renderQuestion).toHaveBeenCalledTimes(1);
    expect(renderQuestion).toHaveBeenCalledWith(expect.any(HTMLElement), false);
    if (forced.ok) expect(forced.captured?.question.imageDataUrl).toMatch(/^data:image/);
  });
  it("captures original image bytes at natural size for the automatic originals pass", async () => {
    // 2026-10-20 授权：文字读不出/合成题图失败/模型看不清时，自动改发原图原版数据。
    const captured = await page.capture(0, false, "originals");
    expect(extractOriginalImages).toHaveBeenCalledWith(expect.any(HTMLElement));
    expect(renderQuestion).not.toHaveBeenCalled();
    expect(captured.imageSource).toBe("originals");
    expect(captured.question.imageDataUrl).toBe("data:image/png;base64,iVBORAA");
    expect(captured.question.extraImageDataUrls).toEqual(["data:image/png;base64,iVBORBB", "data:image/png;base64,iVBORCC"]);
  });
  it("reports an image issue instead of guessing when the originals pass finds nothing readable", async () => {
    vi.mocked(extractOriginalImages).mockRejectedValueOnce(new QuestionImageError("题目没有可读取的原图图像。"));
    const result = await page.handle(command("CAPTURE", { index: 0, imagePass: "originals" }));
    expect(result).toMatchObject({ ok: false, questionIssue: "IMAGE_UNREADABLE" });
    if (!result.ok) expect(result.detail).toContain("原图");
  });
  it("adopts a complete existing answer but does not accept an empty answer", async () => {
    expect(await page.handle(command("ADOPT_EXISTING", { index: 0 }))).toMatchObject({ ok: true, existingAccepted: true });
    document.querySelector<HTMLInputElement>("#answer1")!.value = "";
    expect(await page.handle(command("ADOPT_EXISTING", { index: 0 }))).toMatchObject({ ok: true, existingAccepted: false });
    expect((await page.handle(command("SEND_WORK"))).ok).toBe(false);
  });
  it("distinguishes card numbers within a chapter so the next card has a new task identity", () => {
    const frame = document.createElement("iframe"); frame.id = "iframe";
    frame.src = "/mooc-ans/knowledge/cards?num=0"; document.body.append(frame);
    const first = page.inspect().taskKey;
    frame.src = "/mooc-ans/knowledge/cards?num=1";
    expect(page.inspect().taskKey).not.toBe(first);
  });
  function staticCard(markup = "<h2>每节一句</h2><p><span>普通补充内容</span><br></p>"): Document {
    document.querySelector("#question1")!.remove();
    document.querySelector(".ans-job-icon")!.remove();
    const frame = document.createElement("iframe"); frame.id = "iframe";
    frame.src = "/mooc-ans/knowledge/cards?num=4"; document.body.append(frame);
    const doc = frame.contentDocument!;
    doc.open();
    doc.write(`<body><div id="cardFocus"></div><div id="pageDiv" class="ans-cc">${markup}</div></body>`);
    doc.close();
    vi.spyOn(doc.querySelector("#pageDiv")!, "getClientRects").mockReturnValue([new DOMRect(0, 0, 100, 40)] as unknown as DOMRectList);
    vi.spyOn(doc, "readyState", "get").mockReturnValue("complete");
    return doc;
  }
  it("advances an observed static card without counting it as a completed task", async () => {
    const doc = staticCard('<h2>每节一句</h2><p><span class="ans-img-wrap"><img></span><br></p>');
    const image = doc.querySelector("img")!;
    vi.spyOn(image, "complete", "get").mockReturnValue(true);
    vi.spyOn(image, "naturalWidth", "get").mockReturnValue(678);
    expect(page.inspect()).toMatchObject({ kind: "MATERIAL", completed: false, questionCount: 0 });
    snapshot = page.inspect();
    expect((await page.handle(command("NEXT"))).ok).toBe(true);
    expect(next).toBe(1); expect(sends).toBe(0);
  });
  it("recognises a loaded text-only knowledge card", () => {
    staticCard();
    expect(page.inspect().kind).toBe("MATERIAL");
  });
  it.each(["", '<img src="/not-loaded.jpg">', '<input type="radio">', '<button>作答</button>',
    '<div contenteditable="true">请输入</div>', '<div role="radiogroup">选择</div>',
    '<iframe src="/unknown-module"></iframe>', '<object data="/unknown-module"></object>'])
    ("does not skip an empty, unreadable or interactive card: %s", async markup => {
      staticCard(markup);
      expect(page.inspect().kind).toBe("UNKNOWN");
      snapshot = page.inspect();
      expect((await page.handle(command("NEXT", { allowSkipUnfinished: true }))).ok).toBe(false);
      expect(next).toBe(0);
    });
  it("waits for a loading card and rejects a module iframe outside the static container", () => {
    const doc = staticCard();
    vi.spyOn(doc, "readyState", "get").mockReturnValue("interactive");
    expect(page.inspect().kind).toBe("UNKNOWN");
    vi.spyOn(doc, "readyState", "get").mockReturnValue("complete");
    doc.body.append(doc.createElement("iframe"));
    expect(page.inspect().kind).toBe("UNKNOWN");
  });
  it("rechecks task markers before skipping a previously static card", async () => {
    const doc = staticCard();
    expect(page.inspect().kind).toBe("MATERIAL");
    snapshot = page.inspect();
    const marker = doc.createElement("div"); marker.className = "ans-job-icon";
    marker.setAttribute("aria-label", "任务点未完成"); doc.body.append(marker);
    expect(page.inspect()).toMatchObject({ kind: "UNKNOWN", completed: false });
    expect((await page.handle(command("NEXT", { allowSkipUnfinished: true }))).ok).toBe(false);
    expect(next).toBe(0);
  });
  it("initializes the observed lazy video player using its site play button", async () => {
    document.querySelector("#question1")!.remove();
    const player = document.createElement("div"); player.className = "video-js";
    const video = document.createElement("video"), button = document.createElement("button");
    button.className = "vjs-big-play-button"; player.append(video, button); document.body.append(player);
    const play = vi.spyOn(video, "play").mockResolvedValue();
    let ready = 0; vi.spyOn(video, "readyState", "get").mockImplementation(() => ready);
    button.addEventListener("click", () => { ready = 1; });
    expect((await page.handle(command("PLAY"))).ok).toBe(true); expect(ready).toBe(1); expect(play).toHaveBeenCalledTimes(1);
  });
  it("requires all answers to be verified before submitting, and never repeats a submission", async () => {
    expect((await page.handle(command("SEND_WORK"))).ok).toBe(false);
    await filled();
    expect((await page.handle(command("SEND_WORK"))).ok).toBe(true);
    expect((await page.handle(command("SEND_WORK"))).ok).toBe(false);
    expect(sends).toBe(1);
    expect((await page.handle(command("CONFIRM_WORK"))).ok).toBe(true);
    expect((await page.handle(command("CONFIRM_WORK"))).ok).toBe(true);
    expect(confirms).toBe(1);
    expect((await page.handle(command("NEXT"))).ok).toBe(true);
    expect(next).toBe(1);
  });
  it("does not advance an unfinished task or operate a changed task", async () => {
    expect((await page.handle(command("NEXT"))).ok).toBe(false);
    expect((await page.handle(command("PLAY", { taskKey: "different" }))).ok).toBe(false);
    expect(next).toBe(0);
  });
  function chapterNotice(legacy = false): { box: HTMLElement; learn: HTMLElement; skip: HTMLElement } {
    const box = document.createElement("div");
    if (legacy) box.id = "jobFinishTip"; else box.className = "maskDiv jobFinishTip";
    box.innerHTML = '<p>There are still some unfinished tasks in the current chapter. Do you want to complete them?</p>' +
      `<a class="nextChapter">Next</a><a class="${legacy ? "nextbutton" : "popMoveDele"}">to learn</a>`;
    document.body.append(box);
    return { box, learn: box.querySelector<HTMLElement>(legacy ? ".nextbutton" : ".popMoveDele")!, skip: box.querySelector<HTMLElement>(".nextChapter")! };
  }
  it.each([false, true])("returns to unfinished tasks by default in either notice skin (legacy=%s)", async legacy => {
    const notice = chapterNotice(legacy);
    const learn = vi.fn(), skip = vi.fn();
    notice.learn.addEventListener("click", learn); notice.skip.addEventListener("click", skip);
    expect(await page.handle(command("CONFIRM_NEXT"))).toMatchObject({ ok: true, nextNotice: "LEARN_REMAINING" });
    expect(learn).toHaveBeenCalledTimes(1); expect(skip).not.toHaveBeenCalled();
    expect(page.inspect().completed).toBe(false); expect(sends).toBe(0);
  });
  it.each([false, true])("only confirms the mode-authorized skip, once (legacy=%s)", async legacy => {
    const notice = chapterNotice(legacy);
    const learn = vi.fn(), skip = vi.fn();
    notice.learn.addEventListener("click", learn); notice.skip.addEventListener("click", skip);
    expect(await page.handle(command("CONFIRM_NEXT", { allowSkipUnfinished: true }))).toMatchObject({ ok: true, nextNotice: "SKIP_CONFIRMED" });
    expect(await page.handle(command("CONFIRM_NEXT", { allowSkipUnfinished: true }))).toEqual({ ok: true });
    expect(skip).toHaveBeenCalledTimes(1); expect(learn).not.toHaveBeenCalled();
  });
  it("does not confirm skips for an unknown task, even with the navigation flag", async () => {
    document.querySelector("#question1")!.remove();
    const notice = chapterNotice(); const learn = vi.fn(), skip = vi.fn();
    notice.learn.addEventListener("click", learn); notice.skip.addEventListener("click", skip);
    expect(await page.handle(command("CONFIRM_NEXT", { allowSkipUnfinished: true }))).toMatchObject({ nextNotice: "LEARN_REMAINING" });
    expect(learn).toHaveBeenCalledTimes(1); expect(skip).not.toHaveBeenCalled();
  });
  it("ignores hidden notices and unrelated dialogs, and refuses ambiguous learn controls", async () => {
    const notice = chapterNotice(); notice.box.style.display = "none";
    expect(await page.handle(command("CONFIRM_NEXT"))).toEqual({ ok: true });
    notice.box.style.display = "block";
    notice.box.querySelector("p")!.textContent = "Other Notice: Submit?";
    expect(await page.handle(command("CONFIRM_NEXT"))).toEqual({ ok: true });
    notice.box.querySelector("p")!.textContent = "There are still some unfinished tasks in the current chapter.";
    notice.box.append(notice.learn.cloneNode(true));
    const result = await page.handle(command("CONFIRM_NEXT"));
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.detail).toContain("唯一确认");
  });
  it("does not submit if the page reverts an answer after filling", async () => {
    await filled();
    document.querySelector<HTMLInputElement>("#answer1")!.value = "B";
    expect((await page.handle(command("SEND_WORK"))).ok).toBe(false);
    expect(sends).toBe(0);
  });
  it("rejects another runner while the page lease is active", async () => {
    await page.handle(command("INSPECT"));
    expect((await page.handle(command("INSPECT", { runId: "other" }))).ok).toBe(false);
    expect((await page.handle(command("RELEASE", { runId: "other" }))).ok).toBe(false);
  });
  it("releases the old task lease after a monitor-detected navigation so a new runner can start", async () => {
    await page.handle(command("INSPECT"));
    document.body.dataset.taskId = "new-task";
    expect((await page.handle(command("RELEASE"))).ok).toBe(true);
    expect((await page.handle({ action: "INSPECT", requestId: "other_request", runId: "other" })).ok).toBe(true);
    delete document.body.dataset.taskId;
  });
  it("uses the nested card frame ordinal so sibling task points get distinct identities", () => {
    const outer = document.createElement("iframe"); outer.id = "iframe";
    document.body.append(outer);
    const inner = outer.contentDocument!.createElement("iframe");
    inner.src = "/mooc-ans/knowledge/cards?num=0";
    outer.contentDocument!.body.append(inner);
    const first = page.inspect().taskKey;
    inner.src = "/mooc-ans/knowledge/cards?num=1";
    expect(page.inspect().taskKey).not.toBe(first);
  });
  it("ignores hidden template players and drives the visible video", async () => {
    document.querySelector("#question1")!.remove();
    const hidden = document.createElement("video");
    hidden.style.display = "none";
    const player = document.createElement("div"); player.className = "video-js";
    const visible = document.createElement("video");
    const button = document.createElement("button"); button.className = "vjs-big-play-button";
    player.append(visible, button);
    document.body.append(hidden, player);
    const visiblePlay = vi.spyOn(visible, "play").mockResolvedValue();
    const hiddenPlay = vi.spyOn(hidden, "play").mockResolvedValue();
    let ready = 0;
    vi.spyOn(visible, "readyState", "get").mockImplementation(() => ready);
    let clicked = 0;
    button.addEventListener("click", () => { clicked += 1; ready = 2; });
    expect(page.inspect().video).not.toBeNull();
    const played = await page.handle(command("PLAY"));
    expect(played.ok).toBe(true);
    expect(visiblePlay).toHaveBeenCalled();
    expect(hiddenPlay).not.toHaveBeenCalled();
  });
  it("clicks the site play button when metadata exists but the lazy source is not attached", async () => {
    document.querySelector("#question1")!.remove();
    const player = document.createElement("div"); player.className = "video-js";
    const video = document.createElement("video"), button = document.createElement("button");
    button.className = "vjs-big-play-button"; player.append(video, button); document.body.append(player);
    const play = vi.spyOn(video, "play").mockResolvedValue();
    vi.spyOn(video, "readyState", "get").mockImplementation(() => 1);
    vi.spyOn(video, "duration", "get").mockImplementation(() => 0);
    vi.spyOn(video, "currentSrc", "get").mockImplementation(() => "");
    let clicks = 0; button.addEventListener("click", () => { clicks += 1; });
    expect((await page.handle(command("PLAY"))).ok).toBe(true);
    expect(clicks).toBe(1);
    expect(play).toHaveBeenCalled();
  });
  it("clicks a javascript: placeholder link without running its URL navigation", async () => {
    const submit = document.querySelector<HTMLAnchorElement>(".btnSubmit")!;
    submit.setAttribute("href", "javascript:void(0)");
    let hrefDuringClick: string | null = "unset";
    submit.addEventListener("click", () => { hrefDuringClick = submit.getAttribute("href"); });
    await filled();
    expect((await page.handle(command("SEND_WORK"))).ok).toBe(true);
    expect(sends).toBe(1);
    expect(hrefDuringClick).toBeNull();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(submit.getAttribute("href")).toBe("javascript:void(0)");
  });
  it("verifies rich-text blank answers independent of response ordering or outer whitespace", async () => {
    document.querySelector(".newZy_TItle")!.textContent = "【Fill in the Blank】";
    document.querySelector(".Zy_ulTop")!.remove();
    document.querySelector("#answer1")!.remove();
    const container = document.querySelector(".TiMu")!;
    for (let i = 1; i <= 2; i++) {
      const frame = document.createElement("iframe"); frame.id = `ueditor_${i}`;
      container.append(frame); frame.contentDocument!.body.setAttribute("contenteditable", "true");
    }
    const captured = await page.handle(command("CAPTURE", { index: 0 }));
    if (!captured.ok || !captured.captured) throw new Error("capture failed");
    expect((await page.handle(command("APPLY", { index: 0, fingerprint: captured.captured.fingerprint, answer: {
      status: "ANSWERED", selectedOptionIds: [], textAnswer: null, explanation: "", caveats: [],
      blankAnswers: [{ blankId: "blank_2", answer: " B " }, { blankId: "blank_1", answer: " A " }]
    } }))).ok).toBe(true);
    expect((await page.handle(command("SEND_WORK"))).ok).toBe(true);
    expect(sends).toBe(1);
  });

  function videoPage(): { video: HTMLVideoElement; button: HTMLButtonElement } {
    document.body.innerHTML = `<div class="ans-job-icon" aria-label="任务点未完成"></div>
      <div class="video-js" id="video_player"></div><div id="prevNextFocusNext">Next</div>`;
    const player = document.querySelector<HTMLElement>("#video_player")!;
    const video = document.createElement("video");
    const button = document.createElement("button");
    button.className = "vjs-big-play-button";
    player.append(video, button);
    document.querySelector("#prevNextFocusNext")!.addEventListener("click", () => { next++; });
    page = new CoursePage(document);
    return { video, button };
  }
  function mockMedia(video: HTMLVideoElement, play: () => Promise<void>): void {
    vi.spyOn(video, "readyState", "get").mockReturnValue(1);
    vi.spyOn(video, "duration", "get").mockReturnValue(60);
    vi.spyOn(video, "currentSrc", "get").mockReturnValue("https://mooc1.chaoxing.com/ananas/video.mp4");
    vi.spyOn(video, "play").mockImplementation(play);
  }

  it("only skips an unfinished video task when the runner explicitly authorizes it", async () => {
    const { video } = videoPage();
    vi.spyOn(video, "paused", "get").mockReturnValue(true);
    expect(page.inspect().kind).toBe("VIDEO");
    // 刷题模式 must be an explicit decision, never the default of the NEXT command.
    expect((await page.handle(command("NEXT"))).ok).toBe(false);
    expect(next).toBe(0);
    const skipped = await page.handle(command("NEXT", { allowSkipUnfinished: true }));
    expect(skipped.ok).toBe(true);
    expect(next).toBe(1);
  });
  it("an unfinished quiz also advances only with the explicit skip authorization (只刷课模式)", async () => {
    document.querySelector(".ans-job-icon")!.setAttribute("aria-label", "任务点未完成");
    expect(page.inspect().kind).toBe("QUIZ");
    // 默认拒绝：跳过未完成题目必须是只刷课模式的显式决定，绝不是 NEXT 的默认行为。
    expect((await page.handle(command("NEXT"))).ok).toBe(false);
    expect(next).toBe(0);
    const skipped = await page.handle(command("NEXT", { allowSkipUnfinished: true }));
    expect(skipped.ok).toBe(true);
    expect(next).toBe(1);
  });

  it("enumerates a paused-video popup through the site's own radio options and confirm control", async () => {
    vi.useFakeTimers();
    try {
      const { video } = videoPage();
      let paused = true;
      vi.spyOn(video, "paused", "get").mockImplementation(() => paused);
      const popup = document.createElement("div");
      popup.setAttribute("role", "dialog");
      popup.innerHTML = `<p>随堂检测：选择正确才能继续播放。</p>
        <label><input type="radio" name="popup" value="A">A. 第一项</label>
        <label><input type="radio" name="popup" value="B">B. 第二项</label>
        <label><input type="radio" name="popup" value="C">C. 第三项</label>
        <button type="button">确定</button>`;
      document.body.append(popup);
      const committed: string[] = [];
      popup.querySelectorAll("input").forEach(input => {
        input.addEventListener("click", () => { (input as HTMLInputElement).checked = true; });
      });
      popup.querySelector("button")!.addEventListener("click", () => {
        const selected = popup.querySelector<HTMLInputElement>("input:checked");
        committed.push(selected?.value ?? "");
        if (selected?.value === "B") { popup.remove(); paused = false; }
        else popup.querySelectorAll("input").forEach(input => { input.checked = false; });
      });
      const pending = page.handle(command("ENUM_POPUP"));
      await vi.advanceTimersByTimeAsync(20000);
      const result = await pending;
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.popup).toEqual({ found: true, resolved: true, attempts: 2, options: 3 });
      // 枚举按 DOM 顺序尝试：A 错、B 对，只有站点自身控件被点击。
      expect(committed).toEqual(["A", "B"]);
    } finally { vi.useRealTimers(); }
  });
  it("reports no popup when a paused video page has no forced-choice overlay", async () => {
    const { video } = videoPage();
    vi.spyOn(video, "paused", "get").mockReturnValue(true);
    const result = await page.handle(command("ENUM_POPUP"));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.popup).toEqual({ found: false, resolved: false, attempts: 0, options: 0 });
  });
  it("stops enumerating and reports failure when no option closes the popup", async () => {
    vi.useFakeTimers();
    try {
      const { video } = videoPage();
      vi.spyOn(video, "paused", "get").mockReturnValue(true);
      const popup = document.createElement("div");
      popup.setAttribute("role", "dialog");
      popup.innerHTML = `<label><input type="radio" name="popup" value="A">A. 甲</label>
        <label><input type="radio" name="popup" value="B">B. 乙</label>`;
      document.body.append(popup);
      popup.querySelectorAll("input").forEach(input => input.addEventListener("click", () => { input.checked = true; }));
      const pending = page.handle(command("ENUM_POPUP"));
      await vi.advanceTimersByTimeAsync(30000);
      const result = await pending;
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.popup).toEqual({ found: true, resolved: false, attempts: 2, options: 2 });
    } finally { vi.useRealTimers(); }
  });
  it("enumerates a custom-row popup without native inputs, auto-submitting on the row click", async () => {
    const { video } = videoPage();
    let paused = true;
    vi.spyOn(video, "paused", "get").mockImplementation(() => paused);
    const popup = document.createElement("div");
    popup.setAttribute("role", "dialog");
    popup.innerHTML = `<p>随堂小测</p><div><span data-value="A">A. 对</span><span data-value="B">B. 错</span></div>`;
    document.body.append(popup);
    const rows = [...popup.querySelectorAll<HTMLElement>("span[data-value]")];
    rows[0]!.addEventListener("click", () => { popup.remove(); paused = false; });
    rows[1]!.addEventListener("click", () => { rows[1]!.dataset.clicked = "1"; });
    const result = await page.handle(command("ENUM_POPUP"));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.popup).toEqual({ found: true, resolved: true, attempts: 1, options: 2 });
    expect(rows[1]!.dataset.clicked).toBeUndefined();
  });
  it("never treats chapter quiz options as a video popup", async () => {
    // 章节题目文档中的选项绝不能从弹题枚举路径被点击。
    const hidden = document.querySelector<HTMLInputElement>("#answer1")!;
    hidden.value = "";
    const result = await page.handle(command("ENUM_POPUP"));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.popup?.found).toBe(false);
    expect(hidden.value).toBe("");
  });
  it("starts an un-gestured audible video muted and restores the learner's audio state", async () => {
    const { video, button } = videoPage();
    let paused = true;
    let calls = 0;
    const mutedDuringPlay: boolean[] = [];
    let clicks = 0;
    button.addEventListener("click", () => { clicks += 1; });
    vi.spyOn(video, "paused", "get").mockImplementation(() => paused);
    mockMedia(video, async () => {
      calls += 1;
      mutedDuringPlay.push(video.muted);
      // Chrome rejects the first audible attempts (no user gesture on the media frame),
      // then allows the real (muted) playback; the runner restores sound afterwards.
      if (calls < 3) throw new DOMException("play() failed because the user didn't interact", "NotAllowedError");
      paused = false;
    });
    const result = await page.handle(command("PLAY"));
    expect(result.ok).toBe(true);
    expect(calls).toBe(3);
    expect(mutedDuringPlay[2]).toBe(true);
    expect(video.muted).toBe(false);
    // The site's own control is used both as a retry and while muted, so its player state
    // and progress reporting start from a normal site interaction instead of a bare play().
    expect(clicks).toBeGreaterThanOrEqual(2);
  });
  it("keeps a learner-muted video muted after the autoplay fallback", async () => {
    const { video } = videoPage();
    let paused = true;
    let calls = 0;
    video.muted = true;
    vi.spyOn(video, "paused", "get").mockImplementation(() => paused);
    mockMedia(video, async () => {
      calls += 1;
      if (calls < 3) throw new DOMException("blocked", "NotAllowedError");
      paused = false;
    });
    expect((await page.handle(command("PLAY"))).ok).toBe(true);
    expect(video.muted).toBe(true);
  });
  it("does not toggle or restart a video that is already playing", async () => {
    const { video, button } = videoPage();
    let clicks = 0;
    button.addEventListener("click", () => { clicks += 1; });
    vi.spyOn(video, "paused", "get").mockReturnValue(false);
    const play = vi.spyOn(video, "play").mockResolvedValue();
    expect((await page.handle(command("PLAY"))).ok).toBe(true);
    expect(play).not.toHaveBeenCalled();
    expect(clicks).toBe(0);
  });
  it("reports the concrete autoplay failure instead of leaving a silent black player", async () => {
    const { video } = videoPage();
    vi.spyOn(video, "paused", "get").mockReturnValue(true);
    mockMedia(video, async () => { throw new DOMException("play() failed", "NotAllowedError"); });
    const result = await page.handle(command("PLAY"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.detail).toContain("NotAllowedError");
      expect(result.detail).toContain("手动点击");
    }
  });
  it("bounds a play() promise that never settles instead of hanging the run", async () => {
    vi.useFakeTimers();
    try {
      const { video } = videoPage();
      vi.spyOn(video, "paused", "get").mockImplementation(() => true);
      // 无可选源/管道卡死的真实播放器会让 play() 的 Promise 永不 settle；必须有界失败。
      mockMedia(video, () => new Promise<void>(() => undefined));
      const pending = page.handle(command("PLAY"));
      await vi.advanceTimersByTimeAsync(45000);
      const result = await pending;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.detail).toContain("自动播放失败");
        expect(result.detail).toContain("开始播放超时");
      }
    } finally { vi.useRealTimers(); }
  });
  it("never seeks or changes playback speed while starting the player", async () => {
    const { video } = videoPage();
    let paused = true;
    let calls = 0;
    vi.spyOn(video, "paused", "get").mockImplementation(() => paused);
    mockMedia(video, async () => {
      calls += 1;
      if (calls < 3) throw new DOMException("blocked", "NotAllowedError");
      paused = false;
    });
    const before = { currentTime: video.currentTime, playbackRate: video.playbackRate };
    expect((await page.handle(command("PLAY"))).ok).toBe(true);
    expect(video.currentTime).toBe(before.currentTime);
    expect(video.playbackRate).toBe(before.playbackRate);
  });

  // 非粘贴题：填空题/简答题不保证有已验证的 UEditor。普通输入框、contenteditable 与未知控件
  // 必须走各自的策略，且未知控件只能降级为可读题（READ_ALL 成功）而不是中断整个任务。
  function recordingTargets(targets: HTMLElement[]): string[] {
    const events: string[] = [];
    for (const target of targets) {
      for (const type of ["input", "change", "blur"]) {
        target.addEventListener(type, () => events.push(`${target.id}:${type}`));
      }
    }
    return events;
  }

  it("fills and reads back plain text fields when a blank question has no UEditor", async () => {
    document.querySelector("#question1")!.innerHTML = '<div class="TiMu"><div class="Zy_TItle">' +
      '<span class="newZy_TItle">【Fill in the Blank】</span><p>填写两个空。</p></div>' +
      '<input id="fill_1" type="text" /><textarea id="fill_2"></textarea>' +
      // 只允许可见、可写的原生文本控件：隐藏/单选/复选框与站点隐藏答案 #answer* 都不算答题控件。
      '<input id="fill_hidden" type="text" style="display:none" />' +
      '<input id="fill_radio" type="radio" name="r" /><input id="fill_check" type="checkbox" />' +
      '<input id="answer_fake" type="text" /><input id="answer1" type="hidden" value="" /></div>';
    const input = document.querySelector<HTMLInputElement>("#fill_1")!;
    const textarea = document.querySelector<HTMLTextAreaElement>("#fill_2")!;
    const events = recordingTargets([input, textarea]);
    snapshot = page.inspect();
    const captured = await page.handle(command("CAPTURE", { index: 0 }));
    if (!captured.ok || !captured.captured) throw new Error("capture failed");
    expect(captured.captured.answerMode).toBe("TEXT_FIELD");
    expect(captured.captured.question.type).toBe("FILL_BLANK");
    expect(captured.captured.question.blanks.map(blank => blank.id)).toEqual(["blank_1", "blank_2"]);
    const result = await page.handle(command("APPLY", { index: 0, fingerprint: captured.captured.fingerprint, answer: {
      status: "ANSWERED", selectedOptionIds: [], textAnswer: null, explanation: "", caveats: [],
      blankAnswers: [{ blankId: "blank_2", answer: "第二空" }, { blankId: "blank_1", answer: "第一空" }]
    } }));
    expect(result.ok).toBe(true);
    expect(input.value).toBe("第一空");
    expect(textarea.value).toBe("第二空");
    expect(events).toEqual([
      "fill_1:input", "fill_1:change", "fill_1:blur",
      "fill_2:input", "fill_2:change", "fill_2:blur"
    ]);
    // 回读一致才允许提交：TEXT_FIELD 的值必须由 readAnswer 从控件 .value 读回。
    expect((await page.handle(command("SEND_WORK"))).ok).toBe(true);
    expect(sends).toBe(1);
  });

  it("fills and reads back direct contenteditable editors without a UEditor iframe", async () => {
    document.querySelector("#question1")!.innerHTML = '<div class="TiMu"><div class="Zy_TItle">' +
      '<span class="newZy_TItle">【Fill in the Blank】</span><p>填写两个空。</p></div>' +
      '<div id="rich_1" contenteditable="true"></div><div id="rich_2" contenteditable="true"></div></div>';
    const first = document.querySelector<HTMLElement>("#rich_1")!;
    const second = document.querySelector<HTMLElement>("#rich_2")!;
    const events = recordingTargets([first, second]);
    snapshot = page.inspect();
    const captured = await page.handle(command("CAPTURE", { index: 0 }));
    if (!captured.ok || !captured.captured) throw new Error("capture failed");
    expect(captured.captured.answerMode).toBe("CONTENTEDITABLE");
    expect(captured.captured.question.blanks.map(blank => blank.id)).toEqual(["blank_1", "blank_2"]);
    const result = await page.handle(command("APPLY", { index: 0, fingerprint: captured.captured.fingerprint, answer: {
      status: "ANSWERED", selectedOptionIds: [], textAnswer: null, explanation: "", caveats: [],
      blankAnswers: [{ blankId: "blank_1", answer: "甲" }, { blankId: "blank_2", answer: "乙" }]
    } }));
    expect(result.ok).toBe(true);
    expect(first.textContent).toBe("甲");
    expect(second.textContent).toBe("乙");
    expect(events).toEqual([
      "rich_1:input", "rich_1:change", "rich_1:blur",
      "rich_2:input", "rich_2:change", "rich_2:blur"
    ]);
    expect((await page.handle(command("SEND_WORK"))).ok).toBe(true);
  });

  it("keeps an unknown non-paste widget readable as NONE and refuses APPLY with the reason", async () => {
    document.querySelector("#question1")!.innerHTML = '<div class="TiMu"><div class="Zy_TItle">' +
      '<span class="newZy_TItle">【Fill in the Blank】</span><p>本题只有未适配控件。</p></div>' +
      '<div class="unknown-widget">拖拽区域</div><input id="answer1" type="hidden" value="" /></div>';
    const second = document.createElement("div");
    second.id = "question2";
    second.innerHTML = '<div class="TiMu"><div class="Zy_TItle"><span class="newZy_TItle">【Single Choice】</span>第二题</div>' +
      '<ul class="Zy_ulTop"><li><span class="num_option" data="A">A</span></li><li><span class="num_option" data="B">B</span></li></ul>' +
      '<input id="answer2" type="hidden" value="" /></div>';
    document.body.append(second);
    snapshot = page.inspect();
    // 未知控件不得中断整份读取：READ_ALL 返回降级题，其他题仍正常读取。
    const inventory = await page.handle(command("READ_ALL"));
    expect(inventory.ok).toBe(true);
    if (!inventory.ok || !inventory.questions) throw new Error("read failed");
    expect(inventory.questions).toHaveLength(2);
    const unsupported = inventory.questions[0]!;
    expect(unsupported.answerMode).toBe("NONE");
    expect(unsupported.answerReason).toEqual(expect.any(String));
    expect(unsupported.answerReason!.length).toBeGreaterThan(0);
    expect(unsupported.answerReason).toContain("无法自动回填");
    expect(inventory.questions[1]!.question.type).toBe("SINGLE_CHOICE");
    const result = await page.handle(command("APPLY", { index: 0, fingerprint: unsupported.fingerprint, answer: {
      status: "ANSWERED", selectedOptionIds: [], blankAnswers: [], textAnswer: "手工补答", explanation: "", caveats: []
    } }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("CONTROL_UNSUPPORTED");
      // 明确说明为什么不能回填，而不是静默成功或返回通用失败文案。
      expect(result.detail).toContain("无法自动回填");
      expect(result.detail).toContain("不是已适配");
    }
  });

  it("accepts the observed standalone 作业/测验 page as one quiz with no task chain", () => {
    document.body.dataset.automationWork = "true";
    const work = new CoursePage(document);
    const snap = work.inspect();
    expect(snap.standalone).toBe(true);
    expect(snap.kind).toBe("QUIZ");
    expect(snap.questionCount).toBe(1);
    expect(snap.hasNext).toBe(false);
    expect(snap.completed).toBe(false);
    expect(work.inspect().taskKey).toBe(snap.taskKey);
  });

  it("recognizes only the observed dowork path and still rejects exam paths", () => {
    expect(isWorkPagePath("/mooc-ans/mooc2/work/dowork")).toBe(true);
    expect(isWorkPagePath("/mooc-ans/mooc2/work/dowork/")).toBe(true);
    expect(isWorkPagePath("/mycourse/studentstudy")).toBe(false);
    expect(isWorkPagePath("/mooc-ans/mooc2/work/view")).toBe(false);
    expect(isExamPath("/mooc-ans/exam/test/reVersionTestStartNew")).toBe(true);
    expect(isExamPath("/mooc-ans/mooc2/work/dowork")).toBe(false);
  });

  it("refuses to submit the standalone work page before the whole page is filled and verified", async () => {
    document.body.dataset.automationWork = "true";
    const work = new CoursePage(document);
    const snap = work.inspect();
    const cmd = (action: AutomationCommand["action"], extra: Partial<AutomationCommand> = {}): AutomationCommand =>
      ({ action, requestId: "request_1", runId: "run_1", courseKey: snap.courseKey, taskKey: snap.taskKey, ...extra });
    const early = await work.handle(cmd("SEND_WORK"));
    expect(early.ok).toBe(false);
    expect(sends).toBe(0);
    const captured = await work.handle(cmd("CAPTURE", { index: 0 }));
    if (!captured.ok || !captured.captured) throw new Error("capture failed");
    const applied = await work.handle(cmd("APPLY", { index: 0, fingerprint: captured.captured.fingerprint,
      answer: { status: "ANSWERED", selectedOptionIds: ["opt_1"], blankAnswers: [], textAnswer: null, explanation: "", caveats: [] } }));
    expect(applied.ok).toBe(true);
    expect((await work.handle(cmd("SEND_WORK"))).ok).toBe(true);
    expect(sends).toBe(1);
    expect((await work.handle(cmd("SEND_WORK"))).ok).toBe(false);
    expect(sends).toBe(1);
  });

  it("reports the standalone work page complete only after our own submit leaves the answer view", async () => {
    document.body.dataset.automationWork = "true";
    const work = new CoursePage(document);
    const snap = work.inspect();
    const cmd = (action: AutomationCommand["action"], extra: Partial<AutomationCommand> = {}): AutomationCommand =>
      ({ action, requestId: "request_1", runId: "run_1", courseKey: snap.courseKey, taskKey: snap.taskKey, ...extra });
    expect(snap.completed).toBe(false);
    const captured = await work.handle(cmd("CAPTURE", { index: 0 }));
    if (!captured.ok || !captured.captured) throw new Error("capture failed");
    expect((await work.handle(cmd("APPLY", { index: 0, fingerprint: captured.captured.fingerprint,
      answer: { status: "ANSWERED", selectedOptionIds: ["opt_2"], blankAnswers: [], textAnswer: null, explanation: "", caveats: [] } }))).ok).toBe(true);
    expect((await work.handle(cmd("SEND_WORK"))).ok).toBe(true);
    // 站点交卷后移除作答视图：即使没有文字结果，也以“本页已提交且作答视图消失”作为完成证据。
    document.body.innerHTML = '<div class="result-note">成绩计算中</div>';
    const done = work.inspect();
    expect(done.completed).toBe(true);
    expect(done.kind).toBe("COMPLETED");
    expect(done.questionCount).toBe(0);
  });

  it("does not treat a merely hidden submit button as a completed work page", async () => {
    document.body.dataset.automationWork = "true";
    const work = new CoursePage(document);
    const snap = work.inspect();
    const cmd = (action: AutomationCommand["action"], extra: Partial<AutomationCommand> = {}): AutomationCommand =>
      ({ action, requestId: "request_1", runId: "run_1", courseKey: snap.courseKey, taskKey: snap.taskKey, ...extra });
    const captured = await work.handle(cmd("CAPTURE", { index: 0 }));
    if (!captured.ok || !captured.captured) throw new Error("capture failed");
    expect((await work.handle(cmd("APPLY", { index: 0, fingerprint: captured.captured.fingerprint,
      answer: { status: "ANSWERED", selectedOptionIds: ["opt_2"], blankAnswers: [], textAnswer: null, explanation: "", caveats: [] } }))).ok).toBe(true);
    expect((await work.handle(cmd("SEND_WORK"))).ok).toBe(true);
    // 提交进行中站点可能暂时隐藏提交按钮但题目仍在：这不是完成，不能计入完成。
    document.querySelector<HTMLElement>(".btnSubmit")!.style.display = "none";
    const pending = work.inspect();
    expect(pending.completed).toBe(false);
    expect(pending.kind).toBe("QUIZ");
  });

  it("uses an explicit submitted cue when the result view keeps a submit-like button", () => {
    document.body.dataset.automationWork = "true";
    const work = new CoursePage(document);
    expect(work.inspect().completed).toBe(false);
    document.body.innerHTML = '<a class="btnSubmit">Submit</a><div>提交成功，可查看答案</div>';
    expect(work.inspect().completed).toBe(true);
  });

  // 2026-10-20 bug-fix regressions: hidden/stem completion cues, input submit buttons,
  // explicit type labels, warning dialogs, bare contenteditable and stem lists.
  it("does not treat hidden or question-stem submitted cues as completion evidence", () => {
    document.body.dataset.automationWork = "true";
    const work = new CoursePage(document);
    expect(work.inspect().completed).toBe(false);
    const hidden = document.createElement("div");
    hidden.style.display = "none";
    hidden.textContent = "提交成功";
    document.body.append(hidden);
    expect(work.inspect().completed).toBe(false);
    document.querySelector(".Zy_TItle")!.insertAdjacentHTML("beforeend", "<p>查看答案</p>");
    expect(work.inspect().completed).toBe(false);
  });

  it("clicks an input[type=submit] whose label lives in the value attribute", async () => {
    const legacy = document.querySelector(".btnSubmit")!;
    const input = document.createElement("input");
    input.type = "submit";
    input.value = "提交";
    input.addEventListener("click", () => { sends += 1; });
    legacy.replaceWith(input);
    await filled();
    expect((await page.handle(command("SEND_WORK"))).ok).toBe(true);
    expect(sends).toBe(1);
  });

  it("keeps the explicit type label when the stem mentions another question type", async () => {
    document.querySelector(".Zy_TItle")!.insertAdjacentHTML("beforeend", "<p>以下判断正确的是（可多选）</p>");
    const captured = await page.handle(command("CAPTURE", { index: 0 }));
    if (!captured.ok || !captured.captured) throw new Error("capture failed");
    expect(captured.captured.question.type).toBe("SINGLE_CHOICE");
  });

  it("does not confirm a dialog that warns about unanswered questions", async () => {
    document.querySelector("#confirmSubWin")!.remove();
    const legacy = document.querySelector(".btnSubmit")!;
    const submit = document.createElement("button");
    submit.textContent = "Submit";
    submit.addEventListener("click", () => {
      sends += 1;
      const dialog = document.createElement("div");
      dialog.innerHTML = '<div>警告</div><div>还有 3 道题未作答，确定提交吗？</div>' +
        '<button type="button">取消</button><button type="button">确定</button>';
      dialog.querySelectorAll("button")[1]!.addEventListener("click", () => { confirms += 1; dialog.remove(); });
      dialog.querySelectorAll("button")[0]!.addEventListener("click", () => dialog.remove());
      document.body.append(dialog);
    });
    legacy.replaceWith(submit);
    await filled();
    expect((await page.handle(command("SEND_WORK"))).ok).toBe(true);
    expect((await page.handle(command("CONFIRM_WORK"))).ok).toBe(true);
    expect(confirms).toBe(0);
  });

  it("writes a bare contenteditable and a plaintext-only editor", async () => {
    document.querySelector("#question1")!.innerHTML = '<div class="TiMu"><div class="Zy_TItle">' +
      '<span class="newZy_TItle">【Fill in the Blank】</span><p>填写两个空。</p></div>' +
      '<div id="rich_1" contenteditable></div><div id="rich_2" contenteditable="plaintext-only"></div></div>';
    snapshot = page.inspect();
    const captured = await page.handle(command("CAPTURE", { index: 0 }));
    if (!captured.ok || !captured.captured) throw new Error("capture failed");
    expect(captured.captured.answerMode).toBe("CONTENTEDITABLE");
    const result = await page.handle(command("APPLY", { index: 0, fingerprint: captured.captured.fingerprint, answer: {
      status: "ANSWERED", selectedOptionIds: [], textAnswer: null, explanation: "", caveats: [],
      blankAnswers: [{ blankId: "blank_1", answer: "甲" }, { blankId: "blank_2", answer: "乙" }]
    } }));
    expect(result.ok).toBe(true);
    expect(document.querySelector("#rich_1")!.textContent).toBe("甲");
    expect(document.querySelector("#rich_2")!.textContent).toBe("乙");
  });

  it("does not treat a stem's own ul/li list as answer options", async () => {
    document.querySelector(".Zy_ulTop")!.remove();
    document.querySelector(".Zy_TItle")!.insertAdjacentHTML("beforeend", "<ul><li>规则一</li><li>规则二</li></ul>");
    const captured = await page.handle(command("CAPTURE", { index: 0 }));
    if (!captured.ok || !captured.captured) throw new Error("capture failed");
    expect(captured.captured.question.options).toHaveLength(0);
  });
});
