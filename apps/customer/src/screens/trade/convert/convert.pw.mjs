import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, trpcRefusal } from '../buy/trade.mock.mjs';
import { fillFor, quoteFor } from '../buy/trade.fixtures.mjs';

const shots = process.env.TRADE_SHOTS ?? join(tmpdir(), 'intafaced-trade-shots');
mkdirSync(shots, { recursive: true });
// A short wait lets dialogs finish fading in, so the picture shows the settled state.
const shot = async (page, name) => {
  await page.waitForTimeout(350);
  await page.screenshot({ path: join(shots, `${name}.png`) });
};

const forbidden = /unavailable|not connected|restricted|fixture|lifecycle|undefined|NaN|\[object/i;
const open = async (page, path = '/trade/convert?asset=ETH') => {
  await page.goto(path);
  await page.locator(':is([data-testid="cvt-card"], [data-testid="cvt-card--skeleton"], [data-testid="cvt-receipt"])').waitFor();
};
const amount = (page) => page.getByLabel('Amount to convert');
const preview = (page) => page.getByRole('button', { name: 'Preview conversion' });
const dialog = (page) => page.getByRole('alertdialog');
const box = async (locator) => await locator.first().boundingBox();
const note = (page) => page.evaluate(() => localStorage.getItem('trade-pending:00000000-0000-4000-8000-000000000001'));

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
});

