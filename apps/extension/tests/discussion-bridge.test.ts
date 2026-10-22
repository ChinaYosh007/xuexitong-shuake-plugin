import { afterEach, describe, expect, it, vi } from "vitest";
import { openDiscussionTab } from "../src/automation/discussion-bridge";
import { sha256Hex } from "../src/shared/sha256";
import type { AutomationCommand } from "../src/automation/protocol";

const command: AutomationCommand = { action: "OPEN_DISCUSSION", requestId: "request", runId: "run", courseKey: sha256Hex("1|2"), taskKey: "task" };
const child = { id: 8, openerTabId: 7, status: "complete", url: "https://groupweb.chaoxing.com/course/topic/v3/bbs/topic/thread/replysList?courseId=1&classId=2" };
function setup(granted = true) {
  const get = vi.fn().mockResolvedValueOnce({ id: 7, url: "https://mooc1.chaoxing.com/mycourse/studentstudy?courseId=1&clazzid=2" }).mockResolvedValue(child);
  const create = vi.fn(async () => child);
  const update = vi.fn(async () => child);
  vi.stubGlobal("chrome", { permissions: { contains: vi.fn(async () => granted) }, tabs: { get, create, update } });
  return { get, create, update, open: vi.fn(async () => ({ ok: true as const, discussionUrl: child.url })) };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe("discussion child tab binding", () => {
  it("creates and binds the site-provided destination without a page popup", async () => {
    const t = setup();
    expect(await openDiscussionTab(7, command, t.open)).toEqual({ ok: true, discussionTabId: 8 });
    expect(t.open).toHaveBeenCalledOnce();
    expect(t.create).toHaveBeenCalledOnce();
    expect(t.create).toHaveBeenCalledWith({ url: "about:blank", openerTabId: 7, active: true });
    expect(t.update).toHaveBeenCalledWith(8, { url: child.url });
    expect(t.get.mock.calls).toEqual([[7], [8]]);
  });
  it("requires exact discussion-origin permission before opening", async () => {
    const t = setup(false);
    expect(await openDiscussionTab(7, command, t.open)).toMatchObject({ ok: false, code: "FRAME_ACCESS_DENIED" });
    expect(t.open).not.toHaveBeenCalled();
    expect(t.create).not.toHaveBeenCalled();
  });
  it("uses the created ID even when Chromium omits the opener", async () => {
    const t = setup(); t.get.mockResolvedValue({ ...child, openerTabId: undefined });
    expect(await openDiscussionTab(7, command, t.open)).toEqual({ ok: true, discussionTabId: 8 });
  });
  it("rejects a new child belonging to another course", async () => {
    const t = setup(); t.open.mockResolvedValue({ ok: true, discussionUrl: child.url.replace("courseId=1", "courseId=9") });
    expect(await openDiscussionTab(7, command, t.open)).toMatchObject({ ok: false, code: "DOCUMENT_CHANGED" });
    expect(t.create).not.toHaveBeenCalled();
  });
  it("waits only for the created tab and never retries creating a slow page", async () => {
    vi.useFakeTimers(); const t = setup(); t.get.mockResolvedValue({ ...child, status: "loading" });
    const pending = openDiscussionTab(7, command, t.open);
    await vi.advanceTimersByTimeAsync(11000);
    expect(await pending).toMatchObject({ ok: false, code: "TAB_UNAVAILABLE" });
    expect(t.open).toHaveBeenCalledOnce();
    expect(t.create).toHaveBeenCalledOnce();
    expect(t.get.mock.calls.slice(1).every(args => args[0] === 8)).toBe(true);
  });
  it("rejects navigation away from the bound course after creating the tab", async () => {
    const t = setup(); t.get.mockResolvedValue({ ...child, url: child.url.replace("classId=2", "classId=9") });
    expect(await openDiscussionTab(7, command, t.open)).toMatchObject({ ok: false, code: "DOCUMENT_CHANGED" });
  });
  it("waits through the initial complete about:blank and pending navigation", async () => {
    vi.useFakeTimers(); const t = setup();
    t.get.mockResolvedValueOnce({ ...child, url: "about:blank", pendingUrl: child.url });
    const pending = openDiscussionTab(7, command, t.open);
    await vi.advanceTimersByTimeAsync(250);
    expect(await pending).toEqual({ ok: true, discussionTabId: 8 });
    expect(t.create).toHaveBeenCalledOnce();
  });
  it.each(["", "javascript:alert(1)", "https://example.com/", child.url.replace("groupweb.chaoxing.com", "groupweb.chaoxing.com.evil.test")])("rejects an unsupported destination %s", async url => {
    const t = setup(); t.open.mockResolvedValue({ ok: true, discussionUrl: url });
    expect(await openDiscussionTab(7, command, t.open)).toMatchObject({ ok: false, code: "DOCUMENT_CHANGED" });
    expect(t.create).not.toHaveBeenCalled();
  });
});
