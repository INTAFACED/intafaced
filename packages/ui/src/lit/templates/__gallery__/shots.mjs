// Screenshots of the templates gallery (lane B2). Usage, with the gallery dev server running on 3291:
//   node src/lit/templates/__gallery__/shots.mjs <outDir> [template ...] [--states=a,b] [--widths=390,1440] [--extra=mode=pro&dir=rtl]
// Frozen clock and no animation, so a shot repeats byte for byte. Dev tool only.
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const out = args[0];
const opt = (k, d) => (args.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=');
const templates = args.slice(1).filter((a) => !a.startsWith('--'));
const ids = templates.length ? templates : ['overview', 'record-list', 'monitor', 'flow', 'settings', 'catalogue', 'desk', 'reading'];
const states = opt('states', 'ready').split(',');
const widths = opt('widths', '390,1440').split(',').map(Number);
const extra = opt('extra', '');
mkdirSync(out, { recursive: true });

// CHROMIUM_PATH: a preinstalled browser when the pinned one isn't downloaded (cloud sessions: /opt/pw-browsers/chromium).
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
for (const w of widths) {
  const page = await browser.newPage({ viewport: { width: w, height: w < 600 ? 844 : 900 }, reducedMotion: 'reduce' });
  await page.clock.install({ time: new Date('2026-10-26T10:47:00Z') });
  for (const id of ids) {
    for (const s of states) {
      const url = `http://127.0.0.1:3291/?t=${id}&s=${s}${extra ? `&${extra}` : ''}`;
      await page.goto(url);
      await page.waitForSelector('.lt-room');
      const name = `${id}-${s}-${w}${extra ? `-${extra.replace(/[&=]/g, '_')}` : ''}.png`;
      await page.screenshot({ path: join(out, name), fullPage: true });
      console.log(name);
    }
  }
  await page.close();
}
await browser.close();