test('convert 10 USDT to ETH: quote, countdown, review, convert, receipt, new balance (1440x900)', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
  const api = await mock(page);
  await open(page);

  // Layout (UI-SPEC 5.8): container 1224, two columns, card 520, headline "Convert / USDT to ETH" at 48/58.
  expect(Math.round((await box(page.getByTestId('if-convert'))).width)).toBe(1224);
  expect(
    Math.round(
      (await box(page.locator(':is([data-testid="cvt-card"], [data-testid="cvt-card--skeleton"], [data-testid="cvt-receipt"])'))).width,
    ),
  ).toBe(520);
  await expect(page.getByTestId('cvt-hero').locator('h1')).toContainText('Convert');
  await expect(page.getByTestId('headline-pair')).toHaveText('USDT to ETH');
  await expect(page.getByTestId('cvt-hero').locator('p')).toHaveText('Quoted price · No order book needed · Instant');
  expect(
    await page
      .getByTestId('cvt-hero')
      .locator('h1')
      .evaluate((node) => getComputedStyle(node).fontSize + '/' + getComputedStyle(node).lineHeight),
  ).toBe('48px/58px');
  expect(Math.round((await box(page.getByTestId('from-field'))).height)).toBe(132);
  expect(Math.round((await box(page.getByTestId('cvt-swap'))).width)).toBe(40);
  // Order inside the card: head, From, swap overlapping both, To, then the button.
  const ys = await page.evaluate(() =>
    ['[data-testid="cvt-card__head"]', '[data-testid=from-field]', '[data-testid=to-field]', '[data-slot=button]'].map(
      (s) => document.querySelector(s).getBoundingClientRect().top,
    ),
  );
  expect([...ys].sort((a, b) => a - b)).toEqual(ys);
  await expect(page.getByTestId('cvt-available')).toHaveText('Available 9,993 USDT');
  await expect(page.getByRole('button', { name: 'Enter an amount' })).toBeDisabled();
  await shot(page, 'convert-1440x900-empty');

  // 10 USDT -> whole ETH lots rounded down (0.0038), the quote asked once (a read), 400 ms after the last keystroke.
  await amount(page).fill('10');
  await expect(page.getByTestId('rate')).toContainText('Rate: 1 ETH ≈ $2,608.05');
  const asked = api.of('quote');
  expect(asked).toHaveLength(1);
  // The typed spend goes to the service as it was typed (quoteQty); the service picks the lots.
  expect(asked[0].input).toEqual({ symbol: 'ETH/USDT', side: 'buy', quoteQty: '10' });
  // The To box shows the SERVICE's out amount, not an estimate.
  await expect(page.getByTestId('to-amount').locator('input')).toHaveValue('0.0038');
  await expect(page.getByTestId('hold')).toHaveText(/^Price held for (14|15)s$/);
  await expect(preview(page)).toBeEnabled();
  await shot(page, 'convert-1440x900-quote');

  // Review (critic M7): the figures are rounded to the asset's decimals, pay UP and get DOWN, and the exact strings
  // from the quote response stay in the title (and in the request).
  await preview(page).click();
  await expect(dialog(page)).toBeVisible();
  const quoted = [...api.world.quotes.values()].at(-1);
  await expect(page.getByTestId('dlg-pay')).toHaveAttribute('title', `${quoted.inAmount} USDT`);
  const pay = await page.getByTestId('dlg-pay').innerText();
  expect(pay).toMatch(/^[\d,]+(\.\d{1,6})? USDT$/); // USDT has 6 decimals, never 10
  const shownPay = Number(pay.replace(/,/g, '').split(' ')[0]);
  expect(shownPay).toBeGreaterThanOrEqual(Number(quoted.inAmount)); // rounded up: never less than leaves the account
  expect(shownPay - Number(quoted.inAmount)).toBeLessThan(0.000001);
  const get = await page.getByTestId('dlg-get').innerText();
  await expect(page.getByTestId('dlg-get')).toHaveAttribute('title', `${quoted.outAmount} ETH`);
  expect(get).toMatch(/^\d+(\.\d{1,4})? ETH$/); // ETH's lot is 4 decimals: never more digits than the asset has
  expect(Number(get.split(' ')[0])).toBeLessThanOrEqual(Number(quoted.outAmount));
  await expect(page.getByTestId('dlg-rate')).toContainText('1 ETH ≈ $2,608.05');
  await expect(page.getByTestId('dlg-hold')).toContainText('Price held for');
  expect(await dialog(page).innerText()).not.toMatch(forbidden);
  await shot(page, 'convert-1440x900-review');

  // Convert now: accepted once, with the quote id and a request id.
  await dialog(page).getByRole('button', { name: 'Convert now' }).click();
  await expect(page.getByTestId('cvt-receipt')).toBeVisible();
  await expect(page.getByTestId('cvt-receipt')).toContainText('Converted');
  await expect(page.getByTestId('cvt-paid')).toHaveText(`${quoted.inAmount} USDT`); // the service's exact digits, as in the review
  await expect(page.getByTestId('cvt-received')).toHaveText('0.0038 ETH');
  const accepted = api.of('accept');
  expect(accepted).toHaveLength(1);
  expect(accepted[0].body.quoteId).toBe(quoted.quoteId);
  expect(accepted[0].body.clientConvertId).toMatch(/^convert:[0-9a-f-]{36}$/);
  expect(await note(page)).toBeNull();
  await expect(page.getByTestId('cvt-receipt').locator('a', { hasText: 'View activity' })).toHaveAttribute(
    'href',
    '/money/activity?tab=all',
  );
  await shot(page, 'convert-1440x900-success');

  await page.getByTestId('cvt-receipt').getByRole('button', { name: 'Done' }).click();
  await expect(page.getByTestId('cvt-available')).toHaveText('Available 9,983.08942641 USDT'); // the whole balance, as Money shows it (critic M5)
  await shot(page, 'convert-1440x900-after-balance');
  expect(errors).toEqual([]);
});

