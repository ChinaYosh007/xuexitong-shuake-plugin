import type { AutomationCommand, AutomationResponse } from "./protocol";
import { DISCUSSION_ORIGIN, isCourseTaskPath, isDiscussionPageUrl } from "../shared/pages";
import { sha256Hex } from "../shared/sha256";

/** Open only the verified site's destination, and bind only the tab we created. */
export async function openDiscussionTab(tabId: number, command: AutomationCommand,
  readEntry: () => Promise<AutomationResponse>): Promise<AutomationResponse> {
  if (!await chrome.permissions.contains({ origins: [`${DISCUSSION_ORIGIN}/*`] })) {
    return { ok: false, code: "FRAME_ACCESS_DENIED", detail: "请先点击运行页的「授权讨论页面」，允许读取 groupweb.chaoxing.com，然后重新运行。" };
  }
  const source = await chrome.tabs.get(tabId);
  const url = new URL(source.url ?? "");
  if (url.protocol !== "https:" || !url.hostname.endsWith(".chaoxing.com") || !isCourseTaskPath(url.pathname)) {
    return { ok: false, code: "INVALID_COMMAND", detail: "讨论入口必须来自绑定的学习通课程标签。" };
  }
  const expectedCourse = url.searchParams.get("courseId") ?? url.searchParams.get("courseid");
  const expectedClass = url.searchParams.get("clazzid");
  if (!expectedCourse || !expectedClass || sha256Hex(`${expectedCourse}|${expectedClass}`) !== command.courseKey) {
    return { ok: false, code: "DOCUMENT_CHANGED", detail: "讨论入口的课程已变化。" };
  }
  const result = await readEntry();
  if (!result.ok) return result;
  const destinationUrl = result.discussionUrl ?? "";
  const sameCourse = (value: string): boolean => {
    if (!isDiscussionPageUrl(value)) return false;
    const target = new URL(value);
    return target.searchParams.get("courseId") === expectedCourse && target.searchParams.get("classId") === expectedClass;
  };
  if (!sameCourse(destinationUrl)) {
    return { ok: false, code: "DOCUMENT_CHANGED", detail: "讨论入口目标不属于绑定课程或页面不受支持，未打开。" };
  }
  // Establish the exact tab before navigating; do not discover a page-created popup.
  const created = await chrome.tabs.create({ url: "about:blank", openerTabId: tabId, active: true });
  if (typeof created.id !== "number") return { ok: false, code: "TAB_UNAVAILABLE", detail: "未能创建讨论标签页。" };
  await chrome.tabs.update(created.id, { url: destinationUrl });
  const deadline = Date.now() + 10000;
  do {
    const target = await chrome.tabs.get(created.id);
    // A just-created tab can report complete for its initial about:blank while
    // the requested URL is still pending. That is not a completed redirect.
    if (target.status === "complete" && target.url && target.url !== "about:blank" && !target.pendingUrl) {
      if (!sameCourse(target.url ?? "")) {
        return { ok: false, code: "DOCUMENT_CHANGED", detail: "新讨论页面不属于绑定课程，未读取或写入。" };
      }
      return { ok: true, discussionTabId: created.id };
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  } while (Date.now() < deadline);
  return { ok: false, code: "TAB_UNAVAILABLE", detail: "讨论标签页已打开但尚未加载完成，请检查新页面的网络或登录状态。" };
}
