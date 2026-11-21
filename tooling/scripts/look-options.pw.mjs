// World: none
// The look directions' pictures for the owner's first choice (intafaced #9188, #9227): the same real screens (Home, the
// spot desk, Money; the real directions show Home, Money and Buy) as one new TEST person, verified and funded with TEST USDT through the real ledger, at phone
// (390×844) and computer (1440×900), dark and light, in each direction. Every picture is the running app: a direction
// is only the look's own switches (look.ts: `?look=`, `?accent=`, `?scheme=`; Solid surfaces from its setting).
// Run on this checkout's own stack (`pnpm local:stack verify launch` first):
//   LOOK_OPTIONS_OUT=<folder> pnpm exec playwright test --config tooling/scripts/look-options.config.mjs
// It asserts only that each page answered; what it shows is for the reader.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '../../apps/customer/tests/real-app/journey.mjs';
import { deskPath, fundedTrader, signIn } from '../../apps/customer/tests/real-app/desk.mjs';
import { fund } from '../../apps/customer/tests/real-app/stack.mjs';

const out = process.env.LOOK_OPTIONS_OUT;

/**
 * Today's app (dark only: it has no light values), then the directions. Solid surfaces is the look's own setting
 * (`intafaced.surfaces`).
 */
export const DIRECTIONS = [
  { id: 'today', query: 'look=off&accent=off', solid: false, schemes: ['dark'] },
  { id: 'lit-blue', query: 'look=lit&accent=blue', solid: false },
  { id: 'emerald-solid', query: 'look=lit&accent=emerald', solid: true },
  // the real directions (intafaced #9227): each its own Home, money object, tab bar and material, and the Buy flow
  { id: 'lit-glass', query: 'look=lit&accent=off&direction=lit-glass', solid: false, screens: ['home', 'money', 'buy'] },
  { id: 'ember', query: 'look=lit&accent=off&direction=ember', solid: false, screens: ['home', 'money', 'buy'] },
  // Volt, the chosen look (intafaced #9302): its three screens and its kit page, whole, then with its sheet and a toast open
  {
    id: 'volt',
    query: 'look=lit&accent=off&direction=volt',
    solid: false,
    screens: ['home', 'money', 'buy', 'kit', 'kit-sheet', 'kit-toast'],
  },
];
export const SCREENS = [
  { id: 'home', path: '/home' },
  { id: 'desk', path: deskPath('BTC/USDT') },
  { id: 'money', path: '/money' },
  // The simple buy, as Home's Buy opens it, with an amount typed so its quote and its action are live.
  { id: 'buy', path: '/trade/buy', amount: '100' },
  // The Volt kit page (intafaced #9302), opened only under Volt's switch: the whole page, then its sheet and its toast.
  { id: 'kit', path: '/kit', fullPage: true },
  { id: 'kit-sheet', path: '/kit', click: '[data-kit="open-sheet"]', opens: '[data-slot="dialog-content"]' },
  { id: 'kit-toast', path: '/kit', click: '[data-kit="show-toast"]', opens: '[data-slot="toast"]' },
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
  // Headless Chromium reports `prefers-reduced-transparency: reduce`, which turns every glass surface solid (lit.css,
  // a11y/surfaces.ts): draw what a phone or computer with no such setting shows, as a person sees it. (The pictures of
  // #9188 were taken without this, so their glass was drawn solid.)
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'no-preference' }] });
  const who = await fundedTrader(page, 'look', '2500');
  // Some TEST BTC too, through the same real ledger, so the screens show cash and crypto, as a customer's would.
  expect(fund(who.email, 'BTC', '0.015').tx).toBeTruthy();
  await signIn(page, who);
  const shots = [];
  for (const d of only('LOOK_OPTIONS_DIRECTIONS', DIRECTIONS)) {
    for (const scheme of only('LOOK_OPTIONS_SCHEMES', d.schemes ?? SCHEMES)) {
      // a direction without its own switch forgets any other direction this browser remembers
      await page.goto(`/home?${d.query}${d.query.includes('direction=') ? '' : '&direction=off'}&scheme=${scheme}`);
      await page.evaluate((solid) => {
        if (solid) localStorage.setItem('intafaced.surfaces', 'solid');
        else localStorage.removeItem('intafaced.surfaces');
      }, d.solid);
      for (const size of only('LOOK_OPTIONS_SIZES', SIZES)) {
        await page.setViewportSize({ width: size.width, height: size.height });
        for (const s of only('LOOK_OPTIONS_SCREENS', SCREENS).filter((x) => (d.screens ?? DEFAULT_SCREENS).includes(x.id))) {
          const res = await page.goto(s.path);
          expect(res?.status() ?? 0, `${s.path} answered`).toBeLessThan(400);
          await page.waitForLoadState('networkidle').catch(() => {});
          if (s.amount) {
            const amount = page.getByRole('textbox', { name: /^Amount in/ }).first();
            await amount.fill(s.amount);
            await amount.blur();
            await page.waitForLoadState('networkidle').catch(() => {});
          }
          if (s.click) {
            await page.locator(s.click).click();
            // the sheet or toast is up, and its entrance has finished
            await page.locator(s.opens).first().waitFor({ state: 'visible' });
            await page.evaluate(() =>
              Promise.all(
                document
                  .getAnimations()
                  // a spinner or a skeleton's pulse runs forever: wait only for what ends
                  .filter((a) => a.effect?.getTiming().iterations !== Infinity)
                  .map((a) => a.finished.catch(() => undefined)),
              ),
            );
          }
          await page.evaluate(() => document.fonts.ready);
          // Volt's phone Home keeps its label row on one line (intafaced #9302: it wrapped "Est. total value" and
          // "Customise Home"): every part of the row shares one top, and the label is one line high.
          if (d.id === 'volt' && s.id === 'home' && size.id === 'phone') {
            const row = await page.getByTestId('home-label').evaluate((el) => {
              const tops = [...el.children].map((c) => Math.round(c.getBoundingClientRect().top + c.getBoundingClientRect().height / 2));
              const label = el.firstElementChild?.getBoundingClientRect().height ?? 0;
              const line = parseFloat(getComputedStyle(el).fontSize) * 1.8;
              return { spread: Math.max(...tops) - Math.min(...tops), label, line };
            });
            expect(row.spread, 'the label row is one row').toBeLessThanOrEqual(4);
            expect(row.label, '"Est. total value" is one line').toBeLessThanOrEqual(row.line);
          }
          const root = await page.evaluate(() => ({ ...document.documentElement.dataset }));
          if (!d.solid) expect(root.surfaces, `${s.path} draws glass`).toBe('glass');
          // one direction asked for: its own folder, so the names drop the direction (`<screen>--<size>--<scheme>.png`)
          const one = only('LOOK_OPTIONS_DIRECTIONS', DIRECTIONS).length === 1;
          const file = `${one ? '' : `${d.id}--`}${s.id}--${size.id}--${scheme}.png`;
          if (s.fullPage) {
            // a whole page as one tall screen, so what floats at the foot (the phone's tab bar) is drawn at the foot
            const tall = await page.evaluate(() => document.documentElement.scrollHeight);
            await page.setViewportSize({ width: size.width, height: tall });
            await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
          }
          await page.screenshot({ path: path.join(out, file), animations: 'disabled' });
          if (s.fullPage) await page.setViewportSize({ width: size.width, height: size.height });
          shots.push({ file, direction: d.id, screen: s.id, size: size.id, scheme, url: page.url(), root });
        }
      }
    }
  }
  fs.writeFileSync(path.join(out, 'shots.json'), `${JSON.stringify({ who: who.handle, shots }, null, 2)}\n`);
});