test('Recent conversions lists the conversion just made, not the quotes that were never taken up', async ({ page }) => {
  const api = await mock(page);
  await open(page);
  // Nothing taken up yet: an honest empty table, asked for with a window and a limit (the service refuses without them).
  await expect(page.getByTestId('cvt-recent')).toContainText('No conversions in the last 30 days');
  const asked = api.of('convertList')[0].input;
  expect(asked.limit).toBeGreaterThan(0);
  expect((Date.parse(asked.to) - Date.parse(asked.from)) / 86_400_000).toBe(30);

  await amount(page).fill('10');
  await expect(page.getByTestId('hold')).toHaveText(/^Price held for/);
  await preview(page).click();
  await dialog(page).getByRole('button', { name: 'Convert now' }).click();
  await expect(page.getByTestId('cvt-receipt')).toContainText('Converted');

  await open(page);
  const table = page.getByTestId('cvt-recent').getByRole('table');
  await expect(table.getByRole('row')).toHaveCount(2); // header + the one conversion
  await expect(table).toContainText('USDT');
  await expect(table).toContainText('ETH');
  await expect(table).toContainText('Settled');
  await shot(page, 'convert-1440x900-recent');
});

test('Recent conversions keeps reading pages past quotes that were never taken up', async ({ page }) => {
  const stamp = '2026-10-19T10:00:00.000Z';
  const base = { inAsset: 'USDT', outAsset: 'ETH', inAmount: '10', outAmount: '0.0038', expiresAt: stamp, createdAt: stamp };
  const api = await mock(page, {
    convertList: ({ input }) => ({
      result: {
        data: input.cursor
          ? { rows: [{ ...base, quoteId: 'q-real', lifecycle: 'settled', acceptedAt: stamp, settledAt: stamp }], nextCursor: null }
          : {
              rows: Array.from({ length: 100 }, (_, i) => ({
                ...base,
                quoteId: `q-${i}`,
                lifecycle: 'expired',
                acceptedAt: null,
                settledAt: null,
              })),
              nextCursor: 'page-2',
            },
      },
    }),
  });
  await open(page);
  await expect(page.getByTestId('cvt-recent').getByRole('table')).toContainText('Settled');
  await expect(page.getByTestId('cvt-recent')).not.toContainText('No conversions');
  expect(api.of('convertList').map((call) => call.input.cursor)).toContain('page-2'); // the dev harness may read page 1 twice (strict mode)
});

test('Recent conversions names a refused read and offers Retry on a failed one', async ({ page }) => {
  const api = await mock(page, { convertList: () => trpcRefusal('trade.convert_list_window_too_wide', 'refused', 400) });
  await open(page);
  await expect(page.getByTestId('cvt-recent')).not.toContainText('No conversions');
  api.set('convertList', 'error');
  await open(page);
  await expect(page.getByTestId('cvt-recent').getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(page.getByTestId('cvt-recent')).not.toContainText('No conversions');
});

test('buying with the typed spend: the quote costs at most what was typed', async ({ page }) => {
  const api = await mock(page);
  await open(page);
  await amount(page).fill('10');
  await expect(page.getByTestId('hold')).toHaveText(/^Price held for/);
  expect(api.of('quote').map((call) => call.input)).toEqual([{ symbol: 'ETH/USDT', side: 'buy', quoteQty: '10' }]);
  const quoted = [...api.world.quotes.values()].at(-1);
  expect(Number(quoted.inAmount)).toBeLessThanOrEqual(10);
  expect(Number(quoted.inAmount)).toBeGreaterThan(9.7);
  await preview(page).click();
  await expect(page.getByTestId('dlg-pay')).toHaveAttribute('title', `${quoted.inAmount} USDT`);
  await expect(dialog(page)).not.toContainText(/about/i);
});

test('an older trade service refuses quoteQty: the screen asks again by coin amount and still never costs more than typed', async ({
  page,
}) => {
  const old = await mock(page, { oldServer: true });
  await open(page);
  await amount(page).fill('10');
  await expect(page.getByTestId('hold')).toHaveText(/^Price held for/);
  const calls = old.of('quote').map((call) => call.input);
  expect(calls[0]).toEqual({ symbol: 'ETH/USDT', side: 'buy', quoteQty: '10' });
  expect(calls.slice(1).every((input) => input.qty !== undefined && input.quoteQty === undefined)).toBe(true);
  const oldQuote = [...old.world.quotes.values()].at(-1);
  expect(Number(oldQuote.inAmount)).toBeLessThanOrEqual(10);
});

test('1280x800: card, review and receipt fit without scrolling sideways', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mock(page);
  await open(page);
  await amount(page).fill('25');
  await expect(preview(page)).toBeEnabled();
  await shot(page, 'convert-1280x800-quote');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await preview(page).click();
  await expect(dialog(page)).toBeVisible();
  await shot(page, 'convert-1280x800-review');
  await dialog(page).getByRole('button', { name: 'Convert now' }).click();
  await expect(page.getByTestId('cvt-receipt')).toBeVisible();
  await shot(page, 'convert-1280x800-success');
});

