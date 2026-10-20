<script setup lang="ts">
import UpdateMenu from "../updates/UpdateMenu.vue";
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import type {
  AnswerRequest,
  ProviderProfile,
  QuestionType,
  StudyAnswer,
  StudyQuestion
} from "@study/contracts";
import { PRIVACY_VERSION } from "@study/contracts";
import { BUILD_BACKEND_ORIGIN } from "../shared/buildConfig";
import { ERROR_GUIDANCE } from "../shared/codes";
import type { FillResult, PlanPreview, PreconditionCheck, ReviewedAnswer } from "../shared/types";
import { isHostPermissionFailure } from "../shared/messages";
import type { PageResponse } from "../shared/messages";
import { ConfirmationGuard, evaluatePreconditions } from "../review/guard";
import { buildPlannedFields } from "../review/plan";
import { randomId, randomToken } from "../shared/ids";
import { questionToMarkdown } from "../shared/question-markdown";
import { copyText } from "./clipboard";
import { askLocalProvider, loadActiveProvider } from "../local/provider";
import type { LocalProvider } from "../local/provider";
import type { ApiFailure } from "../api/client";
import {
  describeProblem,
  fetchMe,
  fetchProviderProfiles,
  generateAnswer,
  login as loginRequest,
  logout as logoutRequest
} from "../api/client";
import { clearSession, ensureTrustedStorageAccess, loadSession, saveSession } from "../api/session";
import { loadSettings } from "../api/settings";
import {
  newRequestId, readPermissionSite, readTabIdFromSearch, requestSitePermission,
  resolveTargetTabId, sendPageCommand, sitePermissionOrigin, isCourseTaskUrl
} from "./bridge";
import {
  applyAnswer,
  applyCapture,
  applyFillResult,
  applySelectionText,
  buildReviewedAnswer,
  canApprove as canApproveState,
  canReview as canReviewState,
  canSend as canSendState,
  createFlowState,
  editAnswer,
  markRevalidating,
  markRequesting,
  markReviewed,
  resetFlow,
  setCandidates,
  setFailure,
  setNotice,
  setPlanPreview,
  updateQuestion
} from "./flow";

const flow = createFlowState();
const confirmationGuard = new ConfirmationGuard();

const backendOrigin = ref(BUILD_BACKEND_ORIGIN);
const token = ref<string | null>(null);
const sessionUsername = ref<string | null>(null);
const provider = ref<ProviderProfile | null>(null);
const localProvider = ref<LocalProvider | null>(null);
const targetTabId = ref<number | null>(null);
const busy = ref(false);
const authError = ref<string | null>(null);
const loginForm = reactive({ username: "", password: "" });
const permissionTabId = ref<number | null>(null);
const permissionSite = ref("");
const permissionNotice = ref("");
const permissionRead = ref<"CAPTURE_QUESTION" | "CAPTURE_SELECTION" | null>(null);

const questionTypes: QuestionType[] = [
  "SINGLE_CHOICE",
  "MULTIPLE_CHOICE",
  "TRUE_FALSE",
  "FILL_BLANK",
  "SHORT_ANSWER",
  "UNKNOWN"
];

const draft = reactive<{
  selectedOptionIds: string[];
  blankAnswers: Record<string, string>;
  textAnswer: string;
}>({ selectedOptionIds: [], blankAnswers: {}, textAnswer: "" });

const providerHost = computed(() => {
  if (!provider.value) {
    return "";
  }
  try {
    return new URL(provider.value.baseUrl).host;
  } catch {
    return "(非法地址)";
  }
});

const canSend = computed(() => canSendState(flow) && (localProvider.value !== null || (provider.value !== null && token.value !== null)));
const canReview = computed(() => canReviewState(flow) && flow.question !== null);
const canApprove = computed(
  () =>
    canApproveState(flow) &&
    flow.capture !== null &&
    targetTabId.value !== null &&
    !busy.value
);

const isMulti = computed(() => flow.question?.type === "MULTIPLE_CHOICE");
const isChoice = computed(() =>
  flow.question ? ["SINGLE_CHOICE", "MULTIPLE_CHOICE", "TRUE_FALSE"].includes(flow.question.type) : false
);
const needsTextAnswer = computed(() => flow.question?.type === "SHORT_ANSWER");
const selectedOptionsEditable = computed(() => isChoice.value);
const blockReasonText = computed(() => {
  const code = flow.capture?.fillBlockCode;
  return code ? ERROR_GUIDANCE[code].hint : "";
});

