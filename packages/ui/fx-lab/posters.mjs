// Renders every poster in src/lit/fx/posters/presets.ts from the live object at t = 0 (same seed, same options), at
// 2x, as JPEG (the objects draw on black and are screened onto the page, so no alpha is needed).
//   pnpm --filter @intafaced/ui fx:posters
// Set FX_CHROMIUM to a Chromium binary when the one Playwright expects is not installed.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '../src/lit/fx/posters');
const port = Number(process.env.FX_LAB_PORT ?? 3291);
const names = [...readFileSync(join(out, 'presets.ts'), 'utf8').matchAll(/^\s*'([a-z0-9-]+)': preset\(/gm)].map((m) => m[1]);

const server = spawn('pnpm', ['exec', 'vite', '--config', join(here, 'vite.config.ts')], {
  cwd: join(here, '..'),
  env: { ...process.env, FX_LAB_PORT: String(port) },
  stdio: 'inherit',
});
try {
  for (let i = 0; i < 60; i++) {
    const up = await fetch(`http://127.0.0.1:${port}/`)
      .then((r) => r.ok)
      .catch(() => false);
    if (up) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const browser = await chromium.launch(process.env.FX_CHROMIUM ? { executablePath: process.env.FX_CHROMIUM } : {});
  for (const name of names) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
    await page.goto(`http://127.0.0.1:${port}/?still&preset=${name}`);
    await page.waitForSelector('[data-fx-live]', { timeout: 60000 });
    const box = page.locator('.box').first();
    await box.screenshot({ path: join(out, `${name}.jpg`), type: 'jpeg', quality: 82 });
    // what the poster was rendered from, so presets.test.ts can tell when a preset changed without a new poster
    const preset = await page.evaluate((n) => window.__fxPreset?.(n), name);
    if (!preset) throw new Error(`the lab did not report preset ${name}`);
    writeFileSync(join(out, `${name}.json`), JSON.stringify(preset, null, 2) + '\n');
    console.log(`poster ${name}.jpg`);
    await page.close();
  }
  await browser.close();
} finally {
  server.kill();
}
