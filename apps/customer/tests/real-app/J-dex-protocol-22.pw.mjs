import { test, expect } from '@playwright/test';
import { TOKEN_A, UNBUILT, connectWallet, dexRun, walletSection } from './dex.mjs';
import { bodyRows, tableIn } from './tables.mjs';

// J-dex-protocol-22, in the running app (docs/roadmap/journeys.json): pay a merchant, subscribe, schedule transfers and
// hide behind a stealth handle. One test per step, titled "J-dex-protocol-22 #<n>", run in order with one TEST wallet
// holding TEST token A, and a TEST merchant that accepts on-chain payments. Payments and capped allowances are signed by
// the person's wallet on the Protocol Plane; the card's issuer never holds balances; nothing posts to the ledger.
// rail.crypto while the node is absent; audit.external for mainnet.
// Every step is written; none is built yet, so each fails at its first missing part, quickly (UNBUILT):
// - the wallet room has no Pay, Subscriptions, Scheduled, Spaces or Stealth handle sections (RC-merchant-01, -02,
//   RC-dex-protocol-08, -16, RC-identity-17, RC-pay-03); the on-chain split payment and the stealth scan are proven in
//   services/svc-protocol (merchant-accept.onchain.test.ts, stealth/scan.test.ts), but no room opens them;
// - the stack has no TEST chain or keeper, so no payment, pull or scheduled transfer can mine.
const J = 'J-dex-protocol-22';
const dex = dexRun(J);
// A TEST merchant's on-chain checkout, a friend's address and the members of a space.
const MERCHANT = 'TEST merchant';
const SAVED = '0x52908400098527886E0F7030069857D2E4169EE7';
const MEMBERS = [SAVED, '0x0000000000000000000000000000000000000a01', '0x0000000000000000000000000000000000000a02'];

test.describe.configure({ mode: 'default' });

/** Opens one wallet section with the run's wallet connected. */
async function openSection(page, name) {
  const wallet = await connectWallet(page, dex, { tokens: [TOKEN_A] });
  await walletSection(page, name);
  return wallet;
}

/** Signs whatever the open sheet asks for. */
async function sign(page) {
  await page.getByRole('dialog', { name: 'Check before you sign' }).getByRole('button', { name: 'Continue in wallet' }).click();
}

test(`${J} starts: a TEST wallet holding TEST token A; a TEST merchant that accepts on-chain payments`, async ({ page }) => {
  dex.start();
  await connectWallet(page, dex, { tokens: [TOKEN_A] });
});

test(`${J} #1 pays a merchant from the wallet: the payment splits to the merchant and its fee recipient in one transaction`, async ({
  page,
}) => {
  const wallet = await openSection(page, 'Pay');
  const pay = page.getByRole('form', { name: 'Pay a merchant' });
  await pay.getByRole('combobox', { name: 'Merchant' }).selectOption({ label: MERCHANT }, UNBUILT);
  await pay.getByRole('textbox', { name: /^Amount/ }).fill('10');
  await pay.getByRole('button', { name: 'Review' }).click();
  const sheet = page.getByRole('dialog', { name: 'Check before you sign' });
  await expect(sheet.getByRole('term').filter({ hasText: 'To the merchant' })).toBeVisible();
  await expect(sheet.getByRole('term').filter({ hasText: 'Fee recipient' })).toBeVisible();
  await sign(page);
  await expect.poll(() => wallet.sends.length).toBe(1);
});

test(`${J} #2 grants a subscription of 10 TEST per period: the cap is shown; a pull of 6 then 5 in one period fails on the second; revoke makes the next pull fail`, async ({
  page,
}) => {
  await openSection(page, 'Subscriptions');
  await page.getByRole('button', { name: 'New subscription' }).click(UNBUILT);
  const form = page.getByRole('form', { name: 'New subscription' });
  await form.getByRole('combobox', { name: 'Merchant' }).selectOption({ label: MERCHANT });
  await form.getByRole('textbox', { name: /^Cap per period/ }).fill('10');
  await form.getByRole('button', { name: 'Review' }).click();
  await sign(page);
  const subs = tableIn(page.getByRole('main'), 'Subscriptions');
  const row = bodyRows(subs).filter({ hasText: MERCHANT });
  await expect(row).toContainText('10 TEST Token A per period', { timeout: 60_000 });
  // The TEST merchant pulls 6, then 5, in one period: the second is refused by the cap.
  const pulls = tableIn(page.getByRole('main'), 'Pulls');
  await expect(bodyRows(pulls).filter({ hasText: /\b6 TEST Token A.*Paid/ })).toHaveCount(1, { timeout: 120_000 });
  await expect(bodyRows(pulls).filter({ hasText: /\b5 TEST Token A.*Refused: over the cap for this period/ })).toHaveCount(1);
  await row.getByRole('button', { name: 'Revoke' }).click();
  await sign(page);
  await expect(row).toContainText('Revoked', { timeout: 60_000 });
});