test('selling the coin sends the typed amount as the quantity; swap and the pickers', async ({ page }) => {
  const api = await mock(page);
  await open(page);
  await page.getByTestId('cvt-swap').click();
  await expect(page.getByTestId('headline-pair')).toHaveText('ETH to USDT');
  await expect(page.getByTestId('cvt-available')).toHaveText('Available 2 ETH');
  await amount(page).fill('0.01');
  await expect(page.getByTestId('rate')).toContainText('Rate: 1 ETH ≈ $2,596.');
  expect(api.of('quote').at(-1).input).toEqual({ symbol: 'ETH/USDT', side: 'sell', qty: '0.01' });
  // 0.00015 is not a whole lot (0.0001) of ETH: the box refuses the fifth decimal, so the amount stays as it was.
  await amount(page).fill('0.00015');
  await expect(amount(page)).toHaveValue('0.01');
  // From picker: assets that appear in an open market, with the balance of each.
  await page.getByRole('button', { name: 'Change the From asset' }).click();
  await expect(page.getByTestId('picker__ticker')).toHaveText(['USDT', 'USDC', 'BTC', 'ETH', 'IFC']);
  await expect(page.getByTestId('picker__row').filter({ hasText: 'BTC' })).toContainText('0.25');
  await shot(page, 'convert-1440x900-picker');
  await page.getByTestId('picker__row').filter({ hasText: 'BTC' }).click();
  // BTC can only be swapped for USDT or USDC: ETH is dropped from To.
  await expect(page.getByTestId('headline-pair')).toHaveText('BTC to USDT');
  await page.getByRole('button', { name: 'Change the To asset' }).click();
  await expect(page.getByTestId('picker__ticker')).toHaveText(['USDT', 'USDC']);
});

test('Max puts in the whole available balance', async ({ page }) => {
  const api = await mock(page);
  await open(page);
  await page.getByRole('button', { name: 'Max' }).click();
  await expect(amount(page)).toHaveValue('9993');
  await expect(page.getByTestId('rate')).toBeVisible();
  expect(api.of('quote').at(-1).input.side).toBe('buy');
});

test('too small, and not enough: said before any price is asked for', async ({ page }) => {
  const api = await mock(page);
  await open(page);
  await amount(page).fill('3');
  await expect(page.locator('[data-slot="amount-input"]').first()).toContainText('Minimum is about 5.21 USDT.');
  await shot(page, 'convert-1440x900-minimum');
  await amount(page).fill('20000');
  await expect(page.locator('[data-slot="amount-input"]').first()).toContainText('Not enough USDT. You have 9,993 USDT available.');
  await expect(page.getByRole('button', { name: 'Preview conversion' })).toBeDisabled();
  await shot(page, 'convert-1440x900-insufficient');
  await page.waitForTimeout(900);
  expect(api.of('quote')).toHaveLength(0);
});

