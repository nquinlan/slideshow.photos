import { defineConfig, devices } from '@playwright/test';

/**
 * E2E against the production build (service worker included) served by
 * `astro preview`. Run: npm run build && npm run test:e2e
 */
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4321',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npx astro preview --port 4321',
    url: 'http://localhost:4321/app',
    reuseExistingServer: !process.env.CI,
    env: { ASTRO_TELEMETRY_DISABLED: '1' },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
    // Import + playback in the other engines. Escape is Chromium-only (automation and full-screen
    // differ per engine); offline is Chromium-only because Playwright supports service workers
    // only in Chromium (see offline.spec.ts).
    { name: 'firefox', use: { ...devices['Desktop Firefox'] }, testIgnore: /escape|offline/ },
    { name: 'webkit', use: { ...devices['Desktop Safari'] }, testIgnore: /escape|offline/ },
  ],
});
