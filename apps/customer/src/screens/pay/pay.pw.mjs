import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, refusal, ME, MAYA, SPACE } from './pay.mock.mjs';

const shots = process.env.PAY_SHOTS ?? join(tmpdir(), 'intafaced-pay-shots');
mkdirSync(shots, { recursive: true });
// A short wait lets dialogs and toasts finish fading in, so the picture shows the settled state.
const shot = async (page, name) => {
  await page.waitForTimeout(350);
  await page.screenshot({ path: join(shots, `${name}.png`) });
};
// Both sizes the brief asks for, one picture each.
const shotBoth = async (page, name) => {
  for (const [w, h] of [
    [1440, 900],
    [1280, 800],
  ]) {
    await page.setViewportSize({ width: w, height: h });
    await shot(page, `${name}-${w}x${h}`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
};

const forbidden = /unavailable|not connected|restricted|fixture|lifecycle|undefined|NaN|\[object|ledger|space|transferId|toUser/i;
const open = async (page, path = '/pay/send') => {
  await page.goto(path);
  await page.getByTestId('pay-card').waitFor();
};
const to = (page) => page.getByLabel('Handle', { exact: true });
const accountId = (page) => page.getByLabel('Account ID', { exact: true });
const amount = (page) => page.getByLabel('Amount to send');
const review = (page) => page.getByTestId('pay-review');
const dialog = (page) => page.getByRole('alertdialog');
const sendButton = (page) => page.getByTestId('pay-send');
const box = async (locator) => await locator.first().boundingBox();
const pendingKey = `pay.unresolved:${ME}:send`;

async function pickMaya(page) {
  await to(page).fill('maya_test');
  await to(page).blur();
  await expect(page.getByTestId('recipient-found')).toContainText('@maya_test');
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    // Only once per test page: a reload inside a test keeps what the screen wrote.
    if (!sessionStorage.getItem('harness-cleared')) {
      localStorage.clear();
      sessionStorage.setItem('harness-cleared', '1');
    }
  });
});