const sendPreview = computed(() => {
  if (!flow.question) {
    return "";
  }
  return JSON.stringify(
    {
      type: flow.question.type,
      stem: flow.question.stem,
      options: flow.question.options,
      blanks: flow.question.blanks
    },
    null,
    2
  );
});

watch(
  () => flow.answer,
  (answer) => {
    if (answer) {
      syncDraft(answer);
    }
  }
);

function syncDraft(answer: StudyAnswer): void {
  draft.selectedOptionIds = [...answer.selectedOptionIds];
  const blanks: Record<string, string> = {};
  for (const item of answer.blankAnswers) {
    blanks[item.blankId] = item.answer;
  }
  draft.blankAnswers = blanks;
  draft.textAnswer = answer.textAnswer ?? "";
}

function currentAnswer(): StudyAnswer {
  return {
    status: flow.answer?.status ?? "ANSWERED",
    selectedOptionIds: [...draft.selectedOptionIds],
    blankAnswers: Object.entries(draft.blankAnswers)
      .filter(([, value]) => value.trim().length > 0)
      .map(([blankId, answer]) => ({ blankId, answer: answer.trim() })),
    textAnswer: draft.textAnswer.trim() ? draft.textAnswer : null,
    explanation: flow.answer?.explanation ?? "",
    caveats: flow.answer?.caveats ?? []
  };
}

function pushAnswerEdit(): void {
  if (!flow.answer) {
    return;
  }
  editAnswer(flow, currentAnswer());
}

function toggleOption(optionId: string, event: Event): void {
  const checked = (event.target as HTMLInputElement).checked;
  if (isMulti.value) {
    draft.selectedOptionIds = checked
      ? [...draft.selectedOptionIds.filter((id) => id !== optionId), optionId]
      : draft.selectedOptionIds.filter((id) => id !== optionId);
  } else {
    draft.selectedOptionIds = checked ? [optionId] : [];
  }
  pushAnswerEdit();
}

function blankAnswer(blankId: string): string {
  return draft.blankAnswers[blankId] ?? "";
}

function onBlankAnswerInput(blankId: string, event: Event): void {
  const value = (event.target as HTMLInputElement).value;
  draft.blankAnswers = { ...draft.blankAnswers, [blankId]: value };
  pushAnswerEdit();
}

function onTextAnswerInput(event: Event): void {
  draft.textAnswer = (event.target as HTMLTextAreaElement).value;
  pushAnswerEdit();
}

function patchQuestion(updater: (question: StudyQuestion) => void): void {
  if (!flow.question) {
    return;
  }
  const next = JSON.parse(JSON.stringify(flow.question)) as StudyQuestion;
  updater(next);
  updateQuestion(flow, next);
}

function onTypeChange(event: Event): void {
  const type = (event.target as HTMLSelectElement).value as QuestionType;
  patchQuestion((question) => {
    question.type = type;
  });
}

function onStemInput(event: Event): void {
  const stem = (event.target as HTMLTextAreaElement).value;
  patchQuestion((question) => {
    question.stem = stem;
  });
}

function onOptionInput(index: number, event: Event): void {
  const text = (event.target as HTMLInputElement).value;
  patchQuestion((question) => {
    const option = question.options[index];
    if (option) {
      option.text = text;
    }
  });
}

function onBlankInput(index: number, event: Event): void {
  const label = (event.target as HTMLInputElement).value;
  patchQuestion((question) => {
    const blank = question.blanks[index];
    if (blank) {
      blank.label = label;
    }
  });
}

function addOption(): void {
  patchQuestion((question) => {
    question.options.push({ id: `opt_${question.options.length + 1}`, text: "" });
  });
}

function addBlank(): void {
  patchQuestion((question) => {
    question.blanks.push({ id: `blank_${question.blanks.length + 1}`, label: `空格 ${question.blanks.length + 1}` });
  });
}

async function ensureTabId(): Promise<number | null> {
  const current = await resolveTargetTabId(readTabIdFromSearch(location.search));
  if (current !== targetTabId.value) {
    resetFlow(flow);
    confirmationGuard.clear();
    clearPermissionRequest();
    targetTabId.value = current;
  }
  return targetTabId.value;
}

function clearPermissionRequest(): void {
  permissionTabId.value = null;
  permissionSite.value = "";
  permissionNotice.value = "";
  permissionRead.value = null;
}

async function preparePermissionRequest(
  tabId: number, response: PageResponse, read: "CAPTURE_QUESTION" | "CAPTURE_SELECTION"
): Promise<void> {
  if (isHostPermissionFailure(response)) {
    permissionSite.value = await readPermissionSite(tabId);
    permissionTabId.value = tabId;
    permissionRead.value = read;
  }
}

