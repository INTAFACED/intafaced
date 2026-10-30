import { test, expect } from '@playwright/test';
import { DEVICE_KEY, EDGE, ORIGIN, api, bestPrices, fromUnits, journeyState, toUnits } from './stack.mjs';
import { confirm, deskPath, fundedTrader, held, reviewLimit, signIn } from './desk.mjs';

// J-portfolio-06, in the running app (docs/roadmap/journeys.json): "I see my allocation, pick a display currency and
// choose which account to view". One test per step, titled "J-portfolio-06 #<n>", run in order on one TEST account.
// Step 1 builds the starting state through the real product: TEST 1000 USDT, a buy of 0.002 BTC on the desk, TEST 50 USDT
// in the stack's seeded instant-access savings (an earn position) and TEST 100 USDT moved into a named space. Every
// grouping is checked against the bank's own answer and against the ledger balances: the groups add up to the total
// exactly, the earn group is the saved USDT at par, and the screen names what each group holds.
const J = 'J-portfolio-06';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const SPACE = 'Travel TEST';
const SAVED = '50';
const MOVED = '100';
// A second named space that never holds anything: #5's account picker leaves it out.
const EMPTY_SPACE = 'Empty TEST';

test.describe.configure({ mode: 'default' });

function account() {
  const { who } = run.read();
  if (!who) throw new Error(`${J} #1 set up no account, so this step has no one to act as`);
  return who;
}