test('by handle: look up, review, send, receipt, and the layout of the screen (1440x900)', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
  const api = await mock(page);
  await open(page);

  // Layout (UI-SPEC 5.10): container 1224, two columns, card 520, headline "Pay" at 48/58, tabs Send / Receive.
  expect(Math.round((await box(page.getByTestId('if-pay'))).width)).toBe(1224);
  expect(Math.round((await box(page.getByTestId('pay-card'))).width)).toBe(520);
  await expect(page.getByTestId('pay-hero').locator('h1')).toHaveText('Pay');
  await expect(page.getByTestId('pay-hero').locator('p')).toHaveText('Send money to anyone on INTAFACED. It arrives instantly.');
  expect(
    await page
      .getByTestId('pay-hero')
      .locator('h1')
      .evaluate((n) => getComputedStyle(n).fontSize + '/' + getComputedStyle(n).lineHeight),
  ).toBe('48px/58px');
  await expect(page.getByRole('tab', { name: 'Send' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: 'Receive' })).toBeVisible();
  // Order inside the card: tabs, To, Amount, the button.
  const ys = await page.evaluate(() =>
    ['[role=tablist]', '[data-testid=to-field]', '[data-testid=amount-field]', '[data-testid=pay-review]'].map(
      (s) => document.querySelector(s).getBoundingClientRect().top,
    ),
  );
  expect([...ys].sort((a, b) => a - b)).toEqual(ys);
  // Only held assets with something to send are offered: no BTC (zero), no SOL (locked).
  await expect(page.getByTestId('pay-available')).toHaveText('Available 1,000.5 USDT');
  await expect(review(page)).toBeDisabled();
  await expect(review(page)).toHaveText('Choose who to pay');
  await shotBoth(page, 'send-empty');
  expect(await page.getByLabel('Asset to send').count()).toBe(1);
  await page.getByLabel('Asset to send').click();
  await expect(page.getByRole('option')).toHaveText(['USDT', 'ETH']);
  await page.keyboard.press('Escape');

  // To: resolve on blur.
  await to(page).fill('maya_test');
  await expect(page.getByTestId('recipient-found')).toHaveCount(0);
  await to(page).blur();
  await expect(page.getByTestId('recipient-found')).toContainText('@maya_test');
  expect(api.to('users.resolveHandle')).toHaveLength(1);
  expect(api.to('users.resolveHandle')[0].input).toEqual({ handle: 'maya_test' });
  await expect(review(page)).toHaveText('Enter an amount');

  // Amount above available: the words, inline, and no review.
  await amount(page).fill('2000');
  await expect(page.getByText('You have 1,000.5 USDT available.')).toBeVisible();
  await expect(review(page)).toBeDisabled();
  await shotBoth(page, 'send-over-available');
  await page.getByRole('button', { name: 'Max' }).click();
  await expect(amount(page)).toHaveValue('1000.5');
  await amount(page).fill('1');
  await expect(review(page)).toHaveText('Review');
  await expect(review(page)).toBeEnabled();
  await shotBoth(page, 'send-ready');

  // Review: the words of UI-SPEC 5.10 and the first-time line.
  await review(page).click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).getByRole('heading')).toHaveText('Send 1 USDT to @maya_test?');
  await expect(dialog(page)).toContainText('It arrives instantly and can’t be undone.');
  await expect(page.getByTestId('pay-first-time')).toHaveText('You haven’t sent to @maya_test before. Check the handle with them.');
  expect(api.to('transfers.toUser')).toHaveLength(0);
  await shotBoth(page, 'send-review');
  await sendButton(page).click();

  // Receipt.
  await expect(page.getByTestId('pay-receipt')).toBeVisible();
  await expect(page.getByTestId('buy-receipt__title')).toHaveText('Sent 1 USDT to @maya_test');
  await expect(page.getByRole('link', { name: 'View activity' })).toHaveAttribute('href', '/money/activity?tab=transfers');
  await expect(page.getByRole('button', { name: 'Done' })).toBeVisible();
  await shotBoth(page, 'send-receipt');

  const sent = api.to('transfers.toUser');
  expect(sent).toHaveLength(1);
  expect(sent[0].body).toMatchObject({ fromSpaceId: SPACE.usdt, toUserId: MAYA.userId, amount: '1' });
  expect(sent[0].body.transferId).toMatch(/^[0-9a-f-]{36}$/);
  // The note that guards against a double send is gone once the answer is known.
  expect(await page.evaluate((key) => localStorage.getItem(key), pendingKey)).toBeNull();

  // Done: back to the form with the new balance; the same person no longer gets the first-time line.
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByTestId('pay-available')).toHaveText('Available 999.5 USDT');
  await pickMaya(page);
  await amount(page).fill('2');
  await review(page).click();
  await expect(dialog(page).getByRole('heading')).toHaveText('Send 2 USDT to @maya_test?');
  await expect(page.getByTestId('pay-first-time')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  expect(api.to('transfers.toUser')).toHaveLength(1);

  expect(errors).toEqual([]);
  expect(await page.getByTestId('if-pay').innerText()).not.toMatch(forbidden);
});

test('keyboard path: To, asset, amount, Review, dialog, Send', async ({ page }) => {
  const api = await mock(page);
  await open(page);
  await to(page).focus();
  await page.keyboard.type('maya_test');
  await page.keyboard.press('Enter'); // looks the person up first
  await expect(page.getByTestId('recipient-found')).toContainText('@maya_test');
  await page.keyboard.press('Tab'); // asset
  await expect(page.getByLabel('Asset to send')).toBeFocused();
  await page.keyboard.press('Tab'); // amount
  await expect(amount(page)).toBeFocused();
  await page.keyboard.type('3');
  // Review waits for the published limits for this amount, then Enter reviews.
  await expect(page.getByTestId('pay-terms')).toHaveText('No fee. Up to 1,000,000 USDT per payment. 1,000,000 USDT left today.');
  await page.keyboard.press('Enter'); // reviews
  await expect(dialog(page).getByRole('heading')).toHaveText('Send 3 USDT to @maya_test?');
  await page.getByTestId('pay-send').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('buy-receipt__title')).toHaveText('Sent 3 USDT to @maya_test');
  expect(api.to('transfers.toUser')).toHaveLength(1);
});

