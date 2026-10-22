<script setup lang="ts">
import UpdateMenu from "../updates/UpdateMenu.vue";
import QuestionBoard from "./QuestionBoard.vue";
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import type { ProviderProfile, StudyAnswer, StudyQuestion } from "@study/contracts";
import { PRIVACY_VERSION } from "@study/contracts";
import { fetchMe, fetchProviderProfiles, fetchAutomationLimits, generateAnswer, login, describeProblem } from "../api/client";
import type { AutomationLimits } from "../api/client";
import { clearSession, loadSession, saveSession } from "../api/session";
import { loadRunnerPreferences, loadSettings, saveRunnerPreferences } from "../api/settings";
import { BUILD_BACKEND_ORIGIN } from "../shared/buildConfig";
import { randomId } from "../shared/ids";
import { isSitePermissionGranted, readPermissionSite, readTabIdFromSearch, requestSitePermission, sitePermissionOrigin } from "../sidepanel/bridge";
import { sendAutomationCommand } from "./protocol";
import type { TaskDiagnostics, TaskQuestion } from "./protocol";
import { CourseRunner, createRunnerState } from "./runner";
import { WorkPool } from "./work-pool";
import { DISCUSSION_ORIGIN } from "../shared/pages";
import type { ManualQuestion } from "./runner";
import { QuestionImageError } from "./question-image-error";
import { askLocalProvider, loadActiveProvider } from "../local/provider";
import type { LocalProvider } from "../local/provider";
import { copyPng, copyText } from "../sidepanel/clipboard";
import type { TextCopyResult } from "../sidepanel/clipboard";
import { questionToMarkdown, questionsToMarkdown } from "../shared/question-markdown";
import { ring, setAlarmVolume, stopAlarm, unlockAlarm } from "../shared/alarm";

const tabId = readTabIdFromSearch(location.search);
let commandTabId = tabId;
const discussionGranted = ref(false);
const discussionPermissionNotice = ref("");
async function grantDiscussionPermission(): Promise<void> {
  try {
    discussionGranted.value = await requestSitePermission(DISCUSSION_ORIGIN);
    discussionPermissionNotice.value = discussionGranted.value ? "已授权讨论页面；回复核验后自动发表。" : "未授予讨论页面权限。";
  } catch { discussionPermissionNotice.value = "讨论页面授权失败，请重试。"; }
}
const state = reactive(createRunnerState());
const token = ref<string | null>(null);
const localProvider = ref<LocalProvider | null>(null);

function openOptions(): void {
  void chrome.runtime.openOptionsPage();
}
const provider = ref<ProviderProfile | null>(null);
const origin = ref(BUILD_BACKEND_ORIGIN);
const error = ref("");
const consent = ref(false);
const site = ref("");
const siteGranted = ref(false);
const siteChecked = ref(false);
const permissionNotice = ref("");
const previewImages = reactive<Record<number, { fingerprint: string; dataUrl: string }>>({});
const imageQuestions = reactive<Record<number, string>>({});
const failedQuestionIndices = computed(() => state.manualItems.filter(item => !item.resolved && inventory.value.some(source => source.index === item.index && source.fingerprint === item.captured.fingerprint)).map(item => item.index));
const imageQuestionIndices = computed(() => inventory.value.filter(item => imageQuestions[item.index] === item.fingerprint).map(item => item.index));
const previewBusy = reactive<Record<number, boolean>>({});
const previewPool = new WorkPool(2);
const previewErrors = reactive<Record<number, string>>({});
const taskMode = ref<"course" | "questions" | "videos">("course");
let inventoryTask = "";
const inventory = ref<TaskQuestion[]>([]);
const questionBoard = ref<InstanceType<typeof QuestionBoard> | null>(null);
const previewLoading = ref(false);
const preparing = ref(false);
const limits = ref<AutomationLimits | null>(null);
const startQuestion = ref(1);
const alwaysImage = ref(true);
// 0.2.8 M1：站点允许时把视频定位到末尾触发其自身完成判定；已适配资料滚动到底。均默认开启。
const allowVideoSeek = ref(true);
const allowMaterialScroll = ref(true);
// 拖动可接受性按课程缓存（"allowed"/"denied"），下次同一课程运行前直接套用，省掉重复试探。
const videoSeekPolicies = reactive<Record<string, "allowed" | "denied" | "unknown">>({});
let activeCourseKey = "";
const manualDrafts = reactive<Record<number, { selected: string[]; blanks: Record<string, string>; text: string; multi: boolean; type: string; edited: boolean; context: string }>>({});
const manualErrors = reactive<Record<number, string>>({});
const credentials = reactive({ username: "", password: "" });
const loading = ref(false);
let runId = randomId();
// 仅供本可信扩展页诊断/端到端测试寻址同一课程租约使用：随机临时 ID，不含任何题目或密钥。
(window as typeof window & { __courseRunId?: string }).__courseRunId = runId;
const running = computed(() => state.busy || preparing.value);
const ready = computed(() => tabId !== null && consent.value && !previewLoading.value &&
  (localProvider.value !== null || (Boolean(token.value) && provider.value?.verification.status === "VERIFIED" && limits.value !== null)) &&
  Number.isInteger(startQuestion.value) && startQuestion.value >= 1 && startQuestion.value <= 200);