async function allowSiteReading(): Promise<void> {
  const tabId = permissionTabId.value;
  const read = permissionRead.value;
  if (tabId === null || read === null || !sitePermissionOrigin(permissionSite.value)) {
    return;
  }
  busy.value = true;
  try {
    // Preserve the user gesture: permissions.request runs before the first await.
    const granted = await requestSitePermission(permissionSite.value);
    if (!granted) {
      permissionNotice.value = "未授予站点权限，请重试授权后打开课程任务调度。";
      return;
    }
    const current = await resolveTargetTabId(readTabIdFromSearch(location.search));
    const currentSite = await readPermissionSite(tabId);
    if (current !== tabId || sitePermissionOrigin(currentSite) !== sitePermissionOrigin(permissionSite.value)) {
      clearPermissionRequest();
      setFailure(flow, "DOCUMENT_CHANGED", "授权期间目标标签或站点已变化，请在目标页面重新读取。");
      return;
    }
    clearPermissionRequest();
    if (read === "CAPTURE_SELECTION") {
      await captureSelection();
    } else {
      await captureQuestion();
    }
  } catch {
    permissionNotice.value = "站点授权未完成，请重试授权后打开课程任务调度。";
  } finally {
    busy.value = false;
  }
}

async function captureQuestion(containerIndex?: number): Promise<void> {
  clearPermissionRequest();
  busy.value = true;
  flow.busy = true;
  try {
    const tabId = await ensureTabId();
    if (tabId === null) {
      setFailure(flow, "TAB_UNAVAILABLE", "没有可用的目标标签页，请从学习页面打开侧边栏。");
      return;
    }
    let currentUrl = "";
    try {
      currentUrl = (await chrome.tabs.get(tabId)).url ?? "";
    } catch {
      setFailure(flow, "TAB_UNAVAILABLE", "目标标签页已关闭或无法访问，请重新打开侧边栏。");
      return;
    }
    if (isCourseTaskUrl(currentUrl)) {
      resetFlow(flow);
      await openCourseRunner(tabId);
      return;
    }
    const response = await sendPageCommand(tabId, {
      type: "CAPTURE_QUESTION",
      requestId: newRequestId(),
      ...(containerIndex === undefined ? {} : { containerIndex })
    });
    if (!response.ok) {
      setFailure(flow, response.code, response.detail, response.checks ?? []);
      await preparePermissionRequest(tabId, response, "CAPTURE_QUESTION");
      return;
    }
    if (response.kind !== "CAPTURE_QUESTION") {
      setFailure(flow, "INVALID_COMMAND", "页面脚本返回了非预期响应");
      return;
    }
    if (response.needsSelection) {
      setCandidates(flow, response.candidates);
      return;
    }
    applyCapture(flow, response.captured);
  } finally {
    busy.value = false;
    flow.busy = false;
  }
}

async function chooseCandidate(index: number): Promise<void> {
  await captureQuestion(index);
}

async function captureSelection(): Promise<void> {
  clearPermissionRequest();
  busy.value = true;
  flow.busy = true;
  try {
    const tabId = await ensureTabId();
    if (tabId === null) {
      setFailure(flow, "TAB_UNAVAILABLE", "没有可用的目标标签页");
      return;
    }
    const response = await sendPageCommand(tabId, {
      type: "CAPTURE_SELECTION",
      requestId: newRequestId()
    });
    if (!response.ok) {
      setFailure(flow, response.code, response.detail, response.checks ?? []);
      await preparePermissionRequest(tabId, response, "CAPTURE_SELECTION");
      return;
    }
    if (response.kind !== "CAPTURE_SELECTION") {
      setFailure(flow, "INVALID_COMMAND", "页面脚本返回了非预期响应");
      return;
    }
    applySelectionText(flow, response.text);
  } finally {
    busy.value = false;
    flow.busy = false;
  }
}

