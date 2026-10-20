import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { fileURLToPath } from "node:url";

type CounterKey = "input" | "change" | "paste" | "keydown" | "submit" | "fetch" | "xhr" | "copy";

declare global {
  interface Window {
    __counters: Record<CounterKey, number>;
    __fixtureEvents: Record<string, number>;
    __fixtureMeta: { fixture: string; pageKind: string };
    __injectionExecuted: boolean;
    __fixtureInternal: unknown;
  }
}

const FIXTURES_DIR = path.dirname(fileURLToPath(import.meta.url));

const FIXTURES: ReadonlyArray<{ file: string; fixture: string; kind: "PRACTICE" | "GRADED" | "UNKNOWN" }> = [
  { file: "practice.html", fixture: "practice", kind: "PRACTICE" },
  { file: "no-paste.html", fixture: "no-paste", kind: "PRACTICE" },
  { file: "selection-disabled.html", fixture: "selection-disabled", kind: "PRACTICE" },
  { file: "controlled-input.html", fixture: "controlled-input", kind: "PRACTICE" },
  { file: "readonly-field.html", fixture: "readonly-field", kind: "PRACTICE" },
  { file: "autosubmit-field.html", fixture: "autosubmit-field", kind: "PRACTICE" },
  { file: "iframe-question.html", fixture: "iframe-question", kind: "PRACTICE" },
  { file: "changed-question.html", fixture: "changed-question", kind: "PRACTICE" },
  { file: "graded.html", fixture: "graded", kind: "GRADED" },
  { file: "prompt-injection.html", fixture: "prompt-injection", kind: "PRACTICE" },
];

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

let fixtureServer: Server | undefined;
let fixtureBaseUrl = "";

