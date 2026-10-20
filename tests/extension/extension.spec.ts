import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  approveFill,
  backendPortFromManifest,
  captureFirstQuestion,
  closeExtension,
  ensureLoggedIn,
  extensionAvailable,
  launchExtension,
  openFixturePage,
  openSidePanelForFixture,
  readCounters,
  readFrameCounters,
  readManifest,
  reviewAnswer,
  sendAnswer,
  startMockBackend,
  type ExtensionSession,
  type MockBackend,
} from "./harness";
import type { FixtureCounters } from "./harness";

const available = extensionAvailable();
const port = available ? backendPortFromManifest() : 8080;

let backend: MockBackend | null = null;
let session: ExtensionSession | null = null;
let setupError: string | null = null;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  if (!available) {
    return;
  }
  try {
    backend = await startMockBackend({ port });
    session = await launchExtension();
  } catch (error) {
    setupError = error instanceof Error ? error.message : String(error);
    // Surface the reason for the skipped suite; otherwise the list reporter only prints "-".
    console.error("[extension.spec] setup failed:", setupError);
  }
});

test.afterAll(async () => {
  if (session) {
    await closeExtension(session);
  }
  if (backend) {
    await backend.close();
  }
});

test.beforeEach(() => {
  test.skip(
    !available,
    "apps/extension/dist is missing or was not built for a local backend origin; run 'node scripts/build-extension.mjs' first",
  );
  test.skip(setupError !== null, setupError ?? "extension test setup failed");
});

test.afterEach(async () => {
  if (session) {
    for (const page of session.context.pages()) {
      await page.close().catch(() => undefined);
    }
  }
});

function requireBackend(): MockBackend {
  if (!backend) {
    throw new Error("mock backend is not running");
  }
  return backend;
}

function requireSession(): ExtensionSession {
  if (!session) {
    throw new Error("extension session is not running");
  }
  return session;
}

async function setupFixture(fixtureFile: string): Promise<{ fixture: Page; panel: Page; tabId: number }> {
  const active = requireSession();
  const fixture = await openFixturePage(active.context, requireBackend(), fixtureFile);
  const { panel, tabId } = await openSidePanelForFixture(
    active.context,
    requireBackend(),
    active.extensionId,
    fixture,
  );
  await ensureLoggedIn(panel);
  requireBackend().reset();
  return { fixture, panel, tabId };
}

function zeroCounters(): FixtureCounters {
  return { input: 0, change: 0, paste: 0, keydown: 0, submit: 0, fetch: 0, xhr: 0, copy: 0 };
}

test("MV3 manifest 使用最小权限，不请求 cookies/webRequest/debugger/all_urls", () => {
  const manifest = readManifest();
  expect(manifest.manifest_version).toBe(3);
  const permissions = manifest.permissions as string[];
  expect(permissions.sort()).toEqual(["activeTab", "scripting", "sidePanel", "storage"]);
  const forbidden = ["cookies", "webRequest", "debugger", "unlimitedStorage"];
  for (const permission of forbidden) {
    expect(permissions).not.toContain(permission);
  }
  const hostPermissions = manifest.host_permissions as string[];
  expect(hostPermissions).toEqual([`http://127.0.0.1:${port}/*`]);
  // 用户按需授权的供应商 Origin（不是安装即授予的 host_permissions）：本地直连供应商需要
  // HTTPS 供应商、本机回环 provider 与 localhost 三类用户授权 Origin；与
  // scripts/build-extension.mjs 的 expectedOptional 保持一致，默认不授予、由用户在设置页确认。
  expect(manifest.optional_host_permissions).toEqual([
    "https://*/*",
    "http://127.0.0.1/*",
    "http://localhost/*",
  ]);
  for (const pattern of hostPermissions) {
    expect(pattern).not.toContain("<all_urls>");
  }
  const contentSecurityPolicy = manifest.content_security_policy as { extension_pages?: string };
  expect(contentSecurityPolicy.extension_pages).toContain("script-src 'self'");
  expect(contentSecurityPolicy.extension_pages).not.toContain("unsafe-eval");
  expect(JSON.stringify(manifest)).not.toContain("externally_connectable");
  expect(JSON.stringify(manifest)).not.toContain("unsafe-inline");
});

test("可选站点权限默认未授予，历史点击行为被重置", async () => {
  const worker = requireSession().context.serviceWorkers()[0];
  const state = await worker.evaluate(async () => ({
    granted: await chrome.permissions.getAll(),
    panel: await chrome.sidePanel.getPanelBehavior()
  }));
  expect(state.granted.origins).not.toContain("https://*.chaoxing.com/*");
  expect(state.granted.origins?.some((origin) => origin.includes("chaoxing.com"))).toBe(false);
  expect(state.panel.openPanelOnActionClick).toBe(false);
});

test("practice：采集不发请求、审核前零写入、只有点击发送才调用后端", async () => {
  const active = requireBackend();
  const { fixture, panel } = await setupFixture("practice.html");

  await panel.getByTestId("capture-question").click();
  await expect(panel.getByTestId("candidate-list")).toBeVisible();
  const candidateCount = await panel.getByTestId("candidate-list").locator("button").count();
  expect(candidateCount).toBe(5);
  await panel.getByTestId("candidate-0").click();

  await expect(panel.getByTestId("question-preview")).toBeVisible();
  await expect(panel.getByTestId("page-kind-badge")).toContainText("PRACTICE");
  await expect(panel.getByTestId("question-stem")).toHaveValue(/1 \+ 1/);
  await expect(panel.getByTestId("send-preview")).toContainText("opt_1");

  expect(await readCounters(fixture)).toEqual(zeroCounters());
  const checkedBeforeApproval = await fixture.evaluate(
    () => document.querySelectorAll("input[type=radio]:checked, input[type=checkbox]:checked").length,
  );
  expect(checkedBeforeApproval).toBe(0);
  expect(await panel.getByTestId("approve-fill").count()).toBe(0);
  expect(active.requests).toEqual([]);

  await sendAnswer(panel);
  expect(active.studyAnswerRequests().length).toBe(1);
  await expect(panel.getByTestId("answer-explanation")).toContainText("E2E 伪后端");
  expect(await readCounters(fixture)).toEqual(zeroCounters());
});

test("graded：计分页拒绝回填且不提交，零写入", async () => {
  const active = requireBackend();
  const { fixture, panel } = await setupFixture("graded.html");

  await panel.getByTestId("capture-question").click();
  await expect(panel.getByTestId("error-code")).toHaveText("PAGE_KIND_UNSUPPORTED");
  await expect(panel.getByTestId("failure")).toContainText("计分");
  expect(active.requests).toEqual([]);
  expect(await readCounters(fixture)).toEqual(zeroCounters());
  const untouched = await fixture.evaluate(() => ({
    checked: document.querySelectorAll("input[type=radio]:checked, input[type=checkbox]:checked").length,
    blanks: Array.from(document.querySelectorAll("[data-blank]")).map(
      (node) => (node as HTMLInputElement).value,
    ),
  }));
  expect(untouched.checked).toBe(0);
  expect(untouched.blanks).toEqual([""]);
});

test("autosubmit-field：写入前拒绝，页面 input 副作用与 submit 计数保持 0", async () => {
  const active = requireBackend();
  const { fixture, panel } = await setupFixture("autosubmit-field.html");

  await panel.getByTestId("capture-question").click();
  await expect(panel.getByTestId("question-preview")).toBeVisible();
  await expect(panel.getByTestId("blocked-reason")).toBeVisible();
  await expect(panel.getByTestId("blocked-reason")).toContainText("自动保存或提交");
  expect(await readCounters(fixture)).toEqual(zeroCounters());
  expect(await fixture.evaluate(() => document.body.getAttribute("data-auto-submit-triggered"))).toBeNull();

  await sendAnswer(panel);
  await panel.getByTestId("review-answer").click();
  await expect(panel.getByTestId("notice")).toContainText("不支持回填");
  await expect(panel.getByTestId("plan-preview")).toHaveCount(0);
  expect(await readCounters(fixture)).toEqual(zeroCounters());
  expect(active.requests.filter((entry) => entry.path.includes("submit"))).toEqual([]);
});