/** The person's own bank API through Edge. */
async function bank(who) {
  const login = await fetch(`${EDGE}/api/identity/trpc/auth.login`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceKey: DEVICE_KEY, identifier: who.email, password: who.password }),
  }).then((r) => r.json());
  const token = login?.result?.data?.accessToken;
  if (!token) throw new Error(`sign-in for ${who.email} refused`);
  return {
    /** The raw answer, refusals included. */
    raw: (procedure, input) =>
      fetch(`${EDGE}/api/bank/trpc/${procedure}${input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`}`, {
        headers: { origin: ORIGIN, authorization: `Bearer ${token}` },
      }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) })),
    query: async (procedure, input) => {
      const res = await fetch(
        `${EDGE}/api/bank/trpc/${procedure}${input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`}`,
        { headers: { origin: ORIGIN, authorization: `Bearer ${token}` } },
      );
      const body = await res.json();
      if (!res.ok) throw new Error(`${procedure} refused: ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
      return body.result.data;
    },
  };
}

const sum = (rows) => rows.reduce((total, row) => total + toUnits(row.valueUsd), 0n);

/** The allocation card switched to one grouping. */
async function grouped(page, by) {
  await page.goto('/money');
  const card = page.getByRole('region', { name: 'Where your money is' });
  await card.getByRole('group', { name: 'Group by' }).getByRole('button', { name: by, exact: true }).click();
  await expect(card.getByRole('button', { name: by, exact: true })).toHaveAttribute('aria-pressed', 'true');
  return card;
}

test(`${J} #1 opens allocation: by coin, kind and place; USDT as dollar coins, the savings under earn, spendable and locked; each grouping adds up to the total`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const who = await fundedTrader(page, 'pf06', '1000');
  run.reset({ who });
  await signIn(page, who);

  // A TEST buy of 0.002 BTC across the spread: it takes the maker's quotes and fills at once.
  await page.goto(deskPath('BTC/USDT'));
  const { ask } = await bestPrices('BTC/USDT');
  const priceUp = fromUnits(((toUnits(ask) * 101n) / 100n / 10n ** 16n) * 10n ** 16n);
  await reviewLimit(page, 'buy', priceUp, '0.002');
  await confirm(page, 'buy');
  await expect.poll(async () => held(await (await api(who)).balances(), 'USDT'), { timeout: 20_000 }).toBe(0n);

  // TEST 50 USDT into the stack's instant-access savings: an earn position, held in a stake account.
  const me = await bank(who);
  const pools = await me.query('earn.pools', { limit: 50 });
  const pool = pools.find((row) => row.assetId === 'USDT' && row.kind === 'flexible');
  expect(pool, 'the stack seeds a TEST instant-access USDT pool').toBeTruthy();
  await page.goto('/bank/spaces');
  const savings = page.getByTestId('instant-savings').locator(`[data-testid="instant-savings-pool"][data-pool="${pool.id}"]`);
  await savings.getByRole('button', { name: 'Open instant-access savings', exact: true }).click();
  const open = page.getByRole('dialog');
  await open.getByLabel('Amount (USDT)').fill(SAVED);
  await open.getByRole('button', { name: 'Review' }).click();
  await open.getByRole('button', { name: 'Open instant-access savings' }).click();
  await expect
    .poll(async () => (await me.query('earn.positions', { limit: 50 })).filter((p) => p.poolId === pool.id).map((p) => p.principal))
    .toEqual([SAVED]);
  await page.keyboard.press('Escape');

  // A named space holding TEST 100 USDT, moved from the main account.
  await page.goto('/bank/spaces');
  await page.getByRole('button', { name: 'Create space' }).click();
  const create = page.getByRole('dialog');
  await create.getByLabel('Asset', { exact: true }).selectOption('USDT');
  await create.getByLabel('Space name').fill(SPACE);
  await create.getByRole('button', { name: 'Review' }).click();
  await create.getByRole('button', { name: 'Confirm' }).click();
  await expect(create.getByText('Confirmed by the service')).toBeVisible();
  const spaces = await me.query('spaces.list', { limit: 50 });
  const main = spaces.find((s) => s.kind === 'primary' && s.assetId === 'USDT');
  const travel = spaces.find((s) => s.kind === 'named' && s.name === SPACE);
  expect(travel).toBeTruthy();
  await page.goto('/bank/transfers');
  await page.getByLabel('From your space').selectOption(main.id);
  await page.getByRole('button', { name: 'Continue' }).click();
  const move = page.getByRole('dialog');
  await move.getByLabel('To which of your accounts').selectOption(travel.id);
  await move.getByLabel(/Amount/).fill(MOVED);
  await move.getByRole('button', { name: 'Review' }).click();
  await move.getByRole('button', { name: 'Confirm' }).click();
  await expect(move.getByText(/ledger/i).first()).toBeVisible();
  expect(toUnits((await me.query('spaces.list', { limit: 50 })).find((s) => s.id === travel.id).balance)).toBe(toUnits(MOVED));
  // And a named space left empty, for #5.
  await page.goto('/bank/spaces');
  await page.getByRole('button', { name: 'Create space' }).click();
  const second = page.getByRole('dialog');
  await second.getByLabel('Asset', { exact: true }).selectOption('USDT');
  await second.getByLabel('Space name').fill(EMPTY_SPACE);
  await second.getByRole('button', { name: 'Review' }).click();
  await second.getByRole('button', { name: 'Confirm' }).click();
  await expect(second.getByText('Confirmed by the service')).toBeVisible();
  await page.keyboard.press('Escape');
  run.write({ spaceId: travel.id, poolId: pool.id });

  // The bank's grouping: every class and both places add up to the total, exactly.
  const allocation = await me.query('portfolio.allocation');
  const total = toUnits(allocation.totalValueUsd);
  expect(total).toBeGreaterThan(0n);
  expect(sum(allocation.classes)).toBe(total);
  expect(sum(allocation.types)).toBe(total);
  for (const row of allocation.classes) expect(row.assets.reduce((t, a) => t + toUnits(a.valueUsd), 0n)).toBe(toUnits(row.valueUsd));
  const byClass = Object.fromEntries(allocation.classes.map((row) => [row.class, row]));
  // The saved USDT is earn at par, and only it; the rest of the USDT (main and the space) is dollar coins.
  expect(byClass.earn.assets).toEqual([{ asset: 'USDT', valueUsd: SAVED, share: byClass.earn.assets[0].share }]);
  const usdt = await (await api(who)).balances();
  const usdtTotal = toUnits(usdt.USDT.total) + toUnits(MOVED);
  expect(toUnits(byClass.stablecoin.assets.find((a) => a.asset === 'USDT').valueUsd)).toBe(usdtTotal - toUnits(SAVED));
  // Locked is exactly the savings: the ledger holds them as USDT in use (no order is open and no BTC is held), at par.
  // Spendable is the rest, so the two add up to the total.
  const locked = allocation.types.find((row) => row.type === 'locked');
  const spendable = allocation.types.find((row) => row.type === 'available');
  expect(toUnits(usdt.BTC?.used ?? '0')).toBe(0n);
  expect(toUnits(usdt.USDT.used ?? '0')).toBe(toUnits(SAVED));
  expect(toUnits(locked.valueUsd)).toBe(toUnits(SAVED));
  expect(toUnits(spendable.valueUsd)).toBe(total - toUnits(locked.valueUsd));

  // The screen: by coin, by kind (naming what each kind holds), by place.
  const coin = await grouped(page, 'Coin');
  await expect(coin.locator('li', { hasText: 'USDT' })).toHaveCount(1);
  await expect(coin.locator('li', { hasText: 'BTC' })).toHaveCount(1);
  const kind = await grouped(page, 'Kind');
  await expect(kind.locator('li[data-group="stablecoin"]')).toContainText('Dollar coins');
  await expect(kind.locator('li[data-group="earn"]')).toContainText('Earn');
  await expect(kind.getByRole('row', { name: /^Earn/ })).toContainText('USDT');
  await expect(kind.getByRole('row', { name: /^Dollar coins/ })).toContainText('USDT');
  const place = await grouped(page, 'Place');
  await expect(place.locator('li[data-group="available"]')).toContainText('Spendable');
  await expect(place.locator('li[data-group="locked"]')).toContainText('Locked');
  // Each place's percent on screen is the bank's share of the total, as shown (to its last printed place).
  for (const row of [spendable, locked]) {
    const shown = await place.locator(`li[data-group="${row.type}"] .money-alloc__pct`).innerText();
    const digits = shown.replace(/[^\d.]/g, '');
    const places = (digits.split('.')[1] ?? '').length;
    expect(Math.abs(Number(digits) - Number(row.share) * 100), `${row.type} ${shown} vs ${row.share}`).toBeLessThanOrEqual(
      0.5 * 10 ** -places,
    );
  }
});