// 只刷课模式不调用模型：不需要配置供应商，只需绑定课程标签与一次性运行授权。
const readyVideosOnly = computed(() => tabId !== null && consent.value && !previewLoading.value);
const runner = new CourseRunner(state, {
  async returnToCourse() { commandTabId = tabId; },
  async command(command) {
    if (tabId === null) throw new Error("没有绑定课程标签，请从课程页面打开调度器。");
    const response = await sendAutomationCommand(commandTabId ?? tabId, { ...command, requestId: randomId(), runId });
    if (!response.ok) {
      if (response.questionIssue === "IMAGE_UNREADABLE") throw new QuestionImageError(response.detail, response.captured);
      throw new Error(response.detail);
    }
    if (command.action === "OPEN_DISCUSSION" && typeof response.discussionTabId === "number") commandTabId = response.discussionTabId;
    return response;
  },
  async readQuestion(index, snapshot) {
    if (tabId === null) throw new Error("没有绑定课程标签。");
    const key = `${snapshot.courseKey}:${snapshot.taskKey}`;
    if (key !== inventoryTask) { inventoryTask = key; inventory.value = []; clearPreviewImages(); }
    const response = await sendAutomationCommand(commandTabId ?? tabId, { action: "READ_ONE", index, courseKey: snapshot.courseKey,
      taskKey: snapshot.taskKey, requestId: randomId(), runId });
    if (!response.ok) throw new Error(response.detail);
    if (!response.captured) throw new Error("单题源数据读取响应不完整。");
    if (inventoryTask === key) rememberQuestion(response.captured);
    return response.captured;
  },
  async answer(captured) {
    rememberQuestion(captured);
    if (localProvider.value) return askLocalProvider(localProvider.value, captured.question, { requireImage: captured.imageRequired || captured.needsImage === true });
    if (!token.value || !provider.value) throw new Error("请先配置供应商。");
    const result = await generateAnswer(origin.value, token.value, {
      providerProfileId: provider.value.id, expectedProfileVersion: provider.value.version, sourceMode: "ADAPTER",
      question: captured.question, consent: { shareQuestionWithSelectedProvider: true, privacyVersion: PRIVACY_VERSION }
    }, randomId());
    if (!result.ok) {
      // Backend request-format failures (VALIDATION_ERROR) are run-level, not per-question:
      // mark them so the runner stops instead of turning every question into a manual item.
      throw Object.assign(new Error(describeProblem(result)), {
        code: result.code,
        ...(result.code === "VALIDATION_ERROR" ? { questionScoped: false } : {})
      });
    }
    return result.data.answer;
  },
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  now: Date.now
});

async function refreshProvider(): Promise<void> {
  if (localProvider.value) return;
  if (!token.value) return;
  const me = await fetchMe(origin.value, token.value);
  const profiles = await fetchProviderProfiles(origin.value, token.value);
  if (!me.ok) {
    if (me.status === 401) { await clearSession(); token.value = null; provider.value = null; }
    throw new Error(describeProblem(me));
  }
  if (!profiles.ok) throw new Error(describeProblem(profiles));
  provider.value = profiles.data.find(p => p.id === me.data.defaultProviderProfileId) ?? null;
  if (!provider.value || provider.value.model !== "deepseek-flash" || provider.value.protocol !== "CHAT_COMPLETIONS") {
    throw new Error("请先将已验证的 deepseek-flash / Chat Completions 配置设为默认供应商。");
  }
  const meta = await fetchAutomationLimits(origin.value);
  if (!meta.ok) { limits.value = null; throw new Error(describeProblem(meta)); }
  limits.value = meta.data;
}
async function doLogin(): Promise<void> {
  loading.value = true; error.value = "";
  try {
    const result = await login(origin.value, credentials.username, credentials.password);
    if (!result.ok) throw new Error(describeProblem(result));
    const session = await saveSession(result.data);
    token.value = session.accessToken; credentials.password = "";
    await refreshProvider();
  } catch (e) { error.value = e instanceof Error ? e.message : "登录失败。"; }
  finally { loading.value = false; }
}
async function refreshSitePermission(): Promise<void> {
  siteGranted.value = await isSitePermissionGranted(site.value);
  discussionGranted.value = await isSitePermissionGranted(DISCUSSION_ORIGIN);
  siteChecked.value = true;
}
function onPermissionMaybeChanged(): void {
  // Permissions can be granted/revoked from the side panel or Chrome extension details.
  if (document.visibilityState !== "visible") return;
  void refreshSitePermission();
  // P2/P3: returning to a run page that was backgrounded — compensate one throttled submission
  // wait (re-check the dialog + refresh state) without ever re-clicking submit.
  void runner.onForeground();
}
async function grantSite(): Promise<void> {
  try {
    if (await requestSitePermission(site.value)) {
      siteGranted.value = true;
      permissionNotice.value = "";
      return;
    }
    await refreshSitePermission();
    permissionNotice.value = "未授予权限，可回到课程标签点击扩展图标后再启动。";
  } catch { permissionNotice.value = "站点授权失败，请检查 Chrome 扩展的网站访问权限。"; }
}
async function start(continueTasks = true, skipVideos = false, videosOnly = false): Promise<void> {
  if (running.value) return;
  if (videosOnly ? !readyVideosOnly.value : !ready.value) return;
  // 用户点击即解锁音频：后续错误/待补答/弹题失败的声音提醒才能真的出声。
  unlockAlarm();
  error.value = "";
  preparing.value = true;
  try {
    commandTabId = tabId;
    let concurrency = 2;
    let perMinute = 0;
    if (!videosOnly) {
      // Re-read the saved provider so a settings change (API key, model, image toggle) made
      // after this runner page was opened is honoured by the next run.
      const latest = await loadActiveProvider();
      if (latest) {
        localProvider.value = latest;
        // Local direct mode has no server quotas; the runner still keeps its own pacing.
        limits.value ??= { perUserConcurrency: 0, requestsPerMinute: 0, requestsPerDay: 0 };
        token.value = "local";
      } else if (!localProvider.value) {
        await refreshProvider();
      }
      if (!limits.value) throw new Error("无法读取后端限额。");
      concurrency = limits.value.perUserConcurrency > 0 ? Math.min(2, limits.value.perUserConcurrency) : 2;
      perMinute = limits.value.requestsPerMinute > 0 ? Math.min(10000, limits.value.requestsPerMinute) : 0;
    }
    preparing.value = false;
    // 拖动策略按课程缓存：运行前尽力读取当前课程标识，套用上次学到的可拖性，避免重复试探。
    activeCourseKey = "";
    let initialSeekPolicy: "allowed" | "denied" | "unknown" = "unknown";
    if (allowVideoSeek.value && tabId !== null) {
      try {
        const status = await sendAutomationCommand(commandTabId ?? tabId, { action: "INSPECT", requestId: randomId(), runId });
        if (status.ok && status.snapshot) {
          activeCourseKey = status.snapshot.courseKey;
          initialSeekPolicy = videoSeekPolicies[activeCourseKey] ?? "unknown";
        }
      } catch { /* 读取失败按 unknown 试探 */ }
    }
    await runner.start({ startQuestion: startQuestion.value, requestConcurrency: concurrency,
      requestsPerMinute: perMinute, continueTasks, sendImages: alwaysImage.value ? "always" : "auto", skipVideos, videosOnly,
      allowVideoSeek: allowVideoSeek.value, videoSeekPolicy: initialSeekPolicy, allowMaterialScroll: allowMaterialScroll.value });
  } catch (e) { error.value = e instanceof Error ? e.message : "启动失败。"; }
  finally { preparing.value = false; }
}

