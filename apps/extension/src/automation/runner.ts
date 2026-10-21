import type { StudyAnswer, StudyQuestion } from "@study/contracts";
import type { AutomationCommand, NextNoticeOutcome, PopupOutcome, TaskQuestion, TaskSnapshot } from "./protocol";
import { answerIsUncertain, chooseAnswer, choosePlurality, imageIsUnclear, rankAnswerCandidates } from "./consensus";
import { WorkPool } from "./work-pool";
import { QuestionImageError } from "./question-image-error";

export interface RunOptions {
  startQuestion: number;
  requestConcurrency: number;
  requestsPerMinute: number;
  continueTasks: boolean;
  /** "auto" sends images only when decoded text is unreliable; "always" attaches one for every question. */
  sendImages: "auto" | "always";
  /** 刷题模式: complete task points continuously but never play videos. */
  skipVideos: boolean;
  /** 只刷课模式: play videos and traverse opened PDF/PPT resources; unfinished QUIZ task points are skipped with an
   * explicit NEXT authorization instead of being answered. Mid-video popup questions (弹题)
   * are still answered by bounded page-side enumeration — they gate playback and never use the model. */
  videosOnly: boolean;
}
/** requestsPerMinute = 0 means unlimited (self-hosted BYOK deployment). */
const DEFAULT_OPTIONS: RunOptions = { startQuestion: 1, requestConcurrency: 2, requestsPerMinute: 0, continueTasks: true, sendImages: "auto", skipVideos: false, videosOnly: false };

export interface ManualQuestion {
  index: number;
  captured: TaskQuestion;
  reason: string;
  resolved: boolean;
  /** Every valid sample collected so far, reused by the explicit plurality retry. */
  samples: StudyAnswer[];
  /** Valid answers ranked by vote count; shown so the user can pick one directly. */
  candidates: Array<{ answer: StudyAnswer; count: number }>;
  /** Image-unreadable and refused items are not retried automatically with the model. */
  retryable: boolean;
  /** Rendered-image failure detail; the explicit retry first tries to re-render the image. */
  imageError?: string;
}
type ResolvedQuestion = { captured: TaskQuestion; vote: ReturnType<typeof chooseAnswer> };
const QUESTION_SCOPED_CODES = new Set(["UPSTREAM_INVALID_OUTPUT", "UPSTREAM_TRUNCATED", "VALIDATION_ERROR"]);
/**
 * Providers may mark a failure as belonging to the current question (`questionScoped: true`,
 * e.g. a 4xx caused by an attached image) or explicitly as a run-level failure. Without the
 * explicit flag the historical contract-code set applies.
 */
function questionScopedFailure(error: unknown): boolean {
  const record = (typeof error === "object" && error !== null ? error : {}) as { code?: unknown; questionScoped?: unknown };
  if (record.questionScoped === true) return true;
  if (record.questionScoped === false) return false;
  return typeof record.code === "string" && QUESTION_SCOPED_CODES.has(record.code);
}

function withoutImage(captured: TaskQuestion): TaskQuestion {
  const { imageDataUrl: _image, extraImageDataUrls: _extra, ...question } = captured.question;
  return { ...captured, question };
}

/** How long the heartbeat waits before treating a changed poll as a real task change. */
const MONITOR_RECHECK_MS = 400;
/**
 * Synchronous, side-effect-free description of how the live page differs from the bound
 * quiz task. An empty string means the bound task is unchanged. Differences are joined
 * with 「、」 so the run error names every observed change instead of a generic message.
 */
function describeTaskDrift(bound: TaskSnapshot, current: TaskSnapshot): string {
  const differences: string[] = [];
  if (current.taskKey !== bound.taskKey) differences.push("任务标识已变化");
  if (current.kind !== bound.kind) differences.push(`页面类型由 ${bound.kind} 变为 ${current.kind}`);
  if (current.questionCount !== bound.questionCount) differences.push(`题数由 ${bound.questionCount} 变为 ${current.questionCount}`);
  return differences.join("、");
}

/**
 * The page cannot always label its own question type. When the user supplies only the
 * answer and no type correction, infer the type from the answer shape so chooseAnswer can
 * validate it and APPLY can send the corrected type. Nothing inferable stays UNKNOWN and
 * keeps the “补答不完整” error instead of guessing a type.
 */
function inferManualQuestionType(answer: StudyAnswer): StudyQuestion["type"] {
  if (answer.selectedOptionIds.length > 1) return "MULTIPLE_CHOICE";
  if (answer.selectedOptionIds.length === 1) return "SINGLE_CHOICE";
  if (answer.textAnswer?.trim()) return "SHORT_ANSWER";
  if (answer.blankAnswers.length) return "FILL_BLANK";
  return "UNKNOWN";
}

function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export interface RunnerState {
  phase: "IDLE" | "RUNNING" | "PAUSED" | "NEEDS_INPUT" | "STOPPED" | "DONE" | "ERROR";
  step: string;
  question: number;
  questionCount: number;
  completedTasks: number;
  skippedResources: number;
  skippedVideos: number;
  /** 只刷课模式越过的未完成题目任务点数，不计入已完成任务。 */
  skippedQuizzes: number;
  error: string;
  captured: number;
  inFlight: number;
  buffered: number;
  modelRequests: number;
  agreement: string;
  monitorChecks: number;
  lastCheck: number;
  busy: boolean;
  collected: number;
  filled: number;
  retained: number;
  manualItems: ManualQuestion[];
  manualSaving: boolean;
  imageReplies: Array<{ captured: TaskQuestion; samples: StudyAnswer[] }>;
  /** Live auto-play feedback for the current VIDEO task; empty on every other task kind. */
  videoStatus: string;
}
export interface RunnerPort {
  command(command: Omit<AutomationCommand, "requestId" | "runId">): Promise<{ snapshot?: TaskSnapshot; captured?: TaskQuestion; questions?: TaskQuestion[]; existingAccepted?: boolean; popup?: PopupOutcome; nextNotice?: NextNoticeOutcome }>;
  /** Incremental source reader; older ports may provide only READ_ALL. */
  readQuestion?(index: number, snapshot: TaskSnapshot): Promise<TaskQuestion>;
  answer(question: TaskQuestion): Promise<StudyAnswer>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export function createRunnerState(): RunnerState {
  return { phase: "IDLE", step: "待启动", question: 0, questionCount: 0, completedTasks: 0, skippedResources: 0, skippedVideos: 0, skippedQuizzes: 0, error: "",
    captured: 0, inFlight: 0, buffered: 0, modelRequests: 0, agreement: "", monitorChecks: 0, lastCheck: 0, busy: false,
    collected: 0, filled: 0, retained: 0, manualItems: [], manualSaving: false, imageReplies: [], videoStatus: "" };
}

/** Pinned-tab runner. The model returns data only; every browser action is fixed in code. */
export class CourseRunner {
  private running = false;
  private bound: { courseKey: string; taskKey: string } | null = null;
  private wake = new Set<() => void>();
  private fatal: Error | null = null;
  private starts: number[] = [];
  private rateTail: Promise<void> = Promise.resolve();
  private pausedAt: number | null = null;
  private pausedTime = 0;
  private options: RunOptions = DEFAULT_OPTIONS;
  constructor(readonly state: RunnerState, private readonly port: RunnerPort) {}

