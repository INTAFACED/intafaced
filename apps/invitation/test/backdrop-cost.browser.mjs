// Cost probe for the living backdrop, measured in the real built app (apps/invitation/dist) and, optionally, the lab.
//   node apps/invitation/test/backdrop-cost.browser.mjs              built app only (serves dist itself)
//   node apps/invitation/test/backdrop-cost.browser.mjs <labUrl>     built app, then the lab page too
// The lab URL must mount <LivingBackdrop/> and read ?variant=ribbons|photo, ?dim=1, ?entrance=0|1.
// App rows: welcome = undimmed, step = after Begin (dimmed, the state people spend their time in),
// photo = ?bg=photo, reduced = prefers-reduced-motion emulation.
// Step rows wait 7.5 s first: each field's glow travels once for 6 s on arrival at a step (a transient, not steady state). The first-visit entrance has finished before measuring.
// Readiness is detected from the component's own `data-ready="1"` attribute.
//
// For each profile it measures steady state (BACKDROP_SECONDS, default 10 s) and prints one table:
//   draws/s   : WebGL drawArrays calls on the backdrop canvas (the ribbons' actual shader frames)
//   other gl/s: WebGL draws from anything else on the page (the hero button's small shader)
//   raf/s     : requestAnimationFrame callbacks in the page (what the main thread is asked to produce)
//   frames/s  : compositor DrawFrame events from a CDP trace (what actually reaches the screen)
//   main %    : Performance.getMetrics TaskDuration delta / wall time (renderer main thread busy)
//   gpu cpu % : CPU time of the browser's GPU process / wall time (SystemInfo.getProcessInfo)
//   Profiles: phone = 390x844, 4x CPU throttle; desktop = 1440x900, no throttle.
//   Headless GPU is whatever the host provides, so absolute GPU numbers are indicative, not a device lab.
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(root + '/package.json');
const { chromium } = require('@playwright/test');

const labBase = process.argv[2] || process.env.BACKDROP_URL || '';
const SECONDS = Number(process.env.BACKDROP_SECONDS || 10);