test('lookup answers: yourself, not found, too many lookups, a failure, and a stale answer is dropped', async ({ page }) => {
  const api = await mock(page);
  await open(page);

  await to(page).fill('@harness_me');
  await to(page).blur();
  await expect(page.getByTestId('to-status')).toHaveText('That’s you. Pick someone else.');
  await expect(review(page)).toBeDisabled();
  await shotBoth(page, 'send-self');

  await to(page).fill('nobody_here');
  await to(page).blur();
  await expect(page.getByTestId('to-status')).toHaveText('We couldn’t find @nobody_here. Check the spelling.');

  await to(page).fill('a b');
  await to(page).blur();
  await expect(page.getByTestId('to-status')).toHaveText('A handle has 3 to 32 letters, numbers or underscores.');
  expect(api.to('users.resolveHandle')).toHaveLength(2); // the malformed one never reached the service

  // Editing clears the answer: the old person is never kept for a new text.
  await pickMaya(page);
  await to(page).fill('maya_tes');
  await expect(page.getByTestId('recipient-found')).toHaveCount(0);
  await expect(review(page)).toBeDisabled();
});

test('rate limited and failed lookups say so in plain words', async ({ page }) => {
  let mode = 'limit';
  await mock(page, {
    resolve: () =>
      mode === 'limit'
        ? refusal(
            429,
            'Too many lookups. Try again in a minute. [identity.handle_lookup_rate_limited]',
            'identity.handle_lookup_rate_limited',
          )
        : { status: 500, json: { error: { message: 'boom' } } },
  });
  await open(page);
  await to(page).fill('maya_test');
  await to(page).blur();
  await expect(page.getByTestId('to-status')).toContainText('You’ve checked a lot of handles. Wait a minute, then try again.');
  await shotBoth(page, 'send-rate-limited');
  mode = 'fail';
  await to(page).fill('maya_tes');
  await to(page).blur();
  await expect(page.getByTestId('to-status')).toContainText('We couldn’t check that handle. Nothing was sent. Try again.');
  await expect(review(page)).toBeDisabled();
});

test('a slow lookup for an old text never lands on the new text', async ({ page }) => {
  const release = [];
  await mock(page, {
    resolve: ({ input }) =>
      new Promise((resolve) => {
        const answer = {
          result: {
            data: input.handle === 'maya_test' ? { found: true, userId: MAYA.userId, handle: 'maya_test', self: false } : { found: false },
          },
        };
        if (input.handle === 'maya_test') release.push(() => resolve(answer));
        else resolve(answer);
      }),
  });
  await open(page);
  await to(page).fill('maya_test');
  await to(page).blur();
  await expect(page.getByTestId('to-status')).toHaveText('Checking…');
  await to(page).fill('someone_else');
  await to(page).blur();
  await expect(page.getByTestId('to-status')).toContainText('We couldn’t find @someone_else');
  release.forEach((fn) => fn());
  await page.waitForTimeout(300);
  await expect(page.getByTestId('recipient-found')).toHaveCount(0);
  await expect(page.getByTestId('to-status')).toContainText('We couldn’t find @someone_else');
});

