import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isCourseTaskUrl, isSitePermissionGranted, requestSitePermission, sitePermissionOrigin } from "../src/sidepanel/bridge";
import { isHostPermissionFailure } from "../src/shared/messages";

afterEach(() => vi.unstubAllGlobals());

describe("optional site permission boundary", () => {
  const request = vi.fn();
  const contains = vi.fn();
  beforeEach(() => {
    request.mockReset().mockResolvedValue(true);
    contains.mockReset().mockResolvedValue(false);
    vi.stubGlobal("chrome", { permissions: { request, contains } });
  });

  it("requests only an exact HTTPS Chaoxing origin synchronously", async () => {
    const result = requestSitePermission("https://mooc1.chaoxing.com/course?id=private");
    expect(request).toHaveBeenCalledWith({ origins: ["https://mooc1.chaoxing.com/*"] });
    expect(await result).toBe(true);
  });

  it.each([
    "http://mooc1.chaoxing.com", "https://chaoxing.com.evil.example", "https://evilchaoxing.com",
    "https://user:password@mooc1.chaoxing.com", "https://mooc1.chaoxing.com:444", "<all_urls>",
    "https://*.chaoxing.com", "chrome://extensions", ""
  ])("does not request unauthorized origin %s", async (site) => {
    expect(sitePermissionOrigin(site)).toBeNull();
    expect(await requestSitePermission(site)).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it("offers authorization only for a classified host access failure", () => {
    expect(isHostPermissionFailure({ ok: false, code: "FRAME_ACCESS_DENIED", detail: "permission: injection denied" })).toBe(true);
    expect(isHostPermissionFailure({ ok: false, code: "FRAME_ACCESS_DENIED", detail: "Frame removed" })).toBe(false);
    expect(isHostPermissionFailure({ ok: false, code: "PAGE_KIND_UNSUPPORTED", detail: "permission: denied" })).toBe(false);
  });

  it("reports an already granted exact origin so the request UI stays hidden", async () => {
    contains.mockResolvedValue(true);
    expect(await isSitePermissionGranted("https://mooc1.chaoxing.com/course?id=private")).toBe(true);
    expect(contains).toHaveBeenCalledWith({ origins: ["https://mooc1.chaoxing.com/*"] });
    expect(request).not.toHaveBeenCalled();
  });

  it("never probes an unapproved origin and fails closed", async () => {
    expect(await isSitePermissionGranted("https://evilchaoxing.com")).toBe(false);
    expect(contains).not.toHaveBeenCalled();
    contains.mockRejectedValue(new Error("permissions API unavailable"));
    expect(await isSitePermissionGranted("https://mooc1.chaoxing.com")).toBe(false);
  });
});

describe("course-runner page routing", () => {
  it("routes course task pages and the standalone 作业/测验页 to the scheduler", () => {
    // 2026-10-20 用户授权（验收 §9.27）：独立作业/测验作答页也进入课程调度器刷题。
    expect(isCourseTaskUrl("https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=1")).toBe(true);
    expect(isCourseTaskUrl("https://mooc1.chaoxing.com/mooc-ans/mooc2/work/dowork?courseId=1&workId=2")).toBe(true);
    expect(isCourseTaskUrl("https://mooc1.chaoxing.com/ananas/modules/pdf/index.html")).toBe(false);
    expect(isCourseTaskUrl("https://example.com/mooc-ans/mooc2/work/dowork")).toBe(false);
    expect(isCourseTaskUrl("https://mooc1.chaoxing.com/mooc-ans/exam/test/reVersionTestStartNew")).toBe(false);
  });
});
