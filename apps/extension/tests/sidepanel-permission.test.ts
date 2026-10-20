import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/sidepanel/App.vue";

vi.mock("../src/api/session", () => ({
  ensureTrustedStorageAccess: vi.fn(), clearSession: vi.fn(), saveSession: vi.fn(),
  loadSession: vi.fn(async () => ({ accessToken: "test-session", username: "student" }))
}));
vi.mock("../src/api/settings", () => ({ loadSettings: vi.fn(async () => ({ backendOrigin: "http://127.0.0.1:8080" })) }));
vi.mock("../src/local/provider", () => ({
  loadActiveProvider: vi.fn(async () => null),
  askLocalProvider: vi.fn(),
  ensureOriginPermission: vi.fn(async () => true),
  originPattern: (baseUrl: string) => new URL(baseUrl).origin + "/*"
}));
vi.mock("../src/api/client", () => ({
  fetchMe: vi.fn(async () => ({ ok: true, data: { defaultProviderProfileId: null } })),
  fetchProviderProfiles: vi.fn(async () => ({ ok: true, data: [] })),
  describeProblem: vi.fn(), generateAnswer: vi.fn(), login: vi.fn(), logout: vi.fn()
}));

describe("side panel optional authorization", () => {
  const request = vi.fn();
  const sendMessage = vi.fn();
  const query = vi.fn();
  let wrapper: ReturnType<typeof mount> | undefined;

  beforeEach(() => {
    request.mockReset().mockResolvedValue(false);
    query.mockReset().mockResolvedValue([{ id: 7 }]);
    sendMessage.mockReset().mockResolvedValue({ ok: false, code: "FRAME_ACCESS_DENIED", detail: "permission: page script injection denied" });
    vi.stubGlobal("chrome", {
      tabs: { query, get: vi.fn(async () => ({ id: 7, url: "https://mooc1.chaoxing.com/course" })) },
      runtime: { sendMessage, openOptionsPage: vi.fn(), getManifest: () => ({ version: "0.2.0" }) }, permissions: { request },
      storage: { local: { get: vi.fn(async () => ({})) } }
    });
  });

  afterEach(() => { wrapper?.unmount(); vi.unstubAllGlobals(); });

  async function failedCapture(): Promise<void> {
    wrapper = mount(App);
    await flushPromises();
    await wrapper.get('[data-testid="capture-question"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="allow-site-reading"]').exists()).toBe(true);
    expect(request).not.toHaveBeenCalled();
  }
  it("routes a real course read to the whole-task reader instead of reporting the old adapter failure", async () => {
    const create = vi.fn(async () => ({ id: 99 }));
    Object.assign(chrome.tabs, { create, get: vi.fn(async () => ({ id: 7, url: "https://mooc1.chaoxing.com/mycourse/studentstudy" })) });
    Object.assign(chrome.runtime, { getURL: (path: string) => `chrome-extension://test/${path}` });
    wrapper = mount(App); await flushPromises();
    await wrapper.get('[data-testid="capture-question"]').trigger("click"); await flushPromises();
    expect(create).toHaveBeenCalledWith({ url: "chrome-extension://test/runner.html?tabId=7", active: true });
    expect(sendMessage).not.toHaveBeenCalled(); expect(wrapper.find('[data-testid="error-code"]').exists()).toBe(false);
  });

  it("guides to authorization and the runner after refusing access without retrying injection", async () => {
    await failedCapture();
    await wrapper!.get('[data-testid="allow-site-reading"]').trigger("click");
    await flushPromises();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(wrapper!.get('[data-testid="permission-notice"]').text()).toContain("课程任务调度");
    expect(wrapper!.find('[data-testid="manual-question"]').exists()).toBe(false);
    expect(wrapper!.find('[data-testid="site-permission"]').exists()).toBe(true);
  });

  it("retries capture after a grant and retains the scored-page rejection", async () => {
    await failedCapture();
    request.mockResolvedValue(true);
    sendMessage.mockResolvedValue({ ok: false, code: "PAGE_KIND_UNSUPPORTED", detail: "计分页只识别" });
    await wrapper!.get('[data-testid="allow-site-reading"]').trigger("click");
    await flushPromises();
    expect(request).toHaveBeenCalledWith({ origins: ["https://mooc1.chaoxing.com/*"] });
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(wrapper!.get('[data-testid="error-code"]').text()).toBe("PAGE_KIND_UNSUPPORTED");
    expect(wrapper!.find('[data-testid="approve-fill"]').exists()).toBe(false);
    expect(wrapper!.find('[data-testid="site-permission"]').exists()).toBe(false);
  });

  it("does not retry on a different tab after the authorization prompt", async () => {
    await failedCapture();
    request.mockResolvedValue(true);
    query.mockResolvedValue([{ id: 8 }]);
    await wrapper!.get('[data-testid="allow-site-reading"]').trigger("click");
    await flushPromises();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(wrapper!.get('[data-testid="error-code"]').text()).toBe("DOCUMENT_CHANGED");
  });

  it("guides to the runner if Chrome rejects the permission request", async () => {
    await failedCapture();
    request.mockRejectedValue(new Error("User gesture missing"));
    await wrapper!.get('[data-testid="allow-site-reading"]').trigger("click");
    await flushPromises();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(wrapper!.get('[data-testid="permission-notice"]').text()).toContain("课程任务调度");
  });

  it("asks for a site explicitly when Chrome cannot expose the ungranted URL", async () => {
    chrome.tabs.get = vi.fn().mockResolvedValue({ id: 7 });
    await failedCapture();
    expect(wrapper!.get('[data-testid="allow-site-reading"]').attributes("disabled")).toBeDefined();
    await wrapper!.get('[data-testid="permission-site"]').setValue("https://*.chaoxing.com");
    expect(wrapper!.get('[data-testid="allow-site-reading"]').attributes("disabled")).toBeDefined();
    await wrapper!.get('[data-testid="permission-site"]').setValue("https://mooc1.chaoxing.com");
    expect(wrapper!.get('[data-testid="allow-site-reading"]').attributes("disabled")).toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });

  it("does not offer authorization when activeTab works and the adapter rejects a scored page", async () => {
    sendMessage.mockResolvedValue({ ok: false, code: "PAGE_KIND_UNSUPPORTED", detail: "计分" });
    wrapper = mount(App);
    await flushPromises();
    await wrapper.get('[data-testid="capture-question"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="allow-site-reading"]').exists()).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });
});
