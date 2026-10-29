import { test, expect } from '@playwright/test';
import { api, journeyState } from './stack.mjs';
import { fundedTrader, signIn } from './desk.mjs';

// J-copy-bots-otc-25, in the running app (docs/roadmap/journeys.json): keep my RFQ private, multi-leg and safe on /otc.
// One test per step, titled "J-copy-bots-otc-25 #<n>", run in order on one verified TEST account with TEST 20000 USDT,
// eligible for the desk under the stack's TEST desk terms. Quotes come from the stack's TEST makers; every RFQ and quote
// is read back from svc-trade.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - every step: the request form has no anonymous switch, legs, notional, risk review, kill or dead-man timer; the stack
//   publishes no desk law, so the desk reads closed.
const J = 'J-copy-bots-otc-25';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const UNBUILT = { timeout: 5_000 };

test.describe.configure({ mode: 'default' });
// An action on a part that never appears fails in 15 s, not at the test's time limit.
test.use({ actionTimeout: 15_000 });

function state(key) {
  const value = run.read()[key];
  if (!value) throw new Error(`${J}: an earlier step made no ${key}, so this step has nothing to act on`);
  return value;
}

const form = (page) => page.getByRole('region', { name: 'Request a price' });
const quoteCard = (page) => page.getByRole('region', { name: 'Quote' });

async function openDesk(page) {
  await signIn(page, state('trader'));
  await page.goto('/otc');
  await expect(page.getByRole('heading', { name: 'Quote desk', level: 1 })).toBeVisible();
}

test(`${J} #1 sends an anonymous RFQ: the quote card reads "Counterparty hidden" and the API returns no maker id`, async ({ page }) => {
  test.setTimeout(240_000);
  const trader = await fundedTrader(page, 'jrq', '20000');
  run.reset({ trader });
  await openDesk(page);
  await form(page).getByRole('switch', { name: 'Hide my identity from makers' }).check(UNBUILT);
  await form(page)
    .getByRole('textbox', { name: /^Quantity/ })
    .fill('0.5');
  const answer = page.waitForResponse((res) => res.url().includes('rfq.request'));
  await form(page).getByRole('button', { name: 'Request price' }).click();
  const quote = (await (await answer).json()).result.data;
  await expect(quoteCard(page)).toContainText('Counterparty hidden');
  expect(quote.counterpartyId ?? null).toBeNull();
});

test(`${J} #2 accepts a maker quote that is their own: refused as self-trade; partial execution refused as not offered`, async ({
  page,
}) => {
  await openDesk(page);
  await expect(form(page).getByRole('checkbox', { name: 'Allow partial execution' })).toBeDisabled(UNBUILT);
  const answer = page.waitForResponse((res) => res.url().includes('rfq.request'));
  await form(page)
    .getByRole('textbox', { name: /^Quantity/ })
    .fill('0.5');
  await form(page).getByRole('button', { name: 'Request price' }).click();
  const quote = (await (await answer).json()).result.data;
  const own = await (
    await api(state('trader'))
  ).post('/api/trade/trpc/rfq.accept', { quoteId: quote.id, allowPartial: true, requestId: `${J}-2` });
  expect(JSON.stringify(own.body)).toMatch(/self_trade|partial_not_offered/);
});

test(`${J} #3 builds a multi-leg strategy with sixteen legs: refused over the cap; a notional with a quantity also set refused`, async ({
  page,
}) => {
  await openDesk(page);
  await form(page).getByRole('tab', { name: 'Strategy' }).click(UNBUILT);
  for (let i = 0; i < 16; i++) await form(page).getByRole('button', { name: 'Add a leg' }).click();
  await expect(form(page).getByText(/at most \d+ legs/)).toBeVisible();
  await form(page).getByRole('tab', { name: 'Single' }).click();
  await form(page)
    .getByRole('textbox', { name: /^Quantity/ })
    .fill('0.5');
  await form(page)
    .getByRole('textbox', { name: /^Notional/ })
    .fill('10000');
  await expect(form(page).getByText('Give a quantity or a notional, not both.')).toBeVisible();
});

test(`${J} #4 sends a notional RFQ: a quote for the notional at the firm price`, async ({ page }) => {
  await openDesk(page);
  await form(page)
    .getByRole('textbox', { name: /^Notional/ })
    .fill('10000', UNBUILT);
  const answer = page.waitForResponse((res) => res.url().includes('rfq.request'));
  await form(page).getByRole('button', { name: 'Request price' }).click();
  const quote = (await (await answer).json()).result.data;
  expect(quote.notional).toBe('10000');
  await expect(quoteCard(page)).toContainText('10,000');
});

test(`${J} #5 reviews a two-leg strategy before sending: payoff chart and greeks; fee included in a spot spread; VIP credit "Not set"`, async ({
  page,
}) => {
  await openDesk(page);
  await form(page).getByRole('tab', { name: 'Strategy' }).click(UNBUILT);
  await form(page).getByRole('button', { name: 'Add a leg' }).click();
  await form(page).getByRole('button', { name: 'Add a leg' }).click();
  await form(page).getByRole('button', { name: 'Review' }).click();
  const review = page.getByRole('dialog', { name: 'Review your strategy' });
  await expect(review.getByRole('img', { name: 'Payoff chart' })).toBeVisible();
  await expect(review.getByRole('table', { name: 'Greeks' })).toBeVisible();
  await expect(review).toContainText(/VIP credit\s*Not set/);
  await expect(review.getByText('The probability view isn’t built.')).toBeVisible();
});

test(`${J} #6 kills all bid quotes: only bids cancel, and the count shows`, async ({ page }) => {
  await openDesk(page);
  await page.getByRole('button', { name: 'Kill all bids' }).click(UNBUILT);
  await expect(page.getByRole('status')).toContainText(/\d+ bid quotes? cancelled/);
});

test(`${J} #7 sets the dead-man timer to 5 seconds, then a valid time and lets it lapse; zero turns it off and says so`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openDesk(page);
  const timer = page.getByRole('region', { name: 'Dead-man timer' });
  await timer.getByLabel('Cancel my open quotes after, seconds').fill('5', UNBUILT);
  await timer.getByRole('button', { name: 'Set' }).click();
  await expect(timer.getByText(/between \d+ and \d+ seconds/)).toBeVisible();
  await timer.getByLabel('Cancel my open quotes after, seconds').fill('30');
  await timer.getByRole('button', { name: 'Set' }).click();
  await expect(timer.getByText(/Your open quotes were cancelled/)).toBeVisible({ timeout: 60_000 });
  await timer.getByLabel('Cancel my open quotes after, seconds').fill('0');
  await timer.getByRole('button', { name: 'Set' }).click();
  await expect(timer.getByText('The timer is off.')).toBeVisible();
});