test(`${J} #2 holds a coin with no class: it shows as unclassified, named, and still adds to the total`, async ({ page }) => {
  const who = account();
  const me = await bank(who);
  // A coin has no class when the bank's asset list does not publish it. Which of the coins held that is depends on what
  // the stack publishes (today the dollar coins only), so the expected set is worked out from the list itself.
  const published = new Set((await me.query('assets.list')).assets.map((a) => a.assetId));
  const allocation = await me.query('portfolio.allocation');
  expect(allocation.classesRefused).toBeNull();
  const held = allocation.classes.flatMap((row) => row.assets.map((a) => a.asset));
  const noClass = [...new Set(held)].filter((asset) => !published.has(asset) && !['USDT', 'USDC', 'USD'].includes(asset)).sort();
  expect(noClass.length, 'step 2 needs a held coin the asset list does not publish').toBeGreaterThan(0);

  const unclassified = allocation.classes.find((row) => row.class === 'unclassified');
  expect(unclassified?.assets.map((a) => a.asset).sort()).toEqual(noClass);
  expect(toUnits(unclassified.valueUsd)).toBeGreaterThan(0n);
  // Still counted: the classes add up to the total with it in.
  expect(sum(allocation.classes)).toBe(toUnits(allocation.totalValueUsd));

  await signIn(page, who);
  const kind = await grouped(page, 'Kind');
  await expect(kind.locator('li[data-group="unclassified"]')).toContainText('Unclassified');
  for (const asset of noClass) await expect(kind.getByRole('row', { name: /^Unclassified/ })).toContainText(asset);
  const names = unclassified.assets.map((a) => a.asset).join(', ');
  await expect(
    kind.getByText(
      noClass.length === 1
        ? `${names} has no class in our asset list yet. It still counts in your total.`
        : `${names} have no class in our asset list yet. They still count in your total.`,
    ),
  ).toBeVisible();
});

test(`${J} #3 reads holdings change over a period: each coin then and now, what rose and fell, valued at both ends`, async ({ page }) => {
  const who = account();
  const me = await bank(who);
  // What is held now across the main account and the space, from the ledger: the end of any range that runs to now.
  const main = await (await api(who)).balances();
  const now = { BTC: toUnits(main.BTC?.total ?? '0'), USDT: toUnits(main.USDT.total) + toUnits(MOVED) };

  await signIn(page, who);
  await page.goto('/money');
  const card = page.getByRole('region', { name: 'What you hold, then and now' });
  await card.getByRole('group', { name: 'Compare with' }).getByRole('button', { name: '7 days ago', exact: true }).click();
  await expect(card.getByRole('button', { name: '7 days ago', exact: true })).toHaveAttribute('aria-pressed', 'true');
  for (const asset of ['BTC', 'USDT']) {
    const row = card.locator(`tr[data-change-asset="${asset}"]`);
    // The account did not exist 7 days ago: nothing held then, so everything held now is what rose.
    await expect(row).toHaveAttribute('data-start', '0');
    expect(toUnits(await row.getAttribute('data-end'))).toBe(now[asset]);
    expect(toUnits(await row.getAttribute('data-change'))).toBe(now[asset]);
    await expect(row.locator('td').nth(0)).toHaveText('No holding yet');
    await expect(row.locator('td').nth(2)).toHaveText(new RegExp(`^\\+[\\d,.]+ ${asset}$`));
  }

  // The bank's own answer for the same range adds up row by row, and values each end at its price there.
  const answer = await me.query('portfolio.holdingsChange', { from: new Date(Date.now() - 7 * 86_400_000).toISOString() });
  for (const row of answer.rows) {
    expect(toUnits(row.endAmount) - toUnits(row.startAmount)).toBe(toUnits(row.change));
    if (row.endPriceUsd === null) continue;
    // amount x price, rounded once at 18 places.
    const exact = toUnits(row.endAmount) * toUnits(row.endPriceUsd);
    const diff = toUnits(row.endValueUsd) * 10n ** 18n - exact;
    expect(diff >= -(10n ** 18n) && diff <= 10n ** 18n).toBe(true);
  }
  expect(answer.rows.find((r) => r.assetId === 'USDT')).toMatchObject({ endPriceUsd: '1', endValueUsd: fromUnits(now.USDT) });
});