test("readonly-field：FIELD_READ_ONLY，移除/写入只读字段均不发生", async () => {
  const { fixture, panel } = await setupFixture("readonly-field.html");

  await captureFirstQuestion(panel);
  await expect(panel.getByTestId("page-kind-badge")).toContainText("PRACTICE");
  await sendAnswer(panel);
  await reviewAnswer(panel);

  await expect(panel.getByTestId("error-code")).toHaveText("FIELD_READ_ONLY");
  await expect(panel.getByTestId("plan-preview")).toHaveCount(0);
  expect(await readCounters(fixture)).toEqual(zeroCounters());
  const state = await fixture.evaluate(() => {
    const readonlyBlank = document.getElementById("readonly-blank-1") as HTMLInputElement;
    const disabledBlank = document.getElementById("readonly-blank-2") as HTMLInputElement;
    return {
      readonly: readonlyBlank.readOnly,
      disabled: disabledBlank.disabled,
      readonlyValue: readonlyBlank.value,
      disabledValue: disabledBlank.value,
    };
  });
  expect(state.readonly).toBe(true);
  expect(state.disabled).toBe(true);
  expect(state.readonlyValue).toBe("只读原值");
  expect(state.disabledValue).toBe("禁用原值");
});

test("changed-question：题目变化后拒绝回填，零写入", async () => {
  const { fixture, panel } = await setupFixture("changed-question.html");

  await captureFirstQuestion(panel);
  await expect(panel.getByTestId("question-stem")).toHaveValue(/题干/);

  await fixture.evaluate(() => {
    const button = document.getElementById("simulate-question-change");
    if (button instanceof HTMLButtonElement) {
      button.click();
    }
    // The fixture's 1500ms timer may already have fired on a busy machine.
    // Always mutate after capture so this checks stale-write rejection deterministically.
    const stem = document.getElementById("changed-stem");
    if (stem) stem.textContent += "（采集后变更）";
  });
  await expect(fixture.locator("html")).toHaveAttribute("data-question-changed", "1");

  await sendAnswer(panel);
  await reviewAnswer(panel);
  await expect(panel.getByTestId("error-code")).toHaveText("QUESTION_CHANGED");
  await expect(panel.getByTestId("plan-preview")).toHaveCount(0);
  expect(await readCounters(fixture)).toEqual(zeroCounters());
  expect(
    await fixture.evaluate(() => document.querySelectorAll("input[type=radio]:checked, input[type=checkbox]:checked").length),
  ).toBe(0);
});

test("controlled-input：受控字段回弹被识别为 VALUE_REVERTED / PARTIAL_FILL", async () => {
  const { fixture, panel } = await setupFixture("controlled-input.html");

  await captureFirstQuestion(panel);
  await sendAnswer(panel);
  await reviewAnswer(panel);
  await expect(panel.getByTestId("plan-preview")).toBeVisible();
  expect(await panel.getByTestId("plan-field").count()).toBe(2);
  await approveFill(panel);

  await expect(panel.getByTestId("fill-result")).toContainText("PARTIAL_FILL");
  await expect(panel.getByTestId("partial-fill-count")).toContainText("VALUE_REVERTED");
  await expect(panel.getByTestId("error-code")).toHaveText("VALUE_REVERTED");
  const values = await fixture.evaluate(() => {
    const first = document.getElementById("controlled-blank-1") as HTMLInputElement;
    const second = document.getElementById("controlled-blank-2") as HTMLInputElement;
    return { first: first.value, second: second.value };
  });
  expect(values.first).toBe("答案1");
  expect(values.second).toBe("初始值（不可改）");
  const counters = await readCounters(fixture);
  expect(counters.input).toBeGreaterThanOrEqual(2);
  expect(counters.change).toBeGreaterThanOrEqual(2);
  expect(counters.submit).toBe(0);
  expect(counters.fetch).toBe(0);
  expect(counters.xhr).toBe(0);
});

test("no-paste：阻止粘贴的页面仍可通过控件写入完成回填，paste 计数为 0", async () => {
  const { fixture, panel } = await setupFixture("no-paste.html");

  await captureFirstQuestion(panel);
  await sendAnswer(panel);
  await reviewAnswer(panel);
  await expect(panel.getByTestId("plan-preview")).toBeVisible();
  await approveFill(panel);

  await expect(panel.getByTestId("fill-result")).toContainText("FILLED");
  await expect(panel.getByTestId("fill-result")).toContainText("未提交");
  const values = await fixture.evaluate(() =>
    Array.from(document.querySelectorAll("[data-blank]")).map((node) => (node as HTMLInputElement).value),
  );
  expect(values).toEqual(["答案1", "答案2"]);
  const counters = await readCounters(fixture);
  expect(counters.paste).toBe(0);
  expect(counters.submit).toBe(0);
});

test("selection-disabled：Selection 为空仍可采集并回填，不使用复制/剪贴板", async () => {
  const { fixture, panel } = await setupFixture("selection-disabled.html");

  await captureFirstQuestion(panel);
  await expect(panel.getByTestId("question-stem")).toHaveValue(/Selection 为空/);
  await sendAnswer(panel);
  await reviewAnswer(panel);
  await approveFill(panel);

  await expect(panel.getByTestId("fill-result")).toContainText("FILLED");
  const state = await fixture.evaluate(() => ({
    selected: window.getSelection()?.toString() ?? "",
    checked: (document.querySelector("input[type=radio]") as HTMLInputElement).checked,
    copy: window.__counters.copy,
  }));
  expect(state.selected).toBe("");
  expect(state.checked).toBe(true);
  expect(state.copy).toBe(0);
});

test("iframe-question：同源 iframe 绑定并回填，无权限框架保持关闭", async () => {
  const { fixture, panel } = await setupFixture("iframe-question.html");

  await captureFirstQuestion(panel);
  await expect(panel.getByTestId("question-stem")).toHaveValue(/iframe 内的题目/);
  expect(await readFrameCounters(fixture, "#question-frame")).toEqual(zeroCounters());
  const crossOriginState = await fixture.evaluate(() => {
    const cross = document.getElementById("cross-origin-frame") as HTMLIFrameElement;
    return { accessible: cross.contentDocument !== null, sandbox: cross.getAttribute("sandbox") };
  });
  expect(crossOriginState.accessible).toBe(false);
  expect(crossOriginState.sandbox).not.toContain("allow-same-origin");

  await sendAnswer(panel);
  await reviewAnswer(panel);
  await approveFill(panel);
  await expect(panel.getByTestId("fill-result")).toContainText("FILLED");
  const frameState = await fixture.evaluate(() => {
    const frame = document.getElementById("question-frame") as HTMLIFrameElement;
    const doc = frame.contentDocument;
    if (!doc) {
      throw new Error("frame lost");
    }
    return { checked: (doc.querySelector("input[type=radio]") as HTMLInputElement).checked };
  });
  expect(frameState.checked).toBe(true);
  const frameCounters = await readFrameCounters(fixture, "#question-frame");
  expect(frameCounters.input).toBeGreaterThan(0);
  expect(frameCounters.submit).toBe(0);
});

