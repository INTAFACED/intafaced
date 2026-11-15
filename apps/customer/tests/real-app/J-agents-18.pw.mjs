// World: restart
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { UNBUILT, agentCard, agentsRun, createOwnAgent, openAgents, openOwnAgent, tableIn } from './agents.mjs';
import { free, held, signIn } from './desk.mjs';
import { api, fromUnits, toUnits } from './stack.mjs';
import { installTestWallet, testWalletKey } from './test-wallet.mjs';
import { continueInWallet, testDeposit, testVenue, venueAccount, venueForThisFile, venueInfo, venueRecord } from './venue.mjs';

// J-agents-18, in the running app (docs/roadmap/journeys.json): let the Portfolio and Copy-Intel agents propose, and
// approve what I choose. One test per step, titled "J-agents-18 #<n>", run in order on one verified TEST account, a TEST
// wallet whose own venue account on the stack's TEST venue simulator holds TEST USDC and TEST BTC in a sub-account, and
// an agent of the person's own with access to that sub-account and an allowance of TEST 50 USDC whose agent permission
// the wallet signed (J-agents-08's Access and Allowance pages). Every figure the TEST venue reports is TEST.
// #1 #2 are built: the Portfolio planner on the agent's Portfolio page (svc-trade src/venue/own-agent-rebalance.ts)
// reads what the venue reports the sub-account holds and proposes market orders to the person's targets, sending
// nothing; an approved proposal's orders are placed on the person's own sub-account by the agent permission, within the
// allowance, each once; a rejected one changes nothing. INTAFACED holds and moves nothing, and no profit share is paid.
// Every check of what was sent or held reads the TEST venue's own record of the person's sub-account.
// #4 is built: a person's own session opens Copy intelligence, and a request for a returns ranking is refused before
// anything is priced, held or run.
// #3 is not built yet and fails at its first missing part, quickly (UNBUILT): leader cards have no Copy-Intel stats or
// audited badge (RC-agents-07).
// #5 is red by name (BLOCKED below; D's ruling 2026-10-31 by product law): the Launch and Growth agents keep no run
// history or drafts (services/svc-agents/README.md, "v2 agents"), so the step first asserts what the app does today,
// then fails with its name.
const J = 'J-agents-18';
const agents = agentsRun(J);

test.describe.configure({ mode: 'default' });
venueForThisFile(test);

const main = (page) => page.getByRole('main');
const planner = (page) => main(page).getByRole('region', { name: 'Portfolio planner', exact: true });
const proposals = (page) => planner(page).getByRole('region', { name: 'Rebalance proposals', exact: true }).getByRole('article');
/** One proposal's article, pinned by its id: a newer proposal listed above it never moves the locator. */
const proposal = (page, id) => planner(page).locator(`article[data-proposal-id="${id}"]`);

/** The account's USDT as the ledger holds it, free and held, in scaled units. */
async function usdt() {
  const balances = await (await api(agents.account())).balances();
  return { free: free(balances, 'USDT'), held: held(balances, 'USDT') };
}

/** This run's TEST wallet: the person's own, kept in the run's state from the start. */
function wallet() {
  const { walletKey } = agents.run.read();
  if (!walletKey) throw new Error(`${J} starts made no wallet, so this step has no one to sign as`);
  return privateKeyToAccount(walletKey);
}
const owner = () => wallet().address.toLowerCase();

/** The person's wallet signs one action on its own venue account (or one of its sub-accounts), on the TEST venue directly. */
async function ownVenueAction(intent, subAccount = null) {
  const account = { ...(await venueAccount(owner())), subAccount };
  const prepared = await testVenue('/prepare', { account, signer: { role: 'owner', address: owner() }, intent });
  expect(prepared.status, JSON.stringify(prepared.body)).toBe(200);
  const t = prepared.body.typedData;
  const signature = await wallet().signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
  const sent = await testVenue('/submit', {
    prepared: prepared.body,
    signature: { digest: prepared.body.digest, signature, signedBy: owner() },
  });
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  expect(sent.body.accepted, JSON.stringify(sent.body)).toBe(true);
  return sent.body;
}