/** Picks the display currency on the View settings page, as the person would. */
async function displayIn(page, code) {
  await page.goto('/view');
  await page.getByLabel('Display currency').selectOption(code);
  await expect(page.getByLabel('Display currency')).toHaveValue(code);
}

/** The bank's summary each time the Money screen reads it, newest last. */
function watchSummaries(page) {
  const seen = [];
  page.on('response', async (res) => {
    if (!res.url().includes('/api/bank/trpc/portfolio.summary') || res.status() !== 200) return;
    const body = await res.json().catch(() => null);
    const input = new URL(res.url()).searchParams.get('input');
    if (body?.result?.data) seen.push({ input: input ? JSON.parse(input) : {}, data: body.result.data });
  });
  return seen;
}

/** Whole satoshis as "₿0.00000000". */
const sat8 = (sats) => `₿${sats / 10n ** 8n}.${(sats % 10n ** 8n).toString().padStart(8, '0')}`;

/** A USD value in BTC at the bank's BTC price: one half-up rounding to 8 places (the bank's own rule). */
function btcOf(usd, price) {
  const p = toUnits(price);
  return sat8((toUnits(usd) * 10n ** 8n * 2n + p) / (p * 2n));
}

test(`${J} #4 sets the display currency to BTC: every value is the USD value over the BTC price, in BTC; a currency with no rate is refused by name and keeps USD`, async ({
  page,
}) => {
  const who = account();
  await signIn(page, who);
  await displayIn(page, 'BTC');
  const seen = watchSummaries(page);
  await page.goto('/money');
  await expect(page.getByTestId('if-money')).toHaveAttribute('data-unit', 'BTC');

  // What the screen shows, against the bank's own answer it was drawn from (the newest BTC summary it read).
  await expect
    .poll(
      async () => {
        const answer = [...seen].reverse().find((s) => s.input.displayCurrency === 'BTC')?.data;
        if (!answer?.btc?.total || !answer.btc.priceUsd) return 'no BTC summary read yet';
        const shown = await page.getByTestId('if-money').evaluate((root) => ({
          total: root.querySelector('[data-testid="money-total"] [role="img"]')?.getAttribute('aria-label') ?? null,
          cash: root.querySelector('#cash [data-testid="money-card__total"]')?.textContent?.trim() ?? null,
          crypto: root.querySelector('#crypto [data-testid="money-card__total"]')?.textContent?.trim() ?? null,
          rows: Object.fromEntries(
            [...root.querySelectorAll('tr[data-testid="money-row"]')].map((tr) => [
              tr.getAttribute('data-asset'),
              tr.querySelector('[data-col="value"]')?.textContent?.trim() ?? null,
            ]),
          ),
        }));
        const price = answer.btc.priceUsd;
        const want = {
          total: sat8(toUnits(answer.btc.total) / 10n ** 10n),
          cash: btcOf(answer.cashUsd, price),
          crypto: btcOf(answer.cryptoUsd, price),
          rows: Object.fromEntries(answer.priced.map((row) => [row.asset, btcOf(row.valueUsd, price)])),
        };
        return JSON.stringify(shown) === JSON.stringify(want) ? 'match' : JSON.stringify({ shown, want });
      },
      { timeout: 45_000 },
    )
    .toBe('match');

  // EUR has no rate: the bank refuses it by name, the screen says so and every value stays in USD.
  await displayIn(page, 'EUR');
  await page.goto('/money');
  const note = page.locator('[data-refusal="bank.fx_rate_unset"]');
  await expect(note).toHaveText(/No exchange rate is set for EUR, so your values are shown in USD\./);
  await expect(page.getByTestId('if-money')).toHaveAttribute('data-unit', 'USD');
  await expect(page.locator('#cash [data-testid="money-card__total"]')).toHaveText(/^\$/);
  const refusal = await (await bank(who)).raw('portfolio.summary', { displayCurrency: 'EUR' });
  expect(refusal.status).toBe(412);
  expect(JSON.stringify(refusal.body)).toContain('bank.fx_rate_unset');

  await displayIn(page, 'USD');
});

