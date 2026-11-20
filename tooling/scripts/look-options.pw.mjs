// World: none
// The look directions' pictures for the owner's first choice (intafaced #9188): the same three real screens (Home, the
// spot desk, Money) as one new TEST person, verified and funded with TEST USDT through the real ledger, at phone
// (390×844) and computer (1440×900), dark and light, in each direction. Every picture is the running app: a direction
// is only the look's own switches (look.ts: `?look=`, `?accent=`, `?scheme=`; Solid surfaces from its setting).
// Run on this checkout's own stack (`pnpm local:stack verify launch` first):
//   LOOK_OPTIONS_OUT=<folder> pnpm exec playwright test --config tooling/scripts/look-options.config.mjs
// It asserts only that each page answered; what it shows is for the reader.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '../../apps/customer/tests/real-app/journey.mjs';
import { deskPath, fundedTrader, signIn } from '../../apps/customer/tests/real-app/desk.mjs';

const out = process.env.LOOK_OPTIONS_OUT;

/**
 * Today's app (dark only: it has no light values), then the directions. Solid surfaces is the look's own setting
 * (`intafaced.surfaces`).
 */
export const DIRECTIONS = [
  { id: 'today', query: 'look=off&accent=off&direction=off', solid: false, schemes: ['dark'] },
  { id: 'lit-glass', query: 'look=lit&accent=blue&direction=off', solid: false },
  { id: 'ember', query: 'look=lit&accent=ember&direction=off', solid: false },
  { id: 'emerald-solid', query: 'look=lit&accent=emerald&direction=off', solid: true },
  // The real directions (intafaced #9227): each its own folder, named `<screen>--<size>--<scheme>.png`.
  { id: 'volt', query: 'look=lit&accent=off&direction=volt', solid: false, screens: ['home', 'money', 'buy'], own: true },
];
export const SCREENS = [
  { id: 'home', path: '/home' },
  { id: 'desk', path: deskPath('BTC/USDT') },
  { id: 'money', path: '/money' },
  // The simple buy, as Home's Buy opens it.
  { id: 'buy', path: '/trade/buy' },
];
const DEFAULT_SCREENS = ['home', 'desk', 'money'];
export const SIZES = [
  { id: 'phone', width: 390, height: 844 },
  { id: 'computer', width: 1440, height: 900 },
];
export const SCHEMES = ['dark', 'light'];

const only = (name, list) => {
  const asked = process.env[name]?.split(',').filter(Boolean);
  return asked?.length ? list.filter((x) => asked.includes(typeof x === 'string' ? x : x.id)) : list;
};

test('look options', async ({ page }) => {
  expect(out, 'LOOK_OPTIONS_OUT names the folder').toBeTruthy();
  fs.mkdirSync(out, { recursive: true });
  const who = await fundedTrader(page, 'look', '2500');
  await signIn(page, who);
  const shots = [];
  for (const d of only('LOOK_OPTIONS_DIRECTIONS', DIRECTIONS)) {
    for (const scheme of only('LOOK_OPTIONS_SCHEMES', d.schemes ?? SCHEMES)) {
      await page.goto(`/home?${d.query}&scheme=${scheme}`);
      await page.evaluate((solid) => {
        if (solid) localStorage.setItem('intafaced.surfaces', 'solid');
        else localStorage.removeItem('intafaced.surfaces');
      }, d.solid);
      for (const size of only('LOOK_OPTIONS_SIZES', SIZES)) {
        await page.setViewportSize({ width: size.width, height: size.height });
        for (const s of only(
          'LOOK_OPTIONS_SCREENS',
          SCREENS.filter((x) => (d.screens ?? DEFAULT_SCREENS).includes(x.id)),
        )) {
          const res = await page.goto(s.path);
          expect(res?.status() ?? 0, `${s.path} answered`).toBeLessThan(400);
          await page.waitForLoadState('networkidle').catch(() => {});
          await page.evaluate(() => document.fonts.ready);
          const root = await page.evaluate(() => ({ ...document.documentElement.dataset }));
          const file = `${d.own ? '' : `${d.id}--`}${s.id}--${size.id}--${scheme}.png`;
          await page.screenshot({ path: path.join(out, file), animations: 'disabled' });
          shots.push({ file, direction: d.id, screen: s.id, size: size.id, scheme, url: page.url(), root });
        }
      }
    }
  }
  fs.writeFileSync(path.join(out, 'shots.json'), `${JSON.stringify({ who: who.handle, shots }, null, 2)}\n`);
});
