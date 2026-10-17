/**
 * Screenshots every kit section at 1440x900 and runs an axe accessibility scan on each.
 * Needs the gallery running: `pnpm --filter @intafaced/ui gallery`, then in another shell
 * `lock.sh browser <you> -- pnpm --filter @intafaced/ui gallery:shots`.
 *
 * Browser: Playwright's headless shell with a throwaway profile (Playwright makes one per launch).
 * Never Nitro's Brave (see ~/.codex/context/work/brave-daily-browser.md).
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const base = process.env.GALLERY_URL ?? 'http://127.0.0.1:3290/';
const out = process.env.SHOTS_DIR ?? join(homedir(), '.codex/context/work/design/kit');
const shell = join(
  homedir(),
  'Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell',
);
const sections = ['table', 'input', 'page', 'figures'];

mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: existsSync(shell) ? shell : undefined });
const report = {};
for (const id of [...sections, null]) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(id ? `${base}?only=${id}` : base, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  const name = id ?? 'all';
  const scope = id ? `[data-kit-section="${id}"]` : null;
  // The mock top bar is sticky and would cover the top of a one-part picture.
  if (scope) await page.addStyleTag({ content: 'header.sticky{display:none !important}' });
  if (scope) await page.locator(scope).screenshot({ path: join(out, `kit-${name}.png`) });
  else await page.screenshot({ path: join(out, `kit-${name}.png`), fullPage: true });
  const axe = await (scope ? new AxeBuilder({ page }).include(scope) : new AxeBuilder({ page })).analyze();
  report[name] = {
    errors,
    violations: axe.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      nodes: v.nodes.length,
      help: v.help,
      sample: v.nodes.slice(0, 3).map((n) => ({ target: n.target, html: n.html.slice(0, 160) })),
    })),
  };
  await context.close();
}
await browser.close();
writeFileSync(join(out, 'axe-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