/** 声音提醒：出错时强提醒并每 30 秒重复（使用者可能在看别的窗口）；待人工补答提示一次。 */
const soundEnabled = ref(true);
const alarmVolume = ref(0.7);
setAlarmVolume(alarmVolume.value);
let alarmTimer: ReturnType<typeof setInterval> | null = null;
function stopAlarmRepeat(): void {
  if (alarmTimer !== null) { clearInterval(alarmTimer); alarmTimer = null; }
  stopAlarm();
}
function startAlarmRepeat(): void {
  stopAlarmRepeat();
  let repeats = 0;
  alarmTimer = setInterval(() => {
    if (!soundEnabled.value || state.phase !== "ERROR" || repeats >= 20) { stopAlarmRepeat(); return; }
    repeats += 1;
    ring("error", 2);
  }, 30000);
}
watch(() => state.phase, (phase, previous) => {
  if (phase === previous) return;
  if (phase === "ERROR") {
    // 运行出错需要人工处理（含视频弹题枚举失败）：播放自定义/内置告警音并重复，直到用户回来处理或静音。
    if (soundEnabled.value) { ring("error", 3); startAlarmRepeat(); }
  } else if (phase === "NEEDS_INPUT" && soundEnabled.value) {
    ring("needsInput", 1);
  }
  if (phase !== "ERROR") stopAlarmRepeat();
});
watch(soundEnabled, enabled => { if (!enabled) stopAlarmRepeat(); });
function onUserAttention(): void { stopAlarmRepeat(); }
/** 运行偏好（0.2.8 M1）：拖动/滚动开关、声音开关与音量、按课程缓存的可拖性；存储封装在 api/settings。 */
async function loadRunnerPrefs(): Promise<void> {
  try {
    const prefs = await loadRunnerPreferences();
    allowVideoSeek.value = prefs.allowVideoSeek;
    allowMaterialScroll.value = prefs.allowMaterialScroll;
    soundEnabled.value = prefs.soundEnabled;
    alarmVolume.value = prefs.alarmVolume;
    for (const key of Object.keys(videoSeekPolicies)) delete videoSeekPolicies[key];
    Object.assign(videoSeekPolicies, prefs.videoSeekPolicies);
  } catch { /* 存储不可用则保持默认值 */ }
}
async function saveRunnerPrefs(): Promise<void> {
  try {
    await saveRunnerPreferences({ allowVideoSeek: allowVideoSeek.value, allowMaterialScroll: allowMaterialScroll.value,
      soundEnabled: soundEnabled.value, alarmVolume: alarmVolume.value, videoSeekPolicies: { ...videoSeekPolicies } });
  } catch { /* 忽略持久化失败：本机偏好不影响本次运行 */ }
}
watch([allowVideoSeek, allowMaterialScroll, soundEnabled, alarmVolume], () => { void saveRunnerPrefs(); });
watch(alarmVolume, value => setAlarmVolume(Math.min(1, Math.max(0, value))));
watch(() => state.videoSeekPolicy, policy => {
  if (activeCourseKey && (policy === "allowed" || policy === "denied") && videoSeekPolicies[activeCourseKey] !== policy) {
    videoSeekPolicies[activeCourseKey] = policy; void saveRunnerPrefs();
  }
});
async function previewCurrentQuestion(): Promise<void> {
  if (tabId === null || previewLoading.value) return;
  previewLoading.value = true;
  error.value = "";
  try {
    const status = await sendAutomationCommand(commandTabId ?? tabId, { action: "INSPECT", requestId: randomId(), runId });
    if (!status.ok) throw new Error(status.detail);
    if (!status.snapshot || status.snapshot.kind !== "QUIZ") return;
    const result = await sendAutomationCommand(commandTabId ?? tabId, { action: "READ_ALL", requestId: randomId(), runId,
      courseKey: status.snapshot.courseKey, taskKey: status.snapshot.taskKey });
    if (!result.ok) throw new Error(result.detail);
    if (!result.questions) throw new Error("整份题目读取响应不完整。");
    const task = `${status.snapshot.courseKey}:${status.snapshot.taskKey}`;
    if (inventoryTask !== task) clearPreviewImages();
    inventoryTask = task;
    inventory.value = result.questions;
  } catch (e) { error.value = e instanceof Error ? e.message : "预览失败。"; }
  finally { previewLoading.value = false; }
}
function clearPreviewImages(): void {
  for (const key of Object.keys(imageQuestions)) delete imageQuestions[Number(key)];
  for (const key of Object.keys(previewImages)) delete previewImages[Number(key)];
  for (const key of Object.keys(previewErrors)) delete previewErrors[Number(key)];
}
function rememberQuestion(captured: TaskQuestion): void {
  const previous = inventory.value.find(item => item.index === captured.index);
  if (previous && previous.fingerprint !== captured.fingerprint) delete previewImages[captured.index];
  inventory.value = [...inventory.value.filter(item => item.index !== captured.index), captured].sort((a, b) => a.index - b.index);
  if (captured.needsImage || captured.imageRequired || captured.imageSource === "originals") imageQuestions[captured.index] = captured.fingerprint;
  if (captured.question.imageDataUrl && captured.imageSource !== "originals") previewImages[captured.index] = { fingerprint: captured.fingerprint, dataUrl: captured.question.imageDataUrl };
}
async function previewFallback(item: TaskQuestion): Promise<void> {
  const index = item.index;
  if (tabId === null || previewBusy[index]) return;
  const cached = previewImages[index];
  if (cached?.fingerprint === item.fingerprint) return;
  const expectedTask = inventoryTask;
  previewBusy[index] = true; previewErrors[index] = "";
  try {
    await previewPool.run(async () => {
      const status = await sendAutomationCommand(commandTabId ?? tabId, { action: "INSPECT", requestId: randomId(), runId });
      if (!status.ok || !status.snapshot) throw new Error("课程状态不可用。");
      if (`${status.snapshot.courseKey}:${status.snapshot.taskKey}` !== expectedTask) throw new Error("课程已切换任务，请查看新任务的题目。");
      const result = await sendAutomationCommand(commandTabId ?? tabId, { action: "CAPTURE", forceImage: true, imagePass: "whole", requestId: randomId(), runId,
        courseKey: status.snapshot.courseKey, taskKey: status.snapshot.taskKey, index });
      if (!result.ok) throw new Error(result.detail);
      if (inventoryTask !== expectedTask || result.captured?.fingerprint !== item.fingerprint) throw new Error("题目已变化，请重新读取。");
      const dataUrl = result.captured.question.imageDataUrl;
      if (!dataUrl) throw new Error("未取得可预览的题图。");
      previewImages[index] = { fingerprint: item.fingerprint, dataUrl };
    });
  } catch (e) { previewErrors[index] = e instanceof Error ? e.message : "图像读取失败。"; }
  finally { previewBusy[index] = false; }
}
function startSelectedMode(): Promise<void> {
  return start(true, taskMode.value === "questions", taskMode.value === "videos");
}
watch(() => `${state.completedTasks}|` + state.manualItems.map(item => `${item.index}:${item.captured.fingerprint}:${item.samples.length}`).join(","), () => {
  for (const key of Object.keys(manualDrafts)) {
    if (!state.manualItems.some(item => item.index === Number(key))) { delete manualDrafts[Number(key)]; delete manualErrors[Number(key)]; }
  }
  for (const item of state.manualItems) {
    const context = `${state.completedTasks}:${item.captured.fingerprint}`;
    if (manualDrafts[item.index]?.edited && manualDrafts[item.index]!.context === context) continue;
    const candidate = item.candidates[0]?.answer;
    manualDrafts[item.index] = { selected: [...(candidate?.selectedOptionIds ?? [])],
      blanks: Object.fromEntries((candidate?.blankAnswers ?? []).map(blank => [blank.blankId, blank.answer])),
      text: candidate?.textAnswer ?? "", multi: false, type: "", edited: false, context };
  }
});
/** Effective type after the learner's "题型纠正" choice (empty = keep the captured type). */
function effectiveType(item: ManualQuestion): string {
  const draft = manualDrafts[item.index];
  return draft?.type || item.captured.question.type;
}
function manualBlanks(item: ManualQuestion): Array<{ id: string; label: string }> {
  return effectiveType(item) === "FILL_BLANK" ? item.captured.question.blanks : [];
}
function manualChoiceMultiple(item: ManualQuestion): boolean {
  return effectiveType(item) === "MULTIPLE_CHOICE" || Boolean(manualDrafts[item.index]?.multi);
}
function chooseManualOption(index: number, id: string, multiple: boolean, event: Event): void {
  const draft = manualDrafts[index]!;
  draft.edited = true;
  const checked = (event.target as HTMLInputElement).checked;
  draft.selected = multiple ? checked ? [...new Set([...draft.selected, id])] : draft.selected.filter(value => value !== id) : checked ? [id] : [];
}
async function submitManual(fromPage = false, index?: number): Promise<void> {
  error.value = "";
  if (index !== undefined) manualErrors[index] = "";
  try {
    if (fromPage) { await runner.acceptManualFromPage(); return; }
    const items = state.manualItems.filter(item => !item.resolved && (index === undefined || item.index === index));
    await runner.submitManual(items.filter(item => {
      const draft = manualDrafts[item.index];
      return index !== undefined || (draft && (draft.selected.length || draft.text.trim() || Object.values(draft.blanks).some(value => value.trim())));
    }).map(item => {
      const draft = manualDrafts[item.index]!;
      const rawType = item.captured.question.type;
      // The effective type keeps the captured label unless the learner corrected it; the
      // multi checkbox on an otherwise single-choice question also means MULTIPLE_CHOICE.
      const type = draft.multi && !draft.type ? "MULTIPLE_CHOICE" : (draft.type || rawType);
      const answer: StudyAnswer = { status: "ANSWERED", selectedOptionIds: draft.selected,
        blankAnswers: type === "FILL_BLANK" ? item.captured.question.blanks.map(blank => ({ blankId: blank.id, answer: draft.blanks[blank.id] ?? "" })) : [],
        textAnswer: type === "SHORT_ANSWER" ? draft.text : null, explanation: "用户手动补答", caveats: [] };
      return { index: item.index, answer, ...(type !== rawType ? { questionType: type as StudyQuestion["type"] } : {}) };
    }));
  } catch (e) {
    error.value = e instanceof Error ? e.message : "补答核验失败。";
    if (index !== undefined) manualErrors[index] = error.value;
  }
}
function answerText(item: Pick<ManualQuestion, "captured">, answer: StudyAnswer): string {
  const question = item.captured.question;
  const parts: string[] = [];
  if (answer.selectedOptionIds.length) {
    parts.push(answer.selectedOptionIds.map(id => question.options.find(option => option.id === id)?.text || id).join("、"));
  }
  for (const blank of answer.blankAnswers) {
    parts.push((question.blanks.find(expected => expected.id === blank.blankId)?.label || blank.blankId) + "：" + blank.answer);
  }
  if (answer.textAnswer) parts.push(answer.textAnswer);
  return parts.join("；") || "（未给出可用答案）";
}
function typeLabel(item: ManualQuestion): string {
  switch (item.captured.question.type) {
    case "MULTIPLE_CHOICE": return "多选题（可多选）";
    case "SINGLE_CHOICE": return "单选题";
    case "TRUE_FALSE": return "判断题";
    case "FILL_BLANK": return "填空题";
    case "SHORT_ANSWER": return "简答题";
    default: return "未知题型";
  }
}
function sampleLabel(item: Pick<ManualQuestion, "captured">, sample: StudyAnswer): string {
  const head = sample.status === "ANSWERED" ? answerText(item, sample) : sample.status === "NEEDS_CONTEXT" ? "需要更多上下文" : "拒绝作答";
  const caveats = sample.caveats.length ? "（不确定：" + sample.caveats.join("；").slice(0, 160) + "）" : "";
  const explanation = sample.explanation ? " — " + sample.explanation.slice(0, 120) : "";
  return head + caveats + explanation;
}
function candidateLabel(item: ManualQuestion, candidate: { answer: StudyAnswer; count: number }): string {
  return answerText(item, candidate.answer) + "（" + candidate.count + " 票）";
}
async function retryWithImage(index: number): Promise<void> {
  error.value = "";
  manualErrors[index] = "";
  try { await runner.retryWithImage(index); }
  catch (e) { manualErrors[index] = e instanceof Error ? e.message : "图片发送或回填失败。"; }
}
async function submitNow(): Promise<void> {
  error.value = "";
  try { await runner.submitNow(); }
  catch (e) { error.value = e instanceof Error ? e.message : "提交失败。"; }
}
/** P3: re-observe a submission already clicked, without ever clicking submit again. */
async function recheckSubmission(): Promise<void> {
  error.value = "";
  try { await runner.recheckSubmission(); }
  catch (e) { error.value = e instanceof Error ? e.message : "复核提交结果失败。"; }
}
/**
 * D2/D3 (0.2.8): one safe line for a failing machine to paste back. It carries ONLY structure
 * counters and short enum values plus the runner's own phase/completion tallies — never question
 * text, answers, URLs, HTML or a course identifier (privacy.md). The page-side TaskDiagnostics is
 * already redacted; this only formats it.
 */