test("prompt-injection：注入文本按数据渲染，未知编辑器 CONTROL_UNSUPPORTED", async () => {
  const { fixture, panel } = await setupFixture("prompt-injection.html");

  await captureFirstQuestion(panel);
  await expect(panel.getByTestId("send-preview")).toContainText("<script>");
  const injectionState = await fixture.evaluate(() => ({
    executed: window.__injectionExecuted,
    scriptNodes: document.querySelectorAll("[data-question-stem] script").length,
  }));
  expect(injectionState.executed).toBe(false);
  expect(injectionState.scriptNodes).toBe(0);
  await sendAnswer(panel);
  await reviewAnswer(panel);
  await approveFill(panel);
  await expect(panel.getByTestId("fill-result")).toContainText("FILLED");
  expect(
    await fixture.evaluate(() => document.querySelectorAll("input[type=radio]:checked, input[type=checkbox]:checked").length),
  ).toBe(1);

  // Second pass: the unknown contenteditable container must not be written.
  const second = await setupFixture("prompt-injection.html");
  await second.panel.getByTestId("capture-question").click();
  await expect(second.panel.getByTestId("candidate-list")).toBeVisible();
  await second.panel.getByTestId("candidate-1").click();
  await expect(second.panel.getByTestId("blocked-reason")).toBeVisible();
  const editorState = await second.fixture.evaluate(() => {
    const editor = document.querySelector("[data-unknown-editor]");
    return { text: editor?.textContent ?? "", html: editor?.innerHTML ?? "" };
  });
  expect(editorState.text).toContain("未知编辑器初始内容");
  expect(editorState.html).not.toContain("<script");
  expect(await readCounters(second.fixture)).toEqual(zeroCounters());
});

test("关闭侧边栏后重新打开，不恢复题文或答案", async () => {
  const active = requireSession();
  const fixturePage = await openFixturePage(active.context, requireBackend(), "practice.html");
  let { panel } = await openSidePanelForFixture(active.context, requireBackend(), active.extensionId, fixturePage);
  await ensureLoggedIn(panel);
  await captureFirstQuestion(panel);
  await expect(panel.getByTestId("question-preview")).toBeVisible();
  await panel.close();

  const reopened = await openSidePanelForFixture(
    active.context,
    requireBackend(),
    active.extensionId,
    fixturePage,
  );
  await expect(reopened.panel.getByTestId("login-status")).toBeVisible();
  await expect(reopened.panel.getByTestId("question-preview")).toHaveCount(0);
  await expect(reopened.panel.getByTestId("answer-section")).toHaveCount(0);
  void fixturePage;
});

test("课程调度：一次读取源数据、异步汇总回填、提交与下一任务且不抢占其他标签", async () => {
  const active = requireSession();
  const fixture = await openFixturePage(active.context, requireBackend(), "automation-course.html");
  const { panel, tabId } = await openSidePanelForFixture(active.context, requireBackend(), active.extensionId, fixture);
  await ensureLoggedIn(panel);
  // A previous manual read leaves its listener installed in the same document.
  // It must not answer AUTOMATION_PAGE before the course adapter does.
  await panel.getByTestId("capture-question").click();
  await expect(panel.getByTestId("error-code")).toHaveText("ADAPTER_NOT_MATCHED");
  await panel.close();
  const runner = await active.context.newPage();
  await runner.goto(`chrome-extension://${active.extensionId}/runner.html?tabId=${tabId}`);
  await expect(runner.getByTestId("runner-provider")).toContainText("deepseek-flash");
  requireBackend().reset();
  await runner.getByTestId("runner-preview").click();
  // §9.16 GitHub 计数胶囊：文案为「3已读取」，不再是旧的「已读取 3 题」。
  await expect(runner.getByTestId("runner-inventory")).toContainText("3已读取");
  await expect(runner.getByRole("group", { name: "题目签到表" }).getByRole("button")).toHaveCount(3);
  await expect(runner.getByTestId("runner-source-question")).toHaveCount(0);
  await expect(runner.getByTestId("runner-image")).toHaveCount(0);
  expect(requireBackend().studyAnswerRequests()).toHaveLength(0);
  await expect(runner.getByTestId("runner-limits")).toContainText("并行请求 2");
  // 本用例验证「源文字可读时不附图」的 auto 语义；默认全图模式会改变请求形态，显式关闭。
  await runner.getByTestId("runner-always-image").uncheck();
  await runner.getByTestId("runner-consent").check();
  requireBackend().reset();
  await runner.getByTestId("runner-start").click();
  const other = await active.context.newPage();
  await other.goto("about:blank");
  await other.bringToFront();
  await expect(runner.getByTestId("runner-state")).toContainText("DONE", { timeout: 45000 });
  const counters = await fixture.evaluate(() => (window as unknown as { automationCounters: { send:number;confirm:number;next:number } }).automationCounters);
  expect(counters).toEqual({ send: 1, confirm: 1, next: 1 });
  const requests = requireBackend().studyAnswerRequests();
  expect(requests).toHaveLength(3);
  for (const type of ["SINGLE_CHOICE", "FILL_BLANK", "SHORT_ANSWER"]) {
    expect(requests.filter(request => JSON.parse(request.body).question.type === type)).toHaveLength(1);
  }
  for (const request of requests) expect(JSON.parse(request.body).question.imageDataUrl).toBeUndefined();
  expect(JSON.parse(requests[0]!.body).question.stem).toContain("1 + 1");
  await expect(runner.getByTestId("runner-pipeline")).toContainText("3本轮调用");
});

test("课程调度：刷题模式从第二题开始并保留第一题且连续完成后续任务点", async () => {
  const active = requireSession();
  const fixture = await openFixturePage(active.context, requireBackend(), "automation-course.html");
  const { panel, tabId } = await openSidePanelForFixture(active.context, requireBackend(), active.extensionId, fixture);
  await ensureLoggedIn(panel); await panel.close();
  await fixture.locator('.num_option[data="A"]').click();
  const runner = await active.context.newPage();
  await runner.goto(`chrome-extension://${active.extensionId}/runner.html?tabId=${tabId}`);
  await expect(runner.getByTestId("runner-limits")).toBeVisible();
  await runner.getByTestId("runner-start-question").fill("2");
  await runner.getByTestId("runner-consent").check();
  requireBackend().reset();
  await runner.getByTestId("runner-mode").selectOption("questions");
  await runner.getByTestId("runner-start").click();
  // 刷题模式连续完成任务点（20:3x 起的既定行为），任务链结束后停在“已到最后一个任务”。
  await expect(runner.getByTestId("runner-state")).toContainText("DONE", { timeout: 45000 });
  await expect(runner.getByTestId("runner-state")).toContainText("已到最后一个任务");
  expect(await fixture.evaluate(() => (window as unknown as { automationCounters: unknown }).automationCounters))
    .toEqual({ send: 1, confirm: 1, next: 1 });
  expect(requireBackend().studyAnswerRequests()).toHaveLength(2);
  expect(requireBackend().studyAnswerRequests().some(request => JSON.parse(request.body).question.id === "q_1")).toBe(false);
});

test("课程调度：模糊题跳过后统一补答，其他题自动填写，补全后自动继续", async () => {
  const active = requireSession();
  const fixture = await openFixturePage(active.context, requireBackend(), "automation-course.html");
  const { panel, tabId } = await openSidePanelForFixture(active.context, requireBackend(), active.extensionId, fixture);
  await ensureLoggedIn(panel); await panel.close();
  const runner = await active.context.newPage();
  await runner.goto(`chrome-extension://${active.extensionId}/runner.html?tabId=${tabId}`);
  await expect(runner.getByTestId("runner-inventory")).toContainText("3已读取");
  await runner.getByTestId("runner-consent").check(); requireBackend().reset();
  requireBackend().setAnswerOverride((request, answer) => (request.question as { id: string }).id === "q_1" ?
    { ...(answer as object), status: "NEEDS_CONTEXT", selectedOptionIds: [], caveats: ["图片模糊"] } : answer);
  await runner.getByTestId("runner-mode").selectOption("questions");
  await runner.getByTestId("runner-start").click();
  await expect(runner.getByTestId("runner-state")).toContainText("NEEDS_INPUT", { timeout: 45000 });
  expect(requireBackend().studyAnswerRequests()).toHaveLength(4);
  expect(await fixture.evaluate(() => (window as unknown as { automationCounters: unknown }).automationCounters)).toEqual({ send: 0, confirm: 0, next: 0 });
  await runner.getByTestId("manual-question-1").getByRole("radio").first().check();
  await runner.getByTestId("manual-question-1").getByTestId("manual-entry").click();
  // 补答核验后继续提交并连续推进到任务链末尾。
  await expect(runner.getByTestId("runner-state")).toContainText("DONE", { timeout: 15000 });
  await expect(runner.getByTestId("runner-state")).toContainText("已到最后一个任务");
  expect(requireBackend().studyAnswerRequests()).toHaveLength(4);
  expect(await fixture.evaluate(() => (window as unknown as { automationCounters: unknown }).automationCounters)).toEqual({ send: 1, confirm: 1, next: 1 });
  requireBackend().setAnswerOverride(null);
});

