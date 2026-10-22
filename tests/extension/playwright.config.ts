import { defineConfig } from "@playwright/test";

/**
 * Extension integration tests: real MV3 extension loaded with a persistent
 * context, fixtures served from a local mock backend on the origin baked into
 * the extension build (default http://127.0.0.1:8080).
 *
 *   node scripts/build-extension.mjs
 *   npx playwright test -c tests/extension/playwright.config.ts
 *
 * The mock backend implements only the contract endpoints needed by the side
 * panel (login, me, provider profiles, study answers) and records every request
 * so tests can prove that capture never sends and that no submit/fill endpoint
 * exists. It never calls a real provider.
 */
export default defineConfig({
  testDir: ".",
  testMatch: /(?:extension|navigation)\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120000,
  expect: { timeout: 15000 },
  reporter: [["list"]],
  use: {
    headless: true,
    actionTimeout: 20000,
    trace: "retain-on-failure",
  },
});
