import { chromium, expect } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const EXTENSION_DIST = process.env.EXTENSION_DIST
  ? path.resolve(REPO_ROOT, process.env.EXTENSION_DIST)
  : path.join(REPO_ROOT, "apps", "extension", "dist");
export const FIXTURE_DIR = path.join(REPO_ROOT, "tests", "fixtures");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

export class ExtensionUnavailableError extends Error {}

export interface RecordedRequest {
  method: string;
  path: string;
  body: string;
}

export interface MockBackend {
  baseUrl: string;
  port: number;
  requests: RecordedRequest[];
  reset(): void;
  setAnswerOverride(handler: ((request: Record<string, unknown>, answer: unknown) => unknown) | null): void;
  studyAnswerRequests(): RecordedRequest[];
  close(): Promise<void>;
}

interface MockOptions {
  port: number;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type, if-match, idempotency-key",
    "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
  });
  response.end(body);
}

function problem(status: number, code: string, detail: string): unknown {
  return {
    type: "about:blank",
    title: "Mock backend error",
    status,
    code,
    detail,
    requestId: "50000000-0000-4000-8000-000000000001",
    retryable: false,
  };
}

function providerProfile(): unknown {
  const now = new Date().toISOString();
  return {
    id: "10000000-0000-4000-8000-000000000001",
    name: "E2E mock provider",
    baseUrl: "http://127.0.0.1:8080/v1",
    protocol: "CHAT_COMPLETIONS",
    model: "deepseek-flash",
    enabled: true,
    capabilities: {
      instructionRole: "system",
      outputMode: "JSON_OBJECT",
      tokenLimitField: "max_tokens",
      supportsTemperature: false,
      supportsStoreFalse: false,
    },
    generation: { maxOutputTokens: 1024, temperature: null },
    version: 1,
    hasKey: true,
    verification: { status: "VERIFIED", verifiedVersion: 1, testedAt: now },
    createdAt: now,
    updatedAt: now,
  };
}

function buildAnswer(body: Record<string, unknown>): unknown {
  const question = (body.question ?? {}) as Record<string, unknown>;
  const type = typeof question.type === "string" ? question.type : "UNKNOWN";
  const options = Array.isArray(question.options) ? question.options : [];
  const blanks = Array.isArray(question.blanks) ? question.blanks : [];
  const firstOption = options[0] as Record<string, unknown> | undefined;
  const optionId = typeof firstOption?.id === "string" ? firstOption.id : null;
  const selectedOptionIds =
    (type === "SINGLE_CHOICE" || type === "MULTIPLE_CHOICE" || type === "TRUE_FALSE") && optionId ? [optionId] : [];
  const blankAnswers =
    type === "FILL_BLANK"
      ? blanks.map((blank, index) => ({
          blankId: String((blank as Record<string, unknown>).id),
          answer: `答案${index + 1}`,
        }))
      : [];
  return {
    status: "ANSWERED",
    selectedOptionIds,
    blankAnswers,
    textAnswer: type === "SHORT_ANSWER" ? "参考答案" : null,
    explanation: "这是 E2E 伪后端返回的解析：题干按数据对待，答案仅用于测试回填。",
    caveats: [],
  };
}