/** The venue's own id of the wallet's sub-account A. */
async function subA() {
  const { value } = await venueRecord(owner(), '/sub-accounts');
  const a = value.find((s) => s.name === 'Sub-account A');
  expect(a, 'the venue lists no Sub-account A for this wallet').toBeTruthy();
  return a.subAccount;
}

/** The TEST venue's own record of sub-account A. */
const onA = async (path, extra = {}) => (await venueRecord(owner(), path, extra, undefined, await subA())).value;

/** What the venue holds and has traded on sub-account A and the main account: what "nothing executed" must leave as it was. */
async function sent() {
  const since = '2020-01-01T00:00:00.000Z';
  const [balances, fills, open, mainFills, mainOpen] = await Promise.all([
    onA('/balances'),
    onA('/fills', { since }),
    onA('/open-orders'),
    venueRecord(owner(), '/fills', { since }).then((r) => r.value),
    venueRecord(owner(), '/open-orders').then((r) => r.value),
  ]);
  return { balances, fills, open, mainFills, mainOpen };
}

/** svc-trade's record for the person's own agent (allowances, orders, rebalances), as the person reads it. */
async function trading(what) {
  const { agentId } = agents.run.read();
  const { status, body } = await (await api(agents.account())).get(`/api/v1/venue/own-agents/${agentId}/${what}`);
  expect(status, JSON.stringify(body).slice(0, 400)).toBe(200);
  return body[what];
}

/** Opens the agent's Portfolio page, with this run's TEST wallet in the browser. */
async function openPortfolio(page) {
  const { chainId } = await venueInfo();
  await installTestWallet(page, { chainId, privateKey: agents.run.read().walletKey });
  await openOwnAgent(page, agents, 'Portfolio');
  await expect(planner(page)).toBeVisible();
}

/** Asks the planner for a rebalance to `targets` and returns the proposal's article, newest first. */
async function ask(page, targets) {
  const form = planner(page).getByRole('form', { name: 'Ask for a rebalance' });
  const count = await proposals(page).count();
  await form.getByRole('textbox', { name: /^Targets/ }).fill(targets);
  await form.getByRole('button', { name: 'Propose a rebalance' }).click();
  await expect(proposals(page)).toHaveCount(count + 1);
  const id = await proposals(page).first().getAttribute('data-proposal-id');
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  return proposal(page, id);
}

/** A proposal's orders as the page lists them: side, market, size, worst price and what each commits. */
async function ordersShown(article) {
  const rows = tableIn(article, 'Proposed orders').getByRole('row');
  const out = [];
  for (let i = 1; i < (await rows.count()); i += 1) {
    const cells = await rows.nth(i).getByRole('cell').allInnerTexts();
    out.push(cells.map((c) => c.trim()));
  }
  return out;
}

/** The order sizes a target of `percent`% BTC gives, from the holdings and mids the proposal names, in whole lots of 0.0001. */
function expectedLeg(proposal, percent) {
  const btc = proposal.holdings.find((h) => h.asset === 'BTC');
  const want = (toUnits(proposal.totalValue) * toUnits(percent)) / toUnits('100');
  const delta = want - toUnits(btc.value);
  const lot = toUnits('0.0001');
  const raw = ((delta < 0n ? -delta : delta) * 10n ** 18n) / toUnits(btc.price);
  const capped = delta < 0n && raw > toUnits(btc.total) ? toUnits(btc.total) : raw;
  return { side: delta < 0n ? 'sell' : 'buy', size: fromUnits((capped / lot) * lot) };
}

