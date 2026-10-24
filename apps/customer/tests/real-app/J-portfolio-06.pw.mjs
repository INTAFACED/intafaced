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
  // Locked holds at least the savings; spendable is the rest.
  const locked = allocation.types.find((row) => row.type === 'locked');
  expect(toUnits(locked.valueUsd)).toBeGreaterThanOrEqual(toUnits(SAVED));

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
});

test(`${J} #2 holds a coin with no class: it shows as unclassified, named, and still adds to the total`, async ({ page }) => {
  const who = account();
  const me = await bank(who);
  // On this stack the asset list publishes the dollar coins only, so the BTC bought in step 1 has no class.
  const published = (await me.query('assets.list')).assets.map((a) => a.assetId);
  expect(published, 'BTC is not in the published asset list').not.toContain('BTC');

  const allocation = await me.query('portfolio.allocation');
  const unclassified = allocation.classes.find((row) => row.class === 'unclassified');
  expect(unclassified?.assets.map((a) => a.asset)).toEqual(['BTC']);
  expect(toUnits(unclassified.valueUsd)).toBeGreaterThan(0n);
  // Still counted: the classes add up to the total with it in.
  expect(sum(allocation.classes)).toBe(toUnits(allocation.totalValueUsd));
  expect(allocation.unpriced.map((row) => row.asset)).not.toContain('BTC');

  await signIn(page, who);
  const kind = await grouped(page, 'Kind');
  await expect(kind.locator('li[data-group="unclassified"]')).toContainText('Unclassified');
  await expect(kind.getByRole('row', { name: /^Unclassified/ })).toContainText('BTC');
  await expect(kind.getByText('BTC has no class in our asset list yet. It still counts in your total.')).toBeVisible();
});