test("课程调度：只给图示题附图且缺少上下文时改发整题图片采用第二次回答", async () => {
  const active = requireSession();
  const fixture = await openFixturePage(active.context, requireBackend(), "automation-course.html");
  await fixture.evaluate(() => new Promise<void>(resolve => {
    const canvas = document.createElement("canvas"); canvas.width = 800; canvas.height = 600;
    const context = canvas.getContext("2d")!;
    const pixels = context.createImageData(canvas.width, canvas.height);
    let seed = 123456789;
    for (let offset = 0; offset < pixels.data.length; offset += 4) {
      for (let channel = 0; channel < 3; channel++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; pixels.data[offset + channel] = seed >>> 24; }
      pixels.data[offset + 3] = 255;
    }
    context.putImageData(pixels, 0, 0);
    const image = document.createElement("img"); image.onload = () => resolve();
    image.src = canvas.toDataURL("image/png");
    document.querySelector("#question2 .Zy_TItle")!.append(image);
  }));
  const { panel, tabId } = await openSidePanelForFixture(active.context, requireBackend(), active.extensionId, fixture);
  await ensureLoggedIn(panel); await panel.close();
  const runner = await active.context.newPage();
  await runner.goto(`chrome-extension://${active.extensionId}/runner.html?tabId=${tabId}`);
  await expect(runner.getByTestId("runner-inventory")).toContainText("1图像兜底");
  // 本用例验证「只有图示题附图」的 auto 语义；默认全图模式需显式关闭。
  await runner.getByTestId("runner-always-image").uncheck();
  await runner.getByTestId("runner-consent").check(); requireBackend().reset();
  let attempts = 0;
  requireBackend().setAnswerOverride((request, answer) => (request.question as { id: string }).id === "q_2" && ++attempts === 1 ?
    { ...(answer as object), status: "NEEDS_CONTEXT", blankAnswers: [], caveats: ["答案不确定，需要复核"] } : answer);
  await runner.getByTestId("runner-mode").selectOption("questions");
  await runner.getByTestId("runner-start").click();
  await expect(runner.getByTestId("runner-state")).toContainText("DONE", { timeout: 45000 });
  await expect(runner.getByTestId("runner-state")).toContainText("已到最后一个任务");
  const requests = requireBackend().studyAnswerRequests().map(request => JSON.parse(request.body).question);
  expect(requests).toHaveLength(4);
  for (const question of requests) if (question.id === "q_2") expect(question.imageDataUrl.length).toBeGreaterThan(400000);
  expect(requests.filter(question => question.imageDataUrl)).toHaveLength(2);
  expect(requests.filter(question => question.id === "q_2")).toHaveLength(2);
  await expect(runner.getByTestId("runner-manual-summary")).toHaveCount(0);
  requireBackend().setAnswerOverride(null);
});

test("课程调度：判断题 true/false 隐藏答案可回填并提交", async () => {
  const active = requireSession();
  const fixture = await openFixturePage(active.context, requireBackend(), "automation-judge.html");
  const { panel, tabId } = await openSidePanelForFixture(active.context, requireBackend(), active.extensionId, fixture);
  await ensureLoggedIn(panel); await panel.close();
  const runner = await active.context.newPage();
  await runner.goto(`chrome-extension://${active.extensionId}/runner.html?tabId=${tabId}`);
  // 打开调度页会自动读取全部题目源数据（读取阶段不发送模型请求）；先等读取完成再授权运行。
  await expect(runner.getByTestId("runner-inventory")).toContainText("1已读取");
  await runner.getByTestId("runner-consent").check(); requireBackend().reset();
  await runner.getByTestId("runner-mode").selectOption("questions");
  await runner.getByTestId("runner-start").click();
  await expect(runner.getByTestId("runner-state")).toContainText("DONE", { timeout: 45000 });
  await expect(runner.getByTestId("runner-state")).toContainText("已到最后一个任务");
  // 真实判断题皮肤把隐藏答案写回 true/false（不是 A/B）；回读通过后不应转人工补答。
  await expect(runner.getByTestId("runner-manual-summary")).toHaveCount(0);
  expect(await fixture.evaluate(() => (window as unknown as { automationCounters: unknown }).automationCounters))
    .toEqual({ send: 1, confirm: 1, next: 0 });
  expect(await fixture.evaluate(() => document.querySelector<HTMLInputElement>("#answer1")?.value ?? null)).toBe("true");
  const requests = requireBackend().studyAnswerRequests();
  expect(requests).toHaveLength(1);
  expect((JSON.parse(requests[0]!.body).question as { type: string }).type).toBe("TRUE_FALSE");
});

test("课程调度：刷题模式直接跳过未完成的视频任务点且不尝试播放", async () => {
  const active = requireSession();
  const fixture = await openFixturePage(active.context, requireBackend(), "automation-video.html");
  const { panel, tabId } = await openSidePanelForFixture(active.context, requireBackend(), active.extensionId, fixture);
  await ensureLoggedIn(panel); await panel.close();
  const runner = await active.context.newPage();
  await runner.goto(`chrome-extension://${active.extensionId}/runner.html?tabId=${tabId}`);
  await expect(runner.getByTestId("runner-limits")).toBeVisible();
  await runner.getByTestId("runner-consent").check(); requireBackend().reset();
  await runner.getByTestId("runner-mode").selectOption("questions");
  await runner.getByTestId("runner-start").click();
  await expect(runner.getByTestId("runner-state")).toContainText("DONE", { timeout: 45000 });
  await expect(runner.getByTestId("runner-state")).toContainText("已到最后一个任务");
  // 未完成视频按「跳过」计数（不是完成），且从未点击过播放控件、没有模型请求。
  await expect(runner.getByTestId("runner-skipped-videos")).toContainText("1");
  expect(await fixture.evaluate(() => (window as unknown as { automationCounters: { play: number; next: number } }).automationCounters)).toEqual({ play: 0, next: 1 });
  expect(requireBackend().studyAnswerRequests()).toHaveLength(0);
});

test("课程调度：视频弹题经真实 MV3 桥枚举作答（A 错 B 对），全程不调用模型", async () => {
  const active = requireSession();
  const fixture = await openFixturePage(active.context, requireBackend(), "automation-video-popup.html");
  const { panel, tabId } = await openSidePanelForFixture(active.context, requireBackend(), active.extensionId, fixture);
  await ensureLoggedIn(panel); await panel.close();
  const runner = await active.context.newPage();
  await runner.goto(`chrome-extension://${active.extensionId}/runner.html?tabId=${tabId}`);
  await expect(runner.getByTestId("runner-limits")).toBeVisible();
  requireBackend().reset();
  // 通过运行页（可信发送方）直接驱动固定页面命令：先 INSPECT 取任务键，再 ENUM_POPUP。
  // 弹题枚举是页面侧动作，不读取题目文本、不调用模型；这里验证的是完整 MV3 链路。
  const outcome = await runner.evaluate(async (boundTabId: number): Promise<{ ok: boolean; popup?: { found: boolean; resolved: boolean; attempts: number; options: number } }> => {
    const runId = (window as typeof window & { __courseRunId?: string }).__courseRunId ?? "probe";
    const send = (command: Record<string, unknown>) =>
      chrome.runtime.sendMessage({ type: "AUTOMATION_COMMAND", tabId: boundTabId, command: { ...command, requestId: "probe_" + Date.now(), runId } });
    const status = await send({ action: "INSPECT" }) as { ok: boolean; snapshot?: { courseKey: string; taskKey: string } };
    if (!status.ok || !status.snapshot) return { ok: false };
    return await send({ action: "ENUM_POPUP", courseKey: status.snapshot.courseKey, taskKey: status.snapshot.taskKey }) as {
      ok: boolean; popup?: { found: boolean; resolved: boolean; attempts: number; options: number };
    };
  }, tabId);
  // 枚举按 DOM 顺序：A 提交后站点保留弹题，B 提交后弹题关闭 → 第 2 次尝试通过。
  expect(outcome.ok).toBe(true);
  expect(outcome.popup).toEqual({ found: true, resolved: true, attempts: 2, options: 3 });
  await expect(fixture.locator("#popup")).toBeHidden();
  const counters = await fixture.evaluate(() => (window as unknown as { automationCounters: unknown }).automationCounters);
  expect(counters).toMatchObject({ popupOptions: 2, popupPass: 1, next: 0 });
  expect(requireBackend().studyAnswerRequests()).toHaveLength(0);
});