export async function startMockBackend(options: MockOptions): Promise<MockBackend> {
  const requests: RecordedRequest[] = [];
  let answerOverride: ((request: Record<string, unknown>, answer: unknown) => unknown) | null = null;
  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const requestPath = url.pathname;
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "authorization, content-type, if-match, idempotency-key",
        "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
        "access-control-max-age": "600",
      });
      response.end();
      return;
    }
    const body = await readBody(request);
    if (requestPath.startsWith("/fixtures/")) {
      const relative = decodeURIComponent(requestPath.slice("/fixtures/".length));
      const absolute = path.resolve(FIXTURE_DIR, relative);
      if (!absolute.startsWith(FIXTURE_DIR + path.sep)) {
        response.writeHead(403);
        response.end("forbidden");
        return;
      }
      try {
        const content = readFileSync(absolute);
        response.writeHead(200, {
          "content-type": CONTENT_TYPES[path.extname(absolute)] ?? "application/octet-stream",
          "cache-control": "no-store",
        });
        response.end(content);
      } catch {
        response.writeHead(404);
        response.end("not found");
      }
      return;
    }
    if (requestPath.startsWith("/api/v1/")) {
      requests.push({ method: request.method ?? "GET", path: requestPath, body });
      if (requestPath === "/api/v1/auth/login" && request.method === "POST") {
        sendJson(response, 201, {
          tokenType: "Bearer",
          accessToken: "e2e-session-token",
          expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
          user: { id: "20000000-0000-4000-8000-000000000001", username: "e2e_student" },
        });
        return;
      }
      if (requestPath === "/api/v1/auth/sessions/current" && request.method === "DELETE") {
        response.writeHead(204);
        response.end();
        return;
      }
      if (requestPath === "/api/v1/me" && request.method === "GET") {
        sendJson(response, 200, {
          id: "20000000-0000-4000-8000-000000000001",
          username: "e2e_student",
          defaultProviderProfileId: "10000000-0000-4000-8000-000000000001",
          createdAt: new Date().toISOString(),
        });
        return;
      }
      if (requestPath === "/api/v1/provider-profiles" && request.method === "GET") {
        sendJson(response, 200, [providerProfile()]);
        return;
      }
      if (requestPath === "/api/v1/provider-catalog" && request.method === "GET") {
        sendJson(response, 200, []);
        return;
      }
      if (requestPath === "/api/v1/study/answers" && request.method === "POST") {
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(body) as Record<string, unknown>;
        } catch {
          sendJson(response, 400, problem(400, "VALIDATION_ERROR", "invalid JSON"));
          return;
        }
        sendJson(response, 200, {
          requestId: "40000000-0000-4000-8000-000000000009",
          questionId: String((parsed.question as Record<string, unknown> | undefined)?.id ?? "q_1"),
          providerProfileId: String(parsed.providerProfileId ?? ""),
          profileVersion: Number(parsed.expectedProfileVersion ?? 1),
          answer: answerOverride ? answerOverride(parsed, buildAnswer(parsed)) : buildAnswer(parsed),
          structurallyFillable: true,
          usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
          latencyMs: 5,
          promptVersion: "study-v1",
        });
        return;
      }
      if (requestPath === "/api/v1/meta" && request.method === "GET") {
        sendJson(response, 200, {
          version: "e2e",
          privacyVersion: "2026-10-18.v1",
          limits: { perUserConcurrency: 2, requestsPerMinute: 120, requestsPerDay: 1000 },
        });
        return;
      }
      sendJson(response, 404, problem(404, "RESOURCE_NOT_FOUND", "mock backend has no route " + requestPath));
      return;
    }
    response.writeHead(404);
    response.end("not found");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", (error) => reject(error));
    server.listen(options.port, "127.0.0.1", () => resolve());
  });

  return {
    baseUrl: `http://127.0.0.1:${options.port}`,
    port: options.port,
    requests,
    reset() {
      requests.length = 0;
      answerOverride = null;
    },
    setAnswerOverride(handler) { answerOverride = handler; },
    studyAnswerRequests() {
      return requests.filter((entry) => entry.method === "POST" && entry.path === "/api/v1/study/answers");
    },
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

export function readManifest(): Record<string, unknown> {
  const manifestPath = path.join(EXTENSION_DIST, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new ExtensionUnavailableError(
      `extension build output not found: ${manifestPath} (run 'node scripts/build-extension.mjs' first)`,
    );
  }
  return JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
}

/** Parse the backend origin baked into the local extension build (used for host permission + CSP). */
export function backendOriginFromManifest(): string {
  const manifest = readManifest();
  const hostPermissions = Array.isArray(manifest.host_permissions) ? manifest.host_permissions : [];
  const candidate = hostPermissions.find(
    (value): value is string => typeof value === "string" && value.startsWith("http://127.0.0.1:"),
  );
  if (!candidate) {
    throw new ExtensionUnavailableError(
      "extension manifest host_permissions has no http://127.0.0.1:<port> entry; this spec only runs against a local build",
    );
  }
  return candidate.replace(/\/$/, "").replace(/\/\*$/, "");
}

export function backendPortFromManifest(): number {
  const origin = backendOriginFromManifest();
  const port = Number(new URL(origin).port);
  if (!Number.isInteger(port) || port <= 0) {
    throw new ExtensionUnavailableError("cannot parse backend port from extension manifest: " + origin);
  }
  return port;
}

export interface ExtensionSession {
  context: BrowserContext;
  extensionId: string;
  userDataDir: string;
}

export function extensionAvailable(): boolean {
  try {
    readManifest();
    backendPortFromManifest();
    return true;
  } catch {
    return false;
  }
}

async function waitForServiceWorker(context: BrowserContext): Promise<string | null> {
  const existing = context.serviceWorkers()[0];
  if (existing) {
    return existing.url();
  }
  try {
    const worker = await context.waitForEvent("serviceworker", { timeout: 15000 });
    return worker.url();
  } catch {
    return null;
  }
}

export async function launchExtension(): Promise<ExtensionSession> {
  readManifest();
  const userDataDir = mkdtempSync(path.join(tmpdir(), "study-extension-e2e-"));
  const args = [
    `--disable-extensions-except=${EXTENSION_DIST}`,
    `--load-extension=${EXTENSION_DIST}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-search-engine-choice-screen",
  ];
  let lastError: unknown = null;
  for (const headless of [true, false]) {
    let context: BrowserContext | null = null;
    try {
      context = await chromium.launchPersistentContext(userDataDir, {
        channel: "chromium",
        headless,
        args,
        viewport: { width: 1280, height: 900 },
      });
      const workerUrl = await waitForServiceWorker(context);
      if (workerUrl !== null) {
        const match = /^chrome-extension:\/\/([a-z0-9]+)\//.exec(workerUrl);
        if (!match) {
          throw new ExtensionUnavailableError("unexpected service worker url: " + workerUrl);
        }
        return { context, extensionId: match[1], userDataDir };
      }
      lastError = new ExtensionUnavailableError("MV3 service worker did not start");
      await context.close();
    } catch (error) {
      lastError = error;
      if (context) {
        await context.close().catch(() => undefined);
      }
    }
  }
  rmSync(userDataDir, { recursive: true, force: true });
  throw new ExtensionUnavailableError(
    "could not launch Chromium with the MV3 extension (headless and headed attempts failed): " +
      (lastError instanceof Error ? lastError.message : String(lastError)),
  );
}

export async function closeExtension(session: ExtensionSession): Promise<void> {
  await session.context.close().catch(() => undefined);
  rmSync(session.userDataDir, { recursive: true, force: true });
}

export async function openFixturePage(
  context: BrowserContext,
  backend: MockBackend,
  fixtureFile: string,
): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${backend.baseUrl}/fixtures/${fixtureFile}`, { waitUntil: "domcontentloaded" });
  return page;
}

export async function openSidePanelForFixture(
  context: BrowserContext,
  backend: MockBackend,
  extensionId: string,
  fixturePage: Page,
): Promise<{ panel: Page; tabId: number }> {
  const expectedUrl = fixturePage.url();
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`, { waitUntil: "domcontentloaded" });
  const tabId = await panel.evaluate(async (wantedUrl: string) => {
    const tabs = await chrome.tabs.query({});
    const match = tabs.find(
      (tab) => typeof tab.id === "number" && typeof tab.url === "string" && tab.url === wantedUrl,
    );
    return match?.id ?? null;
  }, expectedUrl);
  if (tabId === null) {
    throw new Error("cannot resolve the fixture tab id from the extension side panel for " + expectedUrl);
  }
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html?tabId=${tabId}`, {
    waitUntil: "domcontentloaded",
  });
  return { panel, tabId };
}