test('fallback: a server without handles gets the Account ID input, and it still sends', async ({ page }) => {
  const api = await mock(page, { me: { status: 404, json: { error: { message: 'No procedure "me"' } } } });
  await open(page);
  // The handle input is not drawn at all; the older Account ID input and its Paste button are.
  await expect(accountId(page)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Paste' })).toBeVisible();
  await expect(to(page)).toHaveCount(0);
  await expect(page.getByTestId('pay-to__at')).toHaveCount(0);
  await shotBoth(page, 'send-fallback');

  await accountId(page).fill('not an id');
  await accountId(page).blur();
  await expect(page.getByTestId('to-status')).toHaveText('That doesn’t look like an Account ID. Paste the whole thing.');
  await accountId(page).fill(ME);
  await accountId(page).blur();
  await expect(page.getByTestId('to-status')).toHaveText('That’s you. Pick someone else.');

  await accountId(page).fill(` ${MAYA.userId.toUpperCase()} `);
  await accountId(page).blur();
  await expect(page.getByTestId('recipient-found')).toContainText('Account ID ready');
  await amount(page).fill('1');
  await review(page).click();
  await expect(dialog(page).getByRole('heading')).toHaveText('Send 1 USDT to this account?');
  await expect(dialog(page)).toContainText(MAYA.userId);
  await expect(page.getByTestId('pay-first-time')).toHaveText('You haven’t sent to this account before. Check the Account ID with them.');
  await sendButton(page).click();
  await expect(page.getByTestId('buy-receipt__title')).toHaveText('Sent 1 USDT');
  expect(api.to('users.resolveHandle')).toHaveLength(0);
  expect(api.to('transfers.toUser')[0].body).toMatchObject({ toUserId: MAYA.userId, amount: '1' });
});

test('fallback: the handle input appears only if the server can look handles up; a missing lookup switches over', async ({ page }) => {
  const api = await mock(page, { resolve: { status: 404, json: { error: { message: 'No procedure "users.resolveHandle"' } } } });
  await open(page);
  await expect(to(page)).toBeVisible();
  await to(page).fill('maya_test');
  await to(page).blur();
  await expect(accountId(page)).toBeVisible();
  await expect(page.getByTestId('to-status')).toHaveText('Paying by handle isn’t turned on. Use their Account ID instead.');
  await expect(to(page)).toHaveCount(0);
  expect(api.to('users.resolveHandle')).toHaveLength(1);
});

test('receive: your handle with Copy and the toast "Copied"; the Account ID until handles are live', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await mock(page);
  await open(page, '/pay/receive');
  await expect(page.getByRole('tab', { name: 'Receive' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('Your handle', { exact: true })).toBeVisible();
  await expect(page.getByTestId('receive-value')).toHaveText('@harness_me');
  await expect(page.getByText('Share this with someone on INTAFACED so they can send you money.')).toBeVisible();
  await shotBoth(page, 'receive');
  await page.getByTestId('receive-copy').click();
  await expect(page.getByText('Copied', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('@harness_me');
  await shotBoth(page, 'receive-copied');
  // Tabs: Send keeps its own address.
  await page.getByRole('tab', { name: 'Send' }).click();
  await expect(page).toHaveURL(/\/pay\/send$/);
  await expect(to(page)).toBeVisible();
});

test('receive without handles shows the Account ID in mono', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await mock(page, { me: { status: 404, json: { error: { message: 'x' } } } });
  await open(page, '/pay/receive');
  await expect(page.getByText('Your Account ID', { exact: true })).toBeVisible();
  await expect(page.getByTestId('receive-value')).toHaveText(ME);
  await page.getByTestId('receive-copy').click();
  await expect(page.getByText('Copied', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(ME);
  await shotBoth(page, 'receive-fallback');
});

test('/pay opens Send', async ({ page }) => {
  await mock(page);
  await open(page, '/pay');
  await expect(page.getByRole('tab', { name: 'Send' })).toHaveAttribute('aria-selected', 'true');
  await expect(to(page)).toBeVisible();
});

test('never sends twice: a double click, a held answer, and a reload while it is on its way', async ({ page }) => {
  const api = await mock(page, { toUser: 'hang' });
  await open(page);
  await pickMaya(page);
  await amount(page).fill('1');
  await review(page).click();
  await sendButton(page).dblclick();
  await expect(sendButton(page)).toBeDisabled();
  await expect.poll(() => api.to('transfers.toUser').length).toBe(1);
  // The dialog cannot be dismissed while the request is out.
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeVisible();
  const first = api.to('transfers.toUser')[0].body.transferId;
  // The note is on the device before the money moves.
  expect(JSON.parse(await page.evaluate((key) => localStorage.getItem(key), pendingKey))).toMatchObject({
    status: 'uncertain',
    reference: first,
  });

  // Reload with the answer lost: the screen cannot know, so it waits and offers no way to send again.
  await page.reload();
  await page.getByTestId('pay-card').waitFor();
  await expect(page.getByTestId('pay-waiting')).toContainText('We’re still confirming your last payment.');
  await expect(page.getByTestId('pay-waiting').getByRole('link', { name: 'View activity' })).toHaveAttribute(
    'href',
    '/money/activity?tab=transfers',
  );
  await pickMaya(page);
  await amount(page).fill('1');
  await expect(review(page)).toBeDisabled();
  await shotBoth(page, 'send-still-confirming');
  expect(api.to('transfers.toUser')).toHaveLength(1);
});

test('a refresh while reviewing sends nothing; the next review has a new id, and a retry inside one review keeps its id', async ({
  page,
}) => {
  let attempt = 0;
  const api = await mock(page, {
    toUser: ({ body }) => {
      attempt += 1;
      if (attempt === 1) return refusal(400, 'The service said no', 'bank.space_not_found');
      return { result: { data: { ledgerTxId: 'tx-1', amount: body.amount } } };
    },
  });
  await open(page);
  await pickMaya(page);
  await amount(page).fill('1');
  await review(page).click();
  await expect(dialog(page)).toBeVisible();
  await page.reload();
  await page.getByTestId('pay-card').waitFor();
  expect(api.to('transfers.toUser')).toHaveLength(0);
  expect(await page.evaluate((key) => localStorage.getItem(key), pendingKey)).toBeNull();

  await pickMaya(page);
  await amount(page).fill('1');
  await review(page).click();
  await sendButton(page).click();
  // A plain refusal: nothing moved, the reason is in the dialog, and Send is available again with the same review.
  await expect(page.getByTestId('pay-failure')).toBeVisible();
  await expect(page.getByTestId('pay-failure')).not.toContainText(/bank\./);
  await shotBoth(page, 'send-refused');
  await expect(sendButton(page)).toBeEnabled();
  await sendButton(page).click();
  await expect(page.getByTestId('buy-receipt__title')).toHaveText('Sent 1 USDT to @maya_test');
  const calls = api.to('transfers.toUser');
  expect(calls).toHaveLength(2);
  expect(calls[1].body.transferId).toBe(calls[0].body.transferId);
});

test('a dropped connection is never retried: the payment is "still confirming" and Send is off', async ({ page }) => {
  const api = await mock(page, { toUser: 'abort' });
  await open(page);
  await pickMaya(page);
  await amount(page).fill('1');
  await review(page).click();
  await sendButton(page).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByTestId('pay-waiting')).toContainText('We’re still confirming your last payment.');
  await expect(review(page)).toBeDisabled();
  await page.waitForTimeout(1200);
  expect(api.to('transfers.toUser')).toHaveLength(1);
  expect(JSON.parse(await page.evaluate((key) => localStorage.getItem(key), pendingKey))).toMatchObject({ status: 'uncertain' });
});

test('another unconfirmed bank payment on this device also keeps Send off', async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('seeded')) {
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem(
        'intafaced.customer.bank-unconfirmed.v1:00000000-0000-4000-8000-000000000001',
        JSON.stringify([
          { reference: '9e3b5c1a-0d4f-4c47-8f3e-2a6b7d8c9e10', title: 'Move money', procedure: 'transfers.between', recordRefs: {} },
        ]),
      );
    }
  });
  const api = await mock(page);
  await open(page);
  await expect(page.getByTestId('pay-waiting')).toContainText('We’re still confirming your last payment.');
  await pickMaya(page);
  await amount(page).fill('1');
  await expect(review(page)).toBeDisabled();
  expect(api.to('transfers.toUser')).toHaveLength(0);
});

