import { test, expect } from './journey.mjs';
import { chosePro, signUp } from './desk.mjs';
import { ORIGIN } from './stack.mjs';
test('debug', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: ORIGIN });
  const page = await context.newPage();
  await chosePro(page);
  await signUp(page, 'dbg07');
  await page.goto('/trade/spot/BTC-USDT');
  await expect(page.getByRole('button', { name: 'Buy BTC' })).toBeVisible();
  await page.evaluate(() => {
    for (const t of ['dragstart', 'dragenter', 'dragover', 'drop', 'dragend'])
      document.addEventListener(t, (e) => { (window.__ev ||= []).push(t + ':' + (e.target.getAttribute?.('aria-label') || e.target.closest?.('[data-widget]')?.getAttribute('data-widget')) + ':' + JSON.stringify(e.dataTransfer?.types)); }, true);
  });
  await page.getByRole('button', { name: 'Layouts' }).click();
  await page.getByRole('dialog', { name: 'Desk layout' }).getByRole('button', { name: 'Arrange widgets' }).click();
  console.log('arranging', await page.getByTestId('if-desk').getAttribute('data-arranging'));
  const handle = page.getByRole('button', { name: 'Move Order book' });
  console.log('handle', JSON.stringify(await handle.boundingBox()), await handle.getAttribute('draggable'));
  await handle.dragTo(page.locator('[data-widget="markets"]'));
  console.log('EV', JSON.stringify((await page.evaluate(() => window.__ev || [])).filter((e) => !e.startsWith('dragover')).slice(0, 12)));
  console.log('order', await page.locator('[data-widget]').evaluateAll((n) => n.map((x) => x.getAttribute('data-widget') + ':' + getComputedStyle(x).order)));
});
