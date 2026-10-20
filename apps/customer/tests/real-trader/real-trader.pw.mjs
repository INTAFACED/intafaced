import path from 'node:path';
import { expect, test } from '@playwright/test';

const shots = process.env.REAL_TRADER_SHOTS ?? '/tmp/intafaced-real-trader-shots';
const shot = (page, name) => page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true });

// The real trader loop on the assembled stack: sign up, KYC approved, test-rail fund, place, fill, cancel, P&L.
// Nothing is mocked. The first step only proves the app answers on the stack; the rest follow once the
// edge has a test sanctions list to let a test account sign up.
test('the real app answers on the assembled stack', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#root')).not.toBeEmpty();
  await shot(page, '01-landing');
});