test('the note goes with the payment, and Review shows the fee and what is left of today', async ({ page }) => {
  const api = await mock(page);
  await open(page);
  await pickMaya(page);
  await amount(page).fill('4');
  await page.locator('#pay-note').fill('  Lunch  on Friday ');
  await expect(page.getByTestId('pay-terms')).toHaveAttribute('data-terms', 'ok');
  await review(page).click();
  await expect(page.getByTestId('pay-review-fee')).toContainText('No fee');
  await expect(page.getByTestId('pay-review-left')).toContainText('999,996 USDT');
  await sendButton(page).click();
  await expect(page.getByTestId('buy-receipt__title')).toHaveText('Sent 4 USDT to @maya_test');
  expect(api.to('transfers.toUser')[0].body).toMatchObject({ amount: '4', note: 'Lunch on Friday' });
  expect(api.to('transfers.quote').at(-1).input).toEqual({ assetId: 'USDT', amount: '4' });
});

test('no published limits, an amount over a limit, and a failed check each keep Review off in plain words', async ({ page }) => {
  // TEST limits.
  const quote = ({ input }) => {
    if (input.assetId === 'ETH')
      return refusal(412, 'No per-transfer limit, daily limit, or fee is published for ETH', 'bank.personal_transfer_terms_unset');
    const amount = Number(input.amount);
    return {
      result: {
        data: {
          assetId: input.assetId,
          amount: input.amount,
          perTransferLimit: '10',
          dailyLimit: '12',
          spentToday: '5',
          fee: '0',
          feeBlocker: null,
          withinPerTransfer: amount <= 10,
          withinDaily: amount + 5 <= 12,
        },
      },
    };
  };
  let fail = false;
  const api = await mock(page, { quote: (request) => (fail ? 'error' : quote(request)) });
  await open(page);
  await pickMaya(page);
  await amount(page).fill('11');
  await expect(page.getByTestId('pay-terms')).toHaveText('The most you can send in one payment is 10 USDT.');
  await expect(review(page)).toBeDisabled();
  await expect(review(page)).toHaveText('Over your limit');
  await amount(page).fill('8');
  await expect(page.getByTestId('pay-terms')).toHaveText('You can send 7 USDT more today.');
  await expect(review(page)).toBeDisabled();
  await amount(page).fill('7');
  await expect(page.getByTestId('pay-terms')).toHaveText('No fee. Up to 10 USDT per payment. 7 USDT left today.');
  await expect(review(page)).toBeEnabled();

  fail = true;
  await amount(page).fill('6');
  await expect(page.getByTestId('pay-terms')).toContainText('We couldn’t check your limits.');
  await expect(review(page)).toHaveText('Limits not checked');
  fail = false;
  await page.getByTestId('pay-terms').getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByTestId('pay-terms')).toHaveText('No fee. Up to 10 USDT per payment. 7 USDT left today.');

  await page.getByLabel('Asset to send').click();
  await page.getByRole('option', { name: /^ETH/ }).click();
  await amount(page).fill('0.1');
  await expect(page.getByTestId('pay-terms')).toHaveText('Sending ETH is paused: no payment limits are published for it.');
  await expect(review(page)).toHaveText('Sending is paused');
  expect(api.to('transfers.toUser')).toHaveLength(0);
});