test(`${J} #5 chooses one account or all combined: the totals follow, and named accounts are listed only when one holds something`, async ({
  page,
}) => {
  const who = account();
  const { spaceId } = run.read();
  const me = await bank(who);
  // The bank's totals for main, the space and all combined add up, read until one price book serves all three.
  await expect
    .poll(
      async () => {
        const [all, main, space] = await Promise.all([
          me.query('portfolio.summary'),
          me.query('portfolio.summary', { scope: 'main' }),
          me.query('portfolio.summary', { scope: spaceId }),
        ]);
        return toUnits(main.totalUsd) + toUnits(space.totalUsd) === toUnits(all.totalUsd) && fromUnits(toUnits(space.totalUsd));
      },
      { timeout: 30_000 },
    )
    .toBe(MOVED);

  await signIn(page, who);
  await page.goto('/money');
  // All accounts: the named account that holds something is listed; the empty one is not, though the bank has it.
  const named = (await me.query('spaces.list', { limit: 50 })).filter((s) => s.kind === 'named');
  expect(named.find((s) => s.name === EMPTY_SPACE)?.balance).toMatch(/^0(\.0+)?$/);
  await expect(page.locator('#accounts').getByText(SPACE)).toBeVisible();
  await expect(page.locator('#accounts').getByText(EMPTY_SPACE)).toHaveCount(0);
  // It can still be chosen on its own: the picker offers every named account.
  await expect(page.getByLabel('Accounts shown').locator('option', { hasText: EMPTY_SPACE })).toHaveCount(1);
  const scope = page.getByLabel('Accounts shown');
  await scope.selectOption(spaceId);
  await expect(page.getByTestId('money-total').locator('[role="img"]')).toHaveAttribute('aria-label', '$100.00');
  await expect(page.locator('tr[data-testid="money-row"][data-asset="BTC"]')).toHaveCount(0);
  await scope.selectOption('main');
  await expect(page.locator('tr[data-testid="money-row"][data-asset="BTC"]')).toHaveCount(1);
  await scope.selectOption('combined');
  await expect(page.locator('tr[data-testid="money-row"][data-asset="USDT"]')).toHaveCount(1);
});

test(`${J} #6 reads cash by currency and presses Convert: each currency's balance, and Convert opens the convert page with that currency`, async ({
  page,
}) => {
  const who = account();
  const me = await bank(who);
  const summary = await me.query('portfolio.summary');
  const cash = summary.priced.filter((row) => ['USDT', 'USDC', 'USD'].includes(row.asset));
  expect(cash.map((row) => row.asset)).toContain('USDT');

  await signIn(page, who);
  await page.goto('/money');
  const card = page.locator('#cash');
  // Each currency's balance as shown: the bank's amount, rounded down to the places on screen.
  for (const row of cash) {
    const text = await card
      .locator(`tr[data-testid="money-row"][data-asset="${row.asset}"] [data-testid="money-num__entries"]`)
      .innerText();
    const shown = new RegExp(`([\\d,]+(?:\\.\\d+)?) ${row.asset}`).exec(text);
    expect(shown, `${row.asset} amount on screen: ${text}`).toBeTruthy();
    const places = shown[1].split('.')[1]?.length ?? 0;
    const step = 10n ** BigInt(18 - places);
    expect(toUnits(shown[1].replaceAll(',', ''))).toBe((toUnits(row.amount) / step) * step);
  }
  await card.locator('tr[data-testid="money-row"][data-asset="USDT"]').getByRole('button', { name: 'Convert USDT' }).click();
  await expect(page).toHaveURL(/\/trade\/convert\?from=USDT/);
  await expect(page.getByTestId('from-field').getByRole('button', { name: 'Change the From asset' })).toContainText('USDT');
});