/** The step that stays red by name, and why. Every failure inside it carries the name (`blockedBy`). */
const V2 = 'services/svc-agents/README.md: v2 agents are "Doctrine names only — no factory until product law"';
const BLOCKED = {
  5: `${J} #5 BLOCKED (${V2}; RC-agents-04): the Launch check and Growth drafts agents keep no run history or drafts`,
};

/**
 * A step that is red by name: `check` asserts what the app does today, and any assertion it fails carries the name;
 * when it passes, the step still fails with the name.
 */
async function blockedBy(name, check) {
  try {
    await check();
  } catch (error) {
    if (error instanceof Error) error.message = `${name}\n(a check before the block failed) ${error.message}`;
    throw error;
  }
  throw new Error(name);
}

test(`${J} starts: a verified TEST account, a TEST wallet with TEST USDC and BTC in its venue sub-account, an agent of its own with an allowance, and the leader directory`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const who = await agents.start(page, 'ag18', '100');
  agents.run.write({ ...agents.run.read(), walletKey: testWalletKey() });
  // The wallet's own venue account: TEST USDC and TEST BTC, moved into Sub-account A, and our builder fee approved there
  // once, as a person who has sold on the venue has. Signed by the wallet on the TEST venue directly: a customer cannot
  // open plain sub-accounts in the app yet, so this is the journey's starting state, not a step.
  expect(await testDeposit(owner(), 'USDC', '100', `j-agents-18:${who.handle}:usdc`)).toBe(true);
  expect(await testDeposit(owner(), 'BTC', '0.001', `j-agents-18:${who.handle}:btc`)).toBe(true);
  await ownVenueAction({ kind: 'create_sub_account', name: 'Sub-account A', subAccountKey: `j-agents-18:${who.handle}:sub:a` });
  const a = await subA();
  for (const [asset, amount] of [
    ['USDC', '100'],
    ['BTC', '0.001'],
  ])
    await ownVenueAction({
      kind: 'sub_account_transfer',
      subAccount: a,
      direction: 'into_sub_account',
      asset,
      amount,
      moveKey: `j-agents-18:${who.handle}:fund-a:${asset}`,
    });
  const status = await (await api(who)).get('/api/v1/venue/status');
  expect(status.status, JSON.stringify(status.body).slice(0, 300)).toBe(200);
  await ownVenueAction({ kind: 'approve_builder_fee', builder: status.body.builder.address, maxFeeBps: status.body.builder.feeBps }, a);
  expect(Object.fromEntries((await onA('/balances')).map((b) => [b.asset, b.total]))).toMatchObject({ USDC: '100', BTC: '0.001' });
  // An agent of the person's own, with access to Sub-account A for a week and an allowance of TEST 50 USDC for a week,
  // whose agent permission the wallet signs (J-agents-08 #2 #4).
  await signIn(page, who);
  await createOwnAgent(page);
  const { chainId } = await venueInfo();
  await installTestWallet(page, { chainId, privateKey: agents.run.read().walletKey });
  await openOwnAgent(page, agents, 'Access');
  const agentId = new URL(page.url()).pathname.split('/').pop();
  expect(agentId).toMatch(/^[0-9a-f-]{36}$/);
  agents.run.write({ ...agents.run.read(), agentId });
  const section = main(page).getByRole('region', { name: 'Account access', exact: true });
  await section.getByRole('button', { name: 'Connect TEST Wallet' }).click();
  await expect(section.getByTestId('venue-wallet-address')).toHaveText(owner());
  const grant = section.getByRole('form', { name: 'Account access' });
  await grant.getByRole('checkbox', { name: 'Sub-account A', exact: true }).check();
  await grant.getByRole('textbox', { name: /^Ends/ }).fill('7');
  await grant.getByRole('button', { name: 'Grant access' }).click();
  await expect(tableIn(section, 'Granted access')).toContainText('Sub-account A');
  // The Allowance page opened afresh by a full load, as J-agents-08's own steps open it; the TEST wallet installed
  // above stays in this page across loads.
  await openOwnAgent(page, agents, 'Allowance');
  // The wallet the Access page connected is restored on the load (the provider asks eth_accounts again), so the page
  // shows its address without a second connect.
  await expect(main(page).getByTestId('venue-wallet-address')).toHaveText(owner());
  const form = main(page).getByRole('form', { name: 'Allowance' });
  await form.getByRole('textbox', { name: /^Amount/ }).fill('50');
  await form.getByRole('combobox', { name: 'Period' }).selectOption({ label: 'A week' });
  await form.getByRole('button', { name: 'Grant allowance' }).click();
  await continueInWallet(page);
  await expect(tableIn(main(page), 'Allowances').getByRole('row').filter({ hasText: 'Active' })).toHaveCount(1);
  const [active] = (await trading('allowances')).filter((x) => x.status === 'active');
  expect(active).toMatchObject({ amount: '50', left: '50', asset: 'USDC', subAccount: a, permissionOnVenue: true });
  agents.run.write({ ...agents.run.read(), agentAddress: active.agentAddress });
  await openAgents(page, agents);
  await expect(agentCard(page, 'Portfolio planner')).toBeVisible();
});