  private async checkpoint(): Promise<boolean> {
    while (this.state.phase === "PAUSED" || this.state.phase === "NEEDS_INPUT") await new Promise<void>(resolve => { this.wake.add(resolve); });
    if (this.fatal) throw this.fatal;
    return this.state.phase === "RUNNING";
  }
  private async delay(ms: number): Promise<boolean> {
    const deadline = this.port.now() + ms;
    while (this.port.now() < deadline) {
      if (!await this.checkpoint()) return false;
      await this.port.sleep(Math.min(500, deadline - this.port.now()));
    }
    return this.checkpoint();
  }
  /** Manual补答 retries run while the main pipeline stays parked in NEEDS_INPUT. */
  private async checkpointManual(): Promise<boolean> {
    while (this.state.phase === "PAUSED") await new Promise<void>(resolve => { this.wake.add(resolve); });
    if (this.fatal && this.state.phase !== "ERROR") throw this.fatal;
    return this.state.phase !== "STOPPED";
  }
  private async delayManual(ms: number): Promise<boolean> {
    const deadline = this.port.now() + ms;
    while (this.port.now() < deadline) {
      if (!await this.checkpointManual()) return false;
      await this.port.sleep(Math.min(500, deadline - this.port.now()));
    }
    return this.checkpointManual();
  }
  private async inspect(): Promise<TaskSnapshot> {
    const result = await this.port.command({ action: "INSPECT" });
    if (!result.snapshot) throw new Error("课程状态响应不完整。");
    if (this.bound && result.snapshot.courseKey !== this.bound.courseKey) throw new Error("课程已变化，调度器停止。");
    this.state.monitorChecks++; this.state.lastCheck = this.port.now();
    return result.snapshot;
  }
  private async action(action: AutomationCommand["action"], extra: Partial<AutomationCommand> = {}): Promise<{ snapshot?: TaskSnapshot; captured?: TaskQuestion; questions?: TaskQuestion[]; existingAccepted?: boolean; nextNotice?: NextNoticeOutcome }> {
    if (!await this.checkpoint()) throw new Error("已停止。");
    return this.port.command({ action, ...this.bound!, ...extra });
  }
  /** Total PLAY attempts: the first one plus at most two retries after a 2s, pause-aware wait. */
  private static readonly PLAY_ATTEMPTS = 3;
  /**
   * 视频播放是页面侧唯一可能被 Chrome 自动播放策略拒绝的动作（页面侧还会先静音起播再恢复
   * 声音，首次尝试可能恰好落在音轨切换上）。只对 PLAY 做有限重试，每一次失败后 delay(2000)，
   * 暂停/停止照样生效；其他动作绝不重试。三次都失败才抛出最后一次错误。
   */
  private async playWithRetry(): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= CourseRunner.PLAY_ATTEMPTS; attempt++) {
      try { await this.action("PLAY"); return; }
      catch (error) {
        lastError = error;
        if (attempt === CourseRunner.PLAY_ATTEMPTS) break;
        if (!await this.delay(2000)) throw new Error("已停止。");
      }
    }
    throw lastError;
  }
  /**
   * 视频弹题（2026-10-19 用户授权：刷课途中的强制弹题不上报人工、不调模型，页面侧按
   * 顺序枚举站点自身选项，答对视频才会继续）。命令失败按「未发现弹题」处理，交回原有
   * 的暂停恢复逻辑；只有「发现了弹题但枚举未通过」才作为运行错误停止并触发声音告警。
   */
  private async enumPopup(): Promise<PopupOutcome> {
    const none: PopupOutcome = { found: false, resolved: false, attempts: 0, options: 0 };
    if (!this.bound) return none;
    try {
      const result = await this.port.command({ action: "ENUM_POPUP", ...this.bound });
      return result.popup ?? none;
    } catch {
      return none;
    }
  }
  /** Visible auto-play feedback so the runner page shows the video module actually working. */
  private videoStatusOf(video: TaskSnapshot["video"]): string {
    if (!video) return "";
    if (video.ended) return "播放已结束，等待站点确认完成";
    if (video.paused) return "检测到暂停，正在恢复播放";
    const at = formatClock(video.currentTime);
    return video.duration > 0 ? `自动播放中 ${at} / ${formatClock(video.duration)}` : `自动播放中 ${at}`;
  }
  pause(): void {
    if (this.state.phase !== "RUNNING") return;
    this.state.phase = "PAUSED";
    this.pausedAt = this.port.now();
    this.state.step = "已暂停；当前请求结束后不会执行下一步";
    if (this.bound) void this.port.command({ action: "PAUSE_VIDEO", ...this.bound }).catch(() => undefined);
  }
  resume(): void {
    if (this.state.phase === "NEEDS_INPUT") {
      const unresolved = this.state.manualItems.filter(item => !item.resolved).length;
      if (unresolved > 0) {
        this.state.step = `还有 ${unresolved} 题待补答；可点“回填补答并自动继续”，或在课程页补答后点核验。`;
        this.notify();
        return;
      }
      this.state.phase = "RUNNING"; this.state.step = "补答已核验，自动继续任务调度"; this.notify();
      return;
    }
    if (this.state.phase !== "PAUSED") return;
    this.state.phase = "RUNNING";
    if (this.pausedAt !== null) this.pausedTime += this.port.now() - this.pausedAt;
    this.pausedAt = null;
    this.notify();
  }
  stop(): void {
    this.state.phase = "STOPPED"; this.state.step = "已停止";
    this.notify();
    if (this.bound) void this.port.command({ action: "RELEASE", ...this.bound }).catch(() => undefined);
  }

  private notify(): void { for (const wake of this.wake) wake(); this.wake.clear(); }

  private async requestSlot<T>(limit: number, issue: () => Promise<T>, mode: "run" | "manual" = "run"): Promise<T> {
    const guard = () => mode === "manual" ? this.checkpointManual() : this.checkpoint();
    const wait = (ms: number) => mode === "manual" ? this.delayManual(ms) : this.delay(ms);
    const previous = this.rateTail;
    let release!: () => void;
    this.rateTail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    let result!: Promise<T>;
    try {
      if (!await guard()) throw new Error("已停止。");
      if (limit > 0) {
        this.starts = this.starts.filter(time => this.port.now() - time < 61000);
        while (this.starts.length >= limit) {
          if (!await wait(61000 - (this.port.now() - this.starts[0]!))) throw new Error("已停止。");
          this.starts = this.starts.filter(time => this.port.now() - time < 61000);
        }
        if (!await guard()) throw new Error("已停止。");
      }
      // Record the slot and issue in the same turn, including after a long pause.
      // Unlimited mode does not keep a rolling window, so long runs cannot grow memory.
      if (limit > 0) this.starts.push(this.port.now());
      result = issue();
    } finally { release(); }
    return result;
  }

  /** Heartbeat observes the same bound task; it never fills or submits on its own. */
  private monitorQuiz(snapshot: TaskSnapshot): () => Promise<void> {
    let pending: Promise<void> | null = null;
    let closed = false;
    const active = (): boolean => !closed && ["RUNNING", "NEEDS_INPUT"].includes(this.state.phase);
    const fail = (message: string): void => {
      if (!active()) return;
      this.fatal = new Error(message);
      this.state.phase = "ERROR"; this.state.error = message;
      this.notify();
    };
    const confirmTaskChange = async (): Promise<void> => {
      const first = await this.inspect();
      if (!active()) return;
      const drift = describeTaskDrift(snapshot, first);
      if (!drift) return;
      // 懒加载、局部重绘或站点换页的瞬间会让单次采样误判为任务变化；等 400ms 再复核。
      await new Promise<void>(resolve => setTimeout(resolve, MONITOR_RECHECK_MS));
      if (!active()) return;
      const second = await this.inspect();
      if (!active()) return;
      const confirmed = describeTaskDrift(snapshot, second);
      if (!confirmed) return;
      fail(`监听发现课程任务已变化（${confirmed}），已取消未回填队列。`);
    };
    const timer = setInterval(() => {
      if (closed || pending || !active()) return;
      pending = confirmTaskChange().catch(error => {
        fail("监听课程页失败：" + (error instanceof Error ? error.message : "未知原因"));
      }).finally(() => { pending = null; });
    }, 2500);
    return async () => { closed = true; clearInterval(timer); await pending; };
  }

  private failPipeline(error: unknown): void {
    if (this.fatal || this.state.phase === "STOPPED") return;
    this.fatal = error instanceof Error ? error : new Error("题目队列失败。");
    this.state.phase = "ERROR"; this.state.error = this.fatal.message;
    this.state.step = "已停止；等待在途请求收尾";
    this.notify();
  }

  private async solveQuiz(snapshot: TaskSnapshot, options: RunOptions): Promise<void> {
    this.state.imageReplies = [];
    const captures = new WorkPool(2);
    const requests = new WorkPool(options.requestConcurrency);
    const resolved: ResolvedQuestion[] = [];
    const manual: ManualQuestion[] = [];
    const stopMonitor = this.monitorQuiz(snapshot);
    const issue = (captured: TaskQuestion, reason: string, samples: StudyAnswer[] = [], retryable = false): ManualQuestion => {
      const item: ManualQuestion = { index: captured.index, captured, reason, resolved: false, samples, retryable,
        candidates: rankAnswerCandidates(captured.question, samples) };
      manual.push(item);
      return item;
    };
    const request = (captured: TaskQuestion) => requests.run(() => this.requestSlot(options.requestsPerMinute, async () => {
      this.state.inFlight++; this.state.modelRequests++;
      try { return await this.port.answer(captured); }
      finally { this.state.inFlight--; }
    }));
    /**
     * 2026-10-20 用户授权（纯图片题全自动）：文字无法读取、合成题图失败或模型看不清时，
     * 自动改发原图原版数据（原尺寸、按需有界降尺度）——二次处理全自动，不再先转人工。
     * 原图可用时返回带图题目；否则返回具体失败原因，调用方走人工兜底。
     * 不新增权限、不绕过 CORS；失败原因会写进人工汇总或状态行。
     */
    const originalImagePass = async (captured: TaskQuestion): Promise<{ question: TaskQuestion } | { failed: string }> => {
      try {
        const result = await captures.run(() => this.action("CAPTURE", { index: captured.index, imagePass: "originals" }));
        const recaptured = result.captured;
        if (!recaptured || recaptured.fingerprint !== captured.fingerprint) return { failed: "题目在原图读取期间已变化" };
        if (typeof recaptured.question.imageDataUrl !== "string" || !recaptured.question.imageDataUrl.startsWith("data:image/")) {
          return { failed: "页面没有返回可用的原图" };
        }
        return { question: recaptured };
      } catch (error) {
        return { failed: error instanceof Error && error.message ? error.message : "原图读取失败" };
      }
    };
    // The image stage replaces the first answer. Do not mix it with older text-only votes.
    const secondImage = async (captured: TaskQuestion, samples: StudyAnswer[]): Promise<void> => {
      let whole: TaskQuestion;
      try { whole = await captures.run(() => this.captureWholeQuestion(captured)); }
      catch (error) {
        const item = issue(captured, "完整题图重试失败：" + (error instanceof Error ? error.message : "无法读取"), samples, true);
        if (captured.needsImage) item.imageError = item.reason;
        return;
      }
      let second: StudyAnswer;
      try { second = await request(whole); }
      catch (error) {
        if (!questionScopedFailure(error)) throw error;
        issue(whole, "图片请求未返回可用答案：" + (error instanceof Error ? error.message : "未知原因"), samples, true); return;
      }
      if (!await this.checkpoint()) return;
      this.state.imageReplies.push({ captured: withoutImage(whole), samples: [...samples, second] });
      try { resolved.push({ captured: withoutImage(whole), vote: chooseAnswer(whole.question, [second]) }); }
      catch { issue(whole, "第二次整题图片回答没有完整可回填答案，请录入或再次发送图片。", [...samples, second], true); }
    };
    /** Shared tail for an uncertain-but-readable sample: two more votes, then consensus or plurality. */
    const settle = async (question: TaskQuestion, first: StudyAnswer): Promise<void> => {
      const extra = await Promise.allSettled([request(question), request(question)]);
      const failedExtra = extra.find(result => result.status === "rejected");
      const answers = [first, ...extra
        .filter((result): result is PromiseFulfilledResult<StudyAnswer> => result.status === "fulfilled")
        .map(result => result.value)];
      if (failedExtra?.status === "rejected" && !questionScopedFailure(failedExtra.reason)) throw failedExtra.reason;
      if (!await this.checkpoint()) return;
      if (answers.length < 2) {
        await secondImage(question, answers);
        return;
      }
      try { resolved.push({ captured: withoutImage(question), vote: chooseAnswer(question.question, answers) }); }
      catch {
        await secondImage(question, answers);
      }
    };
    let next = options.startQuestion - 1;
    let workers: Promise<void>[] = [];
    try {
      this.state.step = "扫描题目源数据，读取完成即异步发送";
      const inventory = this.port.readQuestion ? null : (await this.action("READ_ALL")).questions;
      if (!this.port.readQuestion && (!inventory || inventory.length !== snapshot.questionCount || inventory.some((question, index) => question.index !== index))) throw new Error("整份题目读取响应不完整。");
      // Starting at N preserves existing answers; questions without one are solved by
      // the model like any other question instead of being pushed to the manual list.
      const existingAnswers = new Set<number>();
      for (let index = 0; index < next; index++) {
        const existing = await this.action("ADOPT_EXISTING", { index });
        if (!existing.captured || typeof existing.existingAccepted !== "boolean") throw new Error("前序答案核验响应不完整。");
        if (existing.existingAccepted) { existingAnswers.add(index); this.state.retained++; }
      }
      next = 0;
      this.state.step = "边扫描边异步发送；完成后按题号回填";
      const worker = async (): Promise<void> => {
        try {
          while (await this.checkpoint()) {
            const index = next++;
            if (index >= snapshot.questionCount) return;
            if (existingAnswers.has(index)) continue;
            this.state.buffered++;
            try {
              let captured: TaskQuestion;
              try {
                const source = this.port.readQuestion ? await captures.run(() => this.port.readQuestion!(index, snapshot)) : inventory![index]!;
                if (source.index !== index || !source.fingerprint) throw new Error("单题源数据读取响应不完整。");
                if (!await this.checkpoint()) return;
                if (source.needsImage || options.sendImages === "always") {
                  const result = await captures.run(() => this.action("CAPTURE", { index, forceImage: options.sendImages === "always" }));
                  if (!result.captured || result.captured.fingerprint !== source.fingerprint) throw new Error("题目在整份读取后发生变化。");
                  captured = result.captured;
                } else captured = source;
                this.state.captured++;
              } catch (error) {
                if (!(error instanceof QuestionImageError) || !error.captured) throw error;
                const failed = error.captured;
                const detail = error.message || "未知原因";
                if (!failed.needsImage) {
                  // 题图只是「所有题目都附图像」的补充信息：源文字已可靠读取，题图失败
                  // 不能让整题失去模型回答。改为只发文字继续正常作答。
                  captured = failed;
                  this.state.step = `第 ${failed.index + 1} 题题图读取失败（${detail}），改用源文字作答`;
                } else {
                  // 题图属于必要信息：先自动改发原图原版数据（2026-10-20 授权）；原图可用
                  // 就按正常带图题继续作答，原图也不可用才降级为文字候选或人工汇总。
                  const originals = await originalImagePass(failed);
                  if ("question" in originals) {
                    captured = originals.question;
                    this.state.captured++;
                    this.state.step = `第 ${failed.index + 1} 题合成题图读取失败（${detail}），已自动改发原图作答`;
                  } else if (failed.textUsable) {
                    // Keep the first text answer visible, then retry the full image. A transient
                    // render recovery can finish automatically; never fill image choices from text alone.
                    let sample: StudyAnswer;
                    try {
                      sample = await request(failed);
                    } catch (requestError) {
                      if (!questionScopedFailure(requestError)) throw requestError;
                      await secondImage(failed, []);
                      continue;
                    }
                    await secondImage(failed, [sample]);
                    continue;
                  } else {
                    // 文字也读不出来（纯图片题/字形未知）且原图不可用：只能人工核对题图
                    // 后补答；保留重试入口，重试会先重新读取题图。
                    const item = issue(failed, `题图读取失败（${detail}），自动改发原图也未成功（${originals.failed}）；题目文字也无法可靠读取，请人工核对题图后补答。`, [], true);
                    item.imageError = detail;
                    continue;
                  }
                }
              }
              // 题型本身读不出来（页面标签未知）时，模型调用解决不了问题：直接进汇总，
              // 由用户在汇总表里选择正确题型后补答；同任务其他题继续处理。
              if (captured.question.type === "UNKNOWN") {
                issue(captured, captured.answerReason
                  ?? "页面题型无法识别，已跳过自动答题；请在汇总里选择题型后补答。");
                continue;
              }
              if (["SINGLE_CHOICE", "MULTIPLE_CHOICE", "TRUE_FALSE"].includes(captured.question.type)
                  && captured.question.options.length === 0) {
                issue(captured, "未读取到选项（页面结构未适配），已跳过该题自动答题，请人工补答。");
                continue;
              }
              let first: StudyAnswer;
              try {
                first = await request(captured);
              } catch (error) {
                if (questionScopedFailure(error)) {
                  await secondImage(captured, []);
                  continue;
                }
                throw error;
              }
              if (!await this.checkpoint()) return;
              try {
                if (answerIsUncertain(first)) throw new Error("答案不确定，追加核验");
                resolved.push({ captured: withoutImage(captured), vote: chooseAnswer(captured.question, [first]) });
                continue;
              } catch { /* Only uncertain/unusable answers need two more samples. */ }
              if (first.status === "NEEDS_CONTEXT" || first.status === "REFUSED" || imageIsUnclear(first)) {
                this.state.step = `第 ${captured.index + 1} 题改发完整题干与全部选项图片，直接采用本次图片结果`;
                await secondImage(captured, [first]);
                continue;
              }
              await settle(captured, first);
            } finally {
              this.state.buffered--; this.state.collected++;
              this.state.question = Math.max(this.state.question, index + 1);
            }
          }
        } catch (error) { this.failPipeline(error); }
      };
      workers = Array.from({ length: Math.min(3, snapshot.questionCount - next) }, () => worker());
      await Promise.all(workers);
      if (!await this.checkpoint()) return;
      resolved.sort((a, b) => a.captured.index - b.captured.index);
      for (const result of resolved) {
        if (!await this.checkpoint()) return;
        const { captured, vote } = result;
        this.state.question = captured.index + 1; this.state.agreement = `${vote.agreement}/${vote.samples}`;
        this.state.step = `已汇总；按题号回填并回读第 ${captured.index + 1} 题`;
        try {
          await this.action("APPLY", { index: captured.index, fingerprint: captured.fingerprint, answer: vote.answer });
          this.state.filled++;
        } catch (error) {
          // One question the page refuses to keep must not cancel the whole task.
          manual.push({ index: captured.index, captured, reason:
            "回填未通过页面校验：" + (error instanceof Error ? error.message : "未知原因"), resolved: false,
            samples: [vote.answer], candidates: rankAnswerCandidates(captured.question, [vote.answer]), retryable: true });
        }
      }
      this.state.manualItems = manual.sort((a, b) => a.index - b.index);
      if (this.state.manualItems.length) {
        this.state.phase = "NEEDS_INPUT";
        this.state.step = `已汇总并回填可用答案；${this.state.manualItems.length} 题待手动补答，补全后自动继续`;
        await this.checkpoint();
      }
    } catch (error) { this.failPipeline(error); throw error; }
    finally {
      await stopMonitor();
      await Promise.allSettled(workers);
      this.state.buffered = 0;
      // A fatal error aborts before the sorted manual list is published; keep whatever was
      // collected so the recovery/manual UI can still show and resolve those questions
      // instead of discarding already-spent model calls.
      if (this.state.phase === "ERROR" && manual.length) {
        this.state.manualItems = manual.sort((a, b) => a.index - b.index);
      }
    }
  }

  /**
   * 独立作业/测验作答页（2026-10-20 用户授权 “这也算上，可以刷题”）：整卷读取、并发作答、
   * 排序回填、逐题回读核验，全部通过后只点一次站点提交，并等待页面给出可核验的完成证据。
   * 该页面没有任务链（无下一任务），提交确认即结束本轮；不重复提交、不推断成绩。
   */
  private async runStandaloneWork(snapshot: TaskSnapshot, options: RunOptions, startQuestion: number): Promise<void> {
    if (options.videosOnly) throw new Error("只刷课模式只处理视频任务；作业/测验页请用刷题模式。");
    if (snapshot.completed || snapshot.kind === "COMPLETED") {
      this.state.phase = "DONE"; this.state.step = "作业页此前已提交，无需重复作答"; return;
    }
    if (snapshot.kind !== "QUIZ") throw new Error("作业页题目结构未识别（没有找到已适配的题目容器），已停止；请人工核对页面，不会自动作答或提交。");
    if (!snapshot.questionCount || snapshot.questionCount > 200) throw new Error("作业题目数量不受支持。");
    if (startQuestion > snapshot.questionCount) throw new Error("起始题号超过当前作业题目数量。");
    this.state.questionCount = snapshot.questionCount;
    await this.solveQuiz(snapshot, { ...options, startQuestion });
    if (!await this.checkpoint()) return;
    this.state.step = `已回填 ${this.state.filled}/${snapshot.questionCount} 题，提交作业并等待站点确认`;
    await this.action("SEND_WORK");
    const deadline = this.port.now() + 60000;
    let missing = 0;
    let confirmed = false;
    do {
      if (!await this.delay(1000)) return;
      // 提交后站点可能先弹确认框、再跳转；两者都不允许打断提交后等待。
      try { await this.action("CONFIRM_WORK"); } catch { /* 页面已跳转或弹窗结构变化 */ }
      try { snapshot = await this.inspect(); missing = 0; }
      catch {
        if (++missing >= 3) {
          // 页面已离开作答视图，站点没有给出文字完成标记：如实结束，不重复提交、不宣称核验。
          this.state.phase = "DONE";
          this.state.step = "已点击提交；页面已跳转，站点未返回可核验的完成标记，请人工确认结果";
          return;
        }
        continue;
      }
      if (this.bound && snapshot.taskKey !== this.bound.taskKey) {
        // 站点提交后离开当前作业页（如返回课程任务页）：提交已被接受，本页不再重复提交。
        this.state.completedTasks++;
        this.state.phase = "DONE"; this.state.step = "作业页已提交，站点已跳转离开当前作业页";
        return;
      }
      if (snapshot.completed) { confirmed = true; break; }
      this.state.step = `已点击提交，等待站点确认（剩余 ${Math.max(0, Math.ceil((deadline - this.port.now()) / 1000))} 秒）`;
    } while (this.port.now() < deadline);
    if (!confirmed) throw new Error("已点击提交但站点未返回可核验的完成标记；不会重复提交，请人工确认页面结果。");
    this.state.completedTasks++;
    this.state.phase = "DONE"; this.state.step = "作业页刷题完成，站点已确认提交";
  }

  private async requestForManual(captured: TaskQuestion): Promise<StudyAnswer> {
    return this.requestSlot(this.options.requestsPerMinute, async () => {
      this.state.inFlight++; this.state.modelRequests++;
      try { return await this.port.answer(captured); }
      finally { this.state.inFlight--; }
    }, "manual");
  }

  private async captureWholeQuestion(captured: TaskQuestion): Promise<TaskQuestion> {
    if (!this.bound) throw new Error("没有绑定任务，请重新打开调度页。");
    const result = await this.port.command({ action: "CAPTURE", ...this.bound, index: captured.index, forceImage: true, imagePass: "whole" });
    const whole = result.captured;
    if (!whole || whole.fingerprint !== captured.fingerprint) throw new Error("题目在图片重试前已变化，请重新读取。");
    if (!whole.question.imageDataUrl?.startsWith("data:image/")) throw new Error("未取得完整题干和选项图片；没有降级发送文字。");
    return { ...whole, imageRequired: true };
  }

  /** Explicit image button: one image-stage answer replaces all earlier samples. */
  async retryWithImage(index: number): Promise<void> {
    if (this.state.manualSaving) throw new Error("正在处理另一项补答，请稍候。");
    if (!await this.manualContext()) throw new Error("当前不在补答状态。");
    const item = this.state.manualItems.find(item => item.index === index && !item.resolved);
    if (!item) throw new Error("该题已处理或不在待答列表。");
    this.state.manualSaving = true;
    let recovered = false;
    try {
      item.reason = "正在读取完整题干与全部选项图片…";
      const whole = await this.captureWholeQuestion(item.captured);
      if (!await this.checkpointManual()) return;
      item.captured = whole; item.imageError = undefined;
      item.reason = "正在发送整题图片，等待模型回答…";
      const second = await this.requestForManual(whole);
      if (!await this.checkpointManual()) return;
      item.samples.push(second);
      item.candidates = rankAnswerCandidates(whole.question, [second]);
      const answer = chooseAnswer(whole.question, [second]).answer;
      if (!await this.manualContext()) return;
      await this.port.command({ action: "APPLY", ...this.bound!, index, fingerprint: whole.fingerprint, answer });
      if (!await this.checkpointManual()) return;
      item.resolved = true; this.state.filled++;
      item.reason = "已采用本次图片回答，回填核验通过。";
      this.state.step = `第 ${index + 1} 题图片答案已回填核验；其余题可继续逐题录入`;
      if ((this.state.phase as RunnerState["phase"]) === "ERROR") recovered = this.state.manualItems.every(item => item.resolved);
      else this.finishManual();
    } catch (error) {
      item.reason = "图片发送/回填失败：" + (error instanceof Error ? error.message : "未知原因");
      throw error;
    } finally { this.state.manualSaving = false; this.notify(); }
    if (recovered) await this.recoverFromError();
  }

  /**
   * Image failures leave the item's question data without a rendered image. An explicit retry
   * first asks the course page to render it again (transient load/CORS failures do recover);
   * only when that still fails does it fall back to the recovered stem text.
   */
  private async recaptureForRetry(item: ManualQuestion): Promise<void> {
    if (item.imageError === undefined || !this.bound) return;
    const result = await this.port.command({ action: "CAPTURE", ...this.bound, index: item.index, forceImage: true });
    if (!result.captured || result.captured.fingerprint !== item.captured.fingerprint) throw new Error("题目在重试前已变化。");
    const hadImage = typeof item.captured.question.imageDataUrl === "string";
    item.captured = result.captured;
    const image = result.captured.question.imageDataUrl;
    if (typeof image === "string" && image.startsWith("data:image/")) {
      item.imageError = undefined;
      // Previous samples were text-only; do not let them vote together with image-grounded ones.
      if (!hadImage) { item.samples = []; item.candidates = []; }
    }
  }

  /**
   * Explicit user action from the manual补答 panel: send another concurrent round for
   * the unresolved questions, then accept the answer hit most often (plurality).
   * A top tie or fewer than two hits stays manual; nothing is submitted here.
   */
  async retryManual(): Promise<void> {
    if (this.state.manualSaving || this.state.phase !== "NEEDS_INPUT" || !this.bound) return;
    const items = this.state.manualItems.filter(item => !item.resolved && item.retryable);
    if (!items.length) return;
    this.state.manualSaving = true;
    this.state.step = `并发重试 ${items.length} 题，取命中最多的答案`;
    let recovered = false;
    try {
      for (const item of items) {
        if (!await this.checkpointManual()) return;
        if (item.imageError !== undefined) {
          try { await this.recaptureForRetry(item); }
          catch (error) {
            item.imageError = error instanceof Error && error.message ? error.message : "题图读取失败";
          }
        }
        // A question whose image is required but still cannot be rendered must not be
        // auto-filled from text-only samples; the user reviews the candidates instead.
        if (item.imageError !== undefined && item.captured.textUsable !== true) {
          item.reason = `题图仍无法读取（${item.imageError}），题目文字也无法可靠读取；请人工核对题图后补答。`;
          continue;
        }
        const round = await Promise.allSettled([
          this.requestForManual(item.captured),
          this.requestForManual(item.captured),
          this.requestForManual(item.captured)
        ]);
        const answers = round
          .filter((result): result is PromiseFulfilledResult<StudyAnswer> => result.status === "fulfilled")
          .map(result => result.value);
        item.samples = [...item.samples, ...answers];
        item.candidates = rankAnswerCandidates(item.captured.question, item.samples);
        if (item.imageError !== undefined) {
          item.reason = `题图仍无法读取（${item.imageError}），下面是仅按题目文字请求的候选（${answers.length} 次有效请求），请核对后采用或手动补答。`;
          continue;
        }
        let vote;
        try { vote = choosePlurality(item.captured.question, item.samples); }
        catch (error) {
          const top = item.candidates[0];
          item.reason = top
            ? `重试后仍无重复命中（最高 ${top.count} 票 / 共 ${item.samples.length} 次），可采用候选项或手动输入。`
            : error instanceof Error ? error.message : "重试后仍无最高命中答案，请手动输入。";
          continue;
        }
        try {
          await this.port.command({ action: "APPLY", ...this.bound!, index: item.index, fingerprint: item.captured.fingerprint, answer: vote.answer });
        } catch (error) {
          // 一题回填被页面拒绝不能中断本轮其他题的重试；保留候选并说明原因。
          item.reason = "重试答案仍未通过页面校验：" + (error instanceof Error ? error.message : "未知原因");
          continue;
        }
        if ((this.state.phase as RunnerState["phase"]) === "STOPPED") return;
        item.resolved = true; this.state.filled++;
        this.state.agreement = `${vote.agreement}/${vote.samples}`;
      }
      const remaining = this.state.manualItems.filter(item => !item.resolved);
      this.state.step = remaining.length
        ? `重试后仍有 ${remaining.length} 题待人工补答`
        : "补答已核验，自动继续任务调度";
      // The monitor may have switched the run to ERROR while the retry requests were in
      // flight; once every manual item is verified, recover and submit like the other
      // manual entry points do instead of parking in ERROR.
      if ((this.state.phase as RunnerState["phase"]) === "ERROR" && remaining.length === 0) recovered = true;
      else this.finishManual();
    } finally {
      this.state.manualSaving = false;
      this.notify();
    }
    if (recovered) await this.recoverFromError();
  }

  /** User explicitly adopts one candidate shown in the manual summary. */
  async adoptCandidate(index: number, candidateIndex = 0): Promise<void> {
    const phase = this.state.phase as RunnerState["phase"];
    if (this.state.manualSaving || (phase !== "NEEDS_INPUT" && phase !== "ERROR") || !this.bound) return;
    const item = this.state.manualItems.find(candidate => !candidate.resolved && candidate.index === index);
    const choice = item?.candidates[candidateIndex];
    if (!item || !choice) return;
    this.state.manualSaving = true;
    let recovered = false;
    try {
      await this.port.command({ action: "APPLY", ...this.bound!, index: item.index, fingerprint: item.captured.fingerprint, answer: choice.answer });
      if ((this.state.phase as RunnerState["phase"]) === "STOPPED") return;
      item.resolved = true; this.state.filled++;
      if ((this.state.phase as RunnerState["phase"]) === "ERROR") {
        this.state.step = `已采用第 ${item.index + 1} 题的候选答案（${choice.count} 票）；全部核验后自动提交并继续`;
        recovered = true;
      } else {
        this.state.step = `已采用第 ${item.index + 1} 题的候选答案（${choice.count} 票）`;
        if ((this.state.phase as RunnerState["phase"]) === "NEEDS_INPUT") this.finishManual();
      }
    } finally {
      this.state.manualSaving = false;
      this.notify();
    }
    if (recovered) await this.recoverFromError();
  }

  /** Adopt the top candidate for every unresolved question that has one. */
  async adoptHighestCandidates(): Promise<void> {
    for (const item of this.state.manualItems.filter(candidate => !candidate.resolved && candidate.candidates.length)) {
      const phase = this.state.phase as RunnerState["phase"];
      if (phase !== "NEEDS_INPUT" && phase !== "ERROR") return;
      await this.adoptCandidate(item.index, 0);
    }
  }

  /**
   * Explicit "submit now": clicks the site's own submit button once and waits for the
   * completion marker. Used when the user has already filled the page by hand, or to
   * retry after a stopped automatic path.
   */
  async submitNow(): Promise<void> {
    if (!this.bound || this.state.manualSaving) return;
    this.state.manualSaving = true;
    try {
      this.state.step = "立即提交：点击站点提交按钮";
      const result = await this.submitAndWait();
      if (result === "confirmed" || result === "advanced") this.state.completedTasks++;
    } finally {
      this.state.manualSaving = false;
      this.notify();
    }
  }

  /**
   * Click the site's own submit button once, then poll the completion marker for up to
   * 60 seconds. "advanced" means the site itself moved to the next task. Submission is
   * still guarded by course-page (full read-back before the click, one attempt only).
   */
  private async submitAndWait(): Promise<"confirmed" | "advanced" | "unconfirmed" | "failed"> {
    if (!this.bound) return "failed";
    try {
      await this.port.command({ action: "SEND_WORK", ...this.bound });
      const deadline = this.port.now() + 60000;
      let outcome: "confirmed" | "advanced" | "unconfirmed" = "unconfirmed";
      do {
        await this.port.sleep(1000);
        // A site may navigate/advance as soon as the submit is accepted; the confirmation
        // helper is bound to the old task key and would then reject. That does not mean the
        // submission failed, so ignore a confirmation failure and inspect the task instead.
        try { await this.port.command({ action: "CONFIRM_WORK", ...this.bound }); } catch { /* page may have advanced */ }
        const snapshot = await this.inspect();
        if (snapshot.taskKey !== this.bound.taskKey) { outcome = "advanced"; this.state.step = "站点已自动进入下一任务"; break; }
        if (snapshot.completed) { outcome = "confirmed"; this.state.step = "站点已确认提交成功"; break; }
        this.state.step = "已点击提交，等待站点确认（剩余 " + Math.max(0, Math.ceil((deadline - this.port.now()) / 1000)) + " 秒）";
      } while (this.port.now() < deadline);
      if (outcome === "unconfirmed") this.state.step = "已点击提交但站点未确认；请人工检查后重启任务";
      return outcome;
    } catch (error) {
      this.state.step = "提交失败：" + (error instanceof Error ? error.message : "未知原因");
      return "failed";
    }
  }

  /**
   * ERROR 后补答全部核验：自动点击一次站点提交按钮并继续任务链（2026-10-19 用户
   * 授权“回填、提交并进入下一个任务”）。此前这里要求人工“重新启动以提交”，把可
   * 自动完成的提交留给了人工。提交仍受 course-page 逐题回读一致与单次提交约束；
   * 站点未确认或点击失败时停在 ERROR，不重复提交、不跳任务。
   */
  private async recoverFromError(): Promise<void> {
    if (this.running || this.state.manualSaving || (this.state.phase as RunnerState["phase"]) !== "ERROR" || !this.bound) return;
    if (!this.state.manualItems.length || !this.state.manualItems.every(item => item.resolved)) return;
    this.state.manualSaving = true;
    this.state.busy = true;
    this.state.error = "";
    this.state.step = "补答已核验，自动提交本任务并继续";
    try {
      const result = await this.submitAndWait();
      if ((this.state.phase as RunnerState["phase"]) === "STOPPED") return;
      // “站点已切换任务”时本任务不会被后续调度循环再次计数，在此补记；
      // 仍在原任务时由 runLoop 按完成标记统一计数。
      if (result === "advanced") this.state.completedTasks++;
      if (result === "confirmed" || result === "advanced") {
        // Release the single-save lock before continuing: the next task may also need manual
        // answers, and every manual entry point refuses to run while `manualSaving` is held.
        this.state.manualSaving = false;
        // 起始题号只属于用户首次启动时的任务；后续任务一律从第 1 题开始。
        await this.runLoop({ ...this.options, startQuestion: 1 });
        return;
      }
      this.state.phase = "ERROR";
      this.state.error = this.state.step;
    } finally {
      this.state.manualSaving = false;
      this.state.busy = false;
      this.notify();
    }
  }

  private async manualContext(): Promise<boolean> {
    const phase = this.state.phase as RunnerState["phase"];
    if ((phase !== "NEEDS_INPUT" && phase !== "ERROR") || !this.bound) return false;
    const current = await this.inspect();
    if (current.taskKey !== this.bound.taskKey) throw new Error("任务已变化，请停止后重新读取。");
    return (this.state.phase as RunnerState["phase"]) === "NEEDS_INPUT"
      || (this.state.phase as RunnerState["phase"]) === "ERROR";
  }
  private finishManual(): void {
    if (this.state.phase === "NEEDS_INPUT" && this.state.manualItems.every(item => item.resolved)) {
      this.state.phase = "RUNNING"; this.state.step = "补答已核验，自动继续任务调度"; this.notify();
    }
  }
  async submitManual(entries: Array<{ index: number; answer: StudyAnswer; questionType?: StudyQuestion["type"] }>): Promise<void> {
    const phase = this.state.phase as RunnerState["phase"];
    if (this.state.manualSaving) throw new Error("正在处理另一项补答，请稍候。");
    if (phase !== "NEEDS_INPUT" && phase !== "ERROR") throw new Error("当前不在补答状态，请查看运行结果。");
    const pending = this.state.manualItems.filter(item => !item.resolved);
    if (!entries.length || new Set(entries.map(entry => entry.index)).size !== entries.length ||
        entries.some(entry => !pending.some(item => item.index === entry.index))) throw new Error("请选择尚未处理的待补答题目，不能重复录入。");
    const plans = entries.map(entry => {
      const item = pending.find(item => item.index === entry.index)!;
      // 题型纠正优先；页面识别成功时沿用识别结果；识别为 UNKNOWN 时按补答形态推断，
      // 否则用户只勾选项、不改“题型纠正”会遇到 UNKNOWN 永远校验不通过。
      const type = entry.questionType
        ?? (item.captured.question.type !== "UNKNOWN"
          ? item.captured.question.type
          : inferManualQuestionType(entry.answer));
      const question = { ...item.captured.question, type };
      try { return { item, question, answer: chooseAnswer(question, [entry.answer]).answer }; }
      catch { throw new Error(`第 ${item.index + 1} 题补答不完整，请核对选项或填写全部空格。`); }
    });
    this.state.manualSaving = true;
    let recovered = false;
    try {
      for (const { item, question, answer } of plans) {
        if (!await this.manualContext()) return;
        try {
          await this.port.command({ action: "APPLY", ...this.bound!, index: item.index, fingerprint: item.captured.fingerprint, answer,
            questionType: question.type });
        } catch (error) {
          item.reason = "录入未通过页面核验：" + (error instanceof Error ? error.message : "未知原因");
          throw error;
        }
        if ((this.state.phase as RunnerState["phase"]) === "STOPPED") return;
        item.resolved = true; this.state.filled++;
        item.reason = "录入成功，页面回读核验通过。";
        this.state.step = `第 ${item.index + 1} 题录入成功；剩余 ${this.state.manualItems.filter(item => !item.resolved).length} 题待答`;
      }
      if ((this.state.phase as RunnerState["phase"]) === "ERROR") {
        // 流水线已因错误停止：不再要求人工“重新启动以提交”，补答核验后直接自动提交并继续任务链。
        if (this.state.manualItems.every(item => item.resolved)) {
          this.state.step = "已补填人工答案；自动提交本任务并继续";
          recovered = true;
        }
      } else this.finishManual();
    } finally { this.state.manualSaving = false; this.notify(); }
    if (recovered) await this.recoverFromError();
  }
  async acceptManualFromPage(): Promise<void> {
    if (this.state.manualSaving || (this.state.phase !== "NEEDS_INPUT" && this.state.phase !== "ERROR")) return;
    this.state.manualSaving = true;
    let recovered = false;
    try {
      for (const item of this.state.manualItems.filter(candidate => !candidate.resolved)) {
        if (!await this.manualContext()) return;
        const result = await this.port.command({ action: "ADOPT_EXISTING", ...this.bound!, index: item.index });
        const phase = this.state.phase as RunnerState["phase"];
        if (phase !== "NEEDS_INPUT" && phase !== "ERROR") return;
        if (!result.captured || result.captured.fingerprint !== item.captured.fingerprint) throw new Error(`第 ${item.index + 1} 题已变化，请停止并重新读取。`);
        if (result.existingAccepted === true) { item.resolved = true; this.state.retained++; }
        else item.reason = "网页中未检测到本题全部答案，请填写完整后再核验。";
      }
      const unresolved = this.state.manualItems.filter(item => !item.resolved);
      if (unresolved.length) {
        this.state.step = `网页核验后仍有 ${unresolved.length} 题缺答`;
        throw new Error(`未检测到完整网页答案：第 ${unresolved.map(item => item.index + 1).join("、")} 题；未提交，请补全后再核验。`);
      }
      if ((this.state.phase as RunnerState["phase"]) === "ERROR") {
        const remaining = this.state.manualItems.filter(item => !item.resolved).length;
        if (remaining) this.state.step = `页面核验后仍有 ${remaining} 题待人工补答`;
        else { this.state.step = "已在网页补答并核验；自动提交本任务并继续"; recovered = true; }
      } else this.finishManual();
    } finally { this.state.manualSaving = false; }
    if (recovered) await this.recoverFromError();
  }

  async start(settings: Partial<RunOptions> = {}): Promise<void> {
    if (this.running || this.state.manualSaving) return;
    const options = { ...DEFAULT_OPTIONS, ...settings };
    this.options = options;
    if (!Number.isInteger(options.startQuestion) || options.startQuestion < 1 || options.startQuestion > 200 || !Number.isInteger(options.requestConcurrency) ||
        options.requestConcurrency < 1 || options.requestConcurrency > 3 ||
        !Number.isInteger(options.requestsPerMinute) || options.requestsPerMinute < 0 || options.requestsPerMinute > 10000 ||
        (options.sendImages !== "auto" && options.sendImages !== "always") || typeof options.skipVideos !== "boolean" ||
        typeof options.videosOnly !== "boolean" || (options.skipVideos && options.videosOnly)) {
      this.state.phase = "ERROR"; this.state.error = "调度参数无效。"; return;
    }
    this.bound = null;
    Object.assign(this.state, createRunnerState());
    await this.runLoop(options);
  }

  /**
   * The pinned scheduler loop: solve quizzes, submit, play videos and advance through the
   * task chain. Entered by start() and by ERROR recovery, so an authorized run keeps
   * moving after manual补答 without another人工点击. Recovery keeps the run counters;
   * start() resets them.
   */
  private async runLoop(options: RunOptions): Promise<void> {
    this.running = true;
    this.fatal = null;
    this.pausedAt = null; this.pausedTime = 0;
    this.state.busy = true;
    this.state.phase = "RUNNING"; this.state.error = "";
    this.state.manualItems = [];
    try {
      let snapshot = await this.inspect();
      this.bound = { courseKey: snapshot.courseKey, taskKey: snapshot.taskKey };
      const visited = new Set<string>();
      const recoveredNotices = new Set<string>();
      let startQuestion = options.startQuestion;
      while (await this.checkpoint()) {
        // A notice may already be open when a stopped runner is restarted. Close it via
        // the site's "to learn" action before interacting with the task beneath it.
        this.bound.taskKey = snapshot.taskKey;
        if (!snapshot.standalone && (await this.action("CONFIRM_NEXT")).nextNotice) {
          if (!await this.delay(1000)) return;
          snapshot = await this.inspect();
        }
        // 刚打开或刚切到新任务点时，课程页的视频 iframe / 题目文档常常还没建好，首次
        // INSPECT 会把任务读成 UNKNOWN。与点击 Next 后的等待一致：先有界等待页面稳定，
        // 仍未知才按未适配任务停止；不再让懒加载的视频页在两种模式下都立刻报
        // 「当前任务类型尚未适配」，看起来就像根本没有自动播放。
        const loading = (current: TaskSnapshot) => !current.completed && (current.kind === "UNKNOWN" ||
          current.kind === "QUIZ" && current.questionCount === 0 && !options.videosOnly);
        if (loading(snapshot)) {
          const settleDeadline = this.port.now() + 25000;
          do {
            if (!await this.delay(1000)) return;
            snapshot = await this.inspect();
          } while (loading(snapshot) && this.port.now() < settleDeadline);
        }
        const taskKeyBefore = snapshot.taskKey;
        let autoAdvanced = false;
        this.bound.taskKey = snapshot.taskKey;
        if (visited.has(snapshot.taskKey)) throw new Error("任务跳转形成循环，已停止，避免重复答题和计费。");
        this.state.questionCount = snapshot.questionCount;
        this.state.question = 0; this.state.captured = 0; this.state.agreement = "";
        this.state.collected = 0; this.state.filled = 0; this.state.retained = 0; this.state.manualItems = [];
        this.state.videoStatus = "";
        if (snapshot.standalone) {
          // 独立作业/测验作答页（2026-10-20 授权）：整卷作答一次、核验通过后点站点提交，
          // 没有任务链可继续，确认提交即结束本轮。
          await this.runStandaloneWork(snapshot, options, startQuestion);
          return;
        }
        if (!options.continueTasks && snapshot.kind !== "QUIZ") throw new Error("刷题按钮仅处理当前章节题目任务。");
        if (!snapshot.completed && snapshot.kind === "QUIZ" && options.videosOnly) {
          // 只刷课模式：用户只要视频。题目任务不读题、不调用模型、不提交，带显式跳过授权
          // 进入下一任务点（与刷题模式跳过视频对称），也不计入已完成任务。
          this.state.step = "只刷课模式：跳过题目任务，不读取、不调用模型、不提交";
        } else if (!snapshot.completed && snapshot.kind === "QUIZ") {
          if (!snapshot.questionCount || snapshot.questionCount > 200) throw new Error("任务题目数量不受支持。");
          if (startQuestion > snapshot.questionCount) throw new Error("起始题号超过当前任务题目数量。");
          await this.solveQuiz(snapshot, { ...options, startQuestion });
          startQuestion = 1;
          if (!await this.checkpoint()) return;
          this.state.step = `已回填 ${this.state.filled}/${snapshot.questionCount} 题，提交本任务并等待站点确认`;
          await this.action("SEND_WORK");
          const deadline = this.port.now() + 60000;
          do {
            if (!await this.delay(1000)) return;
            // The site may advance as soon as the submit is accepted; CONFIRM_WORK is bound
            // to the old task key and would reject. Inspect first instead of failing the run.
            try { await this.action("CONFIRM_WORK"); } catch { /* page may have advanced */ }
            snapshot = await this.inspect();
            if (snapshot.taskKey !== this.bound.taskKey) { autoAdvanced = true; break; }
            this.state.step = `已点击提交，等待站点确认（剩余 ${Math.max(0, Math.ceil((deadline - this.port.now()) / 1000))} 秒）`;
          } while (!snapshot.completed && this.port.now() < deadline);
          if (!snapshot.completed && !autoAdvanced) throw new Error("站点尚未确认提交成功；不会重复提交或跳到下一任务。");
        } else if (!snapshot.completed && snapshot.kind === "VIDEO" && options.skipVideos) {
          this.state.step = "刷题模式：跳过视频任务，直接进入下一任务点";
        } else if (!snapshot.completed && snapshot.kind === "VIDEO") {
          this.state.step = "正常播放视频，等待实际播放结束及任务完成";
          let popupPasses = 0;
          // A restarted run may already be parked at a forced question. Playing first can
          // exhaust all retries before the question gets a chance to release the player.
          if (snapshot.video?.paused && !snapshot.video.ended) {
            const popup = await this.enumPopup();
            if (popup.found && !popup.resolved) throw new Error(`视频弹题自动作答未通过（已枚举 ${popup.attempts}/${popup.options} 个选项，弹题仍在），请人工处理后重新启动。`);
            if (popup.resolved) popupPasses++;
          }
          await this.playWithRetry();
          snapshot = await this.inspect();
          if (snapshot.taskKey !== this.bound.taskKey) throw new Error("播放期间任务已变化。");
          this.state.videoStatus = this.videoStatusOf(snapshot.video);
          let lastPlayAt = this.port.now();
          let endedAt: number | null = null;
          let lastTime = snapshot.video?.currentTime ?? 0;
          let progressAt = this.port.now();
          let seenPausedTime = this.pausedTime;
          let videoDeadline = this.port.now() + Math.max(600000, Math.min(14400000, ((snapshot.video?.duration ?? 0) + 300) * 1000));
          while (!snapshot.completed) {
            if (!await this.delay(2500)) return;
            snapshot = await this.inspect();
            if (snapshot.taskKey !== this.bound.taskKey) throw new Error("播放期间任务已变化。");
            if (snapshot.completed) break;
            this.state.videoStatus = this.videoStatusOf(snapshot.video);
            if (this.pausedTime !== seenPausedTime) {
              videoDeadline += this.pausedTime - seenPausedTime;
              seenPausedTime = this.pausedTime; progressAt = this.port.now();
            }
            if (!snapshot.video) throw new Error("监听发现播放器已移除，已停止。");
            if (snapshot.video.paused && !snapshot.video.ended) {
              // 站点弹题会暂停视频：先按 2026-10-19 授权免人工枚举作答（不调模型），再走恢复播放。
              const popup = await this.enumPopup();
              if (popup.found && popup.resolved) {
                if (++popupPasses > 10) throw new Error("同一视频的弹题已连续自动作答超过 10 次，已停止，请人工检查。");
                this.state.videoStatus = `视频弹题已自动作答（枚举第 ${popup.attempts} 个选项通过），等待视频继续`;
                progressAt = this.port.now();
                lastTime = snapshot.video.currentTime;
                try { if (snapshot.video.paused) await this.playWithRetry(); } catch { /* 下一轮轮询继续恢复 */ }
                continue;
              }
              if (popup.found) throw new Error(`视频弹题自动作答未通过（已枚举 ${popup.attempts}/${popup.options} 个选项，弹题仍在），请人工处理后重新启动。`);
            }
            if (snapshot.video.currentTime > lastTime || snapshot.completed || snapshot.video.ended) progressAt = this.port.now();
            lastTime = snapshot.video.currentTime;
            if (this.port.now() - progressAt > 60000) throw new Error(snapshot.video.error
              ? "播放器错误持续超过 60 秒且没有播放进展，请检查课程页面或网络。"
              : "视频超过 60 秒没有播放进展，请检查前台播放或网络要求。");
            if (snapshot.video?.ended) endedAt ??= this.port.now();
            if ((endedAt !== null && this.port.now() - endedAt > 60000) || this.port.now() > videoDeadline) {
              throw new Error("视频播放后站点仍未确认任务完成，请人工检查；不会跳过任务。");
            }
            if (snapshot.video.paused && !snapshot.video.ended && this.port.now() - lastPlayAt >= 5000) {
              // A brief network switch may pause/rebuffer several times. Use actual elapsed
              // time without progress as the limit, rather than just three polling samples.
              lastPlayAt = this.port.now();
              try { await this.action("PLAY"); }
              catch (error) { this.state.videoStatus = `正在恢复播放：${error instanceof Error ? error.message : "播放器暂未就绪"}`; }
            }
          }
          this.state.videoStatus = "站点已确认完成";
        } else if (!snapshot.completed && snapshot.kind === "RESOURCE") {
          if (options.videosOnly) {
            this.state.step = "已打开 PPT/PDF 资料，继续寻找下一个非题目任务点（未确认完成的资料仅计越过）";
          } else {
            this.state.step = "已打开资料任务，等待站点确认完成";
            const deadline = this.port.now() + 60000;
            do {
              if (!await this.delay(1000)) return;
              snapshot = await this.inspect();
              if (snapshot.taskKey !== this.bound.taskKey) throw new Error("资料任务已变化。");
            } while (!snapshot.completed && this.port.now() < deadline);
            if (!snapshot.completed) throw new Error("站点尚未确认资料任务完成；可使用只刷课模式继续寻找非题目任务。");
          }
        } else if (!snapshot.completed && snapshot.kind !== "MATERIAL" && snapshot.kind !== "VIDEO") {
          throw new Error("当前任务类型尚未适配，请人工处理后再启动。");
        }
        if (!await this.checkpoint()) return;
        visited.add(taskKeyBefore);
        if (autoAdvanced) {
          // The site already moved on after our submit: the task that was processed is the
          // submitted QUIZ, not the task we just landed on. Count it and let the next loop
          // iteration handle the new snapshot (which has not been processed yet).
          this.state.completedTasks++;
          if (!options.continueTasks) { this.state.phase = "DONE"; this.state.step = "当前章节刷题完成"; return; }
          continue;
        }
        const skippedVideo = options.skipVideos && snapshot.kind === "VIDEO" && !snapshot.completed;
        const skippedQuiz = options.videosOnly && snapshot.kind === "QUIZ" && !snapshot.completed;
        const skippedResource = snapshot.kind === "MATERIAL" || options.videosOnly && snapshot.kind === "RESOURCE" && !snapshot.completed;
        if (skippedResource) this.state.skippedResources++;
        else if (skippedVideo) this.state.skippedVideos++;
        else if (skippedQuiz) this.state.skippedQuizzes++;
        else this.state.completedTasks++;
        if (!options.continueTasks) { this.state.phase = "DONE"; this.state.step = "当前章节刷题完成"; return; }
        if (!snapshot.hasNext) { this.state.phase = "DONE"; this.state.step = "已到最后一个任务"; return; }
        this.state.step = skippedResource ? "越过已识别的资料/图文卡片，寻找下一个非题目任务点" : "进入下一个任务";
        const previous = snapshot.taskKey;
        // 只有两种「故意越过未完成任务点」的 NEXT 才带页面侧跳过授权：刷题模式越过未完成视频、
        // 只刷课模式越过未完成题目；其余 NEXT 仍要求站点已确认完成或任务是无任务标记的资料页
        // （见 course-page 的 NEXT 守卫）。
        await this.action("NEXT", (skippedVideo || skippedQuiz || skippedResource && snapshot.kind === "RESOURCE") ? { allowSkipUnfinished: true } : {});
        const deadline = this.port.now() + 25000;
        let learnedRemaining = false;
        do {
          if (!await this.delay(1000)) return;
          snapshot = await this.inspect();
          if (snapshot.taskKey === previous) {
            // A lazy quiz can appear while leaving a video on the same card. The old
            // video skip must not become permission to skip that newly discovered quiz.
            const confirmSkip = (skippedVideo && snapshot.kind === "VIDEO") || (skippedQuiz && snapshot.kind === "QUIZ") ||
              (skippedResource && snapshot.kind === "RESOURCE");
            const notice = await this.action("CONFIRM_NEXT", confirmSkip ? { allowSkipUnfinished: true } : {});
            if (notice.nextNotice === "LEARN_REMAINING") {
              if (recoveredNotices.has(previous)) throw new Error("同一任务重复出现未完成提示，已停止，避免循环作答。");
              recoveredNotices.add(previous);
              this.state.step = "站点提示仍有未完成任务，返回当前章节继续处理";
              // Returning from the notice may navigate/re-render the chapter; a lazy task frame
              // can take several seconds to appear. Keep polling boundedly instead of declaring
              // failure after a single 1s sample (same 25s family as the other navigation waits).
              const reappearDeadline = this.port.now() + 15000;
              let reappearError: unknown = null;
              let reappeared = false;
              do {
                if (!await this.delay(1000)) return;
                try { snapshot = await this.inspect(); reappearError = null; }
                catch (inspectError) { reappearError = inspectError; continue; }
                if (snapshot.taskKey !== previous) { reappeared = true; break; }
                // Same card but a real remaining task is now rendered (quiz/video) — process it.
                if (!snapshot.completed && snapshot.kind !== "UNKNOWN") { reappeared = true; break; }
              } while (this.port.now() < reappearDeadline);
              if (!reappeared && reappearError) throw reappearError;
              if (snapshot.taskKey === previous) {
                // Lazy task frames can appear only after the notice sends us back. Undo
                // the provisional card count and allow this same card to be processed.
                visited.delete(previous);
                if (skippedVideo) this.state.skippedVideos--;
                else if (skippedQuiz) this.state.skippedQuizzes--;
                else if (skippedResource) this.state.skippedResources--;
                else this.state.completedTasks = Math.max(0, this.state.completedTasks - 1);
                if (snapshot.completed) throw new Error("站点提示有未完成任务，但尚未定位到剩余任务，请检查课程页面。");
              }
              learnedRemaining = true;
              break;
            }
          }
        } while ((snapshot.taskKey === previous || snapshot.kind === "UNKNOWN") && this.port.now() < deadline);
        if (!learnedRemaining && snapshot.taskKey === previous) throw new Error("页面没有切换到下一任务，已停止。");
      }
    } catch (error) {
      if ((this.state.phase as RunnerState["phase"]) !== "STOPPED") {
        this.state.phase = "ERROR"; this.state.error = error instanceof Error ? error.message : "任务执行失败。";
        this.state.step = "已停止，需要人工处理";
      }
    } finally {
      this.notify();
      if (this.bound) await this.port.command({ action: "RELEASE", ...this.bound }).catch(() => undefined);
      this.running = false;
      this.state.busy = false;
    }
  }
}
