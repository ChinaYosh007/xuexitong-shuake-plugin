import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAutomationLimits } from "../src/api/client";

afterEach(() => vi.unstubAllGlobals());
const mock = (payload: unknown, status = 200) => vi.stubGlobal("fetch", vi.fn(async () => ({
  ok: status === 200, status, headers: { get: () => null }, text: async () => JSON.stringify(payload)
})));

describe("backend automation budget", () => {
  it("reads concurrency and rate ceilings from meta without sending login data", async () => {
    mock({ limits: { perUserConcurrency: 2, requestsPerMinute: 10, requestsPerDay: 100 } });
    expect(await fetchAutomationLimits("http://127.0.0.1:8080")).toMatchObject({ ok: true, data: { requestsPerMinute: 10 } });
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:8080/api/v1/meta", expect.objectContaining({ method: "GET", credentials: "omit" }));
  });
  it("accepts zero limits as unlimited for a self-hosted BYOK backend", async () => {
    mock({ limits: { perUserConcurrency: 0, requestsPerMinute: 0, requestsPerDay: 0 } });
    expect(await fetchAutomationLimits("http://127.0.0.1:8080")).toMatchObject({
      ok: true, data: { perUserConcurrency: 0, requestsPerMinute: 0, requestsPerDay: 0 }
    });
  });
  it("rejects missing, fractional or negative limits instead of guessing a budget", async () => {
    for (const limits of [null, {}, { perUserConcurrency: 2, requestsPerMinute: 1.5, requestsPerDay: 100 },
      { perUserConcurrency: 2, requestsPerMinute: -1, requestsPerDay: 100 }]) {
      mock({ limits });
      expect(await fetchAutomationLimits("http://127.0.0.1:8080")).toMatchObject({ ok: false, code: "INVALID_LIMITS" });
    }
  });
  it("preserves a backend failure instead of guessing a budget or retrying", async () => {
    mock({ code: "UNAVAILABLE", detail: "offline" }, 503);
    expect(await fetchAutomationLimits("http://127.0.0.1:8080")).toMatchObject({ ok: false, status: 503, code: "UNAVAILABLE" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});