test('the price is held for a few seconds and refreshed the moment it expires', async ({ page }) => {
  const api = await mock(page, {
    quote: ({ input }) => {
      const quote = quoteFor(input, { ttlMs: 2500 });
      api.world.quotes.set(quote.quoteId, quote);
      return { result: { data: quote } };
    },
  });
  await open(page);
  await amount(page).fill('10');
  await expect(page.getByTestId('hold')).toHaveText(/^Price held for [12]s$/);
  await expect.poll(() => api.of('quote').length, { timeout: 8000 }).toBeGreaterThanOrEqual(2);
  await expect(page.getByTestId('hold')).toHaveText(/^Price held for [12]s$/);
});

test('a quote that expires while the review is open: the new price must be accepted before anything is sent', async ({ page }) => {
  let n = 0;
  const api = await mock(page, {
    quote: ({ input }) => {
      // Each new quote is a little dearer (spread 20, 40, 60 bps), so the numbers really change.
      n += 1;
      const quote = quoteFor(input, { ttlMs: 3000, spreadBps: 20 * n });
      api.world.quotes.set(quote.quoteId, quote);
      return { result: { data: quote } };
    },
  });
  await open(page);
  await amount(page).fill('10');
  await expect(preview(page)).toBeEnabled();
  await preview(page).click();
  await expect(dialog(page)).toBeVisible();
  const first = [...api.world.quotes.values()].at(-1);
  // The quote is replaced while the customer looks.
  await expect(page.getByTestId('dlg-changed')).toBeVisible({ timeout: 9000 });
  await expect(page.getByTestId('dlg-changed')).toContainText('Price changed');
  await shot(page, 'convert-1440x900-price-changed');
  const accept = dialog(page).getByRole('button', { name: /Accept new price|Convert now/ });
  await expect(accept).toHaveText('Accept new price');
  expect(api.of('accept')).toHaveLength(0);
  await accept.click(); // acknowledges only
  expect(api.of('accept')).toHaveLength(0);
  await expect(dialog(page).getByRole('button', { name: 'Convert now' })).toBeVisible();
  // A click right after the swap is ignored (it must not convert numbers the customer has not seen).
  await dialog(page).getByRole('button', { name: 'Convert now' }).click();
  expect(api.of('accept')).toHaveLength(0);
  await page.waitForTimeout(800);
  await dialog(page).getByRole('button', { name: 'Convert now' }).click();
  await expect(page.getByTestId('cvt-receipt')).toBeVisible();
  expect(api.of('accept')).toHaveLength(1);
  expect(api.of('accept')[0].body.quoteId).not.toBe(first.quoteId);
});

test('refused: not verified shows the way to Verify; instant buys paused shows Use Spot', async ({ page }) => {
  const api = await mock(page, { quote: () => trpcRefusal('tier.insufficient', 'tier insufficient', 403) });
  await open(page);
  await amount(page).fill('10');
  const state = page.locator('[data-slot="state-block"][data-kind="refused"]');
  await expect(state).toContainText('Verify your identity first');
  await expect(state.locator('a', { hasText: 'Verify now' })).toHaveAttribute('href', '/verification');
  expect(await state.innerText()).not.toMatch(/tier|insufficient/i);
  await expect(preview(page)).toBeDisabled();
  await shot(page, 'convert-1440x900-refused-verify');

  api.set('quote', () => trpcRefusal('trade.convert_spread_unset', 'spread unset', 400));
  await amount(page).fill('11');
  await expect(state).toContainText('Instant buy is paused');
  await expect(state.locator('a', { hasText: 'Use Spot' })).toHaveAttribute('href', '/trade/spot/ETH-USDT');
  // The Preview button is replaced by the way forward: no second "Use Spot" button, no Preview.
  await expect(page.getByRole('button', { name: 'Preview conversion' })).toHaveCount(0);
  await shot(page, 'convert-1440x900-refused-spread');
});

