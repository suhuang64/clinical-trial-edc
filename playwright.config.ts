import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './apps/web/e2e',
  fullyParallel: false,
  retries: 0,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:5173', trace: 'retain-on-failure' },
  webServer: process.env.PLAYWRIGHT_EXTERNAL_SERVER
    ? undefined
    : {
        command: 'node ../../node_modules/vite/bin/vite.js',
        cwd: './apps/web',
        url: 'http://127.0.0.1:5173/login',
        reuseExistingServer: true,
        timeout: 120_000,
      },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 900 } } },
    { name: 'tablet', use: { viewport: { width: 1024, height: 768 }, hasTouch: true } },
    {
      name: 'mobile',
      use: {
        ...devices['iPhone 13'],
        browserName: 'chromium',
        viewport: { width: 390, height: 844 },
      },
    },
  ],
})