test.beforeAll(async () => {
  // Serve the fixtures over HTTP: Chromium treats file:// iframes as
  // cross-origin, so the same-origin iframe fixture needs a real HTTP origin.
  const server = createServer((request, response) => {
    const requestPath = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const relative = decodeURIComponent(requestPath).replace(/^\/+/, "") || "practice.html";
    const absolute = path.resolve(FIXTURES_DIR, relative);
    if (!absolute.startsWith(FIXTURES_DIR + path.sep)) {
      response.writeHead(403);
      response.end("forbidden");
      return;
    }
    try {
      const body = readFileSync(absolute);
      const contentType = CONTENT_TYPES[path.extname(absolute)] ?? "application/octet-stream";
      response.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end("not found");
    }
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fixture server has no TCP address");
  }
  fixtureServer = server;
  fixtureBaseUrl = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  if (fixtureServer) {
    await new Promise<void>((resolve, reject) => {
      fixtureServer?.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

function fixtureUrl(file: string): string {
  return `${fixtureBaseUrl}/${file}`;
}

function trackExternalRequests(page: Page): string[] {
  const external: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      return;
    }
    if (url.startsWith(fixtureBaseUrl)) {
      return;
    }
    external.push(url);
  });
  return external;
}

async function counters(page: Page): Promise<Record<CounterKey, number>> {
  return page.evaluate(() => ({
    input: window.__counters.input,
    change: window.__counters.change,
    paste: window.__counters.paste,
    keydown: window.__counters.keydown,
    submit: window.__counters.submit,
    fetch: window.__counters.fetch,
    xhr: window.__counters.xhr,
    copy: window.__counters.copy,
  }));
}

test.describe("fixture 通用契约", () => {
  for (const fixture of FIXTURES) {
    test(`${fixture.fixture}: metadata, read-only counters, reset button and no network`, async ({ page }) => {
      const external = trackExternalRequests(page);
      await page.goto(fixtureUrl(fixture.file));
      await page.waitForLoadState("domcontentloaded");

      const metadata = await page.evaluate(() => ({
        fixture: document.documentElement.getAttribute("data-fixture"),
        pageKind: document.documentElement.getAttribute("data-page-kind"),
        meta: window.__fixtureMeta,
      }));
      expect(metadata.fixture).toBe(fixture.fixture);
      expect(metadata.pageKind).toBe(fixture.kind);
      expect(metadata.meta.fixture).toBe(fixture.fixture);
      expect(metadata.meta.pageKind).toBe(fixture.kind);

      const counterShape = await page.evaluate(() => ({
        keys: Object.keys(window.__counters).sort(),
        inputHasSetter: Object.getOwnPropertyDescriptor(window.__counters, "input")?.set !== undefined,
        events: Object.keys(window.__fixtureEvents).sort(),
      }));
      expect(counterShape.keys).toEqual(["change", "copy", "fetch", "input", "keydown", "paste", "submit", "xhr"]);
      expect(counterShape.inputHasSetter).toBe(false);
      expect(counterShape.events).toEqual(["change", "input", "keydown", "paste", "submit"]);

      const writeAttempt = await page.evaluate(() => {
        const target = window.__counters as unknown as Record<string, number>;
        target.input = 42;
        return window.__counters.input;
      });
      expect(writeAttempt).toBe(0);

      await page.evaluate(() => {
        document.body.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect((await counters(page)).input).toBe(1);

      const resetButton = page.locator("#reset-counters");
      await expect(resetButton).toHaveText("重置计数");
      await resetButton.click();
      const afterReset = await counters(page);
      for (const value of Object.values(afterReset)) {
        expect(value).toBe(0);
      }

      expect(external).toEqual([]);
    });
  }

  test("每个 fixture 文件都有预期行为注释与自包含脚本", () => {
    for (const fixture of FIXTURES) {
      const source = readFileSync(path.join(FIXTURES_DIR, fixture.file), "utf8");
      expect(source).toContain("Expected behavior / 验收点");
      expect(source).toContain(`data-fixture="${fixture.fixture}"`);
      expect(source).toContain(`data-page-kind="${fixture.kind}"`);
      expect(source).not.toMatch(/src="https?:\/\//);
      expect(source).not.toMatch(/@import\s+url\(/);
    }
  });
});

test.describe("practice.html", () => {
  test("包含单选、多选、select、填空与简答，且零提交零网络", async ({ page }) => {
    const external = trackExternalRequests(page);
    await page.goto(fixtureUrl("practice.html"));

    const shape = await page.evaluate(() => ({
      containers: document.querySelectorAll("[data-question-container]").length,
      types: Array.from(document.querySelectorAll("[data-question-container]")).map((node) =>
        node.getAttribute("data-question-type"),
      ),
      radioOptions: document.querySelectorAll("[data-option] input[type=radio]").length,
      checkboxOptions: document.querySelectorAll("[data-option] input[type=checkbox]").length,
      selectOptions: document.querySelectorAll("select option[data-option]").length,
      blanks: document.querySelectorAll("input[data-blank], textarea[data-blank]").length,
      selectValues: Array.from(document.querySelectorAll("select option[data-option]")).map((node) => ({
        id: node.getAttribute("data-option-id"),
        value: (node as HTMLOptionElement).value,
      })),
    }));
    expect(shape.containers).toBe(5);
    expect(shape.types).toEqual(["SINGLE_CHOICE", "MULTIPLE_CHOICE", "SINGLE_CHOICE", "FILL_BLANK", "SHORT_ANSWER"]);
    expect(shape.radioOptions).toBe(3);
    expect(shape.checkboxOptions).toBe(3);
    expect(shape.selectOptions).toBe(3);
    expect(shape.blanks).toBe(3);
    for (const option of shape.selectValues) {
      expect(option.value).toBe(option.id);
    }

    const submitResult = await page.evaluate(() => {
      const form = document.createElement("form");
      document.body.appendChild(form);
      const event = new Event("submit", { bubbles: true, cancelable: true });
      form.dispatchEvent(event);
      form.remove();
      return { prevented: event.defaultPrevented, submit: window.__counters.submit };
    });
    expect(submitResult.prevented).toBe(true);
    expect(submitResult.submit).toBe(1);

    const networkResult = await page.evaluate(async () => ({
      fetchRejected: await window
        .fetch("https://provider.example.invalid/v1/chat/completions")
        .then(() => false)
        .catch(() => true),
      xhrSent: (() => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", "https://provider.example.invalid/v1/responses");
        xhr.send();
        return window.__counters.xhr;
      })(),
      fetch: window.__counters.fetch,
    }));
    expect(networkResult.fetchRejected).toBe(true);
    expect(networkResult.fetch).toBe(1);
    expect(networkResult.xhrSent).toBe(1);
    expect(external).toEqual([]);
  });
});

test.describe("no-paste.html", () => {
  test("paste 与 beforepaste 被阻止，但控件仍可写入且 paste 计数为 0", async ({ page }) => {
    await page.goto(fixtureUrl("no-paste.html"));

    const pasteAttempt = await page.evaluate(() => {
      const blank = document.getElementById("no-paste-blank-1");
      if (!(blank instanceof HTMLInputElement)) {
        throw new Error("missing blank");
      }
      const pasteEvent = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
      blank.dispatchEvent(pasteEvent);
      const beforePasteEvent = new Event("beforepaste", { bubbles: true, cancelable: true });
      blank.dispatchEvent(beforePasteEvent);
      return {
        pastePrevented: pasteEvent.defaultPrevented,
        beforePastePrevented: beforePasteEvent.defaultPrevented,
        pasteCounter: window.__counters.paste,
        valueAfterPaste: blank.value,
      };
    });
    expect(pasteAttempt.pastePrevented).toBe(true);
    expect(pasteAttempt.beforePastePrevented).toBe(true);
    expect(pasteAttempt.pasteCounter).toBe(2);
    expect(pasteAttempt.valueAfterPaste).toBe("");

    const writeResult = await page.evaluate(() => {
      const blank = document.getElementById("no-paste-blank-1");
      if (!(blank instanceof HTMLInputElement)) {
        throw new Error("missing blank");
      }
      blank.value = "12";
      blank.dispatchEvent(new Event("input", { bubbles: true }));
      blank.dispatchEvent(new Event("change", { bubbles: true }));
      return { value: blank.value, input: window.__counters.input, change: window.__counters.change };
    });
    expect(writeResult.value).toBe("12");
    expect(writeResult.input).toBe(1);
    expect(writeResult.change).toBe(1);
  });
});

test.describe("selection-disabled.html", () => {
  test("user-select:none 且 copy 被阻止，Selection 为空仍可读取题目容器", async ({ page }) => {
    await page.goto(fixtureUrl("selection-disabled.html"));

    const style = await page.evaluate(() => {
      const container = document.querySelector("[data-question-container]");
      if (!container) {
        throw new Error("missing question container");
      }
      const computed = getComputedStyle(container);
      return { userSelect: computed.userSelect, webkitUserSelect: computed.getPropertyValue("-webkit-user-select") };
    });
    expect(style.userSelect).toBe("none");

    const stem = page.locator("[data-question-stem]").first();
    await expect(stem).not.toHaveText("");
    const box = await stem.boundingBox();
    if (!box) {
      throw new Error("stem has no bounding box");
    }
    await page.mouse.move(box.x + 4, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 4, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();

    const selection = await page.evaluate(() => {
      const copyEvent = new ClipboardEvent("copy", { bubbles: true, cancelable: true });
      document.body.dispatchEvent(copyEvent);
      return {
        selected: window.getSelection()?.toString() ?? "",
        copyPrevented: copyEvent.defaultPrevented,
        copyCounter: window.__counters.copy,
        containerCount: document.querySelectorAll("[data-question-container]").length,
      };
    });
    expect(selection.selected).toBe("");
    expect(selection.copyPrevented).toBe(true);
    expect(selection.copyCounter).toBe(1);
    expect(selection.containerCount).toBe(2);
  });
});

test.describe("controlled-input.html", () => {
  test("受控字段在 change 后恢复初始值，回读必须发现 VALUE_REVERTED", async ({ page }) => {
    await page.goto(fixtureUrl("controlled-input.html"));

    const result = await page.evaluate(() => {
      const normal = document.getElementById("controlled-blank-1");
      const controlled = document.getElementById("controlled-blank-2");
      if (!(controlled instanceof HTMLInputElement) || !(normal instanceof HTMLInputElement)) {
        throw new Error("missing controlled blanks");
      }
      normal.value = "正常答案";
      normal.dispatchEvent(new Event("input", { bubbles: true }));
      normal.dispatchEvent(new Event("change", { bubbles: true }));
      const initial = controlled.value;
      controlled.value = "模型建议答案";
      controlled.dispatchEvent(new Event("input", { bubbles: true }));
      controlled.dispatchEvent(new Event("change", { bubbles: true }));
      return {
        initial,
        controlledAfterChange: controlled.value,
        normalAfterChange: normal.value,
        status: document.getElementById("controlled-status")?.textContent ?? "",
      };
    });
    expect(result.initial).toBe("初始值（不可改）");
    expect(result.controlledAfterChange).toBe(result.initial);
    expect(result.normalAfterChange).toBe("正常答案");
    expect(result.status).toContain("受控字段已恢复为初始值");
  });
});

test.describe("readonly-field.html", () => {
  test("readonly/disabled 字段与选项保持原状", async ({ page }) => {
    await page.goto(fixtureUrl("readonly-field.html"));

    const state = await page.evaluate(() => {
      const readonlyBlank = document.getElementById("readonly-blank-1");
      const disabledBlank = document.getElementById("readonly-blank-2");
      const radios = Array.from(document.querySelectorAll("input[type=radio]"));
      return {
        readonly: readonlyBlank instanceof HTMLInputElement && readonlyBlank.readOnly,
        readonlyValue: readonlyBlank instanceof HTMLInputElement ? readonlyBlank.value : "",
        disabled: disabledBlank instanceof HTMLInputElement && disabledBlank.disabled,
        disabledValue: disabledBlank instanceof HTMLInputElement ? disabledBlank.value : "",
        radiosDisabled: radios.length > 0 && radios.every((radio) => (radio as HTMLInputElement).disabled),
        containers: document.querySelectorAll("[data-question-container]").length,
      };
    });
    expect(state.readonly).toBe(true);
    expect(state.disabled).toBe(true);
    expect(state.readonlyValue).toBe("只读原值");
    expect(state.disabledValue).toBe("禁用原值");
    expect(state.radiosDisabled).toBe(true);
    expect(state.containers).toBe(2);
  });
});

test.describe("autosubmit-field.html", () => {
  test("input 事件会触达自动保存/提交副作用（模拟），因此适配器必须在写入前拒绝", async ({ page }) => {
    const external = trackExternalRequests(page);
    await page.goto(fixtureUrl("autosubmit-field.html"));

    const initial = await page.evaluate(() => ({
      sideEffect: document.body.getAttribute("data-events-side-effect"),
      containerSideEffect: document
        .querySelector("[data-question-container]")
        ?.getAttribute("data-events-side-effect"),
      submit: window.__counters.submit,
    }));
    expect(initial.sideEffect).toBe("AUTOSUBMIT");
    expect(initial.containerSideEffect).toBe("AUTOSUBMIT");
    expect(initial.submit).toBe(0);

    const triggered = await page.evaluate(() => {
      const blank = document.getElementById("autosubmit-blank-1");
      if (!(blank instanceof HTMLInputElement)) {
        throw new Error("missing autosubmit blank");
      }
      blank.value = "答案";
      blank.dispatchEvent(new Event("input", { bubbles: true }));
      return {
        input: window.__counters.input,
        submit: window.__counters.submit,
        flag: document.body.getAttribute("data-auto-submit-triggered"),
      };
    });
    expect(triggered.input).toBe(1);
    expect(triggered.submit).toBe(1);
    expect(triggered.flag).toBe("1");
    expect(external).toEqual([]);
  });
});

test.describe("iframe-question.html", () => {
  test("同源框架文档可访问，sandbox 无权限框架不可访问且不发网络请求", async ({ page }) => {
    const external = trackExternalRequests(page);
    await page.goto(fixtureUrl("iframe-question.html"));
    await page.waitForLoadState("domcontentloaded");

    const state = await page.evaluate(() => {
      const sameOrigin = document.getElementById("question-frame");
      const crossOrigin = document.getElementById("cross-origin-frame");
      if (!(sameOrigin instanceof HTMLIFrameElement) || !(crossOrigin instanceof HTMLIFrameElement)) {
        throw new Error("missing frames");
      }
      const sameDoc = sameOrigin.contentDocument;
      let crossDoc: Document | null = null;
      let crossThrew = false;
      try {
        crossDoc = crossOrigin.contentDocument;
      } catch {
        crossThrew = true;
      }
      return {
        sameAccessible: Boolean(sameDoc),
        sameQuestionCount: sameDoc ? sameDoc.querySelectorAll("[data-question-container]").length : 0,
        sameFixture: sameDoc?.documentElement.getAttribute("data-fixture") ?? null,
        frameCounters: sameDoc && sameDoc.defaultView ? sameDoc.defaultView.__counters.input : -1,
        crossAccessible: crossDoc !== null,
        crossThrew,
        sandbox: crossOrigin.getAttribute("sandbox"),
      };
    });
    expect(state.sameAccessible).toBe(true);
    expect(state.sameQuestionCount).toBe(2);
    expect(state.sameFixture).toBe("iframe-question-frame");
    expect(state.frameCounters).toBe(0);
    expect(state.crossAccessible).toBe(false);
    expect(state.sandbox).toContain("allow-scripts");
    expect(state.sandbox).not.toContain("allow-same-origin");
    expect(external).toEqual([]);
  });
});

test.describe("changed-question.html", () => {
  test("1500ms 后题干与选项变化，且变化本身不派发 input/change", async ({ page }) => {
    await page.goto(fixtureUrl("changed-question.html"));

    const initial = await page.evaluate(() => ({
      stem: document.getElementById("changed-stem")?.textContent ?? "",
      optionCount: document.querySelectorAll("[data-option]").length,
    }));
    expect(initial.stem).toContain("初始题干");
    expect(initial.optionCount).toBe(2);

    await page.waitForFunction(() => document.documentElement.getAttribute("data-question-changed") === "1", undefined, {
      timeout: 4000,
    });
    const changed = await page.evaluate(() => ({
      stem: document.getElementById("changed-stem")?.textContent ?? "",
      optionCount: document.querySelectorAll("[data-option]").length,
      counters: window.__counters,
    }));
    expect(changed.stem).toContain("更新后的题干");
    expect(changed.optionCount).toBe(3);
    expect(changed.counters.input).toBe(0);
    expect(changed.counters.change).toBe(0);
    expect(changed.counters.submit).toBe(0);
  });

  test("#simulate-question-change 可确定性地立即改变题目", async ({ page }) => {
    await page.goto(fixtureUrl("changed-question.html"));
    await page.click("#simulate-question-change");
    await expect(page.locator("#changed-stem")).toHaveText("更新后的题干：2 + 2 等于多少？");
    expect(await page.evaluate(() => document.querySelectorAll("[data-option]").length)).toBe(3);
  });
});

test.describe("graded.html", () => {
  test("计分页标记为 GRADED，模拟提交按钮只计数不导航", async ({ page }) => {
    await page.goto(fixtureUrl("graded.html"));

    const initial = await page.evaluate(() => ({
      pageKind: document.documentElement.getAttribute("data-page-kind"),
      graded: document.body.getAttribute("data-graded"),
      submit: window.__counters.submit,
      url: location.href,
    }));
    expect(initial.pageKind).toBe("GRADED");
    expect(initial.graded).toBe("true");

    await page.click("#graded-submit");
    const after = await page.evaluate(() => ({
      submit: window.__counters.submit,
      url: location.href,
      status: document.getElementById("graded-status")?.textContent ?? "",
    }));
    expect(after.submit).toBe(1);
    expect(after.url).toBe(initial.url);
    expect(after.status).toContain("模拟计数");
  });
});

test.describe("prompt-injection.html", () => {
  test("题干注入文本按数据渲染，不执行脚本；未知编辑器保持只读", async ({ page }) => {
    const external = trackExternalRequests(page);
    await page.goto(fixtureUrl("prompt-injection.html"));

    const state = await page.evaluate(() => {
      const stem = document.querySelector("[data-question-stem]");
      const contenteditable = document.querySelector("[data-unknown-editor]");
      return {
        executed: window.__injectionExecuted,
        stemText: stem?.textContent ?? "",
        stemScripts: stem ? stem.querySelectorAll("script").length : -1,
        echoText: document.getElementById("injection-echo")?.textContent ?? "",
        unknownEditor: contenteditable?.getAttribute("contenteditable"),
        unknownType: contenteditable?.closest("[data-question-container]")?.getAttribute("data-question-type"),
        containers: document.querySelectorAll("[data-question-container]").length,
        counters: window.__counters,
      };
    });
    expect(state.executed).toBe(false);
    expect(state.stemText).toContain("<script>window.__injectionExecuted = true</script>");
    expect(state.stemScripts).toBe(0);
    expect(state.echoText).toContain("<script>");
    expect(state.unknownEditor).toBe("true");
    expect(state.unknownType).toBe("UNKNOWN");
    expect(state.containers).toBe(2);
    expect(state.counters.input).toBe(0);
    expect(state.counters.submit).toBe(0);
    expect(external).toEqual([]);
  });
});