import { CoursePage } from "./course-page";
import { parseAutomationCommand } from "./protocol";
import { DiscussionPage } from "./discussion-page";
import { isDiscussionPageUrl } from "../shared/pages";

const key = "__studyCourseAutomationV1";
const scope = window as unknown as Record<string, unknown>;
if (!scope[key]) {
  scope[key] = true;
  const page = isDiscussionPageUrl(location.href) ? new DiscussionPage(document) : new CoursePage(document);
  chrome.runtime.onMessage.addListener((message: unknown, sender, respond) => {
    if (sender.id !== chrome.runtime.id || typeof message !== "object" || message === null) return false;
    // Lightweight probe used by the background worker to avoid re-injecting this large file on
    // every command; answered even though the page may not be a course page.
    if ((message as Record<string, unknown>).type === "AUTOMATION_PING") { respond({ ok: true }); return false; }
    if ((message as Record<string, unknown>).type !== "AUTOMATION_PAGE") return false;
    const command = parseAutomationCommand((message as Record<string, unknown>).command);
    if (!command) { respond({ ok: false, code: "INVALID_COMMAND", detail: "无效课程指令。" }); return false; }
    void page.handle(command).then(respond);
    return true;
  });
}