test('a server that refuses the recipient says so in plain words, without raw codes', async ({ page }) => {
  await mock(page, { toUser: refusal(400, 'recipient has no account', 'bank.recipient_no_account') });
  await open(page);
  await pickMaya(page);
  await amount(page).fill('1');
  await review(page).click();
  await sendButton(page).click();
  await expect(page.getByTestId('pay-failure')).toHaveText(
    "@maya_test can't receive USDT. Ask them to open INTAFACED once, then try again.",
  );
});

test('states: loading, no balances, error with retry, signed out', async ({ page }) => {
  // Loading: balances held.
  let api = await mock(page, { spaces: 'hang' });
  await open(page);
  await expect(page.getByTestId('send-loading')).toBeVisible();
  await shotBoth(page, 'send-loading');
  await page.unrouteAll({ behavior: 'ignoreErrors' });

  // Nothing to send.
  api = await mock(page, { spaces: () => ({ result: { data: [] } }) });
  await open(page);
  await expect(page.getByText('Nothing to send yet')).toBeVisible();
  await expect(page.getByText('Add money to your account, then come back to pay someone.')).toBeVisible();
  await shotBoth(page, 'send-nothing-to-send');
  await page.unrouteAll({ behavior: 'ignoreErrors' });

  // Error, then retry succeeds.
  let fail = true;
  api = await mock(page, { spaces: () => (fail ? { status: 500, json: { error: { message: 'down' } } } : { result: { data: [] } }) });
  await open(page);
  await expect(page.getByText('Couldn’t load your balances.')).toBeVisible();
  await shotBoth(page, 'send-error');
  fail = false;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText('Nothing to send yet')).toBeVisible();
  await page.unrouteAll({ behavior: 'ignoreErrors' });

  // The profile read failing is an error too, never a guess about handles.
  await mock(page, { me: 'error' });
  await open(page);
  await expect(page.getByTestId('send-panel').getByText('Couldn’t load your details.')).toBeVisible();
  await page.unrouteAll({ behavior: 'ignoreErrors' });

  // Signed out.
  await mock(page);
  await open(page, '/pay/send?signedout=1');
  await expect(page.getByRole('link', { name: 'Log in to send money' })).toHaveAttribute('href', /^\/login\?redirect=%2Fpay%2Fsend/);
  await shotBoth(page, 'send-signed-out');
  await open(page, '/pay/receive?signedout=1');
  await expect(page.getByRole('link', { name: 'Log in to see your handle' })).toBeVisible();
});