function formatDiagnostics(d: TaskDiagnostics | undefined): string {
  if (!d) return "diagnostics: (尚未取得，运行或预览一次后重试)";
  return "diagnostics: " + [
    `docs=${d.documents}`, `iframes=${d.iframes}`, `cards=${d.cardsFrames}`, `num=${d.cardNumPresent ? 1 : 0}`,
    `mods=${d.modules}`, `kind=${d.moduleKind}`, `active=${d.activeModule}`, `anom=${d.anomalies}`,
    `mark=${d.markerCompleted}/${d.markerTotal}`, `unread=${d.markerUnreadable}`,
    `videos=${d.videoCount}`, `rs=${d.videoReadyState}`, `seek=${d.videoSeekable}`,
    `t=${d.currentTime}`, `dur=${d.duration}`, `ended=${d.ended ? 1 : 0}`, `paused=${d.paused ? 1 : 0}`,
    `pdf=${d.pdfReady ? 1 : 0}`, `scroll=${d.scrollableCandidates}`, `submit=${d.submitCandidates}`
  ].join(" ");
}
function diagnosticsLine(): string {
  return [
    `phase=${state.phase}`, `tasks=${state.completedTasks}`, `skipV=${state.skippedVideos}`,
    `skipQ=${state.skippedQuizzes}`, `skipR=${state.skippedResources}`,
    formatDiagnostics(state.diagnostics)
  ].join(" ");
}
async function copyDiagnostics(): Promise<void> {
  const line = diagnosticsLine();
  await presentCopyResult(await copyText(line), line);
}
const imageNotice = ref("");
const copyNotice = ref("");
const copyFallback = ref("");
const fallbackBox = ref<HTMLTextAreaElement | null>(null);

