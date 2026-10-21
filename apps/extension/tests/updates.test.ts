import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkZipRelease, DEFAULT_UPDATE_FEED, isNewerVersion, loadUpdateSettings, parseRelease, updateUrl } from "../src/updates/updates";
const digest = "a".repeat(64);
const feed = "https://releases.example.test/update.json";
let request: ReturnType<typeof vi.fn>, permit: ReturnType<typeof vi.fn>;
beforeEach(() => {
  permit = vi.fn(async () => true);
  request = vi.fn(async () => new Response(JSON.stringify({ version: "0.3.0", zipUrl: "extension.zip", sha256: digest, notes: "release notes" })));
  vi.stubGlobal("chrome", { permissions: { request: permit } });
  vi.stubGlobal("fetch", request);
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("extension update checks", () => {
  it("defaults new and legacy unpacked installations to the official GitHub feed", async () => {
    const get = vi.fn(async () => ({}));
    vi.stubGlobal("chrome", { storage: { local: { get } }, runtime: { getManifest: () => ({ version: "0.2.5" }) } });
    expect(await loadUpdateSettings()).toEqual({ channel: "zip", feedUrl: DEFAULT_UPDATE_FEED });
    get.mockResolvedValue({ studyAssistantUpdates: { channel: "browser", feedUrl: "" } });
    expect(await loadUpdateSettings()).toEqual({ channel: "zip", feedUrl: DEFAULT_UPDATE_FEED });
    get.mockResolvedValue({ studyAssistantUpdates: { channel: "zip", feedUrl: 42 } });
    expect(await loadUpdateSettings()).toEqual({ channel: "zip", feedUrl: DEFAULT_UPDATE_FEED });
  });
  it("preserves custom feeds and explicit store settings", async () => {
    const get = vi.fn(async () => ({ studyAssistantUpdates: { channel: "zip", feedUrl: feed } }));
    const getManifest = vi.fn((): { update_url?: string } => ({}));
    vi.stubGlobal("chrome", { storage: { local: { get } }, runtime: { getManifest } });
    expect(await loadUpdateSettings()).toEqual({ channel: "zip", feedUrl: feed });
    get.mockResolvedValue({ studyAssistantUpdates: { channel: "browser", feedUrl: feed } });
    expect((await loadUpdateSettings()).channel).toBe("browser");
    get.mockResolvedValue({ studyAssistantUpdates: { channel: "browser", feedUrl: "" } });
    getManifest.mockReturnValue({ update_url: "https://clients2.google.com/service/update2/crx" });
    expect((await loadUpdateSettings()).channel).toBe("browser");
  });
  it("compares numeric versions without downgrades or lexicographic mistakes", () => {
    expect(isNewerVersion("1.10", "1.2.9")).toBe(true);
    expect(isNewerVersion("0.2.0.0", "0.2")).toBe(false);
    expect(isNewerVersion("0.1", "0.2")).toBe(false);
    expect(() => isNewerVersion("0.0.0", "0.2")).toThrow();
    expect(() => isNewerVersion("1.2.3-beta", "0.2")).toThrow();
  });
  it.each(["javascript:alert(1)", "http://remote.example.test/update.json", "https://name:password@example.test/feed", "file:///C:/feed.json"])
    ("refuses an unsupported or credential-bearing update URL: %s", url => expect(() => updateUrl(url)).toThrow());
  it("accepts loopback HTTP for local testing and resolves relative ZIP URLs", () => {
    expect(updateUrl("http://127.0.0.1:8080/update.json").hostname).toBe("127.0.0.1");
    expect(parseRelease({ version: "0.3", zipUrl: "extension.zip", sha256: digest }, feed).zipUrl).toBe("https://releases.example.test/extension.zip");
    expect(() => parseRelease({ version: "0.3", zipUrl: "script.js", sha256: digest }, feed)).toThrow();
    expect(() => parseRelease({ version: "0.3", zipUrl: "extension.zip" }, feed)).toThrow();
  });
  it("checks only a public feed after a user-triggered exact-origin permission request", async () => {
    const result = await checkZipRelease(feed);
    expect(result.version).toBe("0.3.0");
    expect(permit).toHaveBeenCalledWith({ origins: ["https://releases.example.test/*"] });
    expect(request).toHaveBeenCalledWith(feed, expect.objectContaining({ credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" }));
    expect(request.mock.calls[0]![1]).not.toHaveProperty("headers");
  });
  it("does not request the feed after permission is declined", async () => {
    permit.mockResolvedValue(false);
    await expect(checkZipRelease(feed)).rejects.toThrow("未授权");
    expect(request).not.toHaveBeenCalled();
  });
  it("bounds feed size and rejects invalid release documents", async () => {
    request.mockImplementation(async () => new Response("x".repeat(16385)));
    await expect(checkZipRelease(feed)).rejects.toThrow("16 KB");
    request.mockImplementation(async () => new Response(JSON.stringify({ version: "0.3", zipUrl: "javascript:evil", sha256: digest })));
    await expect(checkZipRelease(feed)).rejects.toThrow();
  });
  it("times out a hung check without reloading the extension or running remote code", async () => {
    vi.useFakeTimers();
    request.mockImplementation((_url: unknown, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    }));
    const pending = checkZipRelease(feed).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10000);
    expect((await pending as Error).message).toContain("超时");
  });
});
