import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
describe("automation relay retries", () => {
  for (const action of ["SEND_WORK", "APPLY", "NEXT"] as const) {
    it(`does not replay ${action} after a lost response`, async () => {
      let listener!: (message: unknown, sender: chrome.runtime.MessageSender, respond: (value: unknown) => void) => boolean;
      const sendMessage = vi.fn(async (_tab: number, message: { type: string }) => {
        if (message.type === "AUTOMATION_PING") return { ok: true };
        throw new Error("Response lost after action");
      });
      vi.stubGlobal("chrome", {
        runtime: { id: "test", getURL: (path: string) => `chrome-extension://test/${path}`,
          onInstalled: { addListener: vi.fn() }, onStartup: { addListener: vi.fn() },
          onMessage: { addListener: (handler: typeof listener) => { listener = handler; } } },
        tabs: { get: vi.fn(async () => ({ id: 7 })), sendMessage }, scripting: { executeScript: vi.fn() },
        action: { onClicked: { addListener: vi.fn() } }, sidePanel: { setPanelBehavior: vi.fn() },
        storage: { local: { setAccessLevel: vi.fn() }, session: { setAccessLevel: vi.fn() } }
      });
      await import("../src/background");
      const command = { action, requestId: "request", runId: "run", courseKey: "course", taskKey: "task",
        ...(action === "APPLY" ? { index: 0, fingerprint: "fingerprint", answer: { status: "ANSWERED", selectedOptionIds: ["opt_1"], blankAnswers: [], textAnswer: null, explanation: "", caveats: [] } } : {}) };
      const result = await new Promise(resolve => listener({ type: "AUTOMATION_COMMAND", tabId: 7, command },
        { id: "test", url: "chrome-extension://test/runner.html?tabId=7" }, resolve));
      expect(result).toMatchObject({ ok: false, code: "TAB_UNAVAILABLE", detail: expect.stringContaining("未自动重试") });
      expect(sendMessage.mock.calls.filter(([, message]) => message.type === "AUTOMATION_PAGE")).toHaveLength(1);
      expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
    });
  }
});