test(`${J} #1 asks the Portfolio agent for a rebalance: a proposal listing each order, and nothing executed`, async ({ page }) => {
  const before = await sent();
  const ledgerBefore = await usdt();
  await openPortfolio(page);
  const article = await ask(page, 'BTC 25');
  await expect(article.getByTestId('proposal-status')).toHaveText('Proposed: nothing has been sent');
  await expect(article.getByRole('heading', { name: /Rebalance proposal TEST/ })).toBeVisible();
  // The proposal as svc-trade stored it: the holdings as the venue reports them on Sub-account A, at the venue's mids.
  const [stored] = await trading('rebalances');
  expect(stored).toMatchObject({ status: 'proposed', asset: 'USDC', subAccount: await subA() });
  const venueHolds = Object.fromEntries(before.balances.map((b) => [b.asset, b.total]));
  expect(Object.fromEntries(stored.holdings.map((h) => [h.asset, h.total]))).toEqual({ USDC: venueHolds.USDC, BTC: venueHolds.BTC });
  const best = (await testVenue('/best-prices', { symbol: 'BTC-USDC' })).body.value;
  const btc = stored.holdings.find((h) => h.asset === 'BTC');
  expect(
    toUnits(btc.price) >= toUnits(best.bid) && toUnits(btc.price) <= toUnits(best.ask),
    `${btc.price} vs ${best.bid}/${best.ask}`,
  ).toBe(true);
  const holdings = tableIn(article, 'Holdings as the venue reports them');
  await expect(holdings.getByRole('row').filter({ hasText: 'BTC' })).toContainText(venueHolds.BTC);
  await expect(holdings.getByRole('row').filter({ hasText: 'USDC' })).toContainText(venueHolds.USDC);
  await expect(holdings.getByRole('row').filter({ hasText: 'BTC' })).toContainText('25%');
  // Each order listed: BTC is about 60 of about 160 TEST USDC, so 25% sells BTC, in whole lots, at a worst price.
  const leg = expectedLeg(stored, '25');
  expect(leg).toEqual({ side: 'sell', size: expect.stringMatching(/^0\.000[1-9]$/) });
  expect(stored.orders.map((o) => [o.side, o.symbol, o.size])).toEqual([[leg.side, 'BTC-USDC', leg.size]]);
  const o = stored.orders[0];
  expect(await ordersShown(article)).toEqual([['Sell', 'BTC-USDC', o.size, `${o.price} USDC`, `${o.notional} USDC`, 'Not sent']]);
  await expect(article.getByRole('button', { name: 'Approve' })).toBeVisible();
  await expect(article.getByRole('button', { name: 'Reject' })).toBeVisible();
  // Nothing executed: the venue's own record of the sub-account and the main account is as it was, the agent drew
  // nothing on its allowance, sent no order, and the ledger is untouched.
  expect(await sent()).toEqual(before);
  expect(await trading('orders')).toEqual([]);
  expect((await trading('allowances')).find((x) => x.status === 'active').left).toBe('50');
  expect(await usdt()).toEqual(ledgerBefore);
  // Stored, not the page's: a fresh load lists the same proposal, still proposed.
  await page.reload();
  await page.getByRole('group', { name: 'Agent pages' }).getByRole('button', { name: 'Portfolio', exact: true }).click();
  await expect(proposals(page)).toHaveCount(1);
  await expect(proposals(page).first().getByTestId('proposal-status')).toHaveText('Proposed: nothing has been sent');
});

