#!/usr/bin/env node
// Real-browser smoke test: loads the unpacked MV3 extension into the REAL installed
// Chrome (channel "chrome"), using a throw-away profile. No account data is used:
// the only external page opened is the public Xuexitong entry page (login wall).
//
// Usage: node scripts/real-chrome-smoke.mjs [--url <https://...>] [--headful] [--channel chrome]
//
// Branded Google Chrome 137+ no longer honours --load-extension (verified here on
// Chrome 155), so the default is Playwright's bundled Chromium, which supports
// unpacked MV3 extensions. Pass --channel chrome only with Chrome for Testing.
// Output: JSON report on stdout + .local-real/report.json
import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const dist = path.resolve("apps/extension/dist");
const profileDir = path.resolve(".local-real/profile");
const outDir = path.resolve(".local-real");
await fs.mkdir(profileDir, { recursive: true });

const args = process.argv.slice(2);
const urlIndex = args.indexOf("--url");
const targetUrl = urlIndex >= 0 ? args[urlIndex + 1] : "https://i.chaoxing.com";
const headless = !args.includes("--headful");
const channelIndex = args.indexOf("--channel");
const channel = channelIndex >= 0 ? args[channelIndex + 1] : null;
const loginIndex = args.indexOf("--login");
const loginPair = loginIndex >= 0 ? args[loginIndex + 1].split(":") : null;
const backendIndex = args.indexOf("--backend");
const backendOrigin = backendIndex >= 0 ? args[backendIndex + 1] : null;

const report = {
  startedAt: new Date().toISOString(),
  browser: channel ?? "chromium",
  headless,
  extensionLoaded: false,
  extensionId: null,
  sidePanel: { opened: false, testIds: [], captureError: null },
  page: { url: targetUrl, finalUrl: null, title: null },
  requests: { total: 0, hosts: [], nonExtensionHosts: [] },
  consoleErrors: [],
  ok: false,
};

let context;
try {
  context = await chromium.launchPersistentContext(profileDir, {
    ...(channel ? { channel } : {}),
    headless,
    args: [
      `--disable-extensions-except=${dist}`,
      `--load-extension=${dist}`,
      "--no-first-run",
      "--no-default-browser-check",
    ],
    viewport: { width: 1280, height: 900 },
  });

  // Resolve the extension id from the MV3 service worker target.
  let worker = context.serviceWorkers()[0];
  if (!worker) {
    try {
      worker = await context.waitForEvent("serviceworker", { timeout: 15000 });
    } catch {
      worker = null;
    }
  }
  if (worker) {
    const match = /^chrome-extension:\/\/([a-z]{32})\//.exec(worker.url());
    report.extensionLoaded = Boolean(match);
    report.extensionId = match ? match[1] : null;
  }

  const requests = [];
  context.on("request", (request) => requests.push(request.url()));

  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") report.consoleErrors.push(message.text().slice(0, 200));
  });
  try {
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
  } catch (error) {
    report.page.navigationError = String(error).slice(0, 300);
  }
  report.page.finalUrl = page.url();
  report.page.title = await page.title().catch(() => null);
  const pageKind = await page
    .evaluate(() => document.documentElement.getAttribute("data-page-kind"))
    .catch(() => null);
  report.page.pageKindAttribute = pageKind;

  // Open the side panel page as a normal extension page (trusted context).
  if (report.extensionId) {
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${report.extensionId}/sidepanel.html`, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    report.sidePanel.opened = true;

    // Point the panel at the configured backend origin (local product backend).
    if (backendOrigin) {
      await panel.evaluate(async (origin) => {
        const key = "studyAssistantSettings";
        const stored = (await chrome.storage.local.get(key))[key] ?? {};
        await chrome.storage.local.set({ [key]: { ...stored, backendOrigin: origin } });
      }, backendOrigin).catch(() => {
        // Local builds already default to http://127.0.0.1:8080.
      });
    }

    // Log in with our own product test account (never the Xuexitong account).
    if (loginPair) {
      const [username, password] = loginPair;
      const loginUsername = panel.locator('[data-testid="login-username"]');
      if (await loginUsername.count()) {
        await loginUsername.fill(username);
        await panel.locator('[data-testid="login-password"]').fill(password);
        await panel.locator('[data-testid="login-form"] button[type="submit"]').click().catch(async () => {
          await panel.locator('[data-testid="login-form"]').press("Enter").catch(() => {});
        });
        await panel.waitForTimeout(2500);
      }
      report.sidePanel.loggedIn = (await panel.locator('[data-testid="login-status"]').count()) > 0;
    }

    for (const testId of ["login-section", "capture-question", "capture-selection", "manual-question"]) {
      report.sidePanel.testIds.push({
        testId,
        present: await panel.locator(`[data-testid="${testId}"]`).count().then((n) => n > 0),
      });
    }
    // Clicking "读取当前题目" must refuse safely on an unadapted page (no ad-hoc selectors).
    await panel.locator('[data-testid="capture-question"]').click({ timeout: 15000 }).catch(() => {});
    await panel.waitForTimeout(4000);
    report.sidePanel.captureError = await panel
      .locator('[data-testid="error-code"]')
      .textContent({ timeout: 3000 })
      .catch(() => null);
    report.sidePanel.notice = await panel
      .locator('[data-testid="notice"]')
      .textContent({ timeout: 3000 })
      .catch(() => null);
    report.sidePanel.screenshot = path.join(outDir, "sidepanel.png");
    await panel.screenshot({ path: report.sidePanel.screenshot }).catch(() => {});
  }

  const hosts = new Set();
  for (const requestUrl of requests) {
    try {
      const parsed = new URL(requestUrl);
      hosts.add(parsed.host);
    } catch {
      hosts.add(requestUrl.slice(0, 40));
    }
  }
  report.requests.total = requests.length;
  report.requests.hosts = [...hosts];
  report.requests.nonExtensionHosts = [...hosts].filter(
    (host) => !host.endsWith(".chaoxing.com") && !host.includes("chaoxing") && !host.startsWith("127.0.0.1"),
  );
  report.backendRequests = requests.filter((u) => backendOrigin && u.startsWith(backendOrigin)).length;
  report.xuexitongRequests = requests.filter((u) => /chaoxing\.com/.test(u)).length;
  report.answerRequests = requests.filter((u) => u.includes("/study/answers")).length;
  report.ok = report.extensionLoaded && report.sidePanel.opened && report.answerRequests === 0;
} catch (error) {
  report.fatalError = String(error).slice(0, 600);
} finally {
  if (context) await context.close().catch(() => {});
}

report.finishedAt = new Date().toISOString();
await fs.writeFile(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.ok ? 0 : 1;