async function presentCopyResult(result: TextCopyResult, markdown: string): Promise<void> {
  if (result === "copied") {
    copyNotice.value = "已复制，可直接粘贴到其他 AI。";
    copyFallback.value = "";
    return;
  }
  // Automatic copy was refused: pre-select the text so one Ctrl+C finishes the job.
  copyNotice.value = "";
  copyFallback.value = markdown;
  await nextTick();
  fallbackBox.value?.focus();
  fallbackBox.value?.select();
}

async function copyAllQuestions(): Promise<void> {
  if (!inventory.value.length) return;
  const markdown = questionsToMarkdown(inventory.value);
  await presentCopyResult(await copyText(markdown), markdown);
}

async function copyOneQuestion(item: TaskQuestion): Promise<void> {
  const markdown = questionToMarkdown(item.question);
  const result = await copyText(markdown);
  if (document.querySelector<HTMLDialogElement>(".question-viewer")?.open) {
    copyNotice.value = result === "copied" ? "已复制 Markdown。" : "自动复制未获允许，请在左侧 Markdown 中选择文字并按 Ctrl+C。";
    return;
  }
  await presentCopyResult(result, markdown);
}

function downloadAllQuestions(): void {
  if (!inventory.value.length) return;
  const blob = new Blob([questionsToMarkdown(inventory.value)], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `questions-${inventory.value.length}-${Date.now()}.md`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  copyNotice.value = "已下载整份 Markdown 文件。";
  copyFallback.value = "";
}

async function copyQuestionImage(dataUrl: string): Promise<void> {
  imageNotice.value = "";
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法转换图片");
    context.drawImage(bitmap, 0, 0);
    const png = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(value => value ? resolve(value) : reject(new Error("无法转换图片")), "image/png");
    });
    if (await copyPng(png)) {
      imageNotice.value = "题目图片已复制，可直接粘贴到其他 AI。";
    } else {
      imageNotice.value = "复制图片失败：浏览器拒绝了剪贴板访问，可改用下载。";
    }
  } catch {
    imageNotice.value = "复制图片失败：浏览器拒绝或图片格式不支持，可改用下载。";
  }
}

function downloadQuestionImage(dataUrl: string, index: number): void {
  const link = document.createElement("a");
  link.href = dataUrl;
  link.download = "question-" + (index + 1) + ".png";
  link.click();
  imageNotice.value = "题目图片已下载。";
}

onMounted(async () => {
  document.addEventListener("visibilitychange", onPermissionMaybeChanged);
  window.addEventListener("focus", onPermissionMaybeChanged);
  // 用户回到运行页（点击/按键）即视为已注意到告警，停止重复响铃。
  window.addEventListener("pointerdown", onUserAttention);
  window.addEventListener("keydown", onUserAttention);
  try {
    origin.value = (await loadSettings()).backendOrigin;
    discussionGranted.value = await isSitePermissionGranted(DISCUSSION_ORIGIN);
    await loadRunnerPrefs();
    const local = await loadActiveProvider();
    if (local) {
      localProvider.value = local;
      token.value = "local";
      // Local mode has no server quotas; the runner still keeps its own pacing.
      limits.value = { perUserConcurrency: 0, requestsPerMinute: 0, requestsPerDay: 0 };
      provider.value = {
        id: local.id, name: local.name, baseUrl: local.baseUrl, protocol: local.protocol, model: local.model,
        enabled: true, version: 1, hasKey: true,
        capabilities: { instructionRole: local.instructionRole, outputMode: local.outputMode,
          tokenLimitField: local.tokenLimitField, supportsTemperature: local.supportsTemperature,
          supportsStoreFalse: local.supportsStoreFalse },
        generation: { maxOutputTokens: local.maxOutputTokens, temperature: local.temperature },
        verification: { status: "UNVERIFIED", verifiedVersion: 1, testedAt: null },
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
      };
    } else {
      const session = await loadSession();
      if (session) { token.value = session.accessToken; await refreshProvider(); }
    }
    if (tabId !== null) {
      site.value = await readPermissionSite(tabId);
      await refreshSitePermission();
    }
    await previewCurrentQuestion();
  } catch (e) { error.value = e instanceof Error ? e.message : "加载失败。"; }
});
onBeforeUnmount(() => {
  document.removeEventListener("visibilitychange", onPermissionMaybeChanged);
  window.removeEventListener("focus", onPermissionMaybeChanged);
  window.removeEventListener("pointerdown", onUserAttention);
  window.removeEventListener("keydown", onUserAttention);
  stopAlarmRepeat();
  runner.stop();
});
</script>

