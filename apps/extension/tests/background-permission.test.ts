import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());

describe("background permission handling", () => {
  it("resets panel behavior on load/install/startup and marks only host permission failures", async () => {
    vi.resetModules();
    let installed: (() => void) | undefined;
    let startup: (() => void) | undefined;
    let messageListener: ((message: unknown, sender: chrome.runtime.MessageSender, send: (value: unknown) => void) => boolean) | undefined;
    const setPanelBehavior = vi.fn(async () => undefined);
    const executeScript = vi.fn().mockRejectedValue(new Error("Cannot access contents of the page. Extension manifest must request permission to access the respective host."));
    const sendMessage = vi.fn(async () => ({ ok: false, code: "PAGE_KIND_UNSUPPORTED", detail: "graded" }));
    vi.stubGlobal("chrome", {
      runtime: {
        id: "test-extension",
        getURL: (path: string) => `chrome-extension://test-extension/${path}`,
        onInstalled: { addListener: (listener: () => void) => { installed = listener; } },
        onStartup: { addListener: (listener: () => void) => { startup = listener; } },
        onMessage: { addListener: (listener: typeof messageListener) => { messageListener = listener; } }
      },
      action: { onClicked: { addListener: vi.fn() } },
      sidePanel: { setPanelBehavior },
      storage: { local: { setAccessLevel: vi.fn() }, session: { setAccessLevel: vi.fn() } },
      tabs: { get: vi.fn(async () => ({ id: 7 })), sendMessage }, scripting: { executeScript }
    });
    await import("../src/background");
    installed?.();
    startup?.();
    expect(setPanelBehavior).toHaveBeenCalledTimes(3);
    expect(setPanelBehavior).toHaveBeenCalledWith({ openPanelOnActionClick: false });

    const request = { type: "PAGE_COMMAND", tabId: 7, command: { type: "CAPTURE_QUESTION", requestId: "request-1" } };
    const sender = { id: "test-extension", url: "chrome-extension://test-extension/sidepanel.html" };
    const call = () => new Promise<unknown>((resolve) => messageListener!(request, sender, resolve));
    expect(await call()).toMatchObject({ ok: false, code: "FRAME_ACCESS_DENIED", detail: expect.stringMatching(/^permission: /) });
    expect(sendMessage).not.toHaveBeenCalled();
    executeScript.mockRejectedValue(new Error("Frame removed"));
    expect(await call()).toMatchObject({ detail: "page script injection denied: Frame removed" });
    executeScript.mockResolvedValue([]);
    expect(await call()).toMatchObject({ code: "PAGE_KIND_UNSUPPORTED" });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const automation = { type: "AUTOMATION_COMMAND", tabId: 7,
      command: { action: "INSPECT", requestId: "request_2", runId: "run_1" } };
    const denied = await new Promise<unknown>(resolve => messageListener!(automation, sender, resolve));
    expect(denied).toMatchObject({ ok: false, code: "INVALID_COMMAND" });
    await new Promise<unknown>(resolve => messageListener!(automation,
      { id: "test-extension", url: "chrome-extension://test-extension/runner.html?tabId=7" }, resolve));
    expect(executeScript).toHaveBeenLastCalledWith({ target: { tabId: 7, frameIds: [0] }, files: ["page/automation-entry.js"], world: "ISOLATED" });
  });
});