test('a named space is told apart from the main one', async ({ page }) => {
  await mock(page, {
    spaces: () => ({
      result: {
        data: [
          {
            id: SPACE.usdt,
            assetId: 'USDT',
            kind: 'primary',
            name: 'Main',
            goalTarget: null,
            lockedUntil: null,
            balance: '10',
            ledgerAccount: { ownerType: 'user', ownerId: ME, assetId: 'USDT', kind: 'available' },
          },
          {
            id: SPACE.holiday,
            assetId: 'USDT',
            kind: 'named',
            name: 'Holiday',
            goalTarget: null,
            lockedUntil: null,
            balance: '55',
            ledgerAccount: { ownerType: 'subaccount', ownerId: SPACE.holiday, assetId: 'USDT', kind: 'available' },
          },
        ],
      },
    }),
  });
  await open(page);
  await page.getByLabel('Asset to send').click();
  await expect(page.getByRole('option')).toHaveText(['USDT', 'USDT · Holiday']);
  await page.getByRole('option', { name: 'USDT · Holiday' }).click();
  await expect(page.getByTestId('pay-available')).toHaveText('Available 55 USDT');
});

test('leaving Pay while a payment is on its way: the answer clears the note and the receipt is waiting on return', async ({ page }) => {
  const api = await mock(page, { toUser: 'hang' });
  await open(page);
  await pickMaya(page);
  await amount(page).fill('1');
  await review(page).click();
  await sendButton(page).click();
  await expect.poll(() => api.to('transfers.toUser').length).toBe(1);
  // Go somewhere else in the app: Pay unmounts while the request is out.
  await page.evaluate(() => {
    history.pushState(null, '', '/elsewhere');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(page.getByTestId('elsewhere')).toBeVisible();
  await expect(page.getByTestId('pay-card')).toHaveCount(0);
  await api.release();
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), pendingKey)).toBeNull();
  await page.evaluate(() => {
    history.pushState(null, '', '/pay/send');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(page.getByTestId('buy-receipt__title')).toHaveText('Sent 1 USDT to @maya_test');
  expect(api.to('transfers.toUser')).toHaveLength(1);
  // Done clears it for good.
  await page.getByRole('button', { name: 'Done' }).click();
  await page.evaluate(() => {
    history.pushState(null, '', '/elsewhere');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await page.evaluate(() => {
    history.pushState(null, '', '/pay/send');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(to(page)).toBeVisible();
  await expect(page.getByTestId('pay-receipt')).toHaveCount(0);
});

test('an upper-case copy of your own Account ID is still "That’s you"', async ({ page }) => {
  await mock(page, { me: { status: 404, json: { error: { message: 'x' } } } });
  await open(page);
  await accountId(page).fill(ME.toUpperCase());
  await accountId(page).blur();
  await expect(page.getByTestId('to-status')).toHaveText('That’s you. Pick someone else.');
});

test('a handle that answers as you, in other letters, is refused', async ({ page }) => {
  await mock(page, {
    resolve: () => ({ result: { data: { found: true, userId: ME.toUpperCase(), handle: 'maya_test', self: false } } }),
  });
  await open(page);
  await to(page).fill('maya_test');
  await to(page).blur();
  await expect(page.getByTestId('to-status')).toHaveText('That’s you. Pick someone else.');
});

test('if the chosen asset drops out after a refusal, nothing is chosen and the amount is cleared', async ({ page }) => {
  let dropped = false;
  await mock(page, {
    spaces: () => {
      const data = [
        {
          id: SPACE.usdt,
          assetId: 'USDT',
          kind: 'primary',
          name: 'Main',
          goalTarget: null,
          lockedUntil: null,
          balance: '10',
          ledgerAccount: { ownerType: 'user', ownerId: ME, assetId: 'USDT', kind: 'available' },
        },
        {
          id: SPACE.eth,
          assetId: 'ETH',
          kind: 'primary',
          name: 'Main',
          goalTarget: null,
          lockedUntil: null,
          balance: '5',
          ledgerAccount: { ownerType: 'user', ownerId: ME, assetId: 'ETH', kind: 'available' },
        },
      ];
      return { result: { data: dropped ? data.slice(1) : data } };
    },
    toUser: refusal(400, 'no', 'bank.space_not_found'),
  });
  await open(page);
  await pickMaya(page);
  await amount(page).fill('3');
  await review(page).click();
  dropped = true; // USDT is spent in another tab while the review is open
  await sendButton(page).click();
  await expect(page.getByTestId('pay-failure')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(review(page)).toHaveText('Choose what to send');
  await expect(amount(page)).toHaveValue('');
  await expect(page.getByTestId('pay-available')).toHaveText('');
});

test('a rate-limited send, a rate-limited lookup that can be retried, and Account ID wording', async ({ page }) => {
  let limited = true;
  const api = await mock(page, {
    resolve: ({ input }) =>
      limited
        ? refusal(429, 'slow', 'identity.handle_lookup_rate_limited')
        : { result: { data: { found: true, userId: MAYA.userId, handle: input.handle, self: false } } },
    toUser: refusal(429, 'slow down'),
  });
  await open(page);
  await to(page).fill('maya_test');
  await to(page).blur();
  await expect(page.getByTestId('to-status')).toContainText('Wait a minute');
  limited = false;
  await page.getByTestId('to-status').getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByTestId('recipient-found')).toContainText('@maya_test');
  expect(api.to('users.resolveHandle')).toHaveLength(2);
  await amount(page).fill('1');
  await review(page).click();
  await sendButton(page).click();
  await expect(page.getByTestId('pay-failure')).toHaveText('Too many tries. Wait a minute, then try again.');
});

test('Account ID mode never talks about handles when the account is not found', async ({ page }) => {
  await mock(page, {
    me: { status: 404, json: { error: { message: 'x' } } },
    toUser: refusal(400, 'gone', 'bank.dest_user_missing'),
  });
  await open(page);
  await accountId(page).fill(MAYA.userId);
  await accountId(page).blur();
  await amount(page).fill('1');
  await review(page).click();
  await sendButton(page).click();
  await expect(page.getByTestId('pay-failure')).toHaveText('We couldn’t find that account. Check the Account ID and try again.');
});