<template>
  <main class="app runner">
    <header class="topbar"><h1>课程任务调度</h1><span class="badge">课程标签 {{ tabId ?? "未绑定" }}</span><UpdateMenu :disabled="state.busy" /></header>
    <section class="card">
      <p>调度始终绑定此课程标签，不跟随你切换的标签，也不接管系统鼠标键盘。保持本运行页和课程页打开即可操作其他窗口。</p>
      <p class="hint">运行后边扫描边异步发送，答案汇总后按题号回填。首次回答不可用时自动在后台发送完整题图；自动处理结束仍无完整答案时才显示人工补答。运行期间可展开、预览和复制题目。</p>
    </section>
    <section v-if="localProvider" class="card">
      <p class="badge" data-testid="runner-local-provider">本地直连：{{ localProvider.name }} · 模型 {{ localProvider.model }}</p>
      <p class="hint" data-testid="runner-local-images">图像输入：{{ localProvider.supportsImages === false ? "未开启（图片题无法自动读取，请到设置里开启多模态）" : "已开启（渲染的题图会随请求发送；题图渲染失败时文字可读的题自动改用文字）" }}</p>
      <p class="hint">无需登录，题目由本机插件直接发送到你配置的供应商；Key 只保存在本机。</p>
    </section>
    <section v-if="!token" class="card" data-testid="runner-provider-missing">
      <h2>尚未配置供应商</h2>
      <p class="hint">调度页使用本地直连，不需要登录。请到扩展「设置」添加供应商并授权站点。</p>
      <button type="button" @click="openOptions">打开设置</button>
    </section>
    <section class="card">
      <h2>本次运行授权</h2>
      <button :disabled="previewLoading" data-testid="runner-preview" @click="previewCurrentQuestion">{{ previewLoading ? "正在读取全部题目…" : "读取全部题目（不发送）" }}</button>
      <div class="row">
        <p class="counters" data-testid="runner-inventory">
          <span class="counter"><span class="counter-num">{{ inventory.length }}</span>已读取</span>
          <span class="counter"><span class="counter-num">{{ inventory.filter(item => !item.needsImage).length }}</span>文字可用</span>
          <span class="counter"><span class="counter-num">{{ inventory.filter(item => item.needsImage).length }}</span>图像兜底</span>
        </p>
        <button v-if="inventory.length" type="button" class="primary" data-testid="runner-copy-all" @click="copyAllQuestions">复制整份 Markdown</button>
        <button v-if="inventory.length" type="button" data-testid="runner-download-all" @click="downloadAllQuestions">下载整份 .md</button>
      </div>
      <p v-if="copyNotice" class="hint" data-testid="runner-copy-notice">{{ copyNotice }}</p>
      <div v-if="copyFallback" class="copy-fallback" data-testid="copy-fallback">
        <p class="hint">浏览器拒绝了自动复制，下面内容已全选，请按 Ctrl+C / ⌘C 复制：</p>
        <textarea ref="fallbackBox" :value="copyFallback" rows="10" readonly data-testid="copy-fallback-text"></textarea>
      </div>
      <QuestionBoard ref="questionBoard" :items="inventory" :failed-indices="failedQuestionIndices" :image-indices="imageQuestionIndices"
        :images="previewImages" :busy="previewBusy" :errors="previewErrors" :notice="imageNotice || copyNotice"
        @preview="previewFallback" @copy="copyOneQuestion" @copy-image="copyQuestionImage" @download-image="downloadQuestionImage" />
      <p v-if="provider" data-testid="runner-provider">模型 {{ provider.model }} · {{ localProvider ? "本地直连（配置已保存）" : provider.verification.status }}</p>
      <label>从第几题开始<input v-model.number="startQuestion" type="number" min="1" max="200" :disabled="running" data-testid="runner-start-question" /></label>
      <label><input v-model="alwaysImage" type="checkbox" :disabled="running" data-testid="runner-always-image" />
        所有题目都附带渲染图片（默认开启：题目文字可能来自字体编码/图片，图片更稳；更费 token）</label>
      <p class="hint">默认第 1 题，后续任务自动从第 1 题开始。起始题之前保留并核验已有答案，不重复调用模型；缺答自动作答，最终失败才汇总。自动决定单次或不确定时三次复核，无需逐题选择。</p>
      <p v-if="limits" class="hint" data-testid="runner-limits">并行请求 {{ limits.perUserConcurrency > 0 ? Math.min(2, limits.perUserConcurrency) : 2 }} 个 · {{ limits.requestsPerMinute > 0 ? "每分钟最多 " + limits.requestsPerMinute + " 次" : "不限每分钟次数" }} · {{ limits.requestsPerDay > 0 ? "每日最多 " + limits.requestsPerDay + " 次" : "不限每日次数" }}（个人 Key 自担费用）</p>
      <label><input v-model="consent" type="checkbox" :disabled="running" data-testid="runner-consent" />
        <template v-if="taskMode === 'videos'">允许本次运行自动播放视频、打开已适配资料、提交已有完整答案并确认、发表已有讨论草稿；答案不完整则跳过并继续，不调用模型，视频弹题仅在页面内处理。</template>
        <template v-else>允许本次运行自动播放视频、回填并提交已适配章节任务、发表讨论回复及进入下一任务；题目图像仅在需要模型作答时发送到默认供应商，视频弹题只枚举页面选项、不发送任何内容。</template></label>
      <label class="hint"><input v-model="soundEnabled" type="checkbox" :disabled="running" data-testid="runner-sound" />
        声音提醒（运行出错、需要人工补答或弹题作答失败时响铃；出错每 30 秒重复，直到回到本页处理。人在别的窗口也能听到）</label>
      <p class="hint">各模式均自动提交完整答案并确认；讨论回复核验后自动发表。只刷课模式仅提交已有完整答案或讨论草稿，不生成缺失答案。{{ discussionPermissionNotice }}</p>
      <label v-if="soundEnabled" class="hint" data-testid="runner-alarm-volume-label">告警音量
        <input v-model.number="alarmVolume" type="range" min="0" max="1" step="0.05" :disabled="running" data-testid="runner-alarm-volume" />
        <span>{{ Math.round(alarmVolume * 100) }}%</span>（对本机打包的提示音与回退蜂鸣同时生效，仅调扩展自身音量）</label>
      <label v-if="taskMode !== 'questions'" class="hint"><input v-model="allowVideoSeek" type="checkbox" :disabled="running" data-testid="runner-allow-seek" />
        站点允许时把视频定位到末尾以触发其自身完成判定（只写标准播放位置，不伪造进度；站点禁止或进度回退时自动改回完整播放，任务是否完成仍以站点变绿为唯一依据。可拖性按课程记忆，下次不再重复试探）</label>
      <label v-if="taskMode !== 'questions'" class="hint"><input v-model="allowMaterialScroll" type="checkbox" :disabled="running" data-testid="runner-allow-scroll" />
        已适配的 PPT/PDF 资料打开后滚动到底，促使站点自行确认完成（仅结构滚动，绝不伪造阅读时长或完成状态）</label>
      <div class="row">
        <label class="task-mode">任务模式
          <select v-model="taskMode" :disabled="running" data-testid="runner-mode">
            <option value="course">刷课：视频＋题目</option>
            <option value="questions">刷题：仅完成题目</option>
            <option value="videos">只刷课：视频和资料，跳过题目</option>
          </select>
        </label>
        <button class="primary" data-testid="runner-start" :disabled="running || (taskMode === 'videos' ? !readyVideosOnly : !ready)" @click="startSelectedMode">开始运行</button>
        <button :disabled="running || discussionGranted" data-testid="runner-discussion-permission" @click="grantDiscussionPermission">{{ discussionGranted ? "讨论页面已授权" : "授权讨论页面" }}</button>
        <button data-testid="runner-pause" :disabled="state.phase !== 'RUNNING'" @click="runner.pause()">暂停</button>
        <button data-testid="runner-resume" :disabled="state.phase !== 'PAUSED' && state.phase !== 'NEEDS_INPUT'" @click="runner.resume()">继续</button>
        <button data-testid="runner-stop" :disabled="!running" @click="runner.stop()">停止</button>
        <button data-testid="runner-submit-now" :disabled="state.manualSaving || !(state.phase === 'NEEDS_INPUT' || state.phase === 'ERROR' || state.phase === 'DONE')" @click="submitNow">立即提交当前任务（点站点 Submit）</button>
        <button data-testid="runner-recheck" :disabled="state.busy || state.manualSaving || !(state.phase === 'NEEDS_INPUT' || state.phase === 'ERROR' || state.phase === 'DONE')" @click="recheckSubmission">重新检查提交结果（不再点提交）</button>
        <button data-testid="runner-copy-diagnostics" @click="copyDiagnostics">复制诊断行</button>
      </div>
      <p class="hint" data-testid="runner-diagnostics-hint">「重新检查提交结果」只复核站点当前状态，绝不重复点击提交；「复制诊断行」只含页面结构计数，不含题文、答案、网址或课程标识，可安全粘贴反馈。</p>
      <p class="hint">暂停／停止会阻止后续动作；已发出的模型请求或提交无法撤回。题目图像和答案仅在内存中处理，不记录到运行日志。</p>
      <p class="hint" data-testid="runner-autoplay-hint">刷课模式遇到浏览器拦截有声自动播放时，会先在课程页静音开始播放，播放后再恢复声音；仍失败才提示人工处理。</p>
      <p class="hint" data-testid="runner-popup-hint">视频播放途中出现的强制弹题会自动按顺序枚举页面选项作答（不调模型、不上报人工）；枚举全部选项仍未通过时停止并响铃，请回课程页人工处理。</p>
    </section>
    <section class="card" data-testid="runner-state">
      <h2>{{ state.phase }} · {{ state.step }}</h2>
      <p>本轮已收集 {{ state.collected }} 题 · 当前任务共 {{ state.questionCount }} 题 · 最近处理第 {{ state.question }} 题 · 已确认完成 {{ state.completedTasks }} 个任务</p>
      <p v-if="state.publishedDiscussions" data-testid="runner-published-discussions">已核验发表 {{ state.publishedDiscussions }} 条讨论回复（课程任务点以站点标记为准）</p>
      <p v-if="state.videoStatus" data-testid="runner-video-status">视频任务：{{ state.videoStatus }}</p>
      <p v-if="state.skippedResources" data-testid="runner-skipped-resources">已越过 {{ state.skippedResources }} 个已识别的资料/图文卡片（不计入已完成任务）</p>
      <p v-if="state.skippedVideos" data-testid="runner-skipped-videos">刷题模式已跳过 {{ state.skippedVideos }} 个未完成的视频任务点（不计入已完成任务；后续可回到刷课模式补看）</p>
      <p v-if="state.skippedQuizzes" data-testid="runner-skipped-quizzes">只刷课模式已跳过 {{ state.skippedQuizzes }} 个答案不完整的题目任务点（不调用模型、不提交，不计入已完成任务）</p>
      <p class="counters" data-testid="runner-pipeline">
        <span class="counter"><span class="counter-num">{{ state.collected }}</span>已收集</span>
        <span class="counter"><span class="counter-num">{{ state.filled }}</span>自动回填/补答</span>
        <span class="counter"><span class="counter-num">{{ state.retained }}</span>保留原答</span>
        <span class="counter"><span class="counter-num">{{ state.buffered }}</span>缓冲</span>
        <span class="counter"><span class="counter-num">{{ state.inFlight }}</span>在途请求</span>
        <span class="counter"><span class="counter-num">{{ state.modelRequests }}</span>本轮调用</span>
        <span class="counter">最近投票 {{ state.agreement || "—" }}</span>
      </p>
      <p data-testid="runner-monitor">监听检查 {{ state.monitorChecks }} 次{{ state.lastCheck ? ` · 最近 ${new Date(state.lastCheck).toLocaleTimeString()}` : "" }}</p>
      <p v-if="state.error" class="error" data-testid="runner-error">{{ state.error }}</p>
      <p v-if="state.diagnostics" class="hint" data-testid="runner-diagnostics-line">{{ diagnosticsLine() }}</p>
      <p v-if="error" class="error">{{ error }}</p>
    </section>
    <details v-if="state.imageReplies.length" class="card" data-testid="runner-image-replies" open>
      <summary>整题图片重试的模型回答（直接采用图片阶段结果）</summary>
      <div v-for="reply in state.imageReplies" :key="reply.captured.index">
        <p>第 {{ reply.captured.index + 1 }} 题：</p>
        <p v-for="(sample, sampleIndex) in reply.samples" :key="sampleIndex">{{ sampleIndex === reply.samples.length - 1 ? '图片回答' : '首次回答' }}：{{ sampleLabel(reply, sample) }}</p>
      </div>
    </details>
    <section v-if="state.manualItems.length" class="card" data-testid="runner-manual-summary">
      <h2>待人工补答汇总：{{ state.manualItems.filter(item => !item.resolved).length }} 题</h2>
      <p>先查看本题模型回答。每题两个入口：①「采用图片重新发送并回写」发送完整题干和全部选项图片，直接采用本次图片回答，不与旧回答投票；②「一键录入本题」录入下方当前答案，可直接采用预填的模型候选，也可自己修改。每题独立核验并反馈，不必一次填完全部题。全部补齐后自动提交并继续；未补全不会提交。</p>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <fieldset v-for="item in state.manualItems" :key="item.index" :data-testid="`manual-question-${item.index + 1}`">
        <legend>第 {{ item.index + 1 }} 题 · {{ typeLabel(item) }} · {{ item.resolved ? "已核验" : item.reason }}</legend>
        <p v-if="item.imageError" class="hint" data-testid="manual-image-error">题图读取失败：{{ item.imageError }}；可重新发送完整题图，不会把本次图片请求降级为纯文字。</p>
        <button type="button" data-testid="manual-view-question" @click="questionBoard?.open(item.captured)">查看题目（Markdown / 图片）</button>
        <div v-if="item.samples.length" class="manual-samples" data-testid="runner-model-samples">
          <p class="hint">模型原始回答（共 {{ item.samples.length }} 次，供你判断）：</p>
          <p v-for="(sample, sampleIndex) in item.samples" :key="sampleIndex">{{ sampleIndex + 1 }}. {{ sampleLabel(item, sample) }}</p>
        </div>
        <div v-if="item.candidates.length" data-testid="runner-candidates">
          <p class="hint">模型候选答案（已预填到下方，可修改后录入）：</p>
          <div v-for="(candidate, candidateIndex) in item.candidates" :key="candidateIndex" class="row">
            <span>{{ candidateLabel(item, candidate) }}</span>
          </div>
        </div>
        <fieldset v-if="manualDrafts[item.index]" class="manual-answer-fields" :disabled="item.resolved || (state.phase !== 'NEEDS_INPUT' && state.phase !== 'ERROR')">
          <label>题型纠正
            <select v-model="manualDrafts[item.index]!.type" data-testid="runner-manual-type" @change="manualDrafts[item.index]!.edited = true">
              <option value="">按识别结果（{{ typeLabel(item) }}）</option>
              <option value="SINGLE_CHOICE">单选题</option>
              <option value="MULTIPLE_CHOICE">多选题</option>
              <option value="TRUE_FALSE">判断题</option>
              <option value="FILL_BLANK">填空题</option>
              <option value="SHORT_ANSWER">简答题</option>
            </select>
          </label>
          <label v-if="effectiveType(item) === 'SINGLE_CHOICE' || effectiveType(item) === 'TRUE_FALSE'">
            <input v-model="manualDrafts[item.index]!.multi" type="checkbox" data-testid="runner-manual-multi" @change="manualDrafts[item.index]!.edited = true" /> 本题按多选勾选
          </label>
          <label v-for="(option, optionIndex) in item.captured.question.options" :key="option.id">
            <input :type="manualChoiceMultiple(item) ? 'checkbox' : 'radio'" :name="`manual-${item.index}`" :checked="manualDrafts[item.index]!.selected.includes(option.id)"
              @change="chooseManualOption(item.index, option.id, manualChoiceMultiple(item), $event)" />{{ String.fromCharCode(65 + optionIndex) }} · {{ option.text || '图片选项（见整题图）' }}
          </label>
          <label v-for="blank in manualBlanks(item)" :key="blank.id">{{ blank.label }}<textarea v-model="manualDrafts[item.index]!.blanks[blank.id]" @input="manualDrafts[item.index]!.edited = true"></textarea></label>
          <label v-if="effectiveType(item) === 'SHORT_ANSWER'">答案<textarea v-model="manualDrafts[item.index]!.text" @input="manualDrafts[item.index]!.edited = true"></textarea></label>
        </fieldset>
        <p v-if="manualErrors[item.index]" role="alert" class="error" data-testid="manual-entry-error">{{ manualErrors[item.index] }}</p>
        <p role="status" data-testid="manual-entry-status">{{ item.resolved ? '已核验成功' : state.manualSaving ? item.reason : '可逐题操作；录入后会显示核验结果' }}</p>
        <div class="row">
          <button type="button" data-testid="manual-image-retry" :disabled="item.resolved || state.manualSaving || (state.phase !== 'NEEDS_INPUT' && state.phase !== 'ERROR')" @click="retryWithImage(item.index)">采用图片重新发送并回写</button>
          <button type="button" class="primary" data-testid="manual-entry" :disabled="item.resolved || state.manualSaving || (state.phase !== 'NEEDS_INPUT' && state.phase !== 'ERROR')" @click="submitManual(false, item.index)">一键录入本题</button>
        </div>
      </fieldset>
      <details><summary>批量录入 / 已在网页填写</summary>
      <button class="primary" :disabled="(state.phase !== 'NEEDS_INPUT' && state.phase !== 'ERROR') || state.manualSaving" data-testid="runner-submit-manual" @click="submitManual(false)">回填补答并自动继续</button>
      <button :disabled="(state.phase !== 'NEEDS_INPUT' && state.phase !== 'ERROR') || state.manualSaving" data-testid="runner-check-manual" @click="submitManual(true)">已在网页补答，核验并继续</button>
      </details>
    </section>
    <section v-if="siteChecked && !siteGranted" class="card" data-testid="site-permission-card">
      <h2>可选站点权限</h2>
      <p class="hint">若读取失败，核对课程页的 HTTPS 站点后授权。仅申请具体站点，可在 Chrome 扩展详情撤销。</p>
      <input v-model="site" :disabled="running" placeholder="输入 HTTPS 课程站点" @change="refreshSitePermission" />
      <p>{{ sitePermissionOrigin(site) }}</p>
      <button :disabled="running || !sitePermissionOrigin(site)" @click="grantSite">允许读取此站点</button>
      <p>{{ permissionNotice }}</p>
    </section>
  </main>
</template>

<style scoped>
label:has(> input[type="checkbox"]), label:has(> input[type="radio"]) { display: grid; grid-template-columns: auto 1fr; align-items: start; column-gap: 8px; }
label > input[type="checkbox"], label > input[type="radio"] { margin: 3px 0 0; }
.task-mode { min-width: 220px; flex: 1; margin: 0; }
.task-mode select { margin-top: 4px; }
.row:has(.task-mode) { align-items: flex-end; }
.manual-answer-fields { border: 0; padding: 0; margin: 12px 0; min-width: 0; }
.manual-answer-fields textarea { min-height: 44px; }
</style>