test('the book cannot fill that much: plain words, nothing asked of the customer', async ({ page }) => {
  await mock(page, {
    quote: () => ({
      status: 400,
      json: {
        error: { message: 'insufficient book depth to convert 3 ETH, only 1 available', code: -32600, data: { code: 'BAD_REQUEST' } },
      },
    }),
  });
  await open(page);
  await amount(page).fill('9000');
  await expect(page.locator(':is([data-testid="cvt-note"], [data-testid="over-cost"], [data-testid="check-note"])')).toHaveText(
    'That’s more than we can convert in one go right now. Try a smaller amount.',
  );
  expect(
    await page.locator(':is([data-testid="cvt-note"], [data-testid="over-cost"], [data-testid="check-note"])').innerText(),
  ).not.toMatch(/book|depth/i);
});

test('the quote call fails: the card says so and "Get a new price" asks again', async ({ page }) => {
  const api = await mock(page, { quote: 'error' });
  await open(page);
  await amount(page).fill('10');
  const state = page.locator('[data-slot="state-block"][data-kind="error"]');
  await expect(state).toContainText('Couldn’t get a price');
  await shot(page, 'convert-1440x900-quote-error');
  api.set('quote', undefined);
  api.set('quote', ({ input }) => {
    const quote = quoteFor(input);
    api.world.quotes.set(quote.quoteId, quote);
    return { result: { data: quote } };
  });
  await state.getByRole('button', { name: 'Get a new price' }).click();
  await expect(page.getByTestId('rate')).toBeVisible();
});

test('accept refused: the reason is in the dialog and nothing is assumed done', async ({ page }) => {
  const api = await mock(page, { accept: () => trpcRefusal('trade.convert_quote_expired', 'expired', 400) });
  await open(page);
  await amount(page).fill('10');
  await expect(preview(page)).toBeEnabled();
  await preview(page).click();
  await dialog(page).getByRole('button', { name: 'Convert now' }).click();
  await expect(page.getByTestId('dlg-error')).toContainText('That price has expired. Get a fresh price and confirm again.');
  await expect(page.getByTestId('cvt-receipt')).toHaveCount(0);
  expect(await note(page)).toBeNull(); // a typed refusal is a known outcome
  expect(api.of('accept')).toHaveLength(1);
  await shot(page, 'convert-1440x900-accept-refused');
});

test('a double-click on Convert now sends one request', async ({ page }) => {
  const api = await mock(page, {
    accept: async ({ body }) => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      const quote = api.world.quotes.get(body.quoteId);
      return { result: { data: fillFor(quote) } };
    },
  });
  await open(page);
  await amount(page).fill('10');
  await expect(preview(page)).toBeEnabled();
  await preview(page).click();
  await dialog(page).getByRole('button', { name: 'Convert now' }).dblclick();
  await page.waitForTimeout(1200);
  expect(api.of('accept')).toHaveLength(1);
});

test('the service short of ITS inventory is never reported as the customer being short', async ({ page }) => {
  await mock(page, { accept: () => trpcRefusal('ledger.insufficient_funds', 'Insufficient ETH: requested 0.0038, available 0', 400) });
  await open(page);
  await amount(page).fill('10');
  await expect(preview(page)).toBeEnabled();
  await preview(page).click();
  await dialog(page).getByRole('button', { name: 'Convert now' }).click();
  const error = page.getByTestId('dlg-error');
  await expect(error).toContainText("This can't be done right now.");
  expect(await error.innerText()).not.toMatch(/Not enough|Insufficient|9,993/);
  await shot(page, 'convert-1440x900-house-short');
});

