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
  { id: 'today', query: 'look=off&accent=off', solid: false, schemes: ['dark'] },
  { id: 'lit-blue', query: 'look=lit&accent=blue', solid: false },
  // The real directions (intafaced #9227): `look=<direction>`, their own screens, each picture named
  // `<screen>--<size>--<scheme>.png` in that direction's own folder (LOOK_OPTIONS_DIRECTIONS=<id> LOOK_OPTIONS_OUT=<its folder>)
  { id: 'lit-glass', query: 'look=lit-glass&accent=off', solid: false, screens: ['home', 'money', 'buy'], own: true },
  { id: 'ember', query: 'look=lit&accent=ember', solid: false },
  { id: 'emerald-solid', query: 'look=lit&accent=emerald', solid: true },
];
export const SCREENS = [
  { id: 'home', path: '/home' },
  { id: 'desk', path: deskPath('BTC/USDT') },
  { id: 'money', path: '/money' },
  // a simple buy, as Home's Buy opens it, with an amount typed so the quote shows
  { id: 'buy', path: '/trade/buy', amount: '100' },
];
export const SIZES = [
  { id: 'phone', width: 390, height: 844 },
  { id: 'computer', width: 1440, height: 900 },
];
export const SCHEMES = ['dark', 'light'];

/** The other directions' screens (every screen but the buy, as before #9227) unless a direction names its own. */
const screensOf = (d) => (d.screens ? SCREENS.filter((s) => d.screens.includes(s.id)) : SCREENS.filter((s) => s.id !== 'buy'));

const only = (name, list) => {
  const asked = process.env[name]?.split(',').filter(Boolean);
  return asked?.length ? list.filter((x) => asked.includes(typeof x === 'string' ? x : x.id)) : list;
};

test('look options', async ({ page }) => {
  expect(out, 'LOOK_OPTIONS_OUT names the folder').toBeTruthy();
  fs.mkdirSync(out, { recursive: true });
  // Headless Chromium reports `prefers-reduced-transparency: reduce`, which turns every glass surface solid (lit.css,
  // a11y/surfaces.ts): draw what a phone or computer with no such setting shows, as a person sees it. (The pictures of
  // #9188 were taken without this, so their glass was drawn solid.)
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'no-preference' }] });
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
        for (const s of only('LOOK_OPTIONS_SCREENS', screensOf(d))) {
          const res = await page.goto(s.path);
          expect(res?.status() ?? 0, `${s.path} answered`).toBeLessThan(400);
          await page.waitForLoadState('networkidle').catch(() => {});
          if (s.amount) {
            const field = page.getByRole('textbox', { name: /^Amount in/ });
            await field.fill(s.amount);
            await field.blur();
            await expect(page.getByTestId('approx')).not.toHaveText('');
          }
          await page.evaluate(() => document.fonts.ready);
          const root = await page.evaluate(() => ({ ...document.documentElement.dataset }));
          if (!d.solid) expect(root.surfaces, `${s.path} draws glass`).toBe('glass');
          const file = d.own ? `${s.id}--${size.id}--${scheme}.png` : `${d.id}--${s.id}--${size.id}--${scheme}.png`;
          await page.screenshot({ path: path.join(out, file), animations: 'disabled' });
          shots.push({ file, direction: d.id, screen: s.id, size: size.id, scheme, url: page.url(), root });
        }
      }
    }
  }
  fs.writeFileSync(path.join(out, 'shots.json'), `${JSON.stringify({ who: who.handle, shots }, null, 2)}\n`);
});
