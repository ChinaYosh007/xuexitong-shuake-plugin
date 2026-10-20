import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());

describe("manual page message ownership", () => {
  it("ignores automation and unrelated messages without taking their response channel", async () => {
    vi.resetModules();
    vi.stubGlobal("__studyAssistantPageEntryV1Installed", false);
    let listener: ((message: unknown, sender: chrome.runtime.MessageSender, send: (value: unknown) => void) => boolean) | undefined;
    vi.stubGlobal("chrome", { runtime: {
      id: "test-extension",
      onMessage: { addListener: (value: typeof listener) => { listener = value; } }
    } });
    await import("../src/page/entry");
    const respond = vi.fn();
    const sender = { id: "test-extension" };
    expect(listener!({ type: "AUTOMATION_PAGE", command: {
      action: "INSPECT", requestId: "req_1", runId: "run_1"
    } }, sender, respond)).toBe(false);
    expect(listener!({ type: "UNKNOWN" }, sender, respond)).toBe(false);
    expect(listener!({ type: "CAPTURE_QUESTION", requestId: "req_1" }, { id: "other" }, respond)).toBe(false);
    await Promise.resolve();
    expect(respond).not.toHaveBeenCalled();
    // Malformed commands belonging to this listener must still return a validation error.
    const response = new Promise(resolve => {
      expect(listener!({ type: "CAPTURE_QUESTION", requestId: "../invalid" }, sender, resolve)).toBe(true);
    });
    await expect(response).resolves.toMatchObject({ ok: false, code: "INVALID_COMMAND" });
  });
});
