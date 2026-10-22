import type { AutomationCommand, AutomationResponse, TaskQuestion, TaskSnapshot } from "./protocol";
import { isDiscussionPageUrl } from "../shared/pages";
import { sha256Hex } from "../shared/sha256";
import { renderQuestion } from "./render-question";

/** Real replysList DOM and publication evidence recorded in compatibility §6.12. */
export class DiscussionPage {
  private owner = "";
  private leaseAt = 0;
  private verified: { fingerprint: string; text: string; editor: HTMLTextAreaElement } | null = null;
  private sent: { fingerprint: string; text: string; editor: HTMLTextAreaElement; before: Set<Element> } | null = null;
  private published = false;
  constructor(private readonly root: Document) {}

  private topic(): HTMLElement {
    const nodes = this.root.querySelectorAll<HTMLElement>("#bbsTopicDetail .topicDetail_main .replyContent");
    if (nodes.length !== 1 || !nodes[0]!.textContent?.trim()) throw new Error("无法唯一读取讨论题干。");
    return nodes[0]!;
  }
  private editor(): HTMLTextAreaElement {
    const nodes = [...this.root.querySelectorAll<HTMLTextAreaElement>(".replyEdit .textareawrap textarea")]
      .filter(el => el.getClientRects().length && el.ownerDocument.defaultView?.getComputedStyle(el).visibility !== "hidden");
    if (nodes.length !== 1 || nodes[0]!.disabled || nodes[0]!.readOnly) throw new Error("讨论回复输入框不可写或不唯一。");
    return nodes[0]!;
  }
  private describe(): TaskQuestion {
    const topic = this.topic();
    const title = this.root.querySelector("#bbsTopicDetail .topicDetail_title > span")?.textContent?.trim() ?? "";
    const stem = [title, topic.textContent?.trim()].filter(Boolean).join("\n");
    // An unrendered attachment must not silently become a text-only question.
    if (topic.querySelector("iframe,video,audio,object,embed")) throw new Error("此讨论包含尚未适配的附件，请人工处理。");
    return { index: 0, fingerprint: sha256Hex(stem + "|" + [...topic.querySelectorAll("img")].map(img => img.src).join("|")),
      question: { id: "discussion_1", type: "SHORT_ANSWER", stem, options: [], blanks: [] },
      needsImage: Boolean(topic.querySelector("img,canvas,svg")), textUsable: true, answerMode: "TEXT_FIELD" };
  }
  inspect(): TaskSnapshot {
    if (!isDiscussionPageUrl(this.root.location.href)) throw new Error("当前不是已适配的讨论回复页面。");
    const params = new URLSearchParams(this.root.location.search);
    if (!params.get("courseId") || !params.get("classId")) throw new Error("讨论页面缺少课程标识。");
    const courseKey = sha256Hex(`${params.get("courseId")}|${params.get("classId")}`);
    this.topic(); const editor = this.editor();
    if (this.sent && !this.published && this.describe().fingerprint === this.sent.fingerprint &&
        editor === this.sent.editor && !editor.value.trim()) {
      const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
      this.published = [...this.root.querySelectorAll(".topicDetail_replyList > .topicDetail_replyItem[id]")].some(item =>
        !this.sent!.before.has(item) && [...item.querySelectorAll<HTMLElement>(".replyContent")].some(content =>
          content.getClientRects().length && normalize(content.textContent ?? "") === normalize(this.sent!.text)));
    }
    return { courseKey, taskKey: sha256Hex(`${courseKey}|${this.root.location.pathname}`), kind: "QUIZ", questionCount: 1,
      completed: this.published, hasNext: false, video: null, standalone: true, discussionReply: true };
  }
  async handle(command: AutomationCommand): Promise<AutomationResponse> {
    try {
      if (command.action === "RELEASE") {
        if (this.owner && this.owner !== command.runId) throw new Error("讨论页由另一个调度器持有。");
        this.owner = ""; return { ok: true };
      }
      const snapshot = this.inspect();
      if (command.courseKey && (command.courseKey !== snapshot.courseKey || command.taskKey !== snapshot.taskKey)) throw new Error("讨论任务已变化。");
      if (this.owner && this.owner !== command.runId && Date.now() - this.leaseAt < 120000) throw new Error("讨论页已有另一个调度器运行。");
      this.owner = command.runId; this.leaseAt = Date.now();
      if (command.action === "INSPECT") return { ok: true, snapshot };
      if (command.action === "CONFIRM_WORK") return { ok: true };
      if (command.action === "SEND_WORK") {
        if (this.sent || this.published) throw new Error("讨论已尝试发表，不自动重复发表。");
        const verified = this.verified;
        const editor = this.editor();
        if (!verified || editor !== verified.editor || !verified.text.trim() || editor.value !== verified.text ||
            this.describe().fingerprint !== verified.fingerprint) throw new Error("讨论提交前回读不一致，未发表。");
        const buttons = [...this.root.querySelectorAll<HTMLElement>(".replyEdit .addReply")].filter(button =>
          button.getClientRects().length && button.ownerDocument.defaultView?.getComputedStyle(button).visibility !== "hidden" &&
          button.getAttribute("aria-disabled") !== "true" && !button.hasAttribute("disabled"));
        if (buttons.length !== 1) throw new Error("讨论发表按钮不可用或不唯一。");
        const before = new Set(this.root.querySelectorAll(".topicDetail_replyList > .topicDetail_replyItem"));
        this.sent = { ...verified, before };
        buttons[0]!.click();
        return { ok: true };
      }
      if (!["READ_ALL", "READ_ONE", "CAPTURE", "ADOPT_EXISTING", "APPLY"].includes(command.action)) throw new Error("讨论页面操作不受支持。");
      if (command.action !== "READ_ALL" && command.index !== 0) throw new Error("讨论题号无效。");
      const captured = this.describe();
      if (command.action === "READ_ALL") return { ok: true, questions: [captured] };
      if (command.action === "READ_ONE") return { ok: true, captured };
      if (command.action === "CAPTURE") {
        if (captured.needsImage || command.forceImage) captured.question.imageDataUrl = await renderQuestion(this.topic(), true);
        return { ok: true, captured };
      }
      const editor = this.editor();
      if (command.action === "ADOPT_EXISTING") {
        const accepted = Boolean(editor.value.trim());
        this.verified = accepted ? { fingerprint: captured.fingerprint, text: editor.value, editor } : null;
        return { ok: true, captured, existingAccepted: accepted };
      }
      if (this.sent) throw new Error("讨论已尝试发表，未再次写入。");
      const answer = command.answer;
      if (command.fingerprint !== captured.fingerprint || answer?.status !== "ANSWERED" ||
          !answer.textAnswer?.trim() || answer.selectedOptionIds.length || answer.blankAnswers.length) throw new Error("讨论内容或答案无效，拒绝写入。");
      if (editor.value.trim() && editor.value !== answer.textAnswer) throw new Error("讨论框已有草稿，未覆盖；请检查后再运行。");
      if (editor.maxLength >= 0 && answer.textAnswer.length > editor.maxLength) throw new Error("讨论文字超过输入框长度限制。");
      const setter = Object.getOwnPropertyDescriptor(this.root.defaultView!.HTMLTextAreaElement.prototype, "value")?.set;
      if (!setter) throw new Error("讨论输入框不支持安全写入。");
      setter.call(editor, answer.textAnswer);
      for (const type of ["input", "change", "blur"]) editor.dispatchEvent(new this.root.defaultView!.Event(type, { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 400));
      if (this.describe().fingerprint !== captured.fingerprint || this.editor() !== editor || editor.value !== answer.textAnswer) throw new Error("讨论草稿回读不一致，已停止。");
      this.verified = { fingerprint: captured.fingerprint, text: editor.value, editor };
      return { ok: true };
    } catch (error) {
      return { ok: false, code: "CONTROL_UNSUPPORTED", detail: error instanceof Error ? error.message : "讨论草稿处理失败。" };
    }
  }
}