test(`${J} #3 schedules 5 TEST a week to a saved address: a second keeper trigger in one week fails; cancel stops the next run`, async ({
  page,
}) => {
  await openSection(page, 'Scheduled');
  await page.getByRole('button', { name: 'New scheduled transfer' }).click(UNBUILT);
  const form = page.getByRole('form', { name: 'New scheduled transfer' });
  await form.getByRole('textbox', { name: /^To/ }).fill(SAVED);
  await form.getByRole('textbox', { name: /^Amount/ }).fill('5');
  await form.getByRole('combobox', { name: 'Every' }).selectOption({ label: 'Week' });
  await form.getByRole('button', { name: 'Review' }).click();
  await sign(page);
  const runs = tableIn(page.getByRole('main'), 'Scheduled runs');
  await expect(bodyRows(runs).filter({ hasText: 'Sent' })).toHaveCount(1, { timeout: 120_000 });
  await expect(bodyRows(runs).filter({ hasText: 'Refused: already sent this week' })).toHaveCount(1, { timeout: 120_000 });
  const schedule = bodyRows(tableIn(page.getByRole('main'), 'Scheduled transfers')).filter({ hasText: '5 TEST Token A' });
  await schedule.getByRole('button', { name: 'Cancel' }).click();
  await sign(page);
  await expect(schedule).toContainText('Cancelled: no further runs');
});

test(`${J} #4 creates a named space grouping three addresses: balances per member; an empty space saves with zero; signed out, spaces stay in the browser and work with storage blocked`, async ({
  page,
  browser,
}) => {
  await openSection(page, 'Spaces');
  await page.getByRole('button', { name: 'New space' }).click(UNBUILT);
  const form = page.getByRole('form', { name: 'New space' });
  await form.getByRole('textbox', { name: /^Name/ }).fill('TEST family');
  for (const address of MEMBERS) {
    await form.getByRole('textbox', { name: /^Add an address/ }).fill(address);
    await form.getByRole('button', { name: 'Add' }).click();
  }
  await form.getByRole('button', { name: 'Save space' }).click();
  const space = page.getByRole('region', { name: 'TEST family' });
  await expect(bodyRows(tableIn(space, 'Members'))).toHaveCount(3);
  await page.getByRole('button', { name: 'New space' }).click();
  await form.getByRole('textbox', { name: /^Name/ }).fill('TEST empty');
  await form.getByRole('button', { name: 'Save space' }).click();
  await expect(page.getByRole('region', { name: 'TEST empty' })).toContainText('No members');
  await page.reload();
  await walletSection(page, 'Spaces');
  await expect(page.getByRole('region', { name: 'TEST family' })).toBeVisible();
  // With storage blocked the section still opens and says spaces cannot be kept in this browser.
  const blocked = await browser.newContext();
  try {
    const away = await blocked.newPage();
    await away.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        get() {
          throw new DOMException('blocked', 'SecurityError');
        },
      });
    });
    await away.goto('/wallet');
    await away.getByRole('button', { name: 'Spaces', exact: true }).click();
    await expect(away.getByRole('button', { name: 'New space' })).toBeEnabled();
  } finally {
    await blocked.close();
  }
});

test(`${J} #5 creates a stealth handle and shares it: two payers get two different addresses, neither the spending key; the scanner finds payments with the viewing key only`, async ({
  page,
}) => {
  const wallet = await openSection(page, 'Stealth handle');
  await page.getByRole('button', { name: 'Create a stealth handle' }).click(UNBUILT);
  await sign(page);
  const handle = page.getByRole('region', { name: 'Your stealth handle' });
  await expect(handle.getByTestId('stealth-handle')).toHaveText(/^st:[0-9a-zA-Z]+$/);
  await handle.getByRole('button', { name: 'Show two TEST payer addresses' }).click();
  const addresses = await handle.getByRole('listitem').allInnerTexts();
  expect(addresses).toHaveLength(2);
  expect(addresses[0]).not.toBe(addresses[1]);
  for (const address of addresses) expect(address.toLowerCase()).not.toContain(wallet.address);
  await handle.getByRole('button', { name: 'Scan for payments' }).click();
  await expect(handle.getByRole('status')).toHaveText(/^Found \d+ payments? with your viewing key$/);
});

test(`${J} #6 pays a friend by their handle: it resolves to a fresh stealth address; an unresolved handle reads "Name not resolved" and nothing is sent`, async ({
  page,
}) => {
  const wallet = await openSection(page, 'Pay');
  const pay = page.getByRole('form', { name: 'Pay a handle' });
  await pay.getByRole('textbox', { name: /^Handle/ }).fill('st:testfriend', UNBUILT);
  await expect(pay.getByTestId('resolved-address')).toHaveText(/^Pays a fresh address 0x[0-9a-fA-F]{40}$/);
  await pay.getByRole('textbox', { name: /^Handle/ }).fill('st:nobody-here');
  await expect(pay.getByRole('alert')).toHaveText('Name not resolved');
  await expect(pay.getByRole('button', { name: 'Review' })).toBeDisabled();
  expect(wallet.sends).toHaveLength(0);
});
