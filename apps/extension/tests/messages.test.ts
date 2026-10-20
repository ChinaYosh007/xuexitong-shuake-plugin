import { describe, expect, it } from "vitest";
import {
  isTrustedExtensionPageUrl,
  parseExtensionCommandRequest,
  parsePageCommand,
  parseReviewedAnswer
} from "../src/shared/messages";
import { reviewedAnswer } from "./helpers/fixtures";

describe("page command validation", () => {
  it("accepts exactly the four allowed command types", () => {
    expect(parsePageCommand({ type: "CAPTURE_QUESTION", requestId: "req_1" }).ok).toBe(true);
    expect(parsePageCommand({ type: "CAPTURE_SELECTION", requestId: "req_1" }).ok).toBe(true);
    expect(
      parsePageCommand({
        type: "REVALIDATE_FILL",
        requestId: "req_1",
        planId: "plan_12345678",
        reviewedAnswer: reviewedAnswer({ selectedOptionIds: ["opt_1"] })
      }).ok
    ).toBe(true);
    expect(
      parsePageCommand({
        type: "APPLY_FILL",
        requestId: "req_1",
        planId: "plan_12345678",
        confirmationNonce: "abcdef0123456789abcdef"
      }).ok
    ).toBe(true);
  });

  it("rejects generic fetch/execute/call message types", () => {
    for (const type of ["FETCH_URL", "EXECUTE_SCRIPT", "CALL_API", "EVAL", "NAVIGATE"]) {
      const result = parsePageCommand({ type, requestId: "req_1" });
      expect(result.ok).toBe(false);
    }
  });

  it("rejects oversized or malformed payloads", () => {
    expect(parsePageCommand({ type: "CAPTURE_QUESTION", requestId: "../etc" }).ok).toBe(false);
    expect(
      parsePageCommand({
        type: "APPLY_FILL",
        requestId: "req_1",
        planId: "plan_12345678",
        confirmationNonce: "short"
      }).ok
    ).toBe(false);
    const huge = "x".repeat(30 * 1024);
    expect(
      parsePageCommand({
        type: "REVALIDATE_FILL",
        requestId: "req_1",
        planId: "plan_12345678",
        reviewedAnswer: reviewedAnswer({ explanation: huge })
      }).ok
    ).toBe(false);
  });

  it("validates the bridge envelope and tab ids", () => {
    const valid = {
      type: "PAGE_COMMAND",
      tabId: 12,
      frameId: 0,
      command: { type: "CAPTURE_QUESTION", requestId: "req_1" }
    };
    expect(parseExtensionCommandRequest(valid).ok).toBe(true);
    expect(parseExtensionCommandRequest({ ...valid, tabId: 0 }).ok).toBe(false);
    expect(parseExtensionCommandRequest({ ...valid, type: "FETCH" }).ok).toBe(false);
    expect(parseExtensionCommandRequest({ ...valid, command: { type: "FETCH_URL", requestId: "req_1" } }).ok).toBe(false);
  });
});

describe("reviewed answer validation", () => {
  it("rejects invalid option ids and duplicate blanks", () => {
    expect(parseReviewedAnswer(reviewedAnswer({ selectedOptionIds: ["bad id!"] })).ok).toBe(false);
    expect(
      parseReviewedAnswer(
        reviewedAnswer({
          blankAnswers: [
            { blankId: "blank_1", answer: "a" },
            { blankId: "blank_1", answer: "b" }
          ]
        })
      ).ok
    ).toBe(false);
  });
});

describe("trusted extension page urls", () => {
  const extensionId = "abcdefghijklmnopabcdefghijklmnop";

  it("accepts sidepanel and options pages of this extension only", () => {
    expect(isTrustedExtensionPageUrl(`chrome-extension://${extensionId}/sidepanel.html`, extensionId)).toBe(true);
    expect(isTrustedExtensionPageUrl(`chrome-extension://${extensionId}/options.html?x=1`, extensionId)).toBe(true);
    expect(isTrustedExtensionPageUrl(`chrome-extension://${extensionId}/evil.html`, extensionId)).toBe(false);
    expect(isTrustedExtensionPageUrl("https://example.com/sidepanel.html", extensionId)).toBe(false);
    expect(isTrustedExtensionPageUrl(undefined, extensionId)).toBe(false);
    expect(isTrustedExtensionPageUrl(`chrome-extension://${"x".repeat(32)}/sidepanel.html`, extensionId)).toBe(false);
  });
});