async function sendQuestion(): Promise<void> {
  if (!flow.question || (!localProvider.value && (!provider.value || !token.value))) {
    setFailure(flow, "PROVIDER_NOT_CONFIGURED", "尚未配置供应商，请到设置页添加并授权");
    return;
  }
  markRequesting(flow);
  busy.value = true;
  if (localProvider.value) {
    try {
      // Pick up a settings change (key/model) saved after this panel was opened.
      const latest = await loadActiveProvider();
      if (latest) localProvider.value = latest;
      const answer = await askLocalProvider(localProvider.value, flow.question);
      applyAnswer(flow, answer, provider.value?.version ?? 1);
    } catch (e) {
      flow.busy = false;
      const code = typeof (e as { code?: unknown } | null)?.code === "string"
        ? String((e as { code?: string }).code) : "UPSTREAM_PROTOCOL_ERROR";
      setFailure(flow, code, e instanceof Error ? e.message : "本地供应商请求失败");
      // Keep the captured question usable after a provider failure: the user fixes the
      // setting and presses send again (nothing is retried automatically).
      flow.phase = "CAPTURED";
    } finally {
      busy.value = false;
      flow.busy = false;
    }
    return;
  }
  const currentProvider = provider.value!;
  try {
    const request: AnswerRequest = {
      providerProfileId: currentProvider.id,
      expectedProfileVersion: currentProvider.version,
      sourceMode: flow.sourceMode,
      question: flow.question,
      consent: { shareQuestionWithSelectedProvider: true, privacyVersion: PRIVACY_VERSION }
    };
    const result = await generateAnswer(backendOrigin.value, token.value!, request, randomId());
    if (!result.ok) {
      flow.busy = false;
      flow.phase = "CAPTURED";
      handleApiFailure(result, "生成解析");
      const phaseAfterFailure: string = flow.phase;
      if (phaseAfterFailure === "ERROR") {
        // A recoverable request failure must not lock the send button: the learner fixes the
        // configuration and retries explicitly.
        flow.phase = "CAPTURED";
      }
      return;
    }
    applyAnswer(flow, result.data.answer, currentProvider.version);
  } finally {
    busy.value = false;
    flow.busy = false;
  }
}

async function revalidatePlan(reviewed: ReviewedAnswer): Promise<void> {
  const tabId = await ensureTabId();
  if (tabId === null) {
    setFailure(flow, "TAB_UNAVAILABLE", "没有可用的目标标签页");
    return;
  }
  const planId = randomId();
  // Remember what this request belongs to: if the question/capture/answer changed while the
  // round-trip was in flight, the response must be dropped instead of overwriting the new state.
  const questionRevision = flow.questionRevision;
  const documentNonce = flow.capture?.context.documentNonce ?? null;
  const response = await sendPageCommand(tabId, {
    type: "REVALIDATE_FILL",
    requestId: newRequestId(),
    planId,
    reviewedAnswer: reviewed
  });
  const stillCurrent = flow.questionRevision === questionRevision &&
    (flow.capture?.context.documentNonce ?? null) === documentNonce &&
    // A reactive state read returns a proxy, so compare the phase (set by markReviewed) rather
    // than object identity with the raw `reviewed` argument.
    flow.phase === "REVIEWED";
  if (!stillCurrent) return;
  if (!response.ok) {
    setFailure(flow, response.code, response.detail, response.checks ?? []);
    return;
  }
  if (response.kind !== "REVALIDATE_FILL") {
    setFailure(flow, "INVALID_COMMAND", "页面脚本返回了非预期响应");
    return;
  }
  setPlanPreview(flow, response.plan);
}

async function reviewAnswer(): Promise<void> {
  if (!flow.answer || !flow.question) {
    return;
  }
  const reviewed = buildReviewedAnswer(currentAnswer());
  if (!reviewed) {
    setFailure(flow, "QUESTION_AMBIGUOUS", "当前答案状态不是 ANSWERED，无法审核回填");
    return;
  }
  const planned = buildPlannedFields(flow.question, reviewed);
  if (!planned.ok) {
    setFailure(flow, planned.code, planned.detail);
    return;
  }
  markReviewed(flow, reviewed, null);
  if (flow.capture && flow.capture.fillEligible) {
    // Disable capture/edit buttons while the revalidation round-trip is in flight, so a new
    // capture cannot be overwritten by this response afterwards.
    busy.value = true;
    flow.busy = true;
    try {
      await revalidatePlan(reviewed);
    } finally {
      busy.value = false;
      flow.busy = false;
    }
  } else {
    setNotice(flow, "当前来源或页面不支持回填，仅完成答案审核。");
  }
}