function findBrowser() {
  if (process.env.BACKDROP_BROWSER) return process.env.BACKDROP_BROWSER;
  const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright');
  if (!existsSync(cache)) return undefined;
  const dirs = readdirSync(cache)
    .filter((n) => /^chromium-\d+$/.test(n))
    .sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
  for (const d of dirs) {
    for (const arch of ['chrome-mac-arm64', 'chrome-mac']) {
      const p = join(cache, d, arch, 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

const profiles = [
  { name: 'phone 390x844 4x', w: 390, h: 844, throttle: 4 },
  { name: 'desktop 1440x900', w: 1440, h: 900, throttle: 1 },
];
const lab = (name, q, extra = {}) => ({ target: 'lab', name: 'lab ' + name, q, ...extra });
const app = (name, q, extra = {}) => ({ target: 'app', name: 'app ' + name, q, ...extra });
const scenarios = [
  app('ribbons welcome', ''),
  app('ribbons step (after Begin)', '', { step: true, settle: 7500 }),
  app('photo welcome', '?bg=photo'),
  app('photo step (after Begin)', '?bg=photo', { step: true, settle: 7500 }),
  app('ribbons reduced-motion', '', { reduced: true }),
  app('photo reduced-motion', '?bg=photo', { reduced: true }),
  ...(labBase
    ? [
        lab('ribbons welcome', 'variant=ribbons&entrance=0'),
        lab('ribbons dim (step)', 'variant=ribbons&entrance=0&dim=1', { settle: 2500 }),
        lab('photo welcome', 'variant=photo&entrance=0'),
        lab('photo dim (step)', 'variant=photo&entrance=0&dim=1', { settle: 2500 }),
      ]
    : []),
];

const only = process.env.BACKDROP_ONLY; // e.g. BACKDROP_ONLY=ribbons runs only the ribbons rows
if (only) for (let i = scenarios.length - 1; i >= 0; i--) if (!scenarios[i].name.includes(only)) scenarios.splice(i, 1);

// The built app, served from dist; any API call fails fast (this probe never sends anything).
const dist = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  if (path.startsWith('/api/')) return response.writeHead(503).end('{}');
  const file = path.startsWith('/assets/') ? resolve(dist, '.' + path) : resolve(dist, 'index.html');
  if (!file.startsWith(dist + '/')) return response.writeHead(404).end();
  try {
    const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff2': 'font/woff2' }[extname(file)] || 'application/octet-stream';
    response.writeHead(200, { 'content-type': type }).end(await readFile(file));
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const appBase = `http://127.0.0.1:${server.address().port}/invest`;

const browser = await chromium.launch({ executablePath: findBrowser(), args: ['--headless=new'] });
const browserCdp = await browser.newBrowserCDPSession();
const gpuCpu = async () => {
  try {
    const { processInfo } = await browserCdp.send('SystemInfo.getProcessInfo');
    return processInfo.filter((p) => p.type === 'GPU').reduce((a, p) => a + p.cpuTime, 0);
  } catch {
    return NaN;
  }
};

const rows = [];
let renderer = '';
for (const profile of profiles) {
  for (const sc of scenarios) {
    const ctx = await browser.newContext({
      viewport: { width: profile.w, height: profile.h },
      deviceScaleFactor: 1,
      reducedMotion: sc.reduced ? 'reduce' : 'no-preference',
    });
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      window.__draws = 0;
      window.__other = 0;
      window.__raf = 0;
      for (const C of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
        if (!C) continue;
        const d = C.prototype.drawArrays;
        C.prototype.drawArrays = function (...a) {
          if (this.canvas?.classList?.contains('lb__canvas') || this.canvas?.dataset?.lab) window.__draws++;
          else window.__other++;
          return d.apply(this, a);
        };
      }
      const loop = () => {
        window.__raf++;
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    });
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Performance.enable');
    const url = sc.target === 'app' ? appBase + sc.q : labBase + (labBase.includes('?') ? '&' : '?') + sc.q;
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForSelector('[data-backdrop][data-ready="1"]', { timeout: 120000, state: 'attached' });
    if (sc.target === 'app' && !sc.reduced) await page.waitForTimeout(4000); // let the first-visit entrance finish
    if (sc.step) {
      await page.getByRole('button', { name: 'Begin', exact: true }).click();
      await page.getByLabel('Your name', { exact: true }).waitFor();
    }
    const mode = await page.evaluate(() => document.querySelector('[data-backdrop]').dataset.backdrop);
    if (!renderer) {
      renderer = await page.evaluate(() => {
        const c = document.createElement('canvas');
        const gl = c.getContext('webgl');
        const e = gl && gl.getExtension('WEBGL_debug_renderer_info');
        return gl ? (e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'webgl') : 'no webgl';
      });
    }
    await page.waitForTimeout(sc.settle || 1500);
    if (profile.throttle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.throttle });

    const events = [];
    let tracing = true;
    try {
      cdp.on('Tracing.dataCollected', (e) => events.push(...e.value));
      await cdp.send('Tracing.start', {
        transferMode: 'ReportEvents',
        traceConfig: { includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline.frame', 'cc'] },
      });
    } catch {
      tracing = false;
    }
    const m = async () => {
      const { metrics } = await cdp.send('Performance.getMetrics');
      return Object.fromEntries(metrics.map((x) => [x.name, x.value]));
    };
    const before = await m();
    const draws0 = await page.evaluate(() => [window.__draws, window.__raf, window.__other]);
    const gpu0 = await gpuCpu();
    const t0 = Date.now();
    await page.waitForTimeout(SECONDS * 1000);
    const wall = (Date.now() - t0) / 1000;
    const after = await m();
    const draws1 = await page.evaluate(() => [window.__draws, window.__raf, window.__other]);
    const gpu1 = await gpuCpu();
    let frames = NaN;
    if (tracing) {
      const done = new Promise((r) => cdp.once('Tracing.tracingComplete', r));
      await cdp.send('Tracing.end');
      await done;
      frames = events.filter((e) => e.name === 'DrawFrame' && e.ph !== 'E').length / wall;
    }
    rows.push({
      profile: profile.name,
      scenario: sc.name + (mode === 'photo' && /ribbons/.test(sc.name) ? ' (FELL BACK TO PHOTO)' : ''),
      'draws/s': ((draws1[0] - draws0[0]) / wall).toFixed(1),
      'other gl/s': ((draws1[2] - draws0[2]) / wall).toFixed(1),
      'raf/s': ((draws1[1] - draws0[1]) / wall).toFixed(1),
      'frames/s': Number.isNaN(frames) ? 'n/a' : frames.toFixed(1),
      'main %': (((after.TaskDuration - before.TaskDuration) / wall) * 100).toFixed(1),
      'gpu cpu %': Number.isNaN(gpu0) ? 'n/a' : (((gpu1 - gpu0) / wall) * 100).toFixed(1),
    });
    process.stderr.write('done ' + profile.name + ' / ' + sc.name + '\n');
    await ctx.close();
  }
}
await browser.close();
await new Promise((r) => server.close(r));
console.log('\nWebGL renderer: ' + renderer + '   (' + SECONDS + ' s per row, built app from apps/invitation/dist' + (labBase ? ', lab ' + labBase : '') + ')');
console.table(rows);