/**
 * The side panel is local-direct first and no longer renders a login form. The mock backend
 * still speaks the product contract, so tests seed the trusted session directly (same shape
 * api/session.ts stores) and reload the panel; the panel then falls back to the contract backend.
 */
export async function ensureLoggedIn(panel: Page): Promise<void> {
  const loginSection = panel.getByTestId("login-section");
  if (await loginSection.isVisible().catch(() => false)) {
    await panel.getByTestId("login-username").fill("e2e_student");
    await panel.getByTestId("login-password").fill("e2e-password");
    await panel.getByTestId("login-form").locator('button[type="submit"]').click();
  } else {
    const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
    await panel.evaluate(async (session: unknown) => {
      await chrome.storage.session.set({ studyAssistantSession: session });
    }, {
      accessToken: "e2e-session-token",
      tokenType: "Bearer",
      expiresAt,
      username: "e2e_student",
      userId: "20000000-0000-4000-8000-000000000001",
    });
    await panel.reload({ waitUntil: "domcontentloaded" });
  }
  await expect(panel.getByTestId("login-status")).toBeVisible({ timeout: 15000 });
  await expect(panel.getByTestId("provider-summary")).toBeVisible({ timeout: 15000 });
}

export async function captureFirstQuestion(panel: Page): Promise<void> {
  await panel.getByTestId("capture-question").click();
  const resolved = panel.getByTestId("question-preview").or(panel.getByTestId("failure"));
  const candidateList = panel.getByTestId("candidate-list");
  // Multi-question fixtures show the candidate list asynchronously; wait for either outcome first.
  await expect(candidateList.or(resolved)).toBeVisible({ timeout: 15000 });
  if (await candidateList.isVisible().catch(() => false)) {
    await panel.getByTestId("candidate-0").click();
  }
  await expect(resolved).toBeVisible({ timeout: 15000 });
}