test("课程调度：非粘贴题（纯输入框/内联 SVG/Shadow DOM）读取、回填并本地渲染题图", async () => {
  const active = requireSession();
  const fixture = await openFixturePage(active.context, requireBackend(), "automation-nonpaste.html");
  const { panel, tabId } = await openSidePanelForFixture(active.context, requireBackend(), active.extensionId, fixture);
  await ensureLoggedIn(panel); await panel.close();
  const runner = await active.context.newPage();
  await runner.goto(`chrome-extension://${active.extensionId}/runner.html?tabId=${tabId}`);
  // READ_ALL 成功：普通输入框题与 shadow DOM 题干题按文字读取，只有内联 SVG 题需要图像兜底。
  await expect(runner.getByTestId("runner-inventory")).toContainText("3已读取");
  await expect(runner.getByRole("group", { name: "题目签到表" }).getByRole("button")).toHaveCount(3);
  await expect(runner.getByTestId("runner-source-question")).toHaveCount(0);
  await expect(runner.getByTestId("runner-inventory")).toContainText("2文字可用");
  await expect(runner.getByTestId("runner-inventory")).toContainText("1图像兜底");
  await runner.getByTestId("runner-consent").check();
  requireBackend().reset();
  // 默认「所有题目都附带渲染图片」：内联 SVG 必须由本地 canvas 渲染成 data:image 题图，
  // 而不是报「当前图示不是已适配的图片」把人推到人工补答。
  await runner.getByTestId("runner-mode").selectOption("questions");
  await runner.getByTestId("runner-start").click();
  await expect(runner.getByTestId("runner-state")).toContainText("DONE", { timeout: 45000 });
  await expect(runner.getByTestId("runner-state")).toContainText("已到最后一个任务");
  await expect(runner.getByTestId("runner-manual-summary")).toHaveCount(0);
  const state = await fixture.evaluate(() => ({
    // 下一任务的点击会销毁本题 DOM，因此用 fixture 在导航前记录的最终状态做回读断言。
    final: (window as unknown as { automationFinalAnswers?: { input: string; answer1: string } }).automationFinalAnswers ?? null,
    counters: (window as unknown as { automationCounters: unknown }).automationCounters,
    fields: (window as unknown as { automationFieldCounters: { input: number; change: number; blur: number } }).automationFieldCounters,
  }));
  // 普通 input 被写入，并由站点自身的 input/change 同步到隐藏答案后完成任务；全程没有粘贴。
  expect(state.final).not.toBeNull();
  expect(state.final!.input).toBe("答案1");
  expect(state.final!.answer1).toBe("答案1");
  expect(state.counters).toEqual({ send: 1, confirm: 1, next: 1 });
  expect(state.fields.input).toBeGreaterThan(0);
  expect(state.fields.change).toBeGreaterThan(0);
  expect(state.fields.blur).toBeGreaterThan(0);
  const requests = requireBackend().studyAnswerRequests().map(request =>
    JSON.parse(request.body).question as { id: string; type: string; stem: string; imageDataUrl?: string });
  expect(requests).toHaveLength(3);
  expect(requests.find(question => question.id === "q_1")!.type).toBe("FILL_BLANK");
  // shadow DOM 里的题干文字必须被源读取进入请求，而不是退回纯图像题。
  expect(requests.find(question => question.id === "q_3")!.stem).toContain("影子题干");
  // 内联 SVG 题（第 2 题）本地渲染为图像；默认全图模式下三题都带 data:image 题图。
  expect(requests.find(question => question.id === "q_2")!.imageDataUrl).toMatch(/^data:image\//);
  for (const question of requests) {
    expect(question.imageDataUrl).toMatch(/^data:image\//);
  }
});

test("课程调度：独立作业/测验作答页整卷回填核验后只提交一次并无下一任务", async () => {
  const active = requireSession();
  // 2026-10-20 用户授权：把学习通独立作业/测验作答页（dowork）纳入刷题自动运行。
  const fixture = await openFixturePage(active.context, requireBackend(), "automation-work.html");
  const { panel, tabId } = await openSidePanelForFixture(active.context, requireBackend(), active.extensionId, fixture);
  await ensureLoggedIn(panel); await panel.close();
  const runner = await active.context.newPage();
  await runner.goto(`chrome-extension://${active.extensionId}/runner.html?tabId=${tabId}`);
  await expect(runner.getByTestId("runner-inventory")).toContainText("2已读取");
  // 本题集没有图示，关闭“所有题目都附渲染图片”以保持请求形态简单。
  await runner.getByTestId("runner-always-image").uncheck();
  await runner.getByTestId("runner-consent").check();
  requireBackend().reset();
  await runner.getByTestId("runner-mode").selectOption("questions");
  await runner.getByTestId("runner-start").click();
  // 作业页没有任务链：整卷核验通过后提交一次，站点结果视图出现即结束。
  await expect(runner.getByTestId("runner-state")).toContainText("DONE", { timeout: 45000 });
  await expect(runner.getByTestId("runner-state")).toContainText("作业页刷题完成");
  await expect(runner.getByTestId("runner-state")).toContainText("站点已确认提交");
  const counters = await fixture.evaluate(() => (window as unknown as { automationCounters: unknown }).automationCounters);
  expect(counters).toEqual({ send: 1, confirm: 1 });
  expect(requireBackend().studyAnswerRequests()).toHaveLength(2);
});

test("课程调度：提交后连续越过格言图片和普通图文卡片，再自动完成下一题目任务", async () => {
  const active = requireSession();
  const fixture = await openFixturePage(active.context, requireBackend(), "automation-course.html");
  await fixture.route("**/mooc-ans/knowledge/cards?**", async route => {
    const image = new URL(route.request().url()).searchParams.get("num") === "1" ?
      '<span class="ans-img-wrap"><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z6QAAAABJRU5ErkJggg=="></span>' : "普通补充阅读";
    await route.fulfill({ contentType: "text/html; charset=utf-8", body:
      `<!doctype html><body><div id="cardFocus" role="option"></div><div id="pageDiv" class="ans-cc"><h2>每节一句</h2><p>${image}<br></p></div></body>` });
  });
  await fixture.evaluate(() => {
    const state = window as unknown as { automationCounters: { send: number; confirm: number; next: number } };
    let stage = 0;
    document.addEventListener("click", event => {
      const target = event.target as Element;
      if (target.closest("#prevNextFocusNext")) {
        event.stopImmediatePropagation();
        state.automationCounters.next++; stage++;
        document.body.dataset.taskId = `stage_${stage}`;
        document.body.innerHTML = stage < 3 ?
          `<iframe id="iframe" src="/mooc-ans/knowledge/cards?num=${stage}" style="width:700px;height:350px"></iframe><div id="prevNextFocusNext">Next</div>` :
          '<div class="ans-job-icon" aria-label="任务点未完成"></div><div id="question1"><div class="TiMu"><div class="Zy_TItle"><span class="newZy_TItle">【Single Choice】</span>1 + 1 等于多少？</div><ul class="Zy_ulTop"><li><span class="num_option" data="A">A</span>2</li><li><span class="num_option" data="B">B</span>3</li></ul><input type="hidden" id="answer1" value=""></div></div><a class="btnSubmit">Submit</a><div id="confirmSubWin" style="display:none"><a class="bluebtn">OK</a></div>';
      } else if (stage === 3 && target.closest(".num_option")) {
        document.querySelector<HTMLInputElement>("#answer1")!.value = target.getAttribute("data")!;
      } else if (stage === 3 && target.closest(".btnSubmit")) {
        state.automationCounters.send++;
        document.querySelector<HTMLElement>("#confirmSubWin")!.style.display = "block";
      } else if (stage === 3 && target.closest(".bluebtn")) {
        if (document.querySelector<HTMLInputElement>("#answer1")!.value !== "A") return;
        state.automationCounters.confirm++;
        document.querySelector(".ans-job-icon")!.setAttribute("aria-label", "任务点已完成");
        document.querySelector<HTMLElement>("#confirmSubWin")!.style.display = "none";
      }
    }, true);
  });
  const { panel, tabId } = await openSidePanelForFixture(active.context, requireBackend(), active.extensionId, fixture);
  await ensureLoggedIn(panel); await panel.close();
  const runner = await active.context.newPage();
  await runner.goto(`chrome-extension://${active.extensionId}/runner.html?tabId=${tabId}`);
  await expect(runner.getByTestId("runner-inventory")).toContainText("3已读取");
  await runner.getByTestId("runner-always-image").uncheck();
  await runner.getByTestId("runner-consent").check(); requireBackend().reset();
  await runner.getByTestId("runner-mode").selectOption("questions");
  await runner.getByTestId("runner-start").click();
  await expect(runner.getByTestId("runner-state")).toContainText("DONE", { timeout: 45000 });
  await expect(runner.getByTestId("runner-skipped-resources")).toContainText("已越过 2 个");
  await expect(runner.getByTestId("runner-state")).toContainText("已确认完成 2 个任务");
  expect(await fixture.evaluate(() => (window as unknown as { automationCounters: unknown }).automationCounters))
    .toEqual({ send: 2, confirm: 2, next: 3 });
  expect(requireBackend().studyAnswerRequests()).toHaveLength(4);
  await runner.screenshot({ path: test.info().outputPath("static-card-navigation.png"), fullPage: true });
});

test("课程调度：Resource Analysis 代码图片题按两个空格发送，缺少代码上下文时改发原图并自动核验提交", async () => {
  const active = requireSession();
  const fixture = await openFixturePage(active.context, requireBackend(), "automation-resource-blanks.html");
  const { panel, tabId } = await openSidePanelForFixture(active.context, requireBackend(), active.extensionId, fixture);
  await ensureLoggedIn(panel); await panel.close();
  const runner = await active.context.newPage();
  await runner.goto(`chrome-extension://${active.extensionId}/runner.html?tabId=${tabId}`);
  await expect(runner.getByTestId("runner-inventory")).toContainText("1图像兜底");
  await runner.getByTestId("runner-always-image").uncheck();
  await runner.getByTestId("runner-consent").check(); requireBackend().reset();
  let calls = 0;
  requireBackend().setAnswerOverride((_request, answer) => ++calls === 1 ? {
    status: "NEEDS_CONTEXT", selectedOptionIds: [], blankAnswers: [], textAnswer: null,
    explanation: "未提供具体程序代码、空白标记或选项，无法确定各空应填内容。", caveats: []
  } : answer);
  await runner.getByTestId("runner-mode").selectOption("questions");
  await runner.getByTestId("runner-start").click();
  await expect(runner.getByTestId("runner-state")).toContainText("DONE", { timeout: 45000 });
  await expect(runner.getByTestId("runner-manual-summary")).toHaveCount(0);
  const questions = requireBackend().studyAnswerRequests().map(request => JSON.parse(request.body).question);
  expect(questions).toHaveLength(2);
  for (const question of questions) {
    expect(question.type).toBe("FILL_BLANK");
    expect(question.blanks.map((blank: { id: string }) => blank.id)).toEqual(["blank_1", "blank_2"]);
  }
  expect(questions[0].imageDataUrl).toMatch(/^data:image\/jpeg/);
  expect(questions[1].imageDataUrl).toMatch(/^data:image\/jpeg/);
  expect(await fixture.frameLocator("#ueditor_1").locator("body").textContent()).toBe("答案1");
  expect(await fixture.frameLocator("#ueditor_2").locator("body").textContent()).toBe("答案2");
  expect(await fixture.evaluate(() => (window as unknown as { automationCounters: unknown }).automationCounters)).toEqual({ send: 1, confirm: 1 });
  await runner.screenshot({ path: test.info().outputPath("resource-blanks-verified.png"), fullPage: true });
  requireBackend().setAnswerOverride(null);
});

for (const videosOnly of [false, true]) {
  test(`课程调度：未完成章节提示按${videosOnly ? "只刷课模式确认跳过题目" : "刷课模式返回同页补齐任务"}自动处理`, async () => {
    const active = requireSession();
    const fixture = await openFixturePage(active.context, requireBackend(), "automation-chapter-notice.html");
    const { panel, tabId } = await openSidePanelForFixture(active.context, requireBackend(), active.extensionId, fixture);
    await ensureLoggedIn(panel); await panel.close();
    const runner = await active.context.newPage();
    await runner.goto(`chrome-extension://${active.extensionId}/runner.html?tabId=${tabId}`);
    await expect(runner.getByTestId("runner-limits")).toBeVisible();
    await runner.getByTestId("runner-always-image").uncheck();
    await runner.getByTestId("runner-consent").check(); requireBackend().reset();
    await runner.getByTestId("runner-mode").selectOption(videosOnly ? "videos" : "course");
    await runner.getByTestId("runner-start").click();
    await expect(runner.getByTestId("runner-state")).toContainText("DONE", { timeout: 45000 });
    await expect(runner.getByTestId("runner-state")).toContainText("已确认完成 1 个任务");
    await expect(fixture.locator(".jobFinishTip")).toBeHidden();
    const counters = await fixture.evaluate(() => (window as unknown as { automationCounters: unknown }).automationCounters);
    expect(counters).toEqual(videosOnly ? { next: 2, learn: 1, skip: 1, send: 0, confirm: 0 } :
      { next: 1, learn: 1, skip: 0, send: 1, confirm: 1 });
    expect(requireBackend().studyAnswerRequests()).toHaveLength(videosOnly ? 0 : 1);
    if (videosOnly) await expect(runner.getByTestId("runner-skipped-quizzes")).toContainText("1");
    await runner.screenshot({ path: test.info().outputPath(`chapter-notice-${videosOnly ? "skip" : "learn"}.png`), fullPage: true });
  });
}

test("更新菜单：检查 ZIP 更新源、保留配置且不携带供应商凭据；修改 API 地址清除旧 Key", async () => {
  const active = requireSession(), page = await active.context.newPage();
  const feed = requireBackend().baseUrl + "/updates/update.json";
  let advertised = "0.3.0", reads = 0;
  await page.route(feed, async route => {
    reads++;
    expect(route.request().headers().authorization).toBeUndefined();
    expect(route.request().headers().cookie).toBeUndefined();
    expect(route.request().postData()).toBeNull();
    await route.fulfill({ json: { version: advertised, zipUrl: "extension.zip", sha256: "a".repeat(64), notes: "Synthetic release" } });
  });
  await page.goto(`chrome-extension://${active.extensionId}/options.html`);
  await page.getByLabel("API Key（本机保存）", { exact: true }).fill("synthetic-key-not-real");
  await page.getByLabel("Base URL（API 根路径）", { exact: true }).fill(requireBackend().baseUrl + "/v1");
  await expect(page.getByLabel("API Key（本机保存）", { exact: true })).toHaveValue("");
  const menu = page.getByTestId("update-menu");
  await menu.locator("summary").click();
  await expect(menu.locator("summary")).toContainText("v" + String(readManifest().version));
  await page.getByTestId("update-channel").selectOption("zip");
  await page.getByTestId("update-feed").fill(feed);
  await page.getByTestId("update-check").click();
  await expect(page.getByTestId("update-download")).toHaveAttribute("href", requireBackend().baseUrl + "/updates/extension.zip");
  await expect(menu).toContainText("发现新版本 0.3.0");
  await page.screenshot({ path: test.info().outputPath("update-menu-verified.png"), fullPage: true });
  advertised = "0.1.0";
  await page.reload(); await menu.locator("summary").click();
  await expect(page.getByTestId("update-feed")).toHaveValue(feed);
  await page.getByTestId("update-check").click();
  await expect(menu).toContainText("当前版本已是该更新源的最新版本");
  await expect(page.getByTestId("update-download")).toHaveCount(0);
  expect(reads).toBe(2);
  await page.evaluate(async () => { await chrome.storage.local.remove("studyAssistantUpdates"); });
});

test("本地直连：混合答案字段先纠错，按显式空格编号回填两个编辑器，提交一次", async () => {
  const active = requireSession();
  const fixture = await openFixturePage(active.context, requireBackend(), "automation-resource-blanks.html");
  const { panel, tabId } = await openSidePanelForFixture(active.context, requireBackend(), active.extensionId, fixture);
  await panel.close();
  const runner = await active.context.newPage();
  // Seed only a synthetic provider in this isolated extension test profile.
  const settings = await active.context.newPage();
  await settings.goto(`chrome-extension://${active.extensionId}/options.html`);
  await settings.evaluate(async baseUrl => {
    await chrome.storage.local.set({ studyAssistantLocalActiveId: "synthetic", studyAssistantLocalProviders: [{
      id: "synthetic", name: "Synthetic provider", baseUrl, protocol: "CHAT_COMPLETIONS", model: "synthetic-model",
      apiKey: "synthetic-key", instructionRole: "system", outputMode: "JSON_OBJECT", tokenLimitField: "max_tokens",
      supportsTemperature: false, supportsStoreFalse: false, maxOutputTokens: 2048, temperature: null, supportsImages: true
    }] });
  }, requireBackend().baseUrl + "/v1");
  let calls = 0;
  await runner.route(requireBackend().baseUrl + "/v1/chat/completions", async route => {
    calls++;
    expect(route.request().postData()).toContain("requiredIds");
    const content = { status: "ANSWERED", selectedOptionIds: calls === 1 ? ["opt_1"] : [],
      blankAnswers: [{ blankId: "2", answer: "答案2" }, { blankId: "1", answer: "答案1" }],
      textAnswer: null, explanation: "Synthetic answer", caveats: [] };
    await route.fulfill({ json: { choices: [{ message: { content: JSON.stringify(content) }, finish_reason: "stop" }] } });
  });
  try {
    await runner.goto(`chrome-extension://${active.extensionId}/runner.html?tabId=${tabId}`);
    await expect(runner.getByTestId("runner-inventory")).toContainText("1已读取");
    await runner.getByTestId("runner-consent").check();
    requireBackend().reset();
    await runner.getByTestId("runner-mode").selectOption("questions");
    await runner.getByTestId("runner-start").click();
    await expect(runner.getByTestId("runner-state")).toContainText("DONE", { timeout: 45000 });
    await expect(runner.getByTestId("runner-manual-summary")).toHaveCount(0);
    expect(calls).toBe(2);
    await expect(fixture.frameLocator("#ueditor_1").locator("body")).toHaveText("答案1");
    await expect(fixture.frameLocator("#ueditor_2").locator("body")).toHaveText("答案2");
    expect(await fixture.evaluate(() => (window as unknown as { automationCounters: unknown }).automationCounters)).toEqual({ send: 1, confirm: 1 });
    expect(requireBackend().studyAnswerRequests()).toHaveLength(0);
    await runner.screenshot({ path: test.info().outputPath("local-structured-blanks-verified.png"), fullPage: true });
  } finally {
    await settings.evaluate(async () => { await chrome.storage.local.remove(["studyAssistantLocalProviders", "studyAssistantLocalActiveId"]); });
  }
});

test("延迟填空编辑器：只读采集全部 2/5/2 个空，逐空激活回填，切换输入框不误报题目变化", async () => {
  const active = requireSession();
  const fixture = await openFixturePage(active.context, requireBackend(), "automation-lazy-blanks.html");
  const { panel, tabId } = await openSidePanelForFixture(active.context, requireBackend(), active.extensionId, fixture);
  await ensureLoggedIn(panel); await panel.close();
  const runner = await active.context.newPage();
  await runner.goto(`chrome-extension://${active.extensionId}/runner.html?tabId=${tabId}`);
  await expect(runner.getByTestId("runner-inventory")).toContainText("3已读取");
  expect(await fixture.evaluate(() => (window as unknown as { automationCounters: { activate: number } }).automationCounters.activate)).toBe(0);
  await expect(fixture.locator("iframe")).toHaveCount(0);
  const expected = [["while", "do-while"], ["scan.nextLine()", "info.length()", "info.charAt(index)", "info.charAt(index)", "count++"], ["25", "5"]];
  requireBackend().reset();
  requireBackend().setAnswerOverride((request, original) => {
    const question = request.question as { id: string; type: string; blanks: { id: string }[] };
    const values = expected[Number(question.id.slice(2)) - 1]!;
    expect(question.type).toBe("FILL_BLANK"); expect(question.blanks).toHaveLength(values.length);
    return { ...(original as object), selectedOptionIds: [], textAnswer: null,
      blankAnswers: question.blanks.map((blank, i) => ({ blankId: blank.id, answer: values[i] })).reverse() };
  });
  try {
    await runner.getByTestId("runner-always-image").uncheck(); await runner.getByTestId("runner-consent").check();
    await runner.getByTestId("runner-mode").selectOption("questions");
    await runner.getByTestId("runner-start").click();
    await expect(runner.getByTestId("runner-state")).toContainText("DONE", { timeout: 45000 });
    await expect(runner.getByTestId("runner-manual-summary")).toHaveCount(0);
    for (let q = 0; q < expected.length; q++) {
      for (let i = 0; i < expected[q]!.length; i++) {
        await expect(fixture.locator(`#answerEditor${q + 1}_${i + 1}`)).toHaveValue(expected[q]![i]!);
      }
    }
    expect(await fixture.evaluate(() => (window as unknown as { automationCounters: unknown }).automationCounters)).toEqual({ send: 1, confirm: 1, activate: 9 });
    expect(requireBackend().studyAnswerRequests()).toHaveLength(3);
    await runner.screenshot({ path: test.info().outputPath("lazy-blanks-verified.png"), fullPage: true });
  } finally { requireBackend().setAnswerOverride(null); }
});

test("图片选项二次整题发送直接回填，两个补答入口逐题反馈并保留其他题草稿", async () => {
  const active = requireSession();
  const fixture = await openFixturePage(active.context, requireBackend(), "automation-image-options.html");
  const { panel, tabId } = await openSidePanelForFixture(active.context, requireBackend(), active.extensionId, fixture);
  await ensureLoggedIn(panel); await panel.close();
  const runner = await active.context.newPage();
  await runner.goto(`chrome-extension://${active.extensionId}/runner.html?tabId=${tabId}`);
  await expect(runner.getByTestId("runner-inventory")).toContainText("1图像兜底");
  const calls = new Map<string, number>();
  requireBackend().reset();
  requireBackend().setAnswerOverride((request, original) => {
    const question = request.question as { id: string; imageDataUrl?: string; options: unknown[] };
    const count = (calls.get(question.id) ?? 0) + 1; calls.set(question.id, count);
    if (question.id === "q_1") {
      expect(question.options).toHaveLength(2);
      expect(question.imageDataUrl).toMatch(/^data:image\/jpeg/);
      return count === 1 ? { status: "NEEDS_CONTEXT", selectedOptionIds: [], blankAnswers: [], textAnswer: null, explanation: "需要完整选项图片", caveats: [] }
        : { ...(original as object), status: "ANSWERED", selectedOptionIds: ["opt_2"], caveats: ["不确定，但用户明确采用图片阶段结果"] };
    }
    if (question.id === "q_2" && count > 2) {
      expect(question.imageDataUrl).toMatch(/^data:image\/jpeg/);
      return { ...(original as object), status: "ANSWERED", textAnswer: "first entry", caveats: ["不确定"] };
    }
    return { status: "REFUSED", selectedOptionIds: [], blankAnswers: [], textAnswer: null, explanation: "Synthetic manual case", caveats: [] };
  });
  try {
    await runner.getByTestId("runner-always-image").uncheck(); await runner.getByTestId("runner-consent").check();
    await runner.getByTestId("runner-mode").selectOption("questions");
    await runner.getByTestId("runner-start").click();
    await expect(runner.getByTestId("runner-state")).toContainText("NEEDS_INPUT", { timeout: 45000 });
    await expect(fixture.locator("#answer1")).toHaveValue("B");
    expect(calls.get("q_1")).toBe(2);
    await expect(runner.getByTestId("runner-question-1")).toHaveAttribute("data-status", "image");
    await expect(runner.getByTestId("runner-question-2")).toHaveAttribute("data-status", "failed");
    await expect(runner.getByTestId("runner-question-3")).toHaveAttribute("data-status", "failed");
    await expect(runner.getByTestId("runner-image-replies")).toContainText("图片回答");
    const second = runner.getByTestId("manual-question-2"), third = runner.getByTestId("manual-question-3");
    await expect(second.getByRole("button", { name: "采用图片重新发送并回写", exact: true })).toBeVisible();
    await second.getByTestId("manual-view-question").click();
    await expect(runner.getByTestId("runner-question-viewer")).toBeVisible();
    await expect(runner.getByTestId("runner-question-markdown")).toContainText("题干");
    await runner.getByTestId("runner-close-question").click();
    await third.getByTestId("manual-entry").click();
    await expect(third.getByTestId("manual-entry-error")).toContainText("补答不完整");
    await third.locator("textarea").fill("second entry");
    await second.getByTestId("manual-image-retry").click();
    await expect(second.getByTestId("manual-entry-status")).toHaveText("已核验成功");
    await expect(fixture.locator("#entry2")).toHaveValue("first entry");
    await expect(runner.getByTestId("runner-question-2")).toHaveAttribute("data-status", "image");
    await expect(third.locator("textarea")).toHaveValue("second entry");
    expect(calls.get("q_2")).toBe(3);
    expect(await fixture.evaluate(() => (window as unknown as { automationCounters: unknown }).automationCounters)).toEqual({ send: 0, confirm: 0 });
    await runner.screenshot({ path: test.info().outputPath("image-retry-and-entry.png"), fullPage: true });
    await third.getByTestId("manual-entry").click();
    await expect(third.getByTestId("manual-entry-status")).toHaveText("已核验成功");
    await expect(runner.getByTestId("runner-state")).toContainText("DONE", { timeout: 15000 });
    await expect(fixture.locator("#entry3")).toHaveValue("second entry");
    expect(requireBackend().studyAnswerRequests()).toHaveLength(7);
    expect(await fixture.evaluate(() => (window as unknown as { automationCounters: unknown }).automationCounters)).toEqual({ send: 1, confirm: 1 });
  } finally { requireBackend().setAnswerOverride(null); }
});



test("运行中仍可展开、读取题图及复制，模式下拉统一启动且不额外发送模型请求", async () => {
  const active = requireSession();
  const fixture = await openFixturePage(active.context, requireBackend(), "automation-course.html");
  await fixture.evaluate(() => {
    const original = document.querySelector<HTMLElement>("#question1")!;
    for (let number = 4; number <= 20; number++) {
      const copy = original.cloneNode(true) as HTMLElement; copy.id = `question${number}`;
      const answer = copy.querySelector<HTMLInputElement>("input")!; answer.id = `answer${number}`;
      copy.querySelectorAll<HTMLElement>(".num_option").forEach(option => option.addEventListener("click", () => { answer.value = option.getAttribute("data")!; }));
      if (number === 20) {
        const image = document.createElement("img"); image.width = 40; image.height = 30;
        image.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30" fill="blue"/></svg>');
        copy.querySelector(".Zy_TItle")!.append(image);
      }
      document.body.append(copy);
    }
  });
  const { panel, tabId } = await openSidePanelForFixture(active.context, requireBackend(), active.extensionId, fixture);
  await ensureLoggedIn(panel);
  await expect(panel.getByTestId("manual-question")).toHaveCount(0);
  await panel.close();
  const runner = await active.context.newPage();
  await runner.goto(`chrome-extension://${active.extensionId}/runner.html?tabId=${tabId}`);
  await expect(runner.getByTestId("runner-inventory")).toContainText("20已读取");
  const tiles = runner.getByRole("group", { name: "题目签到表" });
  await expect(tiles.getByRole("button")).toHaveCount(20);
  expect((await tiles.boundingBox())!.height).toBeLessThan(150);
  await expect(runner.getByTestId("runner-question-20")).toHaveAttribute("data-status", "image");
  await runner.getByTestId("runner-always-image").uncheck();
  await runner.getByTestId("runner-consent").check();
  await runner.getByTestId("runner-mode").selectOption("questions");
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let held = 0;
  await runner.route("**/api/v1/study/answers", async route => { held++; await pending; await route.continue(); });
  requireBackend().reset();
  try {
    await runner.getByTestId("runner-start").click();
    await expect.poll(() => held).toBe(2);
    await expect(runner.getByTestId("runner-state")).toContainText("RUNNING");
    await expect(runner.getByTestId("runner-manual-summary")).toHaveCount(0);
    await expect(runner.getByTestId("runner-question-1")).toHaveAttribute("data-status", "text");
    await runner.getByTestId("runner-question-1").click();
    const first = runner.getByTestId("runner-source-question");
    await expect(runner.getByTestId("runner-question-viewer")).toBeVisible();
    await expect(first.getByRole("region")).toHaveCount(2);
    await expect(first.getByTestId("runner-question-markdown")).toContainText("1 + 1");
    await expect(runner.getByTestId("runner-preview-question-1")).toBeEnabled();
    await runner.getByTestId("runner-preview-question-1").click();
    await expect(first.getByTestId("runner-image")).toHaveCount(1);
    await expect(first.getByTestId("runner-image")).toBeVisible();
    await expect(runner.getByTestId("runner-copy-question-1")).toBeEnabled();
    await runner.getByTestId("runner-copy-question-1").click();
    await expect(runner.getByTestId("runner-copy-notice").or(runner.getByTestId("copy-fallback"))).toBeVisible();
    await expect(runner.getByTestId("runner-copy-all")).toBeEnabled();
    await expect(runner.getByTestId("runner-stop")).toBeEnabled();
    expect(held).toBe(2); expect(requireBackend().studyAnswerRequests()).toHaveLength(0);
    const left = await first.getByRole("region", { name: "Markdown 版本" }).boundingBox();
    const right = await first.getByRole("region", { name: "图片版本" }).boundingBox();
    expect(left!.x + left!.width).toBeLessThanOrEqual(right!.x + 1);
    await runner.screenshot({ path: ".local-demo/question-dual-view-0.2.4.png", fullPage: true });
    await runner.getByRole("button", { name: "下一题", exact: true }).click();
    await expect(first.getByTestId("runner-question-markdown")).toContainText("填写第一个空格");
    await runner.keyboard.press("Escape");
    await expect(runner.getByTestId("runner-question-viewer")).not.toBeVisible();
    await runner.screenshot({ path: ".local-demo/question-board-0.2.4.png", fullPage: true });
    release();
    await expect(runner.getByTestId("runner-state")).toContainText("DONE", { timeout: 45000 });
    expect(requireBackend().studyAnswerRequests()).toHaveLength(20);
    expect(await fixture.evaluate(() => (window as unknown as { automationCounters: unknown }).automationCounters)).toEqual({ send: 1, confirm: 1, next: 1 });
  } finally { release(); await runner.unrouteAll({ behavior: "wait" }); }
});