test('a dropped connection on accept: sent once, the note stays, "Check again" asks about the SAME quote and cannot convert twice', async ({
  page,
}) => {
  const api = await mock(page, { accept: 'abort' });
  await open(page);
  await amount(page).fill('10');
  await expect(preview(page)).toBeEnabled();
  await preview(page).click();
  await dialog(page).getByRole('button', { name: 'Convert now' }).click();
  const pending = page.getByTestId('pending');
  await expect(pending).toContainText('We couldn’t confirm this conversion');
  await expect(pending).toContainText('Check Activity before trying again.');
  await expect(preview(page)).toBeDisabled();
  await page.waitForTimeout(1500);
  expect(api.of('accept')).toHaveLength(1); // never auto-retried
  const saved = JSON.parse(await note(page));
  expect(saved).toMatchObject({ kind: 'convert', symbol: 'ETH/USDT' });
  await shot(page, 'convert-1440x900-not-confirmed');

  // The conversion did settle on the service; asking again returns the original, once.
  const sent = api.of('accept')[0].body;
  const quote = api.world.quotes.get(sent.quoteId);
  api.set('accept', undefined);
  api.set('accept', () => {
    const fill = {
      quoteId: quote.quoteId,
      fillId: 'f1',
      takerOrderId: 't',
      makerOrderId: 'm',
      symbol: quote.symbol,
      side: quote.side,
      inAsset: quote.inAsset,
      outAsset: quote.outAsset,
      inAmount: quote.inAmount,
      outAmount: quote.outAmount,
      fillPrice: quote.avgPrice,
      fillNotional: quote.userNotional,
      convertSpreadBps: 20,
      source: quote.source,
      expiresAt: quote.expiresAt,
      acceptedAt: new Date().toISOString(),
      settledAt: new Date().toISOString(),
    };
    return { result: { data: fill } };
  });
  await pending.getByRole('button', { name: 'Check again' }).click();
  await expect(page.getByTestId('cvt-receipt')).toBeVisible();
  expect(api.of('accept')).toHaveLength(2);
  expect(api.of('accept')[1].body).toEqual(sent); // same quote id, same request id
  expect(await note(page)).toBeNull();
});

test('Max never quotes more than the balance: the service sizes the order to the spend, so one ask is enough', async ({ page }) => {
  const api = await mock(page);
  await open(page);
  await page.getByRole('button', { name: 'Max' }).click();
  await expect(preview(page)).toBeEnabled();
  expect(api.of('quote').map((call) => call.input)).toEqual([{ symbol: 'ETH/USDT', side: 'buy', quoteQty: '9993' }]);
  await preview(page).click();
  const sent = [...api.world.quotes.values()].at(-1);
  expect(BigInt(sent.inAmount.split('.')[0])).toBeLessThanOrEqual(9993n);
  expect(Number(sent.inAmount)).toBeLessThanOrEqual(9993);
});

test('on an older service, Max still never quotes more than the balance: the spread is on top, so the request is stepped down', async ({
  page,
}) => {
  const api = await mock(page, { oldServer: true });
  await open(page);
  await page.getByRole('button', { name: 'Max' }).click();
  await expect(preview(page)).toBeEnabled();
  const quotes = api.of('quote');
  // 9,993 USDT / 2602.84 = 3.8392 ETH is dearer than 9,993 once the spread is added, so a smaller quantity was asked.
  expect(quotes.length).toBeGreaterThanOrEqual(2);
  await preview(page).click();
  const paid = (await page.getByTestId('dlg-pay').innerText()).replace(/,/g, '');
  expect(BigInt(paid.replace(' USDT', '').split('.')[0]) <= 9993n).toBe(true);
  expect(paid).not.toMatch(/^1\d{4}/);
  const sent = [...api.world.quotes.values()].at(-1);
  expect(BigInt(sent.inAmount.split('.')[0])).toBeLessThanOrEqual(9993n);
  expect(BigInt(sent.inAmount.replace('.', '').padEnd(1, '0')) > 0n).toBe(true);
});

