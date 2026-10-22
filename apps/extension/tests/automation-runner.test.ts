import { afterEach, describe, expect, it, vi } from "vitest";
import { CourseRunner, createRunnerState } from "../src/automation/runner";
import type { RunnerPort } from "../src/automation/runner";
import type { AutomationCommand, TaskSnapshot } from "../src/automation/protocol";
import type { StudyAnswer } from "@study/contracts";
import { QuestionImageError } from "../src/automation/question-image-error";

const answer: StudyAnswer = { status: "ANSWERED", selectedOptionIds: ["opt_1"], blankAnswers: [], textAnswer: null, explanation: "", caveats: [] };
function setup(kind: TaskSnapshot["kind"] = "QUIZ") {
  const state = createRunnerState();
  const actions: string[] = [];
  // Full command objects: assertions about allowSkipUnfinished must inspect what the runner
  // really sent, not only which action it named.
  const commands: Array<Omit<AutomationCommand, "requestId" | "runId">> = [];
  let now = 0;
  const snapshot: TaskSnapshot = { courseKey: "course", taskKey: "one", kind, questionCount: kind === "QUIZ" ? 2 : 0,
    completed: false, hasNext: false,
    video: kind === "VIDEO" ? { paused: false, ended: false, currentTime: 0, duration: 10, error: false } : null };
  const port: RunnerPort = {
    async command(command) {
      commands.push(command);
      actions.push(command.action);
      if (command.action === "INSPECT") return { snapshot: { ...snapshot } };
      if (command.action === "READ_ALL") return { questions: Array.from({ length: snapshot.questionCount }, (_, index) => ({ index, fingerprint: "fingerprint", needsImage: false,
        question: { id: `q_${index + 1}`, type: "SINGLE_CHOICE" as const, stem: "test", options: [{ id: "opt_1", text: "A" }], blanks: [] } })) };
      if (command.action === "ADOPT_EXISTING") return { existingAccepted: true, captured: { index: command.index!, fingerprint: "fingerprint",
        question: { id: `q_${command.index! + 1}`, type: "SINGLE_CHOICE", stem: "test", options: [{ id: "opt_1", text: "A" }], blanks: [] } } };
      if (command.action === "CAPTURE") return { captured: { index: command.index!, fingerprint: "fingerprint", question: { id: "q_1", type: "SINGLE_CHOICE", stem: "test", options: [{ id: "opt_1", text: "A" }], blanks: [] } } };
      if (command.action === "CONFIRM_WORK") snapshot.completed = true;
      if (command.action === "PLAY") { snapshot.completed = true; snapshot.video = { ...snapshot.video!, ended: true }; }
      return {};
    },
    async answer() { actions.push("MODEL"); return answer; },
    async sleep(ms) { now += ms; }, now: () => now
  };
  return { state, actions, commands, port, snapshot, runner: new CourseRunner(state, port) };
}
afterEach(() => vi.useRealTimers());

