import { expect } from '@playwright/test';
import { api, fund } from './stack.mjs';
import { signUp, verify } from './desk.mjs';

// Pay journeys' shared start: verified TEST members, some holding TEST USDT, and their balances read through each
// person's own API.

/** A verified member, funded with `usdt` TEST USDT when given. */
export async function member(page, prefix, usdt) {
  const who = await signUp(page, prefix);
  await verify(page, who);
  if (usdt) expect(fund(who.email, 'USDT', usdt).tx).toBeTruthy();
  return who;
}

export const usdt = async (who) => (await (await api(who)).balances()).USDT?.free ?? '0';

/** Pay's Send with `handle` looked up, `amount` typed and the terms read: where a send is reviewed from. */
export async function sendTo(page, handle, amount, note = '') {
  await page.goto('/pay');
  const to = page.getByLabel('Handle');
  await to.fill(handle);
  await to.press('Tab');
  await expect(page.getByText(`@${handle}`).first()).toBeVisible();
  await page.getByLabel('Amount to send').fill(amount);
  if (note) await page.locator('#pay-note').fill(note);
}

/** Sends `amount` to `handle` through Review and Send, and returns the receipt reference. */
export async function sendNow(page, handle, amount, note = '') {
  await sendTo(page, handle, amount, note);
  await expect(page.getByTestId('pay-terms')).toHaveAttribute('data-terms', 'ok');
  await page.getByTestId('pay-review').click();
  await page.getByTestId('pay-send').click();
  await expect(page.getByTestId('pay-receipt')).toBeVisible();
  return (await page.getByTestId('pay-receipt-reference').innerText()).trim();
}