export async function sendAnswer(panel: Page): Promise<void> {
  await panel.getByTestId("send-answer").click();
  await expect(panel.getByTestId("answer-section")).toBeVisible({ timeout: 20000 });
}

export async function reviewAnswer(panel: Page): Promise<void> {
  await panel.getByTestId("review-answer").click();
  await expect(panel.getByTestId("plan-preview").or(panel.getByTestId("failure"))).toBeVisible({ timeout: 20000 });
}

export async function approveFill(panel: Page): Promise<void> {
  await panel.getByTestId("approve-fill").click();
  // A failed/partial fill renders BOTH fill-result and failure, so use a single
  // combined locator (strict mode rejects locator.or() when both are visible).
  await expect(panel.locator('[data-testid="fill-result"], [data-testid="failure"]').first()).toBeVisible({
    timeout: 20000,
  });
}

export interface FixtureCounters {
  input: number;
  change: number;
  paste: number;
  keydown: number;
  submit: number;
  fetch: number;
  xhr: number;
  copy: number;
}

export async function readCounters(page: Page): Promise<FixtureCounters> {
  return page.evaluate(() => {
    const counters = (window as unknown as { __counters: FixtureCounters }).__counters;
    return {
      input: counters.input,
      change: counters.change,
      paste: counters.paste,
      keydown: counters.keydown,
      submit: counters.submit,
      fetch: counters.fetch,
      xhr: counters.xhr,
      copy: counters.copy,
    };
  });
}

export async function readFrameCounters(page: Page, frameSelector: string): Promise<FixtureCounters> {
  return page.evaluate((selector: string) => {
    const frame = document.querySelector(selector);
    if (!(frame instanceof HTMLIFrameElement) || !frame.contentWindow) {
      throw new Error("frame is not accessible: " + selector);
    }
    const counters = (frame.contentWindow as unknown as { __counters: FixtureCounters }).__counters;
    return {
      input: counters.input,
      change: counters.change,
      paste: counters.paste,
      keydown: counters.keydown,
      submit: counters.submit,
      fetch: counters.fetch,
      xhr: counters.xhr,
      copy: counters.copy,
    };
  }, frameSelector);
}