test(`${J} #2 approves one proposal and rejects another: the approved orders placed within limits; the rejected one changes nothing`, async ({
  page,
}) => {
  const { agentAddress } = agents.run.read();
  const a = await subA();
  await openPortfolio(page);
  const sellId = await proposals(page).first().getAttribute('data-proposal-id');
  const sell = proposal(page, sellId);
  // A second proposal, the other way: 75% BTC buys BTC.
  const buy = await ask(page, 'BTC 75');
  const buyId = await buy.getAttribute('data-proposal-id');
  const stored = Object.fromEntries((await trading('rebalances')).map((r) => [r.proposalId, r]));
  expect(stored[buyId].orders.map((o) => [o.side, o.symbol])).toEqual([['buy', 'BTC-USDC']]);
  expect(stored[buyId].orders[0].size).toBe(expectedLeg(stored[buyId], '75').size);
  const before = await sent();
  const ledgerBefore = await usdt();
  // Rejected: nothing changes, on the venue, the allowance or the ledger, and it can never be approved.
  await buy.getByRole('button', { name: 'Reject' }).click();
  await expect(planner(page).getByRole('status')).toHaveText('Rejected: nothing was sent and nothing changed.');
  await expect(buy.getByTestId('proposal-status')).toHaveText('Rejected: nothing was sent');
  await expect(buy.getByRole('button', { name: 'Approve' })).toHaveCount(0);
  expect(await sent()).toEqual(before);
  expect(await trading('orders')).toEqual([]);
  expect((await trading('allowances')).find((x) => x.status === 'active').left).toBe('50');
  const door = await api(agents.account());
  const { agentId } = agents.run.read();
  const late = await door.post(`/api/v1/venue/own-agents/${agentId}/rebalances/${buyId}/approve`, {});
  expect(late.status).toBe(409);
  expect(late.body.intafacedCode).toBe('agents.rebalance_rejected');
  expect(await sent()).toEqual(before);
  // Approved: its order is placed on the person's own Sub-account A by the agent permission, as the venue reports it.
  const order = stored[sellId].orders[0];
  await sell.getByRole('button', { name: 'Approve' }).click();
  await expect(planner(page).getByRole('status')).toHaveText(
    'Approved: its orders were placed on your sub-account by the agent permission, as the venue reports them.',
  );
  await expect(sell.getByTestId('proposal-status')).toHaveText('Approved');
  await expect(sell.getByTestId('proposal-order-state')).toHaveText(['Placed']);
  const [placed] = await trading('orders');
  expect(placed).toMatchObject({
    orderId: order.orderId,
    state: 'accepted',
    symbol: 'BTC-USDC',
    side: 'sell',
    size: order.size,
    subAccount: a,
    signedBy: agentAddress,
  });
  const cloid = placed.order.venueClientOrderId;
  expect(await onA('/order-by-client-id', { venueClientOrderId: cloid })).toMatchObject({
    venueClientOrderId: cloid,
    symbol: 'BTC-USDC',
    side: 'sell',
    amount: order.size,
  });
  const after = await sent();
  expect(after.fills.length).toBe(before.fills.length + 1);
  expect(after.fills.at(-1)).toMatchObject({ symbol: 'BTC-USDC', side: 'sell', amount: order.size });
  const btcAfter = after.balances.find((b) => b.asset === 'BTC').total;
  expect(toUnits(btcAfter)).toBe(toUnits(before.balances.find((b) => b.asset === 'BTC').total) - toUnits(order.size));
  expect(after.mainFills).toEqual(before.mainFills);
  expect(after.mainOpen).toEqual(before.mainOpen);
  // Within the limits: the allowance drew exactly the order's notional at its worst price, and its key holds only A.
  const left = (await trading('allowances')).find((x) => x.status === 'active').left;
  expect(toUnits(left)).toBe(toUnits('50') - toUnits(order.notional));
  // INTAFACED holds and moves nothing: the ledger is untouched.
  expect(await usdt()).toEqual(ledgerBefore);
  // Sent once: approving again (a double press, a lost answer) reads the same order back, never a second one.
  const again = await door.post(`/api/v1/venue/own-agents/${agentId}/rebalances/${sellId}/approve`, {});
  expect(again.status, JSON.stringify(again.body).slice(0, 300)).toBe(200);
  expect(again.body.orders.map((x) => [x.orderId, x.state, x.replayed])).toEqual([[order.orderId, 'accepted', true]]);
  expect((await sent()).fills.length).toBe(after.fills.length);
  expect(await trading('orders')).toHaveLength(1);
  // Outside the limits: a proposal whose orders need more than the allowance has left is refused whole, and nothing is
  // sent. Selling every BTC left commits more than the TEST 50 less the first order's draw.
  const over = await ask(page, 'BTC 0');
  const overId = await over.getAttribute('data-proposal-id');
  const overOrder = (await trading('rebalances')).find((r) => r.proposalId === overId).orders[0];
  expect(toUnits(overOrder.notional) > toUnits(left), `${overOrder.notional} vs ${left} left`).toBe(true);
  const beforeOver = await sent();
  await over.getByRole('button', { name: 'Approve' }).click();
  const alert = planner(page).getByRole('alert');
  await expect(alert).toContainText('These orders need more than the allowance has left. Nothing was sent.');
  await expect(alert).toContainText('agents.rebalance_exceeds_allowance');
  await expect(over.getByTestId('proposal-status')).toHaveText('Proposed: nothing has been sent');
  expect(await sent()).toEqual(beforeOver);
  expect(await trading('orders')).toHaveLength(1);
});

