// @vitest-environment-options {"url":"http://localhost/runner.html?tabId=7"}
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/api/settings", () => ({ loadSettings: vi.fn(async () => ({ backendOrigin: "http://127.0.0.1:8080" })) }));
vi.mock("../src/api/session", () => ({
  clearSession: vi.fn(), saveSession: vi.fn(), loadSession: vi.fn(async () => null)
}));
vi.mock("../src/api/client", () => ({
  fetchMe: vi.fn(), fetchProviderProfiles: vi.fn(), fetchAutomationLimits: vi.fn(),
  generateAnswer: vi.fn(), login: vi.fn(), describeProblem: vi.fn()
}));
vi.mock("../src/local/provider", () => ({ loadActiveProvider: vi.fn(async () => null), askLocalProvider: vi.fn() }));

import App from "../src/automation/App.vue";

describe("runner optional site permission card", () => {
  const contains = vi.fn();
  let wrapper: ReturnType<typeof mount> | undefined;

  beforeEach(() => {
    contains.mockReset().mockResolvedValue(true);
    vi.stubGlobal("chrome", {
      tabs: { get: vi.fn(async () => ({ id: 7, url: "https://mooc1.chaoxing.com/mycourse/studentstudy" })) },
      runtime: {
        sendMessage: vi.fn(async () => ({ ok: false, code: "INVALID_COMMAND", detail: "not implemented" })),
        openOptionsPage: vi.fn(),
        getManifest: () => ({ version: "0.2.0" }),
        getURL: (path: string) => `chrome-extension://test/${path}`
      },
      permissions: { contains, request: vi.fn() },
      storage: { local: { get: vi.fn(async () => ({})) } }
    });
  });

  afterEach(() => { wrapper?.unmount(); vi.unstubAllGlobals(); });

  it("hides the request card when the exact course origin is already granted", async () => {
    wrapper = mount(App);
    await flushPromises();
    expect(contains).toHaveBeenCalledWith({ origins: ["https://mooc1.chaoxing.com/*"] });
    expect(wrapper.find('[data-testid="site-permission-card"]').exists()).toBe(false);
  });

  it("keeps the card as a fallback until the user grants that exact site", async () => {
    contains.mockResolvedValue(false);
    const request = vi.fn(async () => true);
    wrapper = mount(App);
    await flushPromises();
    expect(wrapper.find('[data-testid="site-permission-card"]').exists()).toBe(true);
    Object.assign(chrome.permissions, { request });
    await wrapper.get('[data-testid="site-permission-card"] button').trigger("click");
    await flushPromises();
    expect(request).toHaveBeenCalledWith({ origins: ["https://mooc1.chaoxing.com/*"] });
    expect(wrapper.find('[data-testid="site-permission-card"]').exists()).toBe(false);
  });
});
