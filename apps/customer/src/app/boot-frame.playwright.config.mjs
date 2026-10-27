import { defineConfig } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.BOOT_FRAME_PORT ?? 4319);
const out = process.env.BOOT_FRAME_DIST ?? join(tmpdir(), 'intafaced-boot-frame-dist');

// Home's boot frame (index.html, boot.ts) against Home's own loading state, in a production build: the frame exists only
// there (the boot script is a build plugin). The packages the app reads must be built first:
//   pnpm turbo run build --filter=@intafaced/customer^...
//   pnpm exec playwright test --config apps/customer/src/app/boot-frame.playwright.config.mjs
export default defineConfig({
  testDir: here,
  testMatch: 'boot-frame.pw.mjs',
  workers: 1,
  retries: 0,
  timeout: 60000,
  reporter: [['list']],
  outputDir: join(tmpdir(), 'intafaced-boot-frame-results'),
  webServer: {
    command: `pnpm exec vite build --outDir ${out} --emptyOutDir && pnpm exec vite preview --outDir ${out} --host 127.0.0.1 --port ${port} --strictPort`,
    cwd: join(here, '../..'),
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: false,
    timeout: 300000,
  },
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    headless: true,
    timezoneId: 'UTC',
    locale: 'en-US',
    trace: 'off',
    video: 'off',
    screenshot: 'off',
    // Set HOME_CHROMIUM to a Chromium binary when the one Playwright expects is not installed (as the Home harness).
    launchOptions: process.env.HOME_CHROMIUM ? { executablePath: process.env.HOME_CHROMIUM } : {},
  },
});