test(`${J} #3 opens a leader's card: stats computed from fills, with the audited badge only once the Copy-Intel job wrote it`, async ({
  page,
}) => {
  await openAgents(page, agents);
  await agentCard(page, 'Copy intelligence').getByRole('button', { name: 'Details' }).click();
  await main(page).getByRole('link', { name: 'Leader directory' }).click(UNBUILT);
  const card = main(page).getByRole('article').first();
  await expect(card.getByRole('region', { name: 'Stats from fills' })).toBeVisible();
  const badge = card.getByTestId('audited-badge');
  await expect(badge.or(card.getByText('Not audited yet'))).toBeVisible();
});

test(`${J} #4 asks Copy-Intel for a returns ranking: a typed refusal and no board`, async ({ page }) => {
  const CODE = 'agents.copy_intel.returns_board_refused';
  await openAgents(page, agents);
  await agentCard(page, 'Copy intelligence').getByRole('button', { name: 'Open a session' }).click();
  await main(page).getByRole('button', { name: 'Review session' }).click();
  await page.getByRole('dialog', { name: 'Review agent session' }).getByRole('button', { name: 'Open agent session' }).click();
  await expect(page.getByText('Agent session opened')).toBeVisible();
  const workspace = main(page).getByRole('region', { name: 'Session workspace' });
  const sessionId = (await workspace.getByTestId('session-id').textContent()).trim();
  // The session as svc-agents records it: its log and its usage, re-read on "Refresh session".
  const selected = main(page).getByRole('region', { name: 'Selected session' });
  await expect(selected.locator('code')).toHaveText(sessionId);
  const accrued = selected
    .getByRole('term')
    .filter({ hasText: /^Session usage accrued$/ })
    .locator('xpath=following-sibling::dd[1]');
  const log = selected.getByRole('list', { name: 'Agent audit activity' }).getByRole('listitem');
  await expect(accrued).toHaveText(/^0 USDT$/);
  await expect(log).toHaveCount(1);
  const before = await usdt();
  await workspace.getByRole('textbox', { name: /^Ask the agent/ }).fill('TEST: rank the leaders by returns');
  await workspace.getByRole('button', { name: 'Run' }).click();
  const answer = page.waitForResponse((r) => r.url().includes('/api/agents/trpc/run.complete'));
  await page
    .getByRole('dialog', { name: 'Confirm the spend ceiling' })
    .getByRole('button', { name: /^Run up to/ })
    .click();
  // The service's own answer: refused by the one typed refusal, said in its words on the page.
  const refused = await answer;
  expect(refused.ok()).toBe(false);
  expect((await refused.json()).error.message).toBe('agents.refused.copy_intel.returns_board_refused');
  await expect(main(page).getByTestId('failure')).toContainText('Copy intelligence never ranks leaders by returns');
  await expect(tableIn(workspace, 'Runs').getByRole('row').nth(1).getByRole('cell').nth(2)).toContainText('Refused');
  // No board: the agent gave no reply at all, and nothing on the page ranks leaders.
  await expect(workspace.getByRole('region', { name: 'Reply' })).toHaveCount(0);
  await expect(main(page).getByRole('table', { name: /rank/i })).toHaveCount(0);
  await expect(main(page).getByRole('list', { name: /rank/i })).toHaveCount(0);
  // Re-read from svc-agents: the session's log gained exactly one row, the refusal by its one typed code, and nothing
  // ran or was charged, in the session or the ledger.
  const reread = Promise.all(
    ['session.log', 'usage.current'].map((procedure) =>
      page.waitForResponse((r) => r.url().includes(`/api/agents/trpc/${procedure}`) && r.ok()),
    ),
  );
  await selected.getByRole('button', { name: 'Refresh session' }).click();
  await reread;
  await expect(log).toHaveCount(2);
  const refusal = log.filter({ hasText: CODE });
  await expect(refusal).toHaveCount(1);
  await expect(refusal.locator('span[lang="zxx"]')).toHaveText(CODE);
  await expect(refusal.locator('strong')).toContainText('Refused');
  await expect(
    refusal
      .getByRole('term')
      .filter({ hasText: /^Cost$/ })
      .locator('xpath=following-sibling::dd[1]'),
  ).toHaveText(/^0$/);
  await expect(accrued).toHaveText(/^0 USDT$/);
  await expect(workspace.locator('p').filter({ has: page.getByTestId('session-id') })).toContainText('· open');
  expect(await usdt()).toEqual(before);
});

test(`${J} #5 opens the Launch, Risk and Compliance, and Growth agent pages: run history and drafts; a growth proposal to publish stays a draft`, async ({
  page,
}) => {
  await blockedBy(BLOCKED[5], async () => {
    // What the app does today: Launch check and Growth drafts are catalogue cards that open their rooms, with no run
    // history or drafts; Risk and compliance is staff only, its card says so.
    for (const name of ['Launch check', 'Growth drafts']) {
      await openAgents(page, agents);
      await agentCard(page, name).getByRole('button', { name: 'Details' }).click();
      await expect(main(page).getByRole('table', { name: 'Run history' })).toHaveCount(0);
      await expect(main(page).getByRole('table', { name: 'Drafts' })).toHaveCount(0);
    }
    await openAgents(page, agents);
    await expect(agentCard(page, 'Risk and compliance')).toContainText('Staff only');
  });
});