async function approveFill(): Promise<void> {
  const plan = flow.planPreview;
  const reviewed = flow.reviewedAnswer;
  const capture = flow.capture;
  if (!plan || !reviewed || !capture) {
    return;
  }
  const nonce = randomToken(24);
  const issued = confirmationGuard.issue(plan.planId, nonce);
  if (!issued.ok) {
    setFailure(flow, issued.code, issued.detail);
    return;
  }
  const preconditions = evaluatePreconditions({
    capture,
    planPreview: plan,
    reviewedAnswer: reviewed,
    currentTabId: targetTabId.value,
    questionRevision: flow.questionRevision,
    questionRevisionAtPlan: flow.questionRevisionAtPlan,
    configVersionAtSend: flow.configVersionAtSend,
    currentConfigVersion: provider.value?.version ?? null,
    confirmationValid: true,
    planConsumed: false
  });
  if (!preconditions.ok) {
    confirmationGuard.invalidate(plan.planId);
    setFailure(flow, preconditions.code ?? "CONFIRMATION_EXPIRED", "写入前置校验未通过", preconditions.checks);
    return;
  }
  const consumed = confirmationGuard.consume(plan.planId, nonce);
  if (!consumed.ok) {
    setFailure(flow, consumed.code, consumed.detail);
    return;
  }
  busy.value = true;
  markRevalidating(flow);
  try {
    const tabId = await ensureTabId();
    if (tabId === null || tabId !== capture.context.tabId) {
      setFailure(flow, "DOCUMENT_CHANGED", "目标标签已变化，请重新读取并审核本题。");
      return;
    }
    const response = await sendPageCommand(tabId, {
      type: "APPLY_FILL",
      requestId: newRequestId(),
      planId: plan.planId,
      confirmationNonce: nonce
    });
    if (!response.ok) {
      setFailure(flow, response.code, response.detail, response.checks ?? []);
      return;
    }
    if (response.kind !== "APPLY_FILL") {
      setFailure(flow, "INVALID_COMMAND", "页面脚本返回了非预期响应");
      return;
    }
    applyFillResult(flow, response.result as FillResult);
  } finally {
    busy.value = false;
    flow.busy = false;
  }
}

function handleApiFailure(failure: ApiFailure, action: string): void {
  if (
    failure.status === 401 ||
    failure.code === "AUTH_REQUIRED" ||
    failure.code === "SESSION_EXPIRED"
  ) {
    void clearSession();
    token.value = null;
    sessionUsername.value = null;
    provider.value = null;
    authError.value = "登录已过期，请重新登录";
    setNotice(flow, action + "：登录已过期");
    return;
  }
  setFailure(flow, failure.code || "HTTP_ERROR", `${action}：${describeProblem(failure)}`);
}

async function loadProvider(): Promise<void> {
  if (!token.value) {
    return;
  }
  const me = await fetchMe(backendOrigin.value, token.value);
  if (!me.ok) {
    handleApiFailure(me, "读取账号");
    return;
  }
  const profiles = await fetchProviderProfiles(backendOrigin.value, token.value);
  if (!profiles.ok) {
    handleApiFailure(profiles, "读取 API 配置");
    return;
  }
  const preferred = profiles.data.find((item) => item.id === me.data.defaultProviderProfileId);
  provider.value =
    preferred ??
    profiles.data.find((item) => item.enabled && item.verification.status === "VERIFIED") ??
    profiles.data.find((item) => item.enabled) ??
    null;
  if (!provider.value) {
    setNotice(flow, "尚未配置可用的 API 配置，请先在控制台完成配置与测试。");
  }
}

async function doLogin(): Promise<void> {
  busy.value = true;
  authError.value = null;
  try {
    const result = await loginRequest(backendOrigin.value, loginForm.username, loginForm.password);
    if (!result.ok) {
      authError.value = describeProblem(result);
      return;
    }
    const session = await saveSession(result.data);
    token.value = session.accessToken;
    sessionUsername.value = session.username;
    loginForm.password = "";
    await loadProvider();
  } catch {
    authError.value = "无法连接后端，请检查设置中的后端地址";
  } finally {
    busy.value = false;
  }
}

async function doLogout(): Promise<void> {
  if (localProvider.value) {
    localProvider.value = null;
    provider.value = null;
    token.value = null;
    sessionUsername.value = null;
    resetFlow(flow);
    confirmationGuard.clear();
    return;
  }
  if (token.value) {
    await logoutRequest(backendOrigin.value, token.value);
  }
  await clearSession();
  token.value = null;
  sessionUsername.value = null;
  provider.value = null;
  resetFlow(flow);
  confirmationGuard.clear();
  clearPermissionRequest();
}

function openOptions(): void {
  void chrome.runtime.openOptionsPage();
}

async function openCourseRunner(boundTabId?: number): Promise<void> {
  const tabId = boundTabId ?? await resolveTargetTabId(readTabIdFromSearch(location.search));
  if (tabId === null) { setNotice(flow, "请先打开课程任务标签。"); return; }
  const url = chrome.runtime.getURL(`runner.html?tabId=${tabId}`);
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find(tab => tab.url === url);
  if (typeof existing?.id === "number") await chrome.tabs.update(existing.id, { active: true });
  else await chrome.tabs.create({ url, active: true });
  setNotice(flow, "已打开课程读取页，将自动读取全部题目源数据；可选择刷题或刷课模式，无需逐题选择。");
}

