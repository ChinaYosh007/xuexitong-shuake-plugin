import { describe, expect, it } from "vitest";
import { parseAutomationCommand } from "../src/automation/protocol";

describe("fixed automation command protocol", () => {
  const base = { requestId: "request_1", runId: "run_1", courseKey: "course", taskKey: "task" };
  it("only allows whole-question image mode on capture", () => {
    expect(parseAutomationCommand({ ...base, action: "CAPTURE", index: 0, imagePass: "whole" })).toMatchObject({ imagePass: "whole" });
    expect(parseAutomationCommand({ ...base, action: "PLAY", imagePass: "whole" })!.imagePass).toBeUndefined();
  });
  it("accepts only named actions and bound mutation commands", () => {
    expect(parseAutomationCommand({ ...base, action: "INSPECT" })).not.toBeNull();
    expect(parseAutomationCommand({ ...base, action: "READ_ALL" })).not.toBeNull();
    expect(parseAutomationCommand({ ...base, action: "READ_ONE", index: 0 })).not.toBeNull();
    expect(parseAutomationCommand({ ...base, action: "READ_ONE" })).toBeNull();
    expect(parseAutomationCommand({ ...base, action: "READ_ONE", index: 200 })).toBeNull();
    expect(parseAutomationCommand({ action: "READ_ONE", index: 0, requestId: "r", runId: "run" })).toBeNull();
    expect(parseAutomationCommand({ ...base, action: "ADOPT_EXISTING", index: 0 })).not.toBeNull();
    expect(parseAutomationCommand({ ...base, action: "ADOPT_EXISTING", index: -1 })).toBeNull();
    expect(parseAutomationCommand({ ...base, action: "SEND_WORK" })).not.toBeNull();
    expect(parseAutomationCommand({ requestId: "r", runId: "run", action: "NEXT" })).toBeNull();
    expect(parseAutomationCommand({ ...base, action: "EXECUTE_SCRIPT", code: "arbitrary" })).toBeNull();
    expect(parseAutomationCommand({ ...base, action: "CAPTURE", index: -1 })).toBeNull();
    expect(parseAutomationCommand({ ...base, action: "APPLY", index: 0, answer: { status: "ANSWERED" } })).toBeNull();
  });

  it("accepts ENUM_POPUP only as a bound course command", () => {
    // 弹题枚举是绑定课程/任务的页面动作：与 PLAY 一样必须携带 courseKey/taskKey。
    expect(parseAutomationCommand({ ...base, action: "ENUM_POPUP" })).not.toBeNull();
    expect(parseAutomationCommand({ requestId: "request_1", runId: "run_1", action: "ENUM_POPUP" })).toBeNull();
  });
  it("binds chapter notice resolution to the current task and accepts only a strict skip flag", () => {
    expect(parseAutomationCommand({ action: "CONFIRM_NEXT", requestId: "r", runId: "run" })).toBeNull();
    expect(parseAutomationCommand({ ...base, action: "CONFIRM_NEXT", allowSkipUnfinished: true })).toMatchObject({ allowSkipUnfinished: true });
    expect(parseAutomationCommand({ ...base, action: "CONFIRM_NEXT", allowSkipUnfinished: "true" })!.allowSkipUnfinished).toBeUndefined();
  });

  it("accepts imagePass=originals only on CAPTURE and drops every other shape", () => {
    // 原图直发是 CAPTURE 的严格子模式（2026-10-20 授权的自动二次处理通道）。
    const capture = parseAutomationCommand({ ...base, action: "CAPTURE", index: 0, imagePass: "originals" });
    expect(capture).not.toBeNull();
    expect(capture!.imagePass).toBe("originals");
    expect(parseAutomationCommand({ ...base, action: "CAPTURE", index: 0 })!.imagePass).toBeUndefined();
    // 其他动作携带该字段一律丢弃；CAPTURE 上的非法值也不会变成页面侧管线选择。
    const read = parseAutomationCommand({ ...base, action: "READ_ALL", imagePass: "originals" });
    expect(read).not.toBeNull();
    expect(read!.imagePass).toBeUndefined();
    for (const value of ["render", true, 1, null, {}, undefined]) {
      const parsed = parseAutomationCommand({ ...base, action: "CAPTURE", index: 0, imagePass: value });
      expect(parsed).not.toBeNull();
      expect(parsed!.imagePass).toBeUndefined();
    }
  });

  it("accepts allowSkipUnfinished only as a literal true on NEXT and drops it everywhere else", () => {
    const next = parseAutomationCommand({ ...base, action: "NEXT", allowSkipUnfinished: true });
    expect(next).not.toBeNull();
    expect(next!.allowSkipUnfinished).toBe(true);
    // 非 NEXT 动作即使携带 true 也不回填：只有页面侧 NEXT 守卫认识这个字段。
    const play = parseAutomationCommand({ ...base, action: "PLAY", allowSkipUnfinished: true });
    expect(play).not.toBeNull();
    expect(play!.allowSkipUnfinished).toBeUndefined();
    const inspect = parseAutomationCommand({ requestId: "request_1", runId: "run_1", action: "INSPECT", allowSkipUnfinished: true });
    expect(inspect).not.toBeNull();
    expect(inspect!.allowSkipUnfinished).toBeUndefined();
    // NEXT 上只有严格 true 生效；false、字符串与数字都不会变成跳过授权。
    for (const value of [false, "true", 1, null, undefined, {}]) {
      const parsed = parseAutomationCommand({ ...base, action: "NEXT", allowSkipUnfinished: value });
      expect(parsed).not.toBeNull();
      expect(parsed!.allowSkipUnfinished).toBeUndefined();
    }
    expect(parseAutomationCommand({ ...base, action: "NEXT" })!.allowSkipUnfinished).toBeUndefined();
  });
});
