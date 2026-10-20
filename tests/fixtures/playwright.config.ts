import { defineConfig, devices } from "@playwright/test";

/**
 * Fixture behavior tests (no extension needed).
 *
 *   npx playwright test -c tests/fixtures/playwright.config.ts
 *
 * These tests prove the synthetic pages themselves behave as documented in
 * tests/fixtures/README.md: read-only counters, paste/selection restrictions,
 * controlled reversion, autosubmit side effects, iframe accessibility, delayed
 * question changes, graded page kind, prompt-injection inertness, and the
 * absence of real network requests.
 */
export default defineConfig({
  testDir: ".",
  testMatch: /behavior\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30000,
  expect: { timeout: 5000 },
  reporter: [["list"]],
  use: {
    headless: true,
    trace: "off",
    video: "off",
    screenshot: "off",
  },
  projects: [
    {
      name: "fixtures-chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