function checkLabel(check: PreconditionCheck): string {
  return `${check.ok ? "✓" : "✗"} ${check.label}：${check.detail}`;
}

const copyNotice = ref("");
const copyFallback = ref("");
const fallbackBox = ref<HTMLTextAreaElement | null>(null);

async function copyMarkdown(): Promise<void> {
  const question = flow.question;
  if (!question) return;
  const markdown = questionToMarkdown(question);
  if ((await copyText(markdown)) === "copied") {
    copyNotice.value = "题目 Markdown 已复制，可直接粘贴到其他 AI。";
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

function downloadMarkdown(): void {
  const question = flow.question;
  if (!question) return;
  const markdown = questionToMarkdown(question);
  const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "question-" + Date.now() + ".md";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  copyNotice.value = "已下载 Markdown 文件。";
  copyFallback.value = "";
}

onMounted(async () => {
  await ensureTrustedStorageAccess();
  try {
    const settings = await loadSettings();
    backendOrigin.value = settings.backendOrigin;
    targetTabId.value = await resolveTargetTabId(readTabIdFromSearch(location.search));
    const local = await loadActiveProvider();
    if (local) {
      localProvider.value = local;
      token.value = "local";
      sessionUsername.value = "本地直连";
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
      if (session) {
        token.value = session.accessToken;
        sessionUsername.value = session.username;
        await loadProvider();
      }
    }
  } catch {
    authError.value = "加载本地设置失败，请打开设置页检查后端地址";
  }
});

onBeforeUnmount(() => {
  resetFlow(flow);
  confirmationGuard.clear();
});
</script>

<template>
  <main class="app">
    <header class="topbar">
      <div>
        <h1>学习助手</h1>
        <p class="muted" data-testid="local-mode">{{ localProvider ? "本地直连 · 无需登录" : "尚未配置供应商" }}</p>
      </div>
      <button class="link" data-testid="open-options" @click="openOptions">设置</button>
      <UpdateMenu :disabled="busy || flow.busy" />
    </header>

    <section v-if="!token" class="card" data-testid="provider-missing">
      <h2>尚未配置供应商</h2>
      <p class="hint">扩展使用本地直连，不需要登录。请到「设置」添加供应商、填入 API Key，并授权该站点后即可使用。</p>
      <button data-testid="open-options-missing" @click="openOptions">打开设置</button>
    </section>

    <template v-else>
      <section class="card">
        <div class="row">
          <span v-if="localProvider" class="badge" data-testid="local-provider">本地直连：{{ localProvider.name }}</span>
          <template v-else>
            <span class="badge" data-testid="login-status">已登录：{{ sessionUsername }}</span>
            <button class="link" @click="doLogout">退出</button>
          </template>
        </div>
        <div v-if="provider">
          <p data-testid="provider-summary">{{ provider.name }} · {{ provider.protocol }} · 模型 {{ provider.model }}</p>
          <p class="muted">
            供应商域名：{{ providerHost }} · {{ localProvider ? "本地直连（配置已保存，可到设置页“测试连接”验证）" : "验证状态：" + provider.verification.status }} · 配置版本：{{ provider.version }}
          </p>
        </div>
        <p v-else class="warn">尚未配置可用的 API 配置，请先在控制台完成配置与测试。</p>
      </section>

      <section class="card">
        <h2 class="step"><span class="step-num">1</span>读取当前题目</h2>
        <button data-testid="open-course-runner" :disabled="busy" @click="openCourseRunner()">打开课程任务调度</button>
        <div class="row">
          <button class="primary" data-testid="capture-question" :disabled="busy" @click="captureQuestion()">读取当前题目</button>
          <button data-testid="capture-selection" :disabled="busy" @click="captureSelection">读取选中文本（辅助）</button>
        </div>
        <p class="hint">采集只读取页面 DOM，不会发送网络请求；题目只保存在本次侧边栏内存中。</p>
        <div v-if="flow.candidates.length > 1 && flow.phase === 'IDLE'" data-testid="candidate-list">
          <p>页面有多个题目容器，请确认要读取的题目：</p>
          <button
            v-for="candidate in flow.candidates"
            :key="candidate.index"
            class="candidate"
            :data-testid="'candidate-' + candidate.index"
            @click="chooseCandidate(candidate.index)"
          >
            {{ candidate.index + 1 }}. [{{ candidate.questionType }}]
            {{ candidate.stemPreview || "(无题干)" }}
          </button>
        </div>
      </section>

      <section v-if="flow.question" class="card" data-testid="question-preview">
        <h2 class="step"><span class="step-num">2</span>预览并编辑本题</h2>
        <div class="row">
          <span v-if="flow.capture" class="badge" data-testid="page-kind-badge">页面类型：{{ flow.capture.pageKind }}</span>
          <span v-if="flow.capture" class="badge" data-testid="adapter-badge">
            适配器：{{ flow.capture.context.adapterId }} v{{ flow.capture.context.adapterVersion }}
          </span>
          <span v-else class="badge">来源：{{ flow.sourceMode }}</span>
        </div>
        <label>题型
          <select data-testid="question-type" :value="flow.question.type" :disabled="busy" @change="onTypeChange">
            <option v-for="type in questionTypes" :key="type" :value="type">{{ type }}</option>
          </select>
        </label>
        <label>题干
          <textarea
            data-testid="question-stem"
            :value="flow.question.stem"
            rows="4"
            :disabled="busy"
            @input="onStemInput"
          ></textarea>
        </label>
        <div v-if="flow.question.options.length">
          <p class="label">选项（选项 ID 由扩展本地生成）</p>
          <label v-for="(option, index) in flow.question.options" :key="option.id">
            {{ option.id }}
            <input :value="option.text" :disabled="busy" @input="onOptionInput(index, $event)" />
          </label>
        </div>
        <div v-if="flow.question.blanks.length">
          <p class="label">空格</p>
          <label v-for="(blank, index) in flow.question.blanks" :key="blank.id">
            {{ blank.id }}
            <input :value="blank.label" :disabled="busy" @input="onBlankInput(index, $event)" />
          </label>
        </div>
        <div v-if="!flow.capture" class="row">
          <button class="link" :disabled="busy" @click="addOption">添加选项</button>
          <button class="link" :disabled="busy" @click="addBlank">添加空格</button>
        </div>
        <div class="row" data-testid="markdown-actions">
          <button class="link" :disabled="busy" @click="copyMarkdown">复制题目 Markdown</button>
          <button class="link" :disabled="busy" @click="downloadMarkdown">下载 .md</button>
        </div>
        <p v-if="copyNotice" class="hint" data-testid="markdown-notice">{{ copyNotice }}</p>
        <div v-if="copyFallback" class="copy-fallback" data-testid="copy-fallback">
          <p class="hint">浏览器拒绝了自动复制，下面内容已全选，请按 Ctrl+C / ⌘C 复制：</p>
          <textarea ref="fallbackBox" :value="copyFallback" rows="8" readonly data-testid="copy-fallback-text"></textarea>
        </div>
        <p v-if="flow.capture && flow.capture.warnings.length" class="hint">
          {{ flow.capture.warnings.join("；") }}
        </p>
        <p v-if="flow.capture && !flow.capture.fillEligible" class="warn" data-testid="blocked-reason">
          本题可以发送给 AI 学习，但不会回填：{{ blockReasonText }}
        </p>
        <div class="preview">
          <p class="muted">实际发送内容（发送前请核对）：</p>
          <pre data-testid="send-preview">{{ sendPreview }}</pre>
          <p class="muted">
            供应商域名：{{ providerHost || "(未配置)" }} · 模型：{{ provider?.model || "(未配置)" }} ·
            协议：{{ provider?.protocol || "-" }}
          </p>
        </div>
        <div class="row">
          <button class="primary" data-testid="send-answer" :disabled="!canSend" @click="sendQuestion">发送并生成解析</button>
        </div>
        <p class="hint">只有点击“发送并生成解析”才会把上面的题目发送到后端与供应商。</p>
      </section>

      <section v-if="flow.phase === 'REQUESTING'" class="card">正在请求 AI 解析…（不会自动重试）</section>

      <section v-if="flow.answer" class="card" data-testid="answer-section">
        <h2 class="step"><span class="step-num">3</span>审核答案</h2>
        <p class="muted">模型状态：{{ flow.answer.status }}</p>
        <div v-if="selectedOptionsEditable" data-testid="answer-selected-options">
          <p class="label">{{ isMulti ? "多选（勾选正确选项）" : "单选（选择正确选项）" }}</p>
          <label v-for="option in flow.question?.options ?? []" :key="option.id">
            <input
              :type="isMulti ? 'checkbox' : 'radio'"
              name="answer-option"
              :checked="draft.selectedOptionIds.includes(option.id)"
              @change="toggleOption(option.id, $event)"
            />
            {{ option.text }}
          </label>
        </div>
        <div v-if="flow.question?.blanks.length" data-testid="answer-blanks">
          <label v-for="blank in flow.question.blanks" :key="blank.id">
            {{ blank.label }}
            <input :value="blankAnswer(blank.id)" @input="onBlankAnswerInput(blank.id, $event)" />
          </label>
        </div>
        <label v-if="needsTextAnswer">简答答案
          <textarea data-testid="answer-text" :value="draft.textAnswer" @input="onTextAnswerInput"></textarea>
        </label>
        <div class="explanation">
          <p class="muted">解析（按纯文本渲染）：</p>
          <pre data-testid="answer-explanation">{{ flow.answer.explanation }}</pre>
          <p v-if="flow.answer.caveats.length" class="warn">不确定项：{{ flow.answer.caveats.join("；") }}</p>
        </div>
        <div class="row">
          <button class="primary" data-testid="review-answer" :disabled="!canReview" @click="reviewAnswer">审核答案</button>
        </div>
      </section>

      <section v-if="flow.planPreview" class="card" data-testid="plan-preview">
        <h2 class="step"><span class="step-num">4</span>逐字段回填预览</h2>
        <p class="muted">
          页面类型 {{ flow.planPreview.pageKind }} · 适配器 {{ flow.planPreview.adapterId }} v{{ flow.planPreview.adapterVersion }} ·
          事件策略 {{ flow.planPreview.eventPolicy }}
        </p>
        <table>
          <thead>
            <tr><th>字段</th><th>当前值</th><th>将写入</th><th>状态</th></tr>
          </thead>
          <tbody>
            <tr v-for="field in flow.planPreview.fields" :key="field.fieldId" data-testid="plan-field">
              <td>{{ field.label }}</td>
              <td>{{ field.currentText }}</td>
              <td>{{ field.valueText }}</td>
              <td>{{ field.ready ? "就绪" : field.code }}</td>
            </tr>
          </tbody>
        </table>
        <div class="row">
          <button class="primary" data-testid="approve-fill" :disabled="!canApprove" @click="approveFill">审核并回填本题</button>
        </div>
        <p class="hint">回填只写入本题控件并立即回读；不会提交、不会保存，也不会自动重试。</p>
      </section>

      <section
        v-if="flow.fillResult"
        class="card"
        :class="flow.fillResult.status === 'FILLED' ? 'ok' : 'warn'"
        data-testid="fill-result"
      >
        <h2>回填结果：{{ flow.fillResult.status }}</h2>
        <p v-if="flow.fillResult.status !== 'FILLED'" data-testid="partial-fill-count">
          已写入 {{ flow.fillResult.writtenCount }} / {{ flow.fillResult.totalCount }} 字段，持久生效
          {{ flow.fillResult.persistedCount }} 个；错误码 {{ flow.fillResult.code || "-" }}。
        </p>
        <p v-else>已回读验证 {{ flow.fillResult.totalCount }} 个字段；未提交。</p>
        <ul>
          <li v-for="field in flow.fillResult.fields" :key="field.fieldId">
            {{ field.label }}：{{ field.status }}（回读：{{ field.readBackText || "(空)" }}）
          </li>
        </ul>
      </section>

      <section v-if="flow.failure" class="card error" data-testid="failure">
        <p class="error-code" data-testid="error-code">{{ flow.failure.code }}</p>
        <p><strong>{{ flow.failure.title }}</strong></p>
        <p>{{ flow.failure.hint }}</p>
        <p class="muted">{{ flow.failure.detail }}</p>
        <div v-if="permissionTabId !== null" data-testid="site-permission">
          <label>允许读取的学习通站点（仅 HTTPS）
            <input v-model="permissionSite" data-testid="permission-site" :disabled="busy" placeholder="请输入目标页面的 HTTPS 地址" />
          </label>
          <p class="hint">缺少权限时 Chrome 可能隐藏当前网址，请核对并输入目标站点。仅申请此站点，不申请全部子域；可在 Chrome 扩展详情的“网站访问权限”中撤销。拒绝后可重新授权，再打开课程任务调度。</p>
          <p v-if="sitePermissionOrigin(permissionSite)" class="muted" data-testid="permission-origin">{{ sitePermissionOrigin(permissionSite) }}</p>
          <button data-testid="allow-site-reading" :disabled="busy || !sitePermissionOrigin(permissionSite)" @click="allowSiteReading">允许读取当前站点（可选）</button>
          <p v-if="permissionNotice" class="hint" data-testid="permission-notice">{{ permissionNotice }}</p>
        </div>
        <ul v-if="flow.failure.checks.length">
          <li v-for="check in flow.failure.checks" :key="check.id">{{ checkLabel(check) }}</li>
        </ul>
      </section>

      <p v-if="flow.notice" class="hint" data-testid="notice">{{ flow.notice }}</p>
    </template>
  </main>
</template>
