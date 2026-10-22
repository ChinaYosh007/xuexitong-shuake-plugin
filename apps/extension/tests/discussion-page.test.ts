// @vitest-environment-options {"url":"https://groupweb.chaoxing.com/course/topic/v3/bbs/topic/thread/replysList?courseId=1&classId=2"}
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiscussionPage } from "../src/automation/discussion-page";
import { isDiscussionPageUrl } from "../src/shared/pages";
import type { AutomationCommand } from "../src/automation/protocol";
import { questionContentRoots } from "../src/automation/question-roots";

vi.mock("../src/automation/render-question", () => ({ renderQuestion: vi.fn(async () => "data:image/png;base64,test") }));

describe("discussion draft adapter", () => {
  let page: DiscussionPage;
  const answer = { status: "ANSWERED" as const, selectedOptionIds: [], blankAnswers: [], textAnswer: "A plain-text reply <b>without markup</b>", explanation: "", caveats: [] };
  const command = (action: AutomationCommand["action"], extra: Partial<AutomationCommand> = {}): AutomationCommand => ({
    action, requestId: "request", runId: "run", ...page.inspect(), index: 0, ...extra
  });
  beforeEach(() => {
    document.body.innerHTML = '<div id="bbsTopicDetail"><div class="topicDetail_title"><span>Topic</span></div>' +
      '<div class="topicDetail_main"><div><div class="replyContent">Explain the physics.</div></div></div></div>' +
      '<div class="replyEdit"><div class="textareawrap"><textarea></textarea></div><div class="addReply">Comment</div></div>' +
      '<div class="topicDetail_replyList"></div><div class="replyContent">Another student answer must not be collected.</div><textarea id="textarea">Report field</textarea>';
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([new DOMRect(0, 0, 10, 10)] as unknown as DOMRectList);
    page = new DiscussionPage(document);
  });
  afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });

  it("reads the original topic only, fills plain text, verifies the draft and never publishes", async () => {
    const publish = vi.fn(); document.querySelector(".addReply")!.addEventListener("click", publish);
    const captured = await page.handle(command("READ_ONE"));
    expect(captured).toMatchObject({ ok: true, captured: { question: { type: "SHORT_ANSWER", stem: "Topic\nExplain the physics." } } });
    if (!captured.ok) throw new Error("capture");
    expect(await page.handle(command("APPLY", { fingerprint: captured.captured!.fingerprint, answer }))).toEqual({ ok: true });
    expect(document.querySelector("textarea")!.value).toBe(answer.textAnswer);
    expect(document.querySelector("#textarea")!.textContent).toBe("Report field");
    expect(page.inspect()).toMatchObject({ discussionReply: true, completed: false });
    expect((await page.handle(command("NEXT"))).ok).toBe(false);
    expect((await page.handle(command("CONFIRM_WORK"))).ok).toBe(true);
    expect(publish).not.toHaveBeenCalled();
  });
  it.each(["APPLY", "ADOPT_EXISTING"] as const)("publishes a %s-verified reply only once and waits for new matching content plus an empty editor", async action => {
    const read = await page.handle(command("READ_ONE")); if (!read.ok) throw new Error("capture");
    if (action === "APPLY") await page.handle(command(action, { fingerprint: read.captured!.fingerprint, answer }));
    else { document.querySelector("textarea")!.value = answer.textAnswer; await page.handle(command(action)); }
    const publish = vi.fn(); document.querySelector(".addReply")!.addEventListener("click", publish);
    expect(await page.handle(command("SEND_WORK"))).toEqual({ ok: true });
    expect(publish).toHaveBeenCalledOnce(); expect(page.inspect().completed).toBe(false);
    expect((await page.handle(command("SEND_WORK"))).ok).toBe(false);
    const item = document.createElement("div"); item.className = "topicDetail_replyItem"; item.id = "new-reply";
    const content = document.createElement("div"); content.className = "replyContent"; content.textContent = answer.textAnswer; item.append(content);
    document.querySelector(".topicDetail_replyList")!.append(item);
    expect(page.inspect().completed).toBe(false);
    document.querySelector("textarea")!.value = "";
    expect(page.inspect()).toMatchObject({ completed: true, discussionReply: true });
    expect(publish).toHaveBeenCalledOnce();
  });
  it("does not publish a changed draft or count old matching replies and editor clearing as proof", async () => {
    const editor = document.querySelector("textarea")!; editor.value = "My reply";
    await page.handle(command("ADOPT_EXISTING")); editor.value = "Changed reply";
    expect((await page.handle(command("SEND_WORK"))).ok).toBe(false);
    editor.value = "My reply";
    document.querySelector(".topicDetail_replyList")!.innerHTML = '<div class="topicDetail_replyItem" id="old"><div class="replyContent">My reply</div></div>';
    expect((await page.handle(command("SEND_WORK"))).ok).toBe(true);
    editor.value = ""; expect(page.inspect().completed).toBe(false);
  });
  it("refuses unverified or ambiguous publication controls", async () => {
    document.querySelector("textarea")!.value = "My reply";
    expect((await page.handle(command("SEND_WORK"))).ok).toBe(false);
    await page.handle(command("ADOPT_EXISTING"));
    document.querySelector(".addReply")!.parentElement!.append(document.querySelector(".addReply")!.cloneNode(true));
    expect((await page.handle(command("SEND_WORK"))).ok).toBe(false);
  });
  it("does not overwrite a learner's existing draft", async () => {
    document.querySelector("textarea")!.value = "My draft";
    const read = await page.handle(command("READ_ONE"));
    if (!read.ok) throw new Error("capture");
    expect((await page.handle(command("APPLY", { fingerprint: read.captured!.fingerprint, answer }))).ok).toBe(false);
    expect(document.querySelector("textarea")!.value).toBe("My draft");
    expect(await page.handle(command("ADOPT_EXISTING"))).toMatchObject({ existingAccepted: true });
  });
  it("rejects a changed topic and controlled-field reversion", async () => {
    const read = await page.handle(command("READ_ONE")); if (!read.ok) throw new Error("capture");
    document.querySelector("#bbsTopicDetail .replyContent")!.textContent = "Changed topic";
    expect((await page.handle(command("APPLY", { fingerprint: read.captured!.fingerprint, answer }))).ok).toBe(false);
    const fresh = await page.handle(command("READ_ONE")); if (!fresh.ok) throw new Error("capture");
    document.querySelector("textarea")!.addEventListener("input", event => { (event.target as HTMLTextAreaElement).value = ""; });
    expect((await page.handle(command("APPLY", { fingerprint: fresh.captured!.fingerprint, answer }))).ok).toBe(false);
  });
  it("rejects ambiguous, disabled and readonly reply editors", async () => {
    const editor = document.querySelector("textarea")!;
    editor.readOnly = true; expect(() => page.inspect()).toThrow("不可写");
    editor.readOnly = false; editor.disabled = true; expect(() => page.inspect()).toThrow("不可写");
    editor.disabled = false; editor.parentElement!.append(editor.cloneNode()); expect(() => page.inspect()).toThrow("不唯一");
  });
  it("limits discussion routing to the observed HTTPS host and detail path", () => {
    expect(isDiscussionPageUrl(location.href)).toBe(true);
    for (const url of [location.href.replace("https:", "http:"), location.href.replace("groupweb.chaoxing.com", "evil.example"),
      location.href.replace("replysList", "exam"), "https://groupweb.chaoxing.com/other"]) expect(isDiscussionPageUrl(url)).toBe(false);
  });
  it("renders the verified topic body without rendering another student's reply or an editor", () => {
    const topic = document.querySelector<HTMLElement>("#bbsTopicDetail .replyContent")!;
    expect(questionContentRoots(topic)).toEqual([topic]);
    expect(questionContentRoots(document.querySelector<HTMLElement>("body > .replyContent")!)).toEqual([]);
    expect(questionContentRoots(document.querySelector<HTMLElement>(".replyEdit")!)).toEqual([]);
  });
});