test('after a reload the note still carries the quote id, so "Check again" is there; a refusal is still told', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trade-pending:00000000-0000-4000-8000-000000000001',
      JSON.stringify({ kind: 'convert', symbol: 'ETH/USDT', id: 'convert:old', orderId: 'quote-old', startedAt: 1 }),
    );
  });
  const api = await mock(page, { accept: () => trpcRefusal('trade.convert_quote_expired', 'expired', 400) });
  await open(page);
  const pending = page.getByTestId('pending');
  await expect(pending).toContainText('We couldn’t confirm this conversion');
  await pending.getByRole('button', { name: 'Check again' }).click();
  await expect.poll(() => api.of('accept')[0]?.body).toEqual({ quoteId: 'quote-old', clientConvertId: 'convert:old' });
  // The refusal cleared the note, and the words survive it.
  await expect(page.getByTestId('check-note')).toContainText('That price has expired');
  expect(await note(page)).toBeNull();
});

test('an earlier unresolved request blocks a conversion, even after a reload', async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('seeded')) {
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem(
        'trade-pending:00000000-0000-4000-8000-000000000001',
        JSON.stringify({ kind: 'place', symbol: 'BTC/USDT', id: 'desk:earlier', startedAt: 1 }),
      );
    }
  });
  const api = await mock(page);
  await open(page);
  await amount(page).fill('10');
  await expect(page.getByTestId('pending')).toContainText('An earlier request is still being checked');
  await expect(preview(page)).toBeDisabled();
  await page.waitForTimeout(900);
  expect(api.of('quote')).toHaveLength(0);
  expect(api.of('accept')).toHaveLength(0);
});

test('loading: skeletons of the final size while markets arrive', async ({ page }) => {
  const held = await mock(page, { markets: 'hang' });
  await page.goto('/trade/convert');
  await page.getByTestId('cvt-card--skeleton').waitFor();
  await shot(page, 'convert-1440x900-loading');
  await held.release();
  await expect(page.getByTestId('from-field')).toBeVisible();
});

test('empty: no open market', async ({ page }) => {
  await mock(page, { markets: () => [] });
  await open(page);
  const state = page.locator('[data-slot="state-block"][data-kind="empty"]');
  await expect(state).toContainText('Nothing to convert right now');
  await expect(state.locator('a', { hasText: 'Go to Markets' })).toHaveAttribute('href', '/trade');
  await shot(page, 'convert-1440x900-empty-markets');
});

test('error: markets fail inside the card', async ({ page }) => {
  await mock(page, { markets: 'error' });
  await open(page);
  await expect(page.locator('[data-slot="state-block"][data-kind="error"]')).toContainText('Couldn’t load assets.');
  await shot(page, 'convert-1440x900-error');
});

test('signed out: the button asks to log in', async ({ page }) => {
  await mock(page);
  await open(page, '/trade/convert?asset=ETH&signedout=1');
  await expect(page.locator('a', { hasText: 'Log in to convert' })).toHaveAttribute('href', /^\/login\?redirect=/);
  await shot(page, 'convert-1440x900-signed-out');
});

test('plain words, the questions, and a keyboard path', async ({ page }) => {
  await mock(page);
  await open(page);
  expect(await page.getByTestId('if-convert').innerText()).not.toMatch(forbidden);
  await expect(page.getByTestId('cvt-faq').locator('h2')).toHaveText('Questions');
  await expect(page.locator('[data-slot="accordion-trigger"]')).toHaveText([
    'How is the price set?',
    'Why does the price expire?',
    'Where do I see my conversion?',
  ]);
  await page.locator('[data-slot="accordion-trigger"]').first().click();
  await expect(page.locator('[data-slot="accordion-panel"]').first()).toContainText('The price you review is the price you get.');
  await shot(page, 'convert-1440x900-questions');
  await amount(page).fill('10');
  await expect(preview(page)).toBeEnabled();
  await preview(page).focus();
  await page.keyboard.press('Enter');
  await expect(dialog(page)).toBeVisible();
  expect(await page.evaluate(() => Boolean(document.activeElement.closest('[role="alertdialog"]')))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
});
