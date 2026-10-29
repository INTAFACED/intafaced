import { expect } from '@playwright/test';
import { approverSessions, makeContext, refusalText } from '../../../../tooling/scripts/local-test-gates.mjs';
import { DEVICE_KEY, EDGE, ORIGIN, api, bestPrices } from './stack.mjs';
import { signIn } from './desk.mjs';

// The copy journeys' other actors: the operator who lists a leader (the stack's TEST founder, through svc-trade's own
// operator door, as the founder console would), and the leader's own orders on the real book.

/** The user id behind a TEST account, from its own sign-in. */
export async function userIdOf(who) {
  const res = await fetch(`${EDGE}/api/identity/trpc/auth.login`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceKey: DEVICE_KEY, identifier: who.email, password: who.password }),
  });
  const userId = (await res.json())?.result?.data?.userId;
  if (!userId) throw new Error(`sign-in for ${who.email} refused: ${res.status}`);
  return userId;
}

/** Lists `who` as a copy leader in `marketMode`, as the TEST founder. Returns the public leader ref. */
export async function listLeader(who, displayName, { marketMode = 'spot', tenureStart, assets = ['BTC/USDT'] } = {}) {
  const ctx = await makeContext({ log: () => {} });
  const founders = await approverSessions(ctx);
  const res = await ctx.edge.mutate(
    'trade',
    'copy.ops.upsertListing',
    {
      clientRequestId: `journey-list:${displayName}`,
      leaderUserId: await userIdOf(who),
      displayName,
      marketMode,
      recordKind: 'self_reported',
      state: 'listed',
      assets,
      ...(tenureStart ? { tenureStart } : {}),
    },
    founders.a.token,
  );
  const ref = res.json?.result?.data?.leaderRef;
  if (!ref) throw new Error(`listing ${displayName} refused: ${refusalText(res)}`);
  return ref;
}

/** One IOC order of `who` that takes the best price on the book, so it fills at once against the TEST market maker. */
export async function takeBest(who, side, amount, clientOrderId, symbol = 'BTC/USDT') {
  const { bid, ask } = await bestPrices(symbol);
  const res = await (
    await api(who)
  ).post('/api/v1/orders', {
    symbol,
    type: 'limit',
    side,
    amount,
    price: side === 'buy' ? ask : bid,
    timeInForce: 'IOC',
    clientOrderId,
  });
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBeLessThan(300);
  return res.body;
}

/**
 * A lead's fill that followers copy: `takeBest`, then 15 s for the copy driver's sweep before anyone looks. On the stack
 * (27 Oct) a follower's page loaded within a few seconds of the lead's fill left the copy planned but never placed, and the
 * driver moved past it (#6556); read after the sweep, every copy was there. Copying itself is J-copy-bots-otc-01 #8's to prove.
 */
export async function leadFill(who, side, amount, clientOrderId, symbol = 'BTC/USDT') {
  const body = await takeBest(who, side, amount, clientOrderId, symbol);
  await new Promise((resolve) => setTimeout(resolve, 15_000));
  return body;
}

/** The copied orders once the list has loaded: either a row with a market or the empty state shows first. */
export async function copiedOrdersLoaded(detail) {
  const table = detail.getByRole('table', { name: 'Copied orders' });
  await expect(
    table
      .locator('tbody tr')
      .filter({ hasText: /\w\/\w|No copied orders/ })
      .first(),
  ).toBeVisible();
  return copiedOrders(detail);
}

/** A permission end a week ahead, in the datetime-local box's own format. */
export function weekAhead() {
  const when = new Date(Date.now() + 7 * 24 * 3600_000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}T${pad(when.getHours())}:${pad(when.getMinutes())}`;
}

/**
 * `who` follows the leader `leaderRef` from its lead page, as J-copy-bots-otc-01 does on screen: country DE, BTC/USDT,
 * the given limits, and Start copying (which also turns automatic copying on). Returns the follow id.
 *
 * The follow is made on a page of its own, closed after, so the test's page stays where it was. A lead fill to copy
 * goes through `leadFill`, which waits out the copy driver's sweep (#6556).
 */
export async function followOnScreen(page, who, leaderRef, { perOrder = '50', total = '200', fixed = '20' } = {}) {
  const context = await page.context().browser().newContext({ baseURL: ORIGIN });
  const own = await context.newPage();
  await signIn(own, who);
  await own.goto(`/trade/copy/${leaderRef}`);
  await own.getByRole('button', { name: 'Start copying' }).click();
  const wizard = own.getByRole('dialog');
  await wizard.getByLabel('Your country').fill('DE');
  await wizard.getByRole('button', { name: 'Next' }).click();
  await wizard.getByText('BTC/USDT', { exact: true }).click();
  await wizard.getByRole('button', { name: 'Next' }).click();
  await wizard.getByLabel('Most per order (USDT)').fill(perOrder);
  await wizard.getByLabel('Most in total (USDT)').fill(total);
  await wizard.getByLabel('Fixed amount per copied order (USDT)').fill(fixed);
  await wizard.getByLabel('Permission ends').fill(weekAhead());
  await wizard.getByRole('button', { name: 'Next' }).click();
  const answer = own.waitForResponse((res) => res.url().includes('copy.follow'));
  await wizard.getByRole('button', { name: 'Start copying' }).click();
  const res = await answer;
  expect(res.status(), (await res.text()).slice(0, 300)).toBe(200);
  await expect(own).toHaveURL(/tab=follows/);
  const followId = (await res.json()).result.data.followId;
  await context.close();
  return followId;
}

/** Opens My follows and the follow with the leader `leaderRef`; returns its detail dialog. */
export async function openFollow(page, leaderRef) {
  await page.goto('/trade/copy?tab=follows');
  const row = page.getByRole('grid', { name: 'My follows' }).getByRole('rowgroup').nth(1).getByRole('row').filter({ hasText: leaderRef });
  await row.first().getByRole('button', { name: 'Manage' }).click();
  return page.getByRole('dialog');
}

/** The follow's copied orders as the detail dialog lists them (rows, without the empty row). */
export const copiedOrders = (detail) =>
  detail
    .getByRole('table', { name: 'Copied orders' })
    .locator('tbody tr:not([data-slot="table-empty-row"])')
    // Rows with a market only: while the list loads, its placeholder rows have none.
    .filter({ hasText: /\w\/\w/ });
