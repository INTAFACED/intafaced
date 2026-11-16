// World: none
// One page as a person sees it, for `pnpm local:stack verify look <path>` (verify-app.mjs), through the journeys' own
// harness: signed out, or as a new TEST person signed up through the app's own form (desk.mjs signUp). It keeps a
// screenshot and the ARIA snapshot of the page and, with a selector, of that one element with its box and text, in
// VERIFY_LOOK_OUT. It asserts only that the page answered and the element is visible: what it shows is for the reader.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '../../apps/customer/tests/real-app/journey.mjs';
import { signUp } from '../../apps/customer/tests/real-app/desk.mjs';

const where = process.env.VERIFY_LOOK_PATH ?? '/';
const out = process.env.VERIFY_LOOK_OUT;
const selector = process.env.VERIFY_LOOK_SELECTOR ?? null;

test(`look ${where}`, async ({ page }) => {
  expect(out, 'VERIFY_LOOK_OUT names the run folder').toBeTruthy();
  if (process.env.VERIFY_LOOK_SIGN_UP === '1') await signUp(page, 'look');
  const res = await page.goto(where);
  expect(res?.status() ?? 0, `${where} answered`).toBeLessThan(400);
  await page.waitForLoadState('networkidle').catch(() => {});
  fs.writeFileSync(path.join(out, 'page.url.txt'), `${page.url()}\n`);
  fs.writeFileSync(path.join(out, 'page.aria.yml'), `${await page.locator('body').ariaSnapshot()}\n`);
  await page.screenshot({ path: path.join(out, 'page.png'), fullPage: true });
  if (selector) {
    const el = page.locator(selector).first();
    await expect(el, `${selector} is visible`).toBeVisible();
    const facts = { selector, box: await el.boundingBox(), text: await el.innerText() };
    fs.writeFileSync(path.join(out, 'element.json'), `${JSON.stringify(facts, null, 2)}\n`);
    fs.writeFileSync(path.join(out, 'element.aria.yml'), `${await el.ariaSnapshot()}\n`);
    await el.screenshot({ path: path.join(out, 'element.png') });
  }
});