describe("pinned course task runner", () => {
  it("opens a discussion child, fills and publishes once, and counts the reply separately", async () => {
    const t = setup("DISCUSSION");
    const base = t.port.command;
    t.port.command = async command => {
      if (command.action === "OPEN_DISCUSSION") Object.assign(t.snapshot, { taskKey: "discussion", kind: "QUIZ", questionCount: 1, standalone: true, discussionReply: true });
      const result = await base(command);
      if (command.action === "ADOPT_EXISTING") result.existingAccepted = false;
      return result;
    };
    await t.runner.start();
    expect(t.actions).toContain("OPEN_DISCUSSION"); expect(t.actions).toContain("APPLY");
    expect(t.actions.filter(action => action === "SEND_WORK")).toHaveLength(1); expect(t.actions).not.toContain("NEXT");
    expect(t.state).toMatchObject({ phase: "DONE", completedTasks: 0, publishedDiscussions: 1, filled: 1 });
    expect(t.state.step).toContain("已发表");
    await t.runner.submitNow(); await t.runner.recheckSubmission(); await t.runner.onForeground();
    expect(t.actions.filter(action => action === "SEND_WORK")).toHaveLength(1);
  });
  it("preserves an existing discussion draft without charging for another answer", async () => {
    const t = setup("QUIZ"); Object.assign(t.snapshot, { questionCount: 1, standalone: true, discussionReply: true });
    await t.runner.start();
    expect(t.state).toMatchObject({ phase: "DONE", retained: 1, completedTasks: 0, publishedDiscussions: 1 });
    expect(t.actions).not.toContain("MODEL"); expect(t.actions).not.toContain("APPLY"); expect(t.actions).toContain("SEND_WORK");
  });
  it("rechecks delayed discussion publication without resending or counting a course task", async () => {
    const t = setup(); Object.assign(t.snapshot, { questionCount: 1, standalone: true, discussionReply: true });
    const base = t.port.command; let confirmed = false;
    t.port.command = async command => {
      const result = await base(command);
      if (command.action === "CONFIRM_WORK") t.snapshot.completed = confirmed;
      return result;
    };
    await t.runner.start(); expect(t.state.phase).toBe("ERROR");
    confirmed = true; await t.runner.recheckSubmission();
    expect(t.state).toMatchObject({ phase: "DONE", completedTasks: 0, publishedDiscussions: 1 });
    expect(t.actions.filter(action => action === "SEND_WORK")).toHaveLength(1);
    await t.runner.recheckSubmission(); expect(t.state.publishedDiscussions).toBe(1);
  });
  it("publishes an existing discussion reply in videos-only mode without calling the model", async () => {
    const t = setup("DISCUSSION"); t.snapshot.hasNext = true;
    const base = t.port.command;
    t.port.command = async command => {
      if (command.action === "OPEN_DISCUSSION") Object.assign(t.snapshot, { taskKey: "discussion", kind: "QUIZ", questionCount: 1, standalone: true, discussionReply: true });
      return base(command);
    };
    await t.runner.start({ videosOnly: true });
    expect(t.state).toMatchObject({ phase: "DONE", skippedQuizzes: 0, completedTasks: 0, publishedDiscussions: 1 });
    expect(t.actions).toContain("OPEN_DISCUSSION"); expect(t.actions).not.toContain("MODEL"); expect(t.actions).toContain("SEND_WORK");
  });
  it("returns to the same course after publication and advances without inventing a completed task point", async () => {
    const t = setup("DISCUSSION"); t.snapshot.hasNext = true;
    const base = t.port.command;
    t.port.command = async command => {
      if (command.action === "OPEN_DISCUSSION") Object.assign(t.snapshot, { taskKey: "discussion", kind: "QUIZ", questionCount: 1, standalone: true, discussionReply: true });
      if (command.action === "NEXT") Object.assign(t.snapshot, { taskKey: "last", kind: "COMPLETED", completed: true, hasNext: false });
      return base(command);
    };
    t.port.returnToCourse = async () => { Object.assign(t.snapshot, { taskKey: "one", kind: "DISCUSSION", questionCount: 0, standalone: false, discussionReply: false, completed: false }); };
    await t.runner.start();
    expect(t.state).toMatchObject({ phase: "DONE", completedTasks: 1, publishedDiscussions: 1 });
    expect(t.commands.find(command => command.action === "NEXT")).toMatchObject({ taskKey: "one", allowSkipUnfinished: true });
    expect(t.actions.filter(action => action === "SEND_WORK")).toHaveLength(1);
  });
  it.each([{}, { skipVideos: true }, { videosOnly: true }])("automatically submits and confirms complete quiz answers in mode %j", async options => {
    const t = setup(); await t.runner.start(options);
    expect(t.state).toMatchObject({ phase: "DONE", completedTasks: 1 });
    expect(t.actions.filter(action => action === "SEND_WORK")).toHaveLength(1);
    expect(t.actions).toContain("CONFIRM_WORK");
    if (options.videosOnly) expect(t.actions).not.toContain("MODEL");
  });
  it("survives transient inspection failures after Next without replaying navigation", async () => {
    const t = setup("MATERIAL"); t.snapshot.hasNext = true; let misses = 0; let navigating = false;
    const base = t.port.command;
    t.port.command = async command => {
      if (command.action === "NEXT") navigating = true;
      if (command.action === "INSPECT" && navigating) {
        if (++misses <= 3) throw new Error("Frame navigating");
        Object.assign(t.snapshot, { taskKey: "last", kind: "COMPLETED", completed: true, hasNext: false });
      }
      return base(command);
    };
    await t.runner.start();
    expect(t.state.phase).toBe("DONE"); expect(t.actions.filter(action => action === "NEXT")).toHaveLength(1);
  });
  it("videos-only mode traverses an opened resource with authorization and never counts it as completed", async () => {
    const t = setup("RESOURCE"); t.snapshot.hasNext = true;
    const base = t.port.command;
    t.port.command = async command => {
      if (command.action === "NEXT") Object.assign(t.snapshot, { taskKey: "last", kind: "COMPLETED", completed: true, hasNext: false });
      return base(command);
    };
    await t.runner.start({ videosOnly: true });
    expect(t.state.phase).toBe("DONE");
    expect(t.state.skippedResources).toBe(1); expect(t.state.completedTasks).toBe(1);
    expect(t.commands.find(command => command.action === "NEXT")).toMatchObject({ allowSkipUnfinished: true });
    expect(t.actions).not.toContain("MODEL"); expect(t.actions).not.toContain("SEND_WORK");
  });
  it("course mode waits for a resource acknowledgement and never skips an unfinished marked document", async () => {
    const t = setup("RESOURCE"); t.snapshot.hasNext = true;
    await t.runner.start();
    expect(t.state.phase).toBe("ERROR"); expect(t.state.error).toContain("尚未确认资料任务完成");
    expect(t.state.completedTasks).toBe(0); expect(t.actions).not.toContain("NEXT");
  });
  it("records one manual entry without blocking on other unanswered questions, then resumes after the last", async () => {
    const t = setup();
    t.port.answer = async () => ({ ...answer, status: "REFUSED" });
    const running = t.runner.start();
    await vi.waitFor(() => expect(t.state.phase).toBe("NEEDS_INPUT"));
    await t.runner.submitManual([{ index: 0, answer }]);
    expect(t.state.manualItems.map(item => item.resolved)).toEqual([true, false]);
    expect(t.state.step).toContain("剩余 1 题");
    expect(t.actions).not.toContain("SEND_WORK");
    await t.runner.submitManual([{ index: 1, answer }]); await running;
    expect(t.state.phase).toBe("DONE"); expect(t.actions.filter(action => action === "SEND_WORK")).toHaveLength(1);
  });
  it("uses the image button's latest answer even with uncertainty, replacing earlier candidates", async () => {
    const t = setup(); t.snapshot.questionCount = 1;
    const base = t.port.command; const writes: string[][] = [];
    t.port.command = async command => {
      const result = await base(command);
      if (command.action === "CAPTURE" && command.imagePass === "whole") result.captured = {
        index: 0, fingerprint: "fingerprint", question: { id: "q_1", type: "SINGLE_CHOICE", stem: "whole question", blanks: [],
          options: [{ id: "opt_1", text: "A" }, { id: "opt_2", text: "B" }], imageDataUrl: "data:image/jpeg;base64,whole" }
      };
      if (command.action === "APPLY") writes.push(command.answer!.selectedOptionIds);
      return result;
    };
    let calls = 0;
    t.port.answer = async captured => ++calls <= 2 ? { ...answer, status: "REFUSED" } :
      (expect(captured.imageRequired).toBe(true), { ...answer, selectedOptionIds: ["opt_2"], caveats: ["不确定"] });
    const running = t.runner.start(); await vi.waitFor(() => expect(t.state.phase).toBe("NEEDS_INPUT"));
    await t.runner.retryWithImage(0); await running;
    expect(calls).toBe(3); expect(writes).toEqual([["opt_2"]]); expect(t.state.phase).toBe("DONE");
    expect(t.state.manualItems[0]!.samples).toHaveLength(3);
  });
  it("never silently sends text when the explicit image capture fails", async () => {
    const t = setup(); t.snapshot.questionCount = 1;
    t.port.answer = async () => ({ ...answer, status: "REFUSED" });
    const running = t.runner.start(); await vi.waitFor(() => expect(t.state.phase).toBe("NEEDS_INPUT"));
    await expect(t.runner.retryWithImage(0)).rejects.toThrow("未取得完整题干");
    expect(t.state.modelRequests).toBe(1); expect(t.actions).not.toContain("APPLY"); expect(t.state.manualSaving).toBe(false);
    expect(t.state.manualItems[0]!.reason).toContain("图片发送/回填失败");
    t.runner.stop(); await running;
  });
  it("reports missing page answers instead of making the verify button appear unresponsive", async () => {
    const t = setup(); t.snapshot.questionCount = 1; const base = t.port.command;
    t.port.answer = async () => ({ ...answer, status: "REFUSED" });
    t.port.command = async command => command.action === "ADOPT_EXISTING" ? { ...(await base(command)), existingAccepted: false } : base(command);
    const running = t.runner.start(); await vi.waitFor(() => expect(t.state.phase).toBe("NEEDS_INPUT"));
    await expect(t.runner.acceptManualFromPage()).rejects.toThrow("第 1 题");
    expect(t.actions).not.toContain("SEND_WORK"); expect(t.state.manualSaving).toBe(false);
    t.runner.stop(); await running;
  });
  it("does not fill if stopped during an explicit image request", async () => {
    const t = setup(); t.snapshot.questionCount = 1; const base = t.port.command;
    t.port.command = async command => {
      const result = await base(command);
      if (command.action === "CAPTURE" && command.imagePass === "whole" && result.captured) result.captured.question.imageDataUrl = "data:image/jpeg;base64,whole";
      return result;
    };
    t.port.answer = async () => ({ ...answer, status: "REFUSED" });
    const running = t.runner.start(); await vi.waitFor(() => expect(t.state.phase).toBe("NEEDS_INPUT"));
    let resolve!: (answer: StudyAnswer) => void;
    t.port.answer = () => new Promise(done => { resolve = done; });
    const retry = t.runner.retryWithImage(0);
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    t.runner.stop(); resolve(answer); await retry; await running;
    expect(t.actions).not.toContain("APPLY"); expect(t.state.manualSaving).toBe(false);
  });
  it("allows an image retry after a monitor ERROR and auto-recovers after its successful fill", async () => {
    vi.useFakeTimers(); const t = setup(); t.snapshot.questionCount = 1; const base = t.port.command;
    t.port.command = async command => {
      const result = await base(command);
      if (command.action === "CAPTURE" && command.imagePass === "whole" && result.captured) result.captured.question.imageDataUrl = "data:image/jpeg;base64,whole";
      return result;
    };
    t.port.answer = async () => ({ ...answer, status: "REFUSED" });
    const running = t.runner.start();
    for (let i = 0; i < 20 && t.state.phase !== "NEEDS_INPUT"; i++) await vi.advanceTimersByTimeAsync(50);
    expect(t.state.phase).toBe("NEEDS_INPUT"); t.snapshot.taskKey = "changed";
    await vi.advanceTimersByTimeAsync(2900); expect(t.state.phase).toBe("ERROR"); await running;
    t.snapshot.taskKey = "one"; t.port.answer = async () => answer;
    await t.runner.retryWithImage(0);
    expect(t.state.phase).toBe("DONE"); expect(t.actions.filter(action => action === "SEND_WORK")).toHaveLength(1);
  });
  it("fills every question before one submission, confirms completion and then stops at the last task", async () => {
    const t = setup();
    await t.runner.start();
    expect(t.actions.filter(a => a === "APPLY")).toHaveLength(2);
    expect(t.actions.filter(a => a === "SEND_WORK")).toHaveLength(1);
    expect(t.actions.indexOf("SEND_WORK")).toBeGreaterThan(t.actions.lastIndexOf("APPLY"));
    expect(t.actions).toContain("CONFIRM_WORK");
    expect(t.state.phase).toBe("DONE");
    expect(t.state.completedTasks).toBe(1);
  });

  it("dwells about 2s after a confirmed chapter-quiz submit before advancing to the next task", async () => {
    const t = setup();
    t.snapshot.hasNext = true;
    let nowAtSend = -1; let nowAtNext = -1;
    const base = t.port.command;
    t.port.command = async command => {
      if (command.action === "SEND_WORK") nowAtSend = t.port.now();
      if (command.action === "NEXT") {
        nowAtNext = t.port.now();
        Object.assign(t.snapshot, { taskKey: "last", kind: "COMPLETED", completed: true, hasNext: false });
      }
      return base(command);
    };
    await t.runner.start();
    expect(t.actions.filter(a => a === "SEND_WORK")).toHaveLength(1);
    expect(t.actions).toContain("NEXT");
    expect(nowAtNext - nowAtSend).toBeGreaterThanOrEqual(2000);
  });

  it("accepts consistent answers that carry caveats instead of forcing manual input", async () => {
    const t = setup();
    t.port.answer = async () => ({ ...answer, caveats: ["题目表述不够严谨"] });
    await t.runner.start();
    expect(t.state.phase).toBe("DONE");
    expect(t.actions.filter(action => action === "APPLY")).toHaveLength(2);
    expect(t.actions.filter(action => action === "SEND_WORK")).toHaveLength(1);
    expect(t.state.manualItems).toHaveLength(0);
  });

  it("turns a failed page write into a manual item instead of aborting the task", async () => {
    const t = setup();
    const base = t.port.command;
    t.port.command = async command => {
      if (command.action === "APPLY" && command.index === 0) throw new Error("第 1 题页面没有保留回填结果（回读不一致）。");
      return base(command);
    };
    const running = t.runner.start();
    await vi.waitFor(() => expect(t.state.phase).toBe("NEEDS_INPUT"));
    expect(t.state.error).toBe("");
    expect(t.state.manualItems.map(item => item.index)).toContain(0);
    expect(t.state.manualItems[0]!.reason).toContain("回填未通过页面校验");
    t.runner.stop(); await running;
  });

  it("stops after a pending model request resolves without writing or submitting", async () => {
    const t = setup();
    t.port.answer = async () => { t.runner.stop(); return answer; };
    await t.runner.start();
    expect(t.actions).not.toContain("APPLY");
    expect(t.actions).not.toContain("SEND_WORK");
    expect(t.state.phase).toBe("STOPPED");
  });

  it("pauses between the model response and filling until explicitly resumed", async () => {
    const t = setup();
    let first = true;
    t.port.answer = async () => {
      if (first) { first = false; t.runner.pause(); queueMicrotask(() => t.runner.resume()); }
      return answer;
    };
    await t.runner.start();
    expect(t.state.phase).toBe("DONE");
    expect(t.actions).toContain("PAUSE_VIDEO");
  });

  it("never advances or repeats a submission whose success was not confirmed", async () => {
    const t = setup();
    const base = t.port.command;
    t.port.command = async command => command.action === "CONFIRM_WORK" ? {} : base(command);
    await t.runner.start();
    expect(t.state.phase).toBe("ERROR");
    expect(t.actions.filter(a => a === "SEND_WORK")).toHaveLength(1);
    expect(t.actions).not.toContain("NEXT");
  });

  it("does not treat a video's ended event as site completion", async () => {
    const t = setup("VIDEO");
    const base = t.port.command;
    t.port.command = async command => {
      if (command.action === "PLAY") { t.snapshot.video!.ended = true; return {}; }
      return base(command);
    };
    await t.runner.start();
    expect(t.state.phase).toBe("ERROR");
    expect(t.actions).not.toContain("NEXT");
  });

  it("plays a video and only advances once the site marks it complete", async () => {
    const t = setup("VIDEO");
    await t.runner.start();
    expect(t.actions).toContain("PLAY");
    expect(t.actions).not.toContain("MODEL");
    expect(t.state.phase).toBe("DONE");
  });

  it("seeks a site-permitted video to its tail and advances only on the site's own completion marker", async () => {
    const t = setup("VIDEO");
    let seeks = 0;
    t.port.command = async command => {
      t.actions.push(command.action); t.commands.push(command);
      if (command.action === "SEEK_TAIL") { seeks++; t.snapshot.video = { ...t.snapshot.video!, currentTime: 58 };
        return { seek: { seekable: true, applied: true, currentTime: 58, duration: 60, reason: "ok" } }; }
      if (command.action === "PLAY") return {};
      if (command.action === "INSPECT") {
        if (seeks > 0 && (t.snapshot.video?.currentTime ?? 0) >= 58) t.snapshot.completed = true;
        return { snapshot: { ...t.snapshot } };
      }
      return {};
    };
    await t.runner.start({ allowVideoSeek: true, videoSeekPolicy: "allowed" });
    expect(seeks).toBe(1);
    expect(t.actions).toContain("SEEK_TAIL");
    expect(t.actions).not.toContain("PLAY_FROM_START");
    expect(t.actions).not.toContain("MODEL");
    expect(t.state.videoSeekPolicy).toBe("allowed");
    expect(t.state.phase).toBe("DONE");
    expect(t.state.completedTasks).toBe(1);
  });

  it("rolls back to full playback when the site rejects the seek by rewinding progress", async () => {
    const t = setup("VIDEO");
    let seeks = 0; let rewound = false;
    t.port.command = async command => {
      t.actions.push(command.action); t.commands.push(command);
      if (command.action === "SEEK_TAIL") { seeks++; return { seek: { seekable: true, applied: true, currentTime: 58, duration: 60, reason: "ok" } }; }
      if (command.action === "PLAY") {
        if (!rewound) { rewound = true; t.snapshot.video = { ...t.snapshot.video!, currentTime: 0 }; }
        else { t.snapshot.completed = true; t.snapshot.video = { ...t.snapshot.video!, ended: true, currentTime: 10 }; }
        return {};
      }
      if (command.action === "PLAY_FROM_START") { t.snapshot.video = { ...t.snapshot.video!, currentTime: 0 }; return {}; }
      if (command.action === "INSPECT") return { snapshot: { ...t.snapshot } };
      return {};
    };
    await t.runner.start({ allowVideoSeek: true, videoSeekPolicy: "allowed" });
    expect(seeks).toBe(1);
    expect(t.actions).toContain("PLAY_FROM_START");
    expect(t.state.videoSeekPolicy).toBe("denied");
    expect(t.state.phase).toBe("DONE");
    expect(t.state.completedTasks).toBe(1);
  });

  it("scrolls an unfinished PPT/PDF material to its bottom once so the site can confirm completion", async () => {
    const t = setup("RESOURCE");
    let scrolls = 0;
    t.port.command = async command => {
      t.actions.push(command.action); t.commands.push(command);
      if (command.action === "SCROLL_MATERIAL") { scrolls++; return { scroll: { containerFound: true, scrolled: true, reachedBottom: true, steps: 5 } }; }
      if (command.action === "INSPECT") { if (scrolls > 0) t.snapshot.completed = true; return { snapshot: { ...t.snapshot } }; }
      return {};
    };
    await t.runner.start({ allowMaterialScroll: true });
    expect(scrolls).toBe(1);
    expect(t.actions).not.toContain("MODEL");
    expect(t.state.phase).toBe("DONE");
    expect(t.state.completedTasks).toBe(1);
  });

  it("stops for an unknown task instead of silently skipping it", async () => {
    const t = setup("UNKNOWN");
    await t.runner.start();
    expect(t.state.phase).toBe("ERROR");
    expect(t.actions).not.toContain("NEXT");
  });

  it("waits for a lazily loaded task page to settle before judging it unknown, so a slow video still auto-plays", async () => {
    const t = setup("UNKNOWN");
    const base = t.port.command;
    let inspects = 0;
    // 真实课程页的视频 iframe 是异步懒加载的：刚打开时 INSPECT 读到 UNKNOWN，几次之后
    // 播放器才出现。启动路径必须像点击 Next 之后一样有界等待，而不是立刻报「尚未适配」。
    t.snapshot.video = { paused: false, ended: false, currentTime: 0, duration: 10, error: false };
    t.port.command = async command => {
      if (command.action === "INSPECT" && ++inspects >= 3) t.snapshot.kind = "VIDEO";
      return base(command);
    };
    await t.runner.start();
    expect(inspects).toBeGreaterThanOrEqual(3);
    expect(t.actions).toContain("PLAY");
    expect(t.state.phase).toBe("DONE");
    expect(t.state.error).toBe("");
  });

  it("detects course changes and does not operate another course", async () => {
    const t = setup("VIDEO");
    const base = t.port.command;
    t.port.command = async command => {
      const response = await base(command);
      if (command.action === "PLAY") t.snapshot.courseKey = "different";
      return response;
    };
    await t.runner.start();
    expect(t.state.phase).toBe("ERROR");
    expect(t.actions).not.toContain("NEXT");
  });

  it("acquires ahead, runs two requests concurrently and fills FIFO despite reversed response order", async () => {
    const t = setup(); t.snapshot.questionCount = 3;
    const base = t.port.command;
    const applied: number[] = [];
    const resolvers = new Map<number, (answer: StudyAnswer) => void>();
    let active = 0, maximum = 0;
    t.port.command = async command => {
      if (command.action === "APPLY") applied.push(command.index!);
      return base(command);
    };
    t.port.answer = captured => new Promise(resolve => {
      active++; maximum = Math.max(maximum, active);
      resolvers.set(captured.index, result => { active--; resolve(result); });
    });
    const running = t.runner.start();
    await vi.waitFor(() => expect(resolvers.size).toBe(2));
    expect(t.state.captured).toBe(3);
    resolvers.get(1)!(answer);
    await vi.waitFor(() => expect(resolvers.size).toBe(3));
    resolvers.get(2)!(answer);
    await Promise.resolve(); expect(applied).toEqual([]);
    resolvers.get(0)!(answer);
    await running;
    expect(maximum).toBe(2); expect(applied).toEqual([0, 1, 2]);
    expect(t.state.phase).toBe("DONE");
  });

  it("takes one sample for certain answers and an image second pass for missing context", async () => {
    const t = setup(); const calls = [0, 0];
    const base = t.port.command;
    t.port.command = async command => {
      const result = await base(command);
      if (command.action === "CAPTURE" && command.imagePass === "whole" && result.captured) result.captured.question.imageDataUrl = "data:image/jpeg;base64,whole";
      return result;
    };
    t.port.answer = async captured => ++calls[captured.index]! === 1 && captured.index === 1 ? { ...answer, status: "NEEDS_CONTEXT", caveats: ["uncertain"] } : answer;
    await t.runner.start();
    expect(calls).toEqual([1, 2]); expect(t.state.agreement).toBe("1/1");
    expect(t.actions.filter(action => action === "APPLY")).toHaveLength(2);
    expect(t.state.phase).toBe("DONE");
  });

  it("paces parallel request starts using a rolling minute budget without delaying FIFO writes", async () => {
    const t = setup(); t.snapshot.questionCount = 9;
    const times: number[] = [];
    t.port.answer = async () => { times.push(t.port.now()); return answer; };
    await t.runner.start({ requestsPerMinute: 4 });
    expect(times).toHaveLength(9);
    for (const time of times) expect(times.filter(start => start <= time && start > time - 60000).length).toBeLessThanOrEqual(4);
    expect(t.state.phase).toBe("DONE");
  });

  it("the current-task button submits once and does not advance even when a next task exists", async () => {
    const t = setup(); t.snapshot.hasNext = true;
    await t.runner.start({ continueTasks: false });
    expect(t.state.phase).toBe("DONE"); expect(t.state.step).toContain("当前章节");
    expect(t.actions).not.toContain("NEXT");
    expect(t.actions.filter(action => action === "SEND_WORK")).toHaveLength(1);
  });

  it("the periodic monitor cancels queued writes when the task changes during a pending response", async () => {
    vi.useFakeTimers();
    const t = setup(); t.snapshot.questionCount = 1;
    let resolve!: (value: StudyAnswer) => void;
    t.port.answer = () => new Promise(done => { resolve = done; });
    const running = t.runner.start();
    await vi.advanceTimersByTimeAsync(0);
    t.snapshot.taskKey = "changed"; t.snapshot.kind = "VIDEO"; t.snapshot.questionCount = 0;
    // 首次发现差异只触发 400ms 复核，不立即置错。
    await vi.advanceTimersByTimeAsync(2500);
    expect(t.state.phase).toBe("RUNNING");
    await vi.advanceTimersByTimeAsync(400);
    expect(t.state.phase).toBe("ERROR");
    expect(t.state.error).toBe("监听发现课程任务已变化（任务标识已变化、页面类型由 QUIZ 变为 VIDEO、题数由 1 变为 0），已取消未回填队列。");
    resolve(answer); await running;
    expect(t.actions).not.toContain("APPLY"); expect(t.actions).not.toContain("SEND_WORK");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("tolerates a single transient task-change sample instead of aborting the run", async () => {
    vi.useFakeTimers();
    const t = setup(); t.snapshot.questionCount = 1;
    let resolve!: (value: StudyAnswer) => void;
    t.port.answer = () => new Promise(done => { resolve = done; });
    const running = t.runner.start();
    await vi.advanceTimersByTimeAsync(0);
    t.snapshot.taskKey = "changed";
    await vi.advanceTimersByTimeAsync(2500);
    expect(t.state.phase).toBe("RUNNING");
    // 复核时页面又回到原任务：视为瞬时抖动，继续答题。
    t.snapshot.taskKey = "one";
    await vi.advanceTimersByTimeAsync(400);
    expect(t.state.phase).toBe("RUNNING");
    expect(t.state.error).toBe("");
    resolve(answer); await running;
    expect(t.state.phase).toBe("DONE");
    expect(t.state.error).toBe("");
    expect(t.actions.filter(action => action === "APPLY")).toHaveLength(1);
    expect(t.actions.filter(action => action === "SEND_WORK")).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("exits safely when the runner stops during the monitor recheck wait", async () => {
    vi.useFakeTimers();
    const t = setup(); t.snapshot.questionCount = 1;
    let resolve!: (value: StudyAnswer) => void;
    t.port.answer = () => new Promise(done => { resolve = done; });
    const running = t.runner.start();
    await vi.advanceTimersByTimeAsync(0);
    t.snapshot.taskKey = "changed";
    await vi.advanceTimersByTimeAsync(2500);
    expect(t.state.phase).toBe("RUNNING");
    t.runner.stop();
    await vi.advanceTimersByTimeAsync(400);
    expect(t.state.phase).toBe("STOPPED");
    expect(t.state.error).toBe("");
    resolve(answer); await running;
    expect(t.state.phase).toBe("STOPPED");
    expect(t.state.error).toBe("");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports an inspect failure during monitoring with the page-error prefix", async () => {
    vi.useFakeTimers();
    const t = setup(); t.snapshot.questionCount = 1;
    let resolve!: (value: StudyAnswer) => void;
    t.port.answer = () => new Promise(done => { resolve = done; });
    const base = t.port.command;
    const running = t.runner.start();
    await vi.advanceTimersByTimeAsync(0);
    t.port.command = async command => {
      if (command.action === "INSPECT") throw new Error("页面已关闭");
      return base(command);
    };
    await vi.advanceTimersByTimeAsync(2500);
    expect(t.state.phase).toBe("ERROR");
    expect(t.state.error).toBe("监听课程页失败：页面已关闭");
    resolve(answer); await running;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops a video with no playback progress instead of polling forever", async () => {
    const t = setup("VIDEO");
    const base = t.port.command;
    t.port.command = command => command.action === "PLAY" ? Promise.resolve({}) : base(command);
    await t.runner.start();
    expect(t.state.phase).toBe("ERROR"); expect(t.state.error).toContain("没有播放进展");
    expect(t.actions).not.toContain("NEXT");
  });
  it("recovers from a short network pause instead of stopping after three paused polls", async () => {
    const t = setup("VIDEO");
    const base = t.port.command;
    t.port.command = async command => {
      if (command.action === "PLAY") return {};
      if (command.action === "INSPECT") {
        const time = t.port.now();
        t.snapshot.video = { ...t.snapshot.video!, paused: time < 20000, error: time >= 5000 && time < 10000,
          currentTime: Math.max(0, time - 20000) / 1000 };
        t.snapshot.completed = time >= 30000;
      }
      return base(command);
    };
    await t.runner.start();
    expect(t.state.phase).toBe("DONE");
    expect(t.state.completedTasks).toBe(1);
    expect(t.actions).not.toContain("MODEL");
  });
  it("handles an already-open video question before attempting playback", async () => {
    const t = setup("VIDEO"); t.snapshot.video!.paused = true;
    const base = t.port.command;
    let resolved = false;
    const actions: string[] = [];
    t.port.command = async command => {
      actions.push(command.action);
      if (command.action === "ENUM_POPUP") {
        resolved = true;
        return { popup: { found: true, resolved: true, attempts: 2, options: 3 } };
      }
      if (command.action === "PLAY" && !resolved) throw new Error("弹题阻止播放");
      return base(command);
    };
    await t.runner.start();
    expect(t.state.phase).toBe("DONE");
    expect(actions.indexOf("ENUM_POPUP")).toBeLessThan(actions.indexOf("PLAY"));
    expect(t.actions).not.toContain("MODEL");
  });
  it.each([false, true])("stops a persistently paused video after the recovery window (media error: %s)", async error => {
    const t = setup("VIDEO");
    t.snapshot.hasNext = true;
    t.snapshot.video = { ...t.snapshot.video!, paused: true, error };
    const base = t.port.command;
    const playsAt: number[] = [];
    t.port.command = async command => {
      if (command.action === "PLAY") { playsAt.push(t.port.now()); return {}; }
      return base(command);
    };
    await t.runner.start();
    expect(t.state.phase).toBe("ERROR");
    expect(t.state.error).toContain("60 秒");
    expect(t.port.now()).toBeGreaterThanOrEqual(60000);
    expect(t.port.now()).toBeLessThan(70000);
    expect(playsAt.slice(1).every((time, index) => time - playsAt[index]! >= 5000)).toBe(true);
    expect(t.state.completedTasks).toBe(0);
    expect(t.actions).not.toContain("NEXT");
  });

  it("rejects task cycles instead of repeatedly completing the same chapter", async () => {
    const t = setup(); t.snapshot.completed = true; t.snapshot.hasNext = true;
    const base = t.port.command;
    let next = 0;
    t.port.command = async command => {
      if (command.action === "NEXT") t.snapshot.taskKey = ++next === 1 ? "two" : "one";
      return base(command);
    };
    await t.runner.start();
    expect(t.state.phase).toBe("ERROR"); expect(t.state.error).toContain("循环");
    expect(next).toBe(2);
  });

  it("stops queued requests, drains the two already in flight, and never writes their late answers", async () => {
    const t = setup(); t.snapshot.questionCount = 5;
    const finish: Array<(value: StudyAnswer) => void> = [];
    t.port.answer = () => new Promise(resolve => { finish.push(resolve); });
    const running = t.runner.start();
    await vi.waitFor(() => expect(finish.length).toBe(2));
    t.runner.stop(); expect(t.state.busy).toBe(true);
    finish.forEach(resolve => resolve(answer));
    await running;
    expect(finish).toHaveLength(2); expect(t.state.modelRequests).toBe(2);
    expect(t.actions).not.toContain("APPLY"); expect(t.actions).not.toContain("SEND_WORK");
    expect(t.state.busy).toBe(false); expect(t.state.buffered).toBe(0);
  });

  it("resumes all paused queue waiters together without leaking writes during the pause", async () => {
    const t = setup(); t.snapshot.questionCount = 3;
    const finish: Array<(value: StudyAnswer) => void> = [];
    t.port.answer = captured => captured.index === 2 ? Promise.resolve(answer) : new Promise(resolve => { finish.push(resolve); });
    const running = t.runner.start();
    await vi.waitFor(() => expect(finish.length).toBe(2));
    t.runner.pause(); finish.forEach(resolve => resolve(answer));
    await vi.waitFor(() => expect(t.state.inFlight).toBe(0));
    expect(t.actions).not.toContain("APPLY");
    t.runner.resume(); await running;
    expect(t.state.phase).toBe("DONE"); expect(t.actions.filter(action => action === "APPLY")).toHaveLength(3);
  });

  it("does not count an intentional long pause as a stalled video", async () => {
    const t = setup("VIDEO"); let played = 0;
    const base = t.port.command;
    t.port.command = async command => {
      if (command.action === "PLAY") {
        if (++played === 1) {
          t.runner.pause();
          await t.port.sleep(120000);
          t.runner.resume();
        } else t.snapshot.completed = true;
        t.snapshot.video!.paused = true;
        return {};
      }
      return base(command);
    };
    await t.runner.start();
    expect(t.state.phase).toBe("DONE"); expect(played).toBe(2);
  });

  it("turns a question-scoped invalid model output into a manual item instead of aborting the run", async () => {
    const t = setup();
    t.port.answer = async captured => {
      if (captured.index === 0) throw Object.assign(new Error("bad option id"), { code: "UPSTREAM_INVALID_OUTPUT" });
      return answer;
    };
    const running = t.runner.start();
    await vi.waitFor(() => expect(t.state.phase).toBe("NEEDS_INPUT"));
    expect(t.state.error).toBe("");
    expect(t.state.manualItems).toHaveLength(1);
    expect(t.state.manualItems[0]!.index).toBe(0);
    expect(t.state.modelRequests).toBe(2);
    t.runner.stop(); await running;
  });

  it("skips a choice question whose options could not be read, without calling the model", async () => {
    const t = setup();
    const base = t.port.command;
    t.port.command = async command => {
      if (command.action === "READ_ALL") {
        return {
          questions: [
            { index: 0, fingerprint: "fingerprint", needsImage: false,
              question: { id: "q_1", type: "MULTIPLE_CHOICE" as const, stem: "unreadable options", options: [], blanks: [] } },
            { index: 1, fingerprint: "fingerprint", needsImage: false,
              question: { id: "q_2", type: "SINGLE_CHOICE" as const, stem: "ok", options: [{ id: "opt_1", text: "A" }], blanks: [] } }
          ]
        };
      }
      return base(command);
    };
    const running = t.runner.start();
    await vi.waitFor(() => expect(t.state.phase).toBe("NEEDS_INPUT"));
    expect(t.state.manualItems).toHaveLength(1);
    expect(t.state.manualItems[0]!.reason).toContain("选项");
    expect(t.state.modelRequests).toBe(1);
    t.runner.stop(); await running;
  });

  it("sends an unrecognized question type straight to the manual summary without calling the model", async () => {
    const t = setup();
    const base = t.port.command;
    t.port.command = async command => {
      if (command.action === "READ_ALL") {
        return {
          questions: [
            { index: 0, fingerprint: "fingerprint", needsImage: false,
              question: { id: "q_1", type: "UNKNOWN" as const, stem: "unreadable type", options: [], blanks: [] } },
            { index: 1, fingerprint: "fingerprint", needsImage: false,
              question: { id: "q_2", type: "SINGLE_CHOICE" as const, stem: "ok", options: [{ id: "opt_1", text: "A" }], blanks: [] } }
          ]
        };
      }
      return base(command);
    };
    const running = t.runner.start();
    await vi.waitFor(() => expect(t.state.phase).toBe("NEEDS_INPUT"));
    expect(t.state.modelRequests).toBe(1);
    expect(t.state.manualItems).toHaveLength(1);
    expect(t.state.manualItems[0]!.index).toBe(0);
    expect(t.state.manualItems[0]!.reason).toContain("题型");
    expect(t.state.manualItems[0]!.reason).toContain("汇总");
    expect(t.state.manualItems[0]!.reason).toContain("补答");
    expect(t.state.manualItems[0]!.retryable).toBe(false);
    expect(t.state.filled).toBe(1);
    expect(t.actions.filter(action => action === "APPLY")).toHaveLength(1);
    t.runner.stop(); await running;
  });

  it("infers the type of an unidentified question from the manual answer shape before filling", async () => {
    const t = setup(); t.snapshot.questionCount = 1;
    const base = t.port.command;
    const applied: Array<{ index: number; type?: string }> = [];
    t.port.command = async command => {
      if (command.action === "READ_ALL") {
        return { questions: [{ index: 0, fingerprint: "fingerprint", needsImage: false,
          question: { id: "q_1", type: "UNKNOWN" as const, stem: "unreadable type",
            options: [{ id: "opt_1", text: "A" }], blanks: [] } }] };
      }
      if (command.action === "APPLY") applied.push({ index: command.index!, type: command.questionType });
      return base(command);
    };
    const running = t.runner.start();
    await vi.waitFor(() => expect(t.state.phase).toBe("NEEDS_INPUT"));
    expect(t.state.modelRequests).toBe(0);
    // 什么都没填且无法推断题型：仍报“补答不完整”，不写页面。
    await expect(t.runner.submitManual([{ index: 0, answer: { ...answer, selectedOptionIds: [] } }]))
      .rejects.toThrow("补答不完整");
    expect(applied).toHaveLength(0);
    // 只选择一个选项、不改“题型纠正”：按答案形态推断为单选题后回填并继续。
    await t.runner.submitManual([{ index: 0, answer }]);
    await running;
    expect(applied).toEqual([{ index: 0, type: "SINGLE_CHOICE" }]);
    expect(t.state.manualItems[0]!.resolved).toBe(true);
    expect(t.state.phase).toBe("DONE");
    expect(t.actions.filter(action => action === "SEND_WORK")).toHaveLength(1);
  });

  it("keeps tied candidates manual instead of auto-filling an arbitrary first answer", async () => {
    const t = setup(); t.snapshot.questionCount = 1;
    const base = t.port.command;
    t.port.command = async command => {
      if (command.action === "READ_ALL") {
        return { questions: [{ index: 0, fingerprint: "fingerprint", needsImage: false,
          question: { id: "q_1", type: "SINGLE_CHOICE" as const, stem: "test",
            options: [{ id: "opt_1", text: "A" }, { id: "opt_2", text: "B" }], blanks: [] } }] };
      }
      return base(command);
    };
    let calls = 0;
    t.port.answer = async () => {
      calls += 1;
      if (calls === 1) return { ...answer, selectedOptionIds: [] };
      return calls === 2 ? { ...answer, selectedOptionIds: ["opt_1"] } : { ...answer, selectedOptionIds: ["opt_2"] };
    };
    const running = t.runner.start();
    await vi.waitFor(() => expect(t.state.phase).toBe("NEEDS_INPUT"));
    expect(t.state.manualItems).toHaveLength(1);
    expect(t.actions).not.toContain("APPLY"); expect(t.actions).not.toContain("SEND_WORK");
    t.runner.stop(); await running;
  });
  it("checks an ANSWERED sample marked uncertain and only fills after two matching votes", async () => {
    const t = setup(); t.snapshot.questionCount = 1;
    let calls = 0;
    t.port.answer = async () => (++calls === 1 ? { ...answer, caveats: ["不确定"] } : answer);
    await t.runner.start();
    expect(calls).toBe(3); expect(t.state.phase).toBe("DONE");
    expect(t.actions.filter(action => action === "APPLY")).toHaveLength(1);
  });

  it("submitNow never resubmits or recounts an already completed run", async () => {
    const t = setup(); t.snapshot.questionCount = 1;
    await t.runner.start({ continueTasks: false });
    const before = t.actions.filter(action => action === "SEND_WORK").length;
    await t.runner.submitNow();
    expect(t.actions.filter(action => action === "SEND_WORK").length).toBe(before);
    expect(t.state.completedTasks).toBe(1);
  });

  it("auto-submits and continues the chain after manual补答 when the run stopped in ERROR", async () => {
    vi.useFakeTimers();
    const t = setup();
    t.port.answer = async captured => captured.index === 0
      ? { ...answer, status: "NEEDS_CONTEXT", caveats: ["图片模糊"] }
      : answer;
    const running = t.runner.start();
    for (let i = 0; i < 20 && t.state.phase !== "NEEDS_INPUT"; i++) await vi.advanceTimersByTimeAsync(50);
    expect(t.state.phase).toBe("NEEDS_INPUT");
    expect(t.state.manualItems).toHaveLength(1);
    expect(t.actions).not.toContain("SEND_WORK");
    // 停车补答期间监控判定任务变化（如站点重渲染误报）→ 流水线以 ERROR 停止，汇总仍待补答。
    t.snapshot.taskKey = "changed";
    await vi.advanceTimersByTimeAsync(2500);
    await vi.advanceTimersByTimeAsync(400);
    expect(t.state.phase).toBe("ERROR");
    await running;
    // 页面实际仍是原任务：补答核验后必须自动提交并继续，而不是要求人工“重新启动以提交”。
    t.snapshot.taskKey = "one";
    await t.runner.submitManual([{ index: 0, answer }]);
    expect(t.state.phase).toBe("DONE");
    expect(t.state.step).toContain("已到最后一个任务");
    expect(t.actions.filter(action => action === "SEND_WORK")).toHaveLength(1);
    expect(t.actions).toContain("CONFIRM_WORK");
    expect(t.state.completedTasks).toBe(1);
    // 补答已核验并随恢复提交消费；调度继续后汇总卡清空。
    expect(t.state.manualItems).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("counts the submitted quiz and processes the next task when the site advances before CONFIRM_WORK", async () => {
    const t = setup();
    const base = t.port.command;
    t.port.command = async command => {
      if (command.action === "SEND_WORK") {
        // The site accepts the submit and immediately renders the next task; CONFIRM_WORK is
        // still bound to the old task key and rejects (course-page binding guard).
        t.snapshot.taskKey = "two";
        t.snapshot.kind = "MATERIAL";
        t.snapshot.completed = false;
        t.snapshot.hasNext = false;
        t.snapshot.questionCount = 0;
      }
      if (command.action === "CONFIRM_WORK" && t.snapshot.taskKey !== "one") {
        throw new Error("课程或任务已变化，请重新启动。");
      }
      return base(command);
    };
    await t.runner.start();
    expect(t.state.phase).toBe("DONE");
    // The submitted QUIZ is counted, the landed MATERIAL card is counted as a skipped resource.
    expect(t.state.completedTasks).toBe(1);
    expect(t.state.skippedResources).toBe(1);
  });

  it("keeps collected manual items when a parallel request stops the run with a fatal error", async () => {
    const t = setup();
    t.port.answer = async captured => {
      if (captured.index === 1) throw new Error("网络错误");
      throw Object.assign(new Error("模型输出无法用于本题"), { code: "UPSTREAM_INVALID_OUTPUT" });
    };
    await t.runner.start();
    expect(t.state.phase).toBe("ERROR");
    // The already-spent question must remain in the manual summary instead of disappearing.
    expect(t.state.manualItems.map(item => item.index)).toContain(0);
  });

  it("releases the manual-saving lock before continuing so a later task can also be answered", async () => {
    vi.useFakeTimers();
    const t = setup();
    t.snapshot.hasNext = true;
    t.port.answer = async captured => captured.index === 1
      ? { ...answer, status: "NEEDS_CONTEXT", selectedOptionIds: [], caveats: ["图片模糊"] }
      : answer;
    const base = t.port.command;
    t.port.command = async command => {
      if (command.action === "NEXT") {
        t.snapshot.taskKey = "two";
        t.snapshot.completed = false;
        t.snapshot.hasNext = false;
        t.snapshot.questionCount = 2;
        t.snapshot.kind = "QUIZ";
        return {};
      }
      return base(command);
    };
    const running = t.runner.start();
    for (let i = 0; i < 20 && t.state.phase !== "NEEDS_INPUT"; i++) await vi.advanceTimersByTimeAsync(50);
    expect(t.state.phase).toBe("NEEDS_INPUT");
    expect(t.state.manualItems.map(item => item.index)).toEqual([1]);
    // Simulate the heartbeat misreading a re-render as a task change while parked for manual input.
    t.snapshot.taskKey = "drifted";
    await vi.advanceTimersByTimeAsync(2500);
    await vi.advanceTimersByTimeAsync(400);
    expect(t.state.phase).toBe("ERROR");
    await running;
    // The page is actually still the original task; resolving the first manual item should
    // submit, continue to task two, and leave the manual workflow usable there as well.
    t.snapshot.taskKey = "one";
    const recovery = t.runner.submitManual([{ index: 1, answer }]);
    for (let i = 0; i < 200; i++) {
      await vi.advanceTimersByTimeAsync(50);
      if (t.state.phase === "NEEDS_INPUT" && t.snapshot.taskKey === "two" && t.state.manualItems.length) break;
    }
    expect(t.snapshot.taskKey).toBe("two");
    expect(t.state.phase).toBe("NEEDS_INPUT");
    await t.runner.submitManual([{ index: 1, answer }]);
    for (let i = 0; i < 40 && t.state.phase !== "DONE"; i++) await vi.advanceTimersByTimeAsync(50);
    expect(t.state.phase).toBe("DONE");
    await recovery;
    expect(t.state.completedTasks).toBe(2);
    t.runner.stop();
  });

  it("auto-submits after the last candidate is adopted following an ERROR stop", async () => {
    vi.useFakeTimers();
    const t = setup();
    let rejectFirstFill = true;
    const base = t.port.command;
    t.port.command = async command => {
      if (command.action === "APPLY" && command.index === 0 && rejectFirstFill) {
        rejectFirstFill = false;
        throw new Error("第 1 题页面没有保留回填结果（回读不一致）。");
      }
      return base(command);
    };
    const running = t.runner.start();
    for (let i = 0; i < 20 && t.state.phase !== "NEEDS_INPUT"; i++) await vi.advanceTimersByTimeAsync(50);
    expect(t.state.phase).toBe("NEEDS_INPUT");
    expect(t.state.manualItems).toHaveLength(1);
    expect(t.state.manualItems[0]!.candidates.length).toBeGreaterThan(0);
    t.snapshot.taskKey = "changed";
    await vi.advanceTimersByTimeAsync(2500);
    await vi.advanceTimersByTimeAsync(400);
    expect(t.state.phase).toBe("ERROR");
    await running;
    t.snapshot.taskKey = "one";
    await t.runner.adoptCandidate(0, 0);
    expect(t.state.phase).toBe("DONE");
    expect(t.actions.filter(action => action === "SEND_WORK")).toHaveLength(1);
    expect(t.actions).toContain("CONFIRM_WORK");
    expect(t.state.completedTasks).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("verifies page-side补答 in ERROR, then auto-submits and continues", async () => {
    vi.useFakeTimers();
    const t = setup();
    t.port.answer = async captured => captured.index === 0
      ? { ...answer, status: "NEEDS_CONTEXT", caveats: ["图片模糊"] }
      : answer;
    const running = t.runner.start();
    for (let i = 0; i < 20 && t.state.phase !== "NEEDS_INPUT"; i++) await vi.advanceTimersByTimeAsync(50);
    expect(t.state.phase).toBe("NEEDS_INPUT");
    t.snapshot.taskKey = "changed";
    await vi.advanceTimersByTimeAsync(2500);
    await vi.advanceTimersByTimeAsync(400);
    expect(t.state.phase).toBe("ERROR");
    await running;
    t.snapshot.taskKey = "one";
    await t.runner.acceptManualFromPage();
    expect(t.state.phase).toBe("DONE");
    expect(t.actions.filter(action => action === "SEND_WORK")).toHaveLength(1);
    expect(t.actions).toContain("CONFIRM_WORK");
    expect(t.state.completedTasks).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("can attach a rendered image to every question when requested", async () => {
    const t = setup();
    await t.runner.start({ sendImages: "always" });
    expect(t.actions.filter(action => action === "CAPTURE")).toHaveLength(2);
    expect(t.state.phase).toBe("DONE");
  });

  it("re-runs unresolved manual questions on demand and accepts the most frequent answer", async () => {
    const t = setup(); t.snapshot.questionCount = 1;
    let calls = 0;
    const base = t.port.command;
    t.port.command = async command => {
      const result = await base(command);
      if (command.action === "CAPTURE" && result.captured) result.captured.question.imageDataUrl = "data:image/jpeg;base64,whole";
      return result;
    };
    t.port.answer = async () => (++calls <= 4 ? { ...answer, selectedOptionIds: [] } : answer);
    const running = t.runner.start();
    await vi.waitFor(() => expect(t.state.phase).toBe("NEEDS_INPUT"));
    expect(t.state.manualItems[0]!.retryable).toBe(true);
    await t.runner.retryManual();
    await running;
    expect(t.state.modelRequests).toBe(7);
    expect(t.state.manualItems[0]!.resolved).toBe(true);
    expect(t.state.phase).toBe("DONE");
    expect(t.actions.filter(action => action === "APPLY")).toHaveLength(1);
    expect(t.actions.filter(action => action === "SEND_WORK")).toHaveLength(1);
  });

  it("keeps retrying the remaining questions when one retry write is rejected", async () => {
    const t = setup();
    let initial = true;
    t.port.answer = async () => initial ? { ...answer, status: "REFUSED" as const } : answer;
    const running = t.runner.start();
    await vi.waitFor(() => expect(t.state.phase).toBe("NEEDS_INPUT"));
    expect(t.state.manualItems).toHaveLength(2);
    initial = false;
    const applied: number[] = [];
    const base = t.port.command;
    t.port.command = async command => {
      if (command.action === "APPLY") {
        applied.push(command.index!);
        if (command.index === 0) throw new Error("第 1 题页面没有保留回填结果（回读不一致）。");
      }
      return base(command);
    };
    await t.runner.retryManual();
    // 第一题回填失败不中断本轮：第二题仍被重试并回填。
    expect(applied).toEqual([0, 1]);
    expect(t.state.phase).toBe("NEEDS_INPUT");
    expect(t.state.manualSaving).toBe(false);
    expect(t.state.manualItems[0]!.resolved).toBe(false);
    expect(t.state.manualItems[0]!.reason).toBe("重试答案仍未通过页面校验：第 1 题页面没有保留回填结果（回读不一致）。");
    expect(t.state.manualItems[1]!.resolved).toBe(true);
    expect(t.state.filled).toBe(1);
    expect(t.state.step).toContain("1 题待人工补答");
    expect(t.actions).not.toContain("SEND_WORK");
    t.runner.stop(); await running;
  });

  it("shows a FIFO-head error immediately while late parallel requests drain", async () => {
    const t = setup(); t.snapshot.questionCount = 3;
    const finish: Array<(value: StudyAnswer) => void> = [];
    t.port.answer = captured => captured.index === 0 ? Promise.reject(new Error("model failed")) :
      new Promise(resolve => { finish.push(resolve); });
    const running = t.runner.start();
    await vi.waitFor(() => expect(t.state.phase).toBe("ERROR"));
    expect(t.state.error).toBe("model failed"); expect(t.state.busy).toBe(true);
    finish.forEach(resolve => resolve(answer)); await running;
    expect(t.state.busy).toBe(false); expect(t.actions).not.toContain("APPLY");
  });

  it("collects every response before any sorted fill and preserves earlier answers when starting at N", async () => {
    const t = setup(); t.snapshot.questionCount = 4;
    const base = t.port.command; const events: string[] = [];
    t.port.command = async command => { if (command.action === "APPLY") events.push(`fill-${command.index}`); return base(command); };
    t.port.answer = async captured => { events.push(`answer-${captured.index}`); return answer; };
    await t.runner.start({ startQuestion: 2 });
    expect(events).toEqual(["answer-1", "answer-2", "answer-3", "fill-1", "fill-2", "fill-3"]);
    expect(t.state.retained).toBe(1); expect(t.state.phase).toBe("DONE");
    expect(t.actions.filter(action => action === "READ_ALL")).toHaveLength(1);
    expect(t.actions).not.toContain("CAPTURE");
  });

  it("fills other questions, summarizes a blurry one, then automatically resumes after manual input", async () => {
    const t = setup(); const calls = [0, 0];
    t.port.answer = async captured => { calls[captured.index]!++; return captured.index === 0 ? { ...answer, status: "NEEDS_CONTEXT", caveats: ["图片模糊"] } : answer; };
    const running = t.runner.start();
    await vi.waitFor(() => expect(t.state.phase).toBe("NEEDS_INPUT"));
    expect(calls).toEqual([1, 1]); expect(t.state.filled).toBe(1);
    expect(t.actions).not.toContain("SEND_WORK");
    await t.runner.submitManual([{ index: 0, answer }]); await running;
    expect(t.state.phase).toBe("DONE"); expect(t.state.manualItems[0]!.resolved).toBe(true);
    expect(t.actions.filter(action => action === "SEND_WORK")).toHaveLength(1);
  });

  it("falls back to text-only when the optional rendered image fails", async () => {
    const t = setup(); const base = t.port.command; const seen: Array<string | null | undefined> = [];
    t.port.command = async command => {
      const result = await base(command);
      if (command.action === "CAPTURE") {
        throw new QuestionImageError("题目图片加载失败。", {
          index: command.index!, fingerprint: "fingerprint", needsImage: false, textUsable: true,
          question: { id: `q_${command.index! + 1}`, type: "SINGLE_CHOICE", stem: "test", options: [{ id: "opt_1", text: "A" }], blanks: [] }
        });
      }
      return result;
    };
    t.port.answer = async captured => { seen.push(captured.question.imageDataUrl); return answer; };
    await t.runner.start({ sendImages: "always" });
    // 「所有题目都附图像」只是补充：题图失败时两题仍应按源文字得到模型答案并回填。
    expect(t.state.manualItems).toHaveLength(0);
    expect(t.state.modelRequests).toBe(2);
    expect(seen).toEqual([undefined, undefined]);
    expect(t.actions.filter(action => action === "APPLY")).toHaveLength(2);
    expect(t.state.phase).toBe("DONE");
  });

  it("keeps a required image failure manual but still requests one text-only answer", async () => {
    const t = setup(); t.snapshot.questionCount = 1;
    const base = t.port.command;
    t.port.command = async command => {
      const result = await base(command);
      if (command.action === "CAPTURE") {
        throw new QuestionImageError("题目图片不允许跨域读取。", {
          index: 0, fingerprint: "fingerprint", needsImage: true, textUsable: true,
          question: { id: "q_1", type: "SINGLE_CHOICE", stem: "test", options: [{ id: "opt_1", text: "A" }], blanks: [] }
        });
      }
      return result;
    };
    const running = t.runner.start({ sendImages: "always" });
    await vi.waitFor(() => expect(t.state.phase).toBe("NEEDS_INPUT"));
    const item = t.state.manualItems[0]!;
    expect(item.retryable).toBe(true);
    expect(item.imageError).toContain("跨域");
    // 题图失败也不能显示“没有 AI 信息”：仍按可读文字请求一次，候选供人工核对。
    expect(item.samples).toHaveLength(1);
    expect(item.candidates).toHaveLength(1);
    expect(t.state.modelRequests).toBe(1);
    expect(t.state.filled).toBe(0);
    expect(t.actions).not.toContain("APPLY");
    t.runner.stop(); await running;
  });

  it("automatically re-renders after the first text answer and directly fills the second image answer", async () => {
    const t = setup(); t.snapshot.questionCount = 1;
    const base = t.port.command; const requestImages: Array<string | null | undefined> = [];
    let renderCalls = 0;
    t.port.command = async command => {
      const result = await base(command);
      if (command.action === "CAPTURE" && command.imagePass === "originals") {
        // 原图直发也不可用（如跨域拒绝）：该题必须落进人工汇总并给出两次失败原因。
        throw new QuestionImageError("题目原图无法安全读取（可能含跨域内容）。");
      }
      if (command.action === "CAPTURE") {
        renderCalls++;
        if (renderCalls === 1) {
          throw new QuestionImageError("题目图片尚未加载完成。", {
            index: 0, fingerprint: "fingerprint", needsImage: true, textUsable: true,
            question: { id: "q_1", type: "SINGLE_CHOICE", stem: "test", options: [{ id: "opt_1", text: "A" }], blanks: [] }
          });
        }
        result.captured = { index: 0, fingerprint: "fingerprint", needsImage: true, textUsable: true,
          question: { id: "q_1", type: "SINGLE_CHOICE", stem: "test", options: [{ id: "opt_1", text: "A" }], blanks: [],
            imageDataUrl: "data:image/jpeg;base64,/9j/AAAA" } };
      }
      return result;
    };
    t.port.answer = async captured => { requestImages.push(captured.question.imageDataUrl); return answer; };
    await t.runner.start({ sendImages: "always" });
    expect(renderCalls).toBe(2);
    expect(requestImages).toEqual([undefined, "data:image/jpeg;base64,/9j/AAAA"]);
    expect(t.state.manualItems).toHaveLength(0);
    expect(t.state.phase).toBe("DONE");
    expect(t.actions.filter(action => action === "APPLY")).toHaveLength(1);
  });

  it("automatically re-sends original image bytes when the composite render fails on an image-only question", async () => {
    const t = setup(); t.snapshot.questionCount = 1;
    const base = t.port.command;
    const seenPasses: Array<string | undefined> = [];
    const sentImages: Array<Array<string | null | undefined>> = [];
    t.port.command = async command => {
      const result = await base(command);
      if (command.action === "CAPTURE") {
        seenPasses.push(command.imagePass);
        if (command.imagePass === "originals") {
          result.captured = { index: 0, fingerprint: "fingerprint", needsImage: true, textUsable: false, imageSource: "originals",
            question: { id: "q_1", type: "SINGLE_CHOICE", stem: "请解答附带图像中的本题，返回定义的选项/空格 ID；无法看清时返回 NEEDS_CONTEXT。",
              options: [{ id: "opt_1", text: "A" }], blanks: [],
              imageDataUrl: "data:image/png;base64,iVBORAAAA", extraImageDataUrls: ["data:image/png;base64,iVBORBBBB"] } };
          return result;
        }
        throw new QuestionImageError("题目图像超过 400 KB，请人工处理。", {
          index: 0, fingerprint: "fingerprint", needsImage: true, textUsable: false,
          question: { id: "q_1", type: "SINGLE_CHOICE", stem: "请解答附带图像中的本题，返回定义的选项/空格 ID；无法看清时返回 NEEDS_CONTEXT。",
            options: [{ id: "opt_1", text: "A" }], blanks: [] }
        });
      }
      return result;
    };
    t.port.answer = async captured => {
      sentImages.push([captured.question.imageDataUrl, ...(captured.question.extraImageDataUrls ?? [])]);
      return answer;
    };
    await t.runner.start({ sendImages: "always" });
    // 纯图片题（文字不可读）：合成题图失败后自动改发原图原版数据，一次命中即回填，
    // 不再转人工（2026-10-20 授权的完全自动化路径）。
    expect(seenPasses).toEqual([undefined, "originals"]);
    expect(sentImages).toEqual([["data:image/png;base64,iVBORAAAA", "data:image/png;base64,iVBORBBBB"]]);
    expect(t.state.manualItems).toHaveLength(0);
    expect(t.actions.filter(action => action === "APPLY")).toHaveLength(1);
    expect(t.state.phase).toBe("DONE");
  });

  it("automatically sends a whole-question image and adopts its answer without another vote", async () => {
    const t = setup(); t.snapshot.questionCount = 1;
    const base = t.port.command;
    const calls: Array<Array<string | null | undefined>> = [];
    t.port.command = async command => {
      const result = await base(command);
      if (command.action === "CAPTURE" && command.imagePass === "whole") {
        result.captured = { index: 0, fingerprint: "fingerprint", needsImage: true, textUsable: true, imageSource: "render",
          question: { id: "q_1", type: "SINGLE_CHOICE", stem: "test", options: [{ id: "opt_1", text: "A" }], blanks: [],
            imageDataUrl: "data:image/png;base64,iVBORAAAA" } };
      }
      return result;
    };
    t.port.answer = async captured => {
      calls.push([captured.question.imageDataUrl, ...(captured.question.extraImageDataUrls ?? [])]);
      if (calls.length === 1) return { ...answer, status: "NEEDS_CONTEXT", caveats: ["图片模糊，无法看清题目"] };
      return answer;
    };
    await t.runner.start({ sendImages: "always" });
    expect(calls).toEqual([
      [undefined],
      ["data:image/png;base64,iVBORAAAA"]
    ]);
    expect(t.state.manualItems).toHaveLength(0);
    expect(t.actions.filter(action => action === "APPLY")).toHaveLength(1);
    expect(t.state.phase).toBe("DONE");
  });

  it("shows both samples when the whole-question image answer still has no usable answer", async () => {
    const t = setup(); t.snapshot.questionCount = 1;
    const base = t.port.command;
    t.port.command = async command => {
      const result = await base(command);
      if (command.action === "CAPTURE" && command.imagePass === "whole") {
        result.captured = { index: 0, fingerprint: "fingerprint", needsImage: true, textUsable: true, imageSource: "render",
          question: { id: "q_1", type: "SINGLE_CHOICE", stem: "test", options: [{ id: "opt_1", text: "A" }], blanks: [],
            imageDataUrl: "data:image/png;base64,iVBORAAAA" } };
      }
      return result;
    };
    t.port.answer = async () => ({ ...answer, status: "NEEDS_CONTEXT", caveats: ["图像不清晰"] });
    const running = t.runner.start({ sendImages: "always" });
    await vi.waitFor(() => expect(t.state.phase).toBe("NEEDS_INPUT"));
    const item = t.state.manualItems[0]!;
    expect(item.reason).toContain("没有完整可回填答案");
    expect(item.samples).toHaveLength(2);
    expect(item.retryable).toBe(true);
    expect(t.state.filled).toBe(0);
    expect(t.actions).not.toContain("APPLY");
    t.runner.stop(); await running;
  });

  it("keeps an unreadable image-only question manual, keeps retry enabled and verifies page answers", async () => {
    const t = setup(); t.snapshot.questionCount = 1;
    const base = t.port.command;
    t.port.command = async command => {
      const result = await base(command);
      if (command.action === "CAPTURE") {
        throw new QuestionImageError("题目图片不允许跨域读取。", {
          index: 0, fingerprint: "fingerprint", needsImage: true, textUsable: false,
          question: { id: "q_1", type: "SINGLE_CHOICE", stem: "请解答附带图像中的本题，返回定义的选项/空格 ID；无法看清时返回 NEEDS_CONTEXT。",
            options: [{ id: "opt_1", text: "A" }], blanks: [] }
        });
      }
      return result;
    };
    const running = t.runner.start({ sendImages: "always" });
    await vi.waitFor(() => expect(t.state.phase).toBe("NEEDS_INPUT"));
    const item = t.state.manualItems[0]!;
    expect(item.retryable).toBe(true);
    expect(item.samples).toHaveLength(0);
    expect(t.state.modelRequests).toBe(0);
    // 没有可发送的文字：重试只重读题图，仍失败时给出具体原因，不产生无根据的模型调用。
    await t.runner.retryManual();
    expect(item.samples).toHaveLength(0);
    expect(t.state.modelRequests).toBe(0);
    expect(item.reason).toContain("题图仍无法读取");
    expect(t.state.phase).toBe("NEEDS_INPUT");
    await t.runner.acceptManualFromPage(); await running;
    expect(t.state.phase).toBe("DONE");
  });

  it("solves prefix questions with the model when they have no existing answer", async () => {
    const t = setup(); const base = t.port.command;
    t.port.command = async command => { const result = await base(command); if (command.action === "ADOPT_EXISTING") result.existingAccepted = false; return result; };
    await t.runner.start({ startQuestion: 2 });
    expect(t.state.phase).toBe("DONE");
    expect(t.state.modelRequests).toBe(2);
    expect(t.actions.filter(action => action === "APPLY")).toHaveLength(2);
    expect(t.actions.filter(action => action === "SEND_WORK")).toHaveLength(1);
  });
  it("questions-only mode never plays a video, while course mode does", async () => {
    const questions = setup("VIDEO"); await questions.runner.start({ continueTasks: false });
    expect(questions.state.phase).toBe("ERROR"); expect(questions.actions).not.toContain("PLAY");
    const course = setup("VIDEO"); await course.runner.start(); expect(course.actions).toContain("PLAY");
  });
  it("rejects an out-of-range starting question before any model calls or writes", async () => {
    const t = setup(); await t.runner.start({ startQuestion: 3 });
    expect(t.state.phase).toBe("ERROR"); expect(t.actions).not.toContain("MODEL"); expect(t.actions).not.toContain("APPLY");
  });
  it("resets the starting question to one in the next quiz of course mode", async () => {
    const t = setup(); t.snapshot.hasNext = true;
    const base = t.port.command, indices: number[] = [];
    t.port.command = async command => {
      if (command.action === "NEXT") { t.snapshot.taskKey = "two"; t.snapshot.completed = false; t.snapshot.hasNext = false; }
      return base(command);
    };
    t.port.answer = async captured => { indices.push(captured.index); return answer; };
    await t.runner.start({ startQuestion: 2 });
    expect(indices).toEqual([1, 0, 1]); expect(t.state.completedTasks).toBe(2);
  });
  it("course mode skips only an identified non-task resource without counting it as completed", async () => {
    const t = setup("MATERIAL"); t.snapshot.hasNext = true;
    const base = t.port.command;
    t.port.command = async command => {
      if (command.action === "NEXT") { t.snapshot.taskKey = "video"; t.snapshot.kind = "VIDEO"; t.snapshot.video = { paused: true, ended: false, currentTime: 0, duration: 10, error: false }; t.snapshot.hasNext = false; }
      return base(command);
    };
    await t.runner.start();
    expect(t.state.phase).toBe("DONE"); expect(t.state.skippedResources).toBe(1);
    expect(t.state.skippedVideos).toBe(0); expect(t.state.completedTasks).toBe(1);
  });
  it("resolves an already-open chapter notice before reading or filling the current quiz", async () => {
    const t = setup(); const base = t.port.command; let pending = true;
    t.port.command = async command => {
      const result = await base(command);
      if (command.action === "CONFIRM_NEXT" && pending) { pending = false; return { nextNotice: "LEARN_REMAINING" }; }
      return result;
    };
    await t.runner.start();
    expect(t.state.phase).toBe("DONE"); expect(t.state.completedTasks).toBe(1);
    expect(t.actions.indexOf("CONFIRM_NEXT")).toBeLessThan(t.actions.indexOf("READ_ALL"));
  });
  it("returns to a lazy unfinished quiz on the same card and undoes the provisional completion count", async () => {
    const t = setup("COMPLETED"); t.snapshot.completed = true; t.snapshot.hasNext = true;
    const base = t.port.command; let pending = false;
    t.port.command = async command => {
      const result = await base(command);
      if (command.action === "NEXT") pending = true;
      if (command.action === "CONFIRM_NEXT" && pending) {
        pending = false;
        Object.assign(t.snapshot, { kind: "QUIZ", questionCount: 2, completed: false, hasNext: false });
        return { nextNotice: "LEARN_REMAINING" };
      }
      return result;
    };
    await t.runner.start();
    expect(t.state.phase).toBe("DONE"); expect(t.state.completedTasks).toBe(1);
    expect(t.actions.filter(action => action === "MODEL")).toHaveLength(2);
    expect(t.actions.filter(action => action === "SEND_WORK")).toHaveLength(1);
  });
  it.each(["VIDEO", "QUIZ"] as const)("propagates the explicit %s skip to its chapter notice confirmation", async kind => {
    const t = setup(kind); t.snapshot.hasNext = true;
    const base = t.port.command; let pending = false;
    t.port.command = async command => {
      const result = await base(command);
      if (command.action === "ADOPT_EXISTING") result.existingAccepted = false;
      if (command.action === "NEXT") pending = true;
      if (command.action === "CONFIRM_NEXT" && pending) {
        expect(command.allowSkipUnfinished).toBe(true); pending = false;
        Object.assign(t.snapshot, { taskKey: "last", kind: "COMPLETED", completed: true, questionCount: 0, hasNext: false, video: null });
        return { nextNotice: "SKIP_CONFIRMED" };
      }
      return result;
    };
    await t.runner.start(kind === "VIDEO" ? { skipVideos: true } : { videosOnly: true });
    expect(t.state.phase).toBe("DONE"); expect(t.state.completedTasks).toBe(1);
    expect(kind === "VIDEO" ? t.state.skippedVideos : t.state.skippedQuizzes).toBe(1);
    expect(t.actions).not.toContain("MODEL"); expect(t.actions).not.toContain("PLAY");
  });
  it("stops when the site repeatedly returns the same unfinished card instead of looping or double-submitting", async () => {
    const t = setup("COMPLETED"); t.snapshot.completed = true; t.snapshot.hasNext = true;
    const base = t.port.command; let pending = false;
    t.port.command = async command => {
      const result = await base(command);
      if (command.action === "NEXT") pending = true;
      if (command.action === "CONFIRM_NEXT" && pending) {
        pending = false; Object.assign(t.snapshot, { kind: "QUIZ", questionCount: 2, completed: false });
        return { nextNotice: "LEARN_REMAINING" };
      }
      return result;
    };
    await t.runner.start();
    expect(t.state.phase).toBe("ERROR"); expect(t.state.error).toContain("重复出现未完成提示");
    expect(t.actions.filter(action => action === "SEND_WORK")).toHaveLength(1);
  });
  it("does not carry a video skip over to a newly loaded quiz on the same card", async () => {
    const t = setup("VIDEO"); t.snapshot.hasNext = true;
    const base = t.port.command; let pending = false;
    t.port.command = async command => {
      const result = await base(command);
      if (command.action === "NEXT") {
        pending = true;
        Object.assign(t.snapshot, { kind: "QUIZ", questionCount: 2, hasNext: false, video: null });
      }
      if (command.action === "CONFIRM_NEXT" && pending) {
        expect(command.allowSkipUnfinished).toBeUndefined(); pending = false;
        return { nextNotice: "LEARN_REMAINING" };
      }
      return result;
    };
    await t.runner.start({ skipVideos: true });
    expect(t.state.phase).toBe("DONE"); expect(t.state.skippedVideos).toBe(0);
    expect(t.actions.filter(action => action === "SEND_WORK")).toHaveLength(1);
  });
  it("continues from a submitted quiz through consecutive static cards to the next quiz", async () => {
    const t = setup(); t.snapshot.hasNext = true;
    const base = t.port.command;
    let next = 0;
    t.port.command = async command => {
      if (command.action === "NEXT") {
        next++;
        Object.assign(t.snapshot, { taskKey: `task_${next}`, completed: false,
          kind: next < 3 ? "MATERIAL" : "QUIZ", questionCount: next < 3 ? 0 : 2, hasNext: next < 3 });
      }
      return base(command);
    };
    await t.runner.start();
    expect(t.state.phase).toBe("DONE");
    expect(t.state.completedTasks).toBe(2); expect(t.state.skippedResources).toBe(2);
    expect(t.actions.filter(action => action === "SEND_WORK")).toHaveLength(2);
    expect(t.actions.filter(action => action === "MODEL")).toHaveLength(4);
    expect(t.commands.filter(command => command.action === "NEXT")).toHaveLength(3);
    expect(t.commands.filter(command => command.action === "NEXT").every(command => !command.allowSkipUnfinished)).toBe(true);
  });
  it("ends at a final static card without inventing a completed task", async () => {
    const t = setup("MATERIAL");
    await t.runner.start();
    expect(t.state.phase).toBe("DONE"); expect(t.state.completedTasks).toBe(0);
    expect(t.state.skippedResources).toBe(1); expect(t.actions).not.toContain("MODEL");
    expect(t.actions).not.toContain("NEXT");
  });
  it("stops on a resource navigation loop or a Next button that does not change the page", async () => {
    const t = setup("MATERIAL"); t.snapshot.hasNext = true;
    await t.runner.start();
    expect(t.state.phase).toBe("ERROR"); expect(t.state.error).toContain("没有切换");
    expect(t.actions.filter(action => action === "NEXT")).toHaveLength(1);
    expect(t.state.completedTasks).toBe(0);
  });
  it("refreshes the video duration after lazy loading instead of imposing the initial ten-minute deadline", async () => {
    const t = setup("VIDEO"); t.snapshot.video!.duration = 0;
    const base = t.port.command;
    t.port.command = async command => {
      if (command.action === "PLAY") { t.snapshot.video!.duration = 1200; return {}; }
      if (command.action === "INSPECT") { t.snapshot.video!.currentTime = t.port.now() / 1000; t.snapshot.completed = t.port.now() >= 650000; }
      return base(command);
    };
    await t.runner.start(); expect(t.state.phase).toBe("DONE");
  });

  it("questions-only mode skips an unfinished video with an explicit NEXT permission and counts a skipped video, never playing it", async () => {
    const t = setup("VIDEO"); t.snapshot.hasNext = true;
    const base = t.port.command;
    t.port.command = async command => {
      if (command.action === "NEXT") {
        t.snapshot.taskKey = "two"; t.snapshot.kind = "QUIZ"; t.snapshot.questionCount = 0;
        t.snapshot.completed = true; t.snapshot.hasNext = false; t.snapshot.video = null;
      }
      return base(command);
    };
    await t.runner.start({ skipVideos: true });
    // 跳过未完成视频必须携带页面侧跳过授权，否则 course-page 的 NEXT 守卫会拒绝跳转。
    const nexts = t.commands.filter(command => command.action === "NEXT");
    expect(nexts).toHaveLength(1);
    expect(nexts[0]!.allowSkipUnfinished).toBe(true);
    expect(t.actions).not.toContain("PLAY");
    expect(t.state.skippedVideos).toBe(1);
    expect(t.state.skippedResources).toBe(0);
    // 下一任务点已由站点确认完成，仍按完成任务计数。
    expect(t.state.completedTasks).toBe(1);
    expect(t.state.phase).toBe("DONE");
  });

  it("questions-only mode counts a video the site already completed as completed and sends a plain NEXT", async () => {
    const t = setup("VIDEO"); t.snapshot.completed = true; t.snapshot.hasNext = true; t.snapshot.video = null;
    const base = t.port.command;
    t.port.command = async command => {
      if (command.action === "NEXT") {
        t.snapshot.taskKey = "two"; t.snapshot.kind = "QUIZ"; t.snapshot.questionCount = 0;
        t.snapshot.completed = true; t.snapshot.hasNext = false;
      }
      return base(command);
    };
    await t.runner.start({ skipVideos: true });
    expect(t.actions).not.toContain("PLAY");
    const nexts = t.commands.filter(command => command.action === "NEXT");
    expect(nexts).toHaveLength(1);
    expect(nexts[0]!.allowSkipUnfinished).toBeUndefined();
    expect(t.state.skippedVideos).toBe(0);
    expect(t.state.completedTasks).toBe(2);
    expect(t.state.phase).toBe("DONE");
  });

  it("videos-only mode skips an incomplete quiz with an explicit NEXT permission and never calls the model", async () => {
    const t = setup("QUIZ"); t.snapshot.hasNext = true;
    const base = t.port.command;
    t.port.command = async command => {
      if (command.action === "NEXT") {
        t.snapshot.taskKey = "two"; t.snapshot.kind = "VIDEO"; t.snapshot.questionCount = 0;
        t.snapshot.completed = true; t.snapshot.hasNext = false;
        t.snapshot.video = { paused: false, ended: true, currentTime: 5, duration: 5, error: false };
      }
      const result = await base(command);
      if (command.action === "ADOPT_EXISTING") result.existingAccepted = false;
      return result;
    };
    await t.runner.start({ videosOnly: true });
    const nexts = t.commands.filter(command => command.action === "NEXT");
    expect(nexts).toHaveLength(1);
    // 只刷课模式跳过未完成题目必须携带页面侧跳过授权（与刷题模式跳过视频对称）。
    expect(nexts[0]!.allowSkipUnfinished).toBe(true);
    expect(t.actions).not.toContain("READ_ALL");
    expect(t.actions).not.toContain("MODEL");
    expect(t.actions).not.toContain("APPLY");
    expect(t.actions).not.toContain("SEND_WORK");
    expect(t.state.skippedQuizzes).toBe(1);
    // 下一任务点已由站点确认完成，仍按完成任务计数。
    expect(t.state.completedTasks).toBe(1);
    expect(t.state.phase).toBe("DONE");
  });

  it("videos-only mode still plays a video task and finishes it", async () => {
    const t = setup("VIDEO");
    await t.runner.start({ videosOnly: true });
    expect(t.actions).toContain("PLAY");
    expect(t.state.completedTasks).toBe(1);
    expect(t.state.phase).toBe("DONE");
  });

  it("rejects enabling the questions-only and videos-only modes at once", async () => {
    const t = setup("QUIZ");
    await t.runner.start({ skipVideos: true, videosOnly: true });
    expect(t.state.phase).toBe("ERROR");
    expect(t.state.error).toBe("调度参数无效。");
  });

  it("answers a mid-video popup by page-side enumeration without a model call and resumes playback", async () => {
    const t = setup("VIDEO");
    const base = t.port.command;
    let popped = false;
    let enumCalls = 0;
    t.port.command = async command => {
      if (command.action === "PLAY") { t.snapshot.video!.paused = false; t.snapshot.video!.ended = false; return {}; }
      if (command.action === "ENUM_POPUP") {
        enumCalls += 1;
        // 页面侧枚举通过：弹题关闭、视频恢复。
        t.snapshot.video!.paused = false;
        return { popup: { found: true, resolved: true, attempts: 2, options: 3 } };
      }
      if (command.action === "INSPECT") {
        const result = await base(command);
        const snapshot = result.snapshot!;
        snapshot.video!.currentTime = t.port.now() / 1000;
        if (!popped && t.port.now() >= 5000 && t.port.now() < 12000) {
          popped = true;
          snapshot.video = { ...snapshot.video!, paused: true };
        }
        if (t.port.now() >= 12000) {
          snapshot.completed = true;
          snapshot.video = { ...snapshot.video!, ended: true };
        }
        return result;
      }
      return base(command);
    };
    await t.runner.start();
    expect(enumCalls).toBe(1);
    // 弹题通过后视频继续真实播放，站点确认完成，任务链走到末尾；全程无模型调用。
    expect(t.actions).not.toContain("MODEL");
    expect(t.state.completedTasks).toBe(1);
    expect(t.state.phase).toBe("DONE");
  });

  it("stops with a counting error when popup enumeration cannot pass the popup", async () => {
    const t = setup("VIDEO");
    const base = t.port.command;
    t.port.command = async command => {
      if (command.action === "PLAY") { t.snapshot.video!.paused = false; t.snapshot.video!.ended = false; return {}; }
      if (command.action === "ENUM_POPUP") return { popup: { found: true, resolved: false, attempts: 3, options: 3 } };
      if (command.action === "INSPECT") {
        const result = await base(command);
        const snapshot = result.snapshot!;
        snapshot.video!.currentTime = t.port.now() / 1000;
        if (t.port.now() >= 5000) snapshot.video = { ...snapshot.video!, paused: true };
        return result;
      }
      return base(command);
    };
    await t.runner.start();
    expect(t.state.phase).toBe("ERROR");
    expect(t.state.error).toContain("视频弹题自动作答未通过");
    expect(t.state.error).toContain("3/3");
  });

  it("course mode plays an unfinished video, waits for the site to confirm it and advances with a plain NEXT", async () => {
    const t = setup("VIDEO"); t.snapshot.hasNext = true;
    const base = t.port.command;
    t.port.command = async command => {
      if (command.action === "NEXT") {
        t.snapshot.taskKey = "two"; t.snapshot.kind = "QUIZ"; t.snapshot.questionCount = 0;
        t.snapshot.completed = true; t.snapshot.hasNext = false; t.snapshot.video = null;
      }
      return base(command);
    };
    await t.runner.start();
    expect(t.actions.filter(action => action === "PLAY")).toHaveLength(1);
    // 刷课模式从未「跳过」视频：NEXT 不带跳过授权，也不会虚报跳过计数。
    const nexts = t.commands.filter(command => command.action === "NEXT");
    expect(nexts).toHaveLength(1);
    expect(nexts[0]!.allowSkipUnfinished).toBeUndefined();
    expect(t.state.skippedVideos).toBe(0);
    expect(t.state.completedTasks).toBe(2);
    expect(t.state.phase).toBe("DONE");
  });

  it("retries a rejected video play twice after a two-second pause-aware wait and then continues", async () => {
    const t = setup("VIDEO");
    const base = t.port.command;
    const playsAt: number[] = [];
    t.port.command = async command => {
      if (command.action === "PLAY") {
        playsAt.push(t.port.now());
        if (playsAt.length <= 2) throw new Error(`播放被拒绝（第 ${playsAt.length} 次）`);
      }
      return base(command);
    };
    await t.runner.start();
    expect(playsAt).toHaveLength(3);
    expect(playsAt[1]! - playsAt[0]!).toBeGreaterThanOrEqual(2000);
    expect(playsAt[2]! - playsAt[1]!).toBeGreaterThanOrEqual(2000);
    expect(t.state.phase).toBe("DONE");
    expect(t.state.error).toBe("");
    expect(t.state.completedTasks).toBe(1);
  });

  it("stops with the last error when the video play is rejected three times", async () => {
    const t = setup("VIDEO");
    const base = t.port.command;
    let plays = 0;
    t.port.command = async command => {
      if (command.action === "PLAY") throw new Error(`播放被拒绝（第 ${++plays} 次）`);
      return base(command);
    };
    await t.runner.start();
    expect(plays).toBe(3);
    expect(t.state.phase).toBe("ERROR");
    expect(t.state.error).toBe("播放被拒绝（第 3 次）");
    expect(t.state.completedTasks).toBe(0);
    expect(t.actions).not.toContain("NEXT");
  });

  it("stops retrying the video play when the user stops during the retry wait", async () => {
    const t = setup("VIDEO");
    const base = t.port.command;
    let plays = 0;
    t.port.command = async command => {
      if (command.action === "PLAY") {
        plays++;
        t.runner.stop();
        throw new Error("播放被拒绝");
      }
      return base(command);
    };
    await t.runner.start();
    expect(plays).toBe(1);
    expect(t.state.phase).toBe("STOPPED");
    expect(t.state.error).toBe("");
  });

  it("answers and submits the standalone 作业/测验 page once, then stops without a next task", async () => {
    const t = setup();
    t.snapshot.standalone = true;
    t.snapshot.taskKey = "work-one";
    await t.runner.start();
    expect(t.state.phase).toBe("DONE");
    expect(t.state.completedTasks).toBe(1);
    expect(t.actions.filter(action => action === "APPLY")).toHaveLength(2);
    expect(t.actions.filter(action => action === "SEND_WORK")).toHaveLength(1);
    expect(t.actions.indexOf("SEND_WORK")).toBeGreaterThan(t.actions.lastIndexOf("APPLY"));
    expect(t.actions).not.toContain("NEXT");
  });

  it("submits complete existing standalone work in videos-only mode without generating answers", async () => {
    const t = setup();
    t.snapshot.standalone = true;
    t.snapshot.taskKey = "work-one";
    await t.runner.start({ videosOnly: true });
    expect(t.state.phase).toBe("DONE");
    expect(t.state.completedTasks).toBe(1);
    expect(t.actions).not.toContain("MODEL");
    expect(t.actions).not.toContain("READ_ALL");
    expect(t.actions).toContain("SEND_WORK");
  });

  it("does not re-answer an already submitted standalone 作业/测验 page", async () => {
    const t = setup();
    t.snapshot.standalone = true;
    t.snapshot.taskKey = "work-one";
    t.snapshot.kind = "COMPLETED";
    t.snapshot.completed = true;
    t.snapshot.questionCount = 0;
    await t.runner.start();
    expect(t.state.phase).toBe("DONE");
    expect(t.state.step).toContain("已提交");
    expect(t.actions).not.toContain("READ_ALL");
    expect(t.actions).not.toContain("SEND_WORK");
  });

  it("ends honestly when the standalone 作业/测验 page navigates away before confirming submission", async () => {
    const t = setup();
    t.snapshot.standalone = true;
    t.snapshot.taskKey = "work-one";
    t.snapshot.questionCount = 1;
    const base = t.port.command;
    let submitted = false;
    t.port.command = async command => {
      if (submitted) throw new Error("页面已跳转");
      const result = await base(command);
      if (command.action === "SEND_WORK") submitted = true;
      return result;
    };
    await t.runner.start();
    expect(t.state.phase).toBe("DONE");
    expect(t.state.step).toContain("未返回可核验");
    expect(t.state.completedTasks).toBe(0);
    expect(t.actions.filter(action => action === "SEND_WORK")).toHaveLength(1);
  });

  it("counts a standalone 作业/测验 submission once the site leaves the work page", async () => {
    const t = setup();
    t.snapshot.standalone = true;
    t.snapshot.taskKey = "work-one";
    t.snapshot.questionCount = 1;
    const base = t.port.command;
    t.port.command = async command => {
      if (command.action === "SEND_WORK") t.snapshot.taskKey = "course-task";
      return base(command);
    };
    await t.runner.start();
    expect(t.state.phase).toBe("DONE");
    expect(t.state.completedTasks).toBe(1);
  });
});


describe("incremental scan dispatch", () => {
  it("sends the first question while later source scans are still pending, then fills in order", async () => {
    const t = setup(); t.snapshot.questionCount = 3;
    const base = t.port.command;
    const inventory = (await base({ action: "READ_ALL" })).questions!;
    t.actions.length = 0;
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const events: string[] = [];
    t.port.readQuestion = async index => {
      if (index > 0) await pending;
      events.push(`read-${index}`); return inventory[index]!;
    };
    t.port.answer = async captured => { events.push(`model-${captured.index}`); return answer; };
    t.port.command = async command => {
      if (command.action === "APPLY") events.push(`fill-${command.index}`);
      return base(command);
    };
    const running = t.runner.start();
    await vi.waitFor(() => expect(events).toContain("model-0"));
    expect(events).not.toContain("read-1"); expect(events).not.toContain("read-2");
    expect(t.state.phase).toBe("RUNNING"); expect(t.actions).not.toContain("READ_ALL");
    expect(t.actions).not.toContain("APPLY");
    release(); await running;
    expect(events.filter(event => event.startsWith("fill-"))).toEqual(["fill-0", "fill-1", "fill-2"]);
    expect(t.state.phase).toBe("DONE");
  });
  it("automatically sends the whole image after inconclusive samples before showing any manual input", async () => {
    const t = setup(); t.snapshot.questionCount = 1; const base = t.port.command;
    t.port.command = async command => {
      const result = await base(command);
      if (command.action === "CAPTURE" && result.captured) result.captured.question.imageDataUrl = "data:image/jpeg;base64,whole";
      return result;
    };
    let calls = 0;
    t.port.answer = async captured => {
      calls++; expect(t.state.phase).toBe("RUNNING"); expect(t.state.manualItems).toEqual([]);
      if (calls < 4) return { ...answer, selectedOptionIds: [] };
      expect(captured.imageRequired).toBe(true); return answer;
    };
    await t.runner.start();
    expect(calls).toBe(4); expect(t.state.phase).toBe("DONE"); expect(t.state.manualItems).toEqual([]);
    expect(t.state.filled).toBe(1);
  });
});
