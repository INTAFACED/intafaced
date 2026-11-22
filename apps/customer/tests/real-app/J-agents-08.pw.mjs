// World: restart
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { agentsRun, createOwnAgent, openOwnAgent, tableIn } from './agents.mjs';
import { signIn } from './desk.mjs';
import { api, toUnits } from './stack.mjs';
import { installTestWallet, testWalletKey } from './test-wallet.mjs';
import { continueInWallet, testDeposit, testVenue, venueAccount, venueForThisFile, venueInfo, venueRecord } from './venue.mjs';

// J-agents-08, in the running app (docs/roadmap/journeys.json): give an agent an allowance and access I can revoke, and
// let it place an order I can see. One test per step, titled "J-agents-08 #<n>", run in order on one verified TEST
// account, a TEST wallet whose own venue account on the stack's TEST venue simulator holds TEST USDC and two venue
// sub-accounts, and an agent of its own. Every figure the TEST venue reports is TEST. The allowance is a limit, never a
// balance the service holds; two draws that together exceed it admit one; the agent order is a venue order on the
// person's own venue account, and the agent permission never withdraws.
// Built: #1 the Access page's allow and deny rules, decided by svc-agents (AG-spend-02); #2 the Access page's account
// access, the sub-accounts the agent may act on until when (AG-spend-02), listed from the venue's own record through
// svc-trade's user-venue door (on for this file, LOCAL_STACK_USER_VENUE=on); #3 to #7 the Allowance page (AG-spend-03,
// RC-agents-06): svc-trade keeps the allowance and holds every order to it, the person's wallet signs the venue's agent
// permission for the key svc-trade holds on sub-account A only, svc-agents drafts the order from the person's words and
// its gate (the rules and access of #1 #2) is asked again before the key signs. Every check of what was sent or placed
// reads the TEST venue's own record of the person's sub-account.
// The start's two sub-accounts are opened, and A is funded with TEST USDC, by the person's own wallet signing the venue's
// actions on the TEST venue directly: a customer cannot open plain sub-accounts in the app yet, so this is the journey's
// starting state, not a step.
const J = 'J-agents-08';
const agents = agentsRun(J);

test.describe.configure({ mode: 'default' });
venueForThisFile(test);

const main = (page) => page.getByRole('main');
const access = (page) => main(page).getByRole('region', { name: 'Access', exact: true });
const allowanceForm = (page) => main(page).getByRole('form', { name: 'Allowance' });
const askForm = (page) => main(page).getByRole('form', { name: 'Ask the agent to trade' });
const preview = (page) => main(page).getByRole('region', { name: 'Order preview' });

/** The own agent's id, from the address of its page (/agents/<id>). */
async function agentId(page) {
  const id = new URL(page.url()).pathname.split('/').pop();
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  return id;
}

/** svc-agents' own gate for an agent action on an account (`main` or `sub:<venue id>`), as the person: its status, refusal code and decision. */
async function policyCheck(id, action, account = 'main') {
  const input = encodeURIComponent(JSON.stringify({ id, action, account }));
  const { status, body } = await (await api(agents.account())).get(`/api/agents/trpc/own.policy.check?input=${input}`);
  return { status, code: body?.error?.message ?? null, outcome: body?.result?.data?.outcome ?? null };
}

/** The account access svc-agents stores for the agent, as the person reads it. */
async function storedAccess(id) {
  const input = encodeURIComponent(JSON.stringify({ id }));
  const { status, body } = await (await api(agents.account())).get(`/api/agents/trpc/own.access.get?input=${input}`);
  expect(status, JSON.stringify(body).slice(0, 400)).toBe(200);
  return body.result.data.grants;
}

/** This run's TEST wallet: the person's own, kept in the run's state from the start. */
function wallet() {
  const { walletKey } = agents.run.read();
  if (!walletKey) throw new Error(`${J} starts made no wallet, so this step has no one to sign as`);
  return privateKeyToAccount(walletKey);
}
const owner = () => wallet().address.toLowerCase();

/** The person's wallet signs one action on its own main venue account, on the TEST venue directly. */
async function ownVenueAction(intent) {
  const account = await venueAccount(owner());
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

/** The venue's own list of the wallet's sub-accounts, by name. */
async function subAccounts() {
  const { value } = await venueRecord(owner(), '/sub-accounts');
  return Object.fromEntries(value.map((s) => [s.name, s.subAccount]));
}

/** The TEST venue's own record of one of the wallet's sub-accounts. */
async function subRecord(subAccount, path, extra = {}) {
  const { status, body } = await testVenue(path, { account: { ...(await venueAccount(owner())), subAccount }, ...extra });
  expect(status, JSON.stringify(body)).toBe(200);
  return body;
}

/** What the venue holds and has traded on sub-account A and on the main account: what "nothing is sent" must leave as it was. */
async function sent() {
  const a = (await subAccounts())['Sub-account A'];
  const since = '2020-01-01T00:00:00.000Z';
  const [aFills, aOpen, aBalances, mainFills, mainOpen] = await Promise.all([
    subRecord(a, '/fills', { since }),
    subRecord(a, '/open-orders'),
    subRecord(a, '/balances'),
    venueRecord(owner(), '/fills', { since }),
    venueRecord(owner(), '/open-orders'),
  ]);
  return { aFills: aFills.value, aOpen: aOpen.value, aBalances: aBalances.value, mainFills: mainFills.value, mainOpen: mainOpen.value };
}

/** svc-trade's record of the agent's allowances and orders, as the person reads it. */
async function trading(id, what) {
  const { status, body } = await (await api(agents.account())).get(`/api/v1/venue/own-agents/${id}/${what}`);
  expect(status, JSON.stringify(body).slice(0, 400)).toBe(200);
  return body[what];
}

/** The agent permissions the venue's own record holds on sub-account A. */
async function permissionsOnA() {
  return (await subRecord((await subAccounts())['Sub-account A'], '/agents')).value.map((x) => x.address.toLowerCase());
}

/** Opens the Allowance page with this run's TEST wallet connected. Returns the wallet, to watch and steer its signatures. */
async function openAllowance(page) {
  const { chainId } = await venueInfo();
  const testWallet = await installTestWallet(page, { chainId, privateKey: agents.run.read().walletKey });
  await openOwnAgent(page, agents, 'Allowance');
  await main(page).getByRole('region', { name: 'Allowance', exact: true }).getByRole('button', { name: 'Connect TEST Wallet' }).click();
  await expect(main(page).getByTestId('venue-wallet-address')).toHaveText(owner());
  return testWallet;
}

/** One TEST switch on this wallet's venue account only (packages/venue-sim `/test/account-switches`). */
async function accountSwitch(body) {
  const r = await testVenue('/test/account-switches', { owner: owner(), ...body });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

async function ask(page, words) {
  await askForm(page)
    .getByRole('textbox', { name: /^Ask the agent/ })
    .fill(words);
  await askForm(page).getByRole('button', { name: 'Run' }).click();
}

test(`${J} starts: a verified TEST account, a TEST wallet with TEST USDC in its own venue account and two venue sub-accounts, and an agent of its own`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const who = await agents.start(page, 'ag08', '100');
  agents.run.write({ walletKey: testWalletKey() });
  expect(await testDeposit(owner(), 'USDC', '100', `j-agents-08:${who.handle}:usdc`)).toBe(true);
  for (const [n, name] of ['Sub-account A', 'Sub-account B'].entries())
    await ownVenueAction({ kind: 'create_sub_account', name, subAccountKey: `j-agents-08:${who.handle}:sub:${n}` });
  expect(Object.keys(await subAccounts()).sort()).toEqual(['Sub-account A', 'Sub-account B']);
  const subs = await subAccounts();
  await ownVenueAction({
    kind: 'sub_account_transfer',
    subAccount: subs['Sub-account A'],
    direction: 'into_sub_account',
    asset: 'USDC',
    amount: '50',
    moveKey: `j-agents-08:${who.handle}:fund-a`,
  });
  expect((await subRecord(subs['Sub-account A'], '/balances')).value.find((b) => b.asset === 'USDC')?.total).toBe('50');
  await signIn(page, agents.account());
  await createOwnAgent(page);
});

test(`${J} #1 writes an allow and a deny rule for one action at different scopes: refused whichever came first; no matching rule on a rules-required agent refuses`, async ({
  page,
}) => {
  await openOwnAgent(page, agents, 'Access');
  const rule = access(page).getByRole('form', { name: 'New access rule' });
  const rules = () => tableIn(access(page), 'Access rules');
  const add = async (effect, scope) => {
    await rule.getByRole('combobox', { name: 'Effect' }).selectOption({ label: effect });
    await rule.getByRole('combobox', { name: 'Action' }).selectOption({ label: 'Place an order' });
    await rule.getByRole('combobox', { name: 'Scope' }).selectOption({ label: scope });
    await rule.getByRole('button', { name: 'Add rule' }).click();
    await expect(rules().getByRole('row').filter({ hasText: effect }).filter({ hasText: scope })).toHaveCount(1);
  };
  const id = await agentId(page);
  // Both orders: allow on every account then deny on main, and then the same two rules written the other way round.
  for (const order of [
    [
      ['Allow', 'All my accounts'],
      ['Deny', 'Main account'],
    ],
    [
      ['Deny', 'Main account'],
      ['Allow', 'All my accounts'],
    ],
  ]) {
    // Each remove is answered before the next: the stored rules come back one fewer.
    const table = access(page).getByRole('region', { name: 'Access rules', exact: true });
    for (let left = (await table.count()) ? (await rules().getByRole('row').count()) - 1 : 0; left > 0; left--) {
      await rules().getByRole('row').nth(1).getByRole('button', { name: 'Remove' }).click();
      if (left > 1) await expect(rules().getByRole('row')).toHaveCount(left);
    }
    await expect(access(page).getByText('No access rules yet.')).toBeVisible();
    for (const [effect, scope] of order) await add(effect, scope);
    await expect(access(page).getByTestId('effective-place-order')).toHaveText('Refused: a deny rule wins');
    // The service's own gate refuses it, not only the page's words: the check every agent action is to pass first.
    expect(await policyCheck(id, 'place_order')).toEqual({ status: 403, code: 'agents.policy_denied', outcome: null });
  }
  // The decision is stored, not the page's: a fresh load reads the same.
  await page.reload();
  await page.getByRole('group', { name: 'Agent pages' }).getByRole('button', { name: 'Access', exact: true }).click();
  await expect(access(page).getByTestId('effective-place-order')).toHaveText('Refused: a deny rule wins');
  // No rule names cancelling: left to the agent's other limits until rules are required, then refused.
  await expect(access(page).getByTestId('effective-cancel-order')).toHaveText('No rule: the agent’s other limits decide');
  await access(page).getByRole('checkbox', { name: 'Only allow what a rule allows' }).check();
  await expect(access(page).getByTestId('effective-cancel-order')).toHaveText('Refused: no rule allows it');
  expect(await policyCheck(id, 'cancel_order')).toEqual({ status: 403, code: 'agents.policy_no_match', outcome: null });
});

test(`${J} #2 gives the agent access to sub-account A only: a tool naming sub-account B is refused; access has an expiry and a blank expiry refuses`, async ({
  page,
}) => {
  const subs = await subAccounts();
  const { chainId } = await venueInfo();
  await installTestWallet(page, { chainId, privateKey: agents.run.read().walletKey });
  await openOwnAgent(page, agents, 'Access');
  const id = await agentId(page);
  const section = main(page).getByRole('region', { name: 'Account access', exact: true });
  await section.getByRole('button', { name: 'Connect TEST Wallet' }).click();
  await expect(section.getByTestId('venue-wallet-address')).toHaveText(owner());
  // The sub-accounts offered are the venue's own two for this wallet.
  const grant = section.getByRole('form', { name: 'Account access' });
  await expect(grant.getByRole('checkbox')).toHaveCount(2);
  await grant.getByRole('checkbox', { name: 'Sub-account A', exact: true }).check();
  await expect(grant.getByRole('checkbox', { name: 'Sub-account B', exact: true })).not.toBeChecked();
  // A blank expiry refuses, naming it, and grants nothing.
  await grant.getByRole('textbox', { name: /^Ends/ }).fill('');
  await grant.getByRole('button', { name: 'Grant access' }).click();
  await expect(grant.getByRole('alert')).toContainText('Set when this access ends.');
  await expect(grant.getByRole('alert')).toContainText('agents.access_expiry_unset');
  expect(await storedAccess(id)).toEqual([]);
  // With an expiry of 7 days: A, and only A, is granted until then.
  const before = Date.now();
  await grant.getByRole('textbox', { name: /^Ends/ }).fill('7');
  await grant.getByRole('button', { name: 'Grant access' }).click();
  const granted = tableIn(section, 'Granted access');
  await expect(granted.getByRole('row')).toHaveCount(2);
  await expect(granted).toContainText('Sub-account A');
  await expect(granted).not.toContainText('Sub-account B');
  const stored = await storedAccess(id);
  expect(stored.map((g) => ({ subAccount: g.subAccount, name: g.name, owner: g.owner }))).toEqual([
    { subAccount: subs['Sub-account A'], name: 'Sub-account A', owner: owner() },
  ]);
  const week = 7 * 86_400_000;
  expect(Date.parse(stored[0].endsAt) - Date.parse(stored[0].grantedAt)).toBe(week);
  expect(Date.parse(stored[0].endsAt)).toBeGreaterThanOrEqual(before + week - 60_000);
  expect(Date.parse(stored[0].endsAt)).toBeLessThanOrEqual(Date.now() + week + 60_000);
  await expect(granted.getByTestId('access-ends').locator('time')).toHaveAttribute('datetime', stored[0].endsAt);
  // A tool naming sub-account B is refused by the service's own gate; one naming A gets past access to the rules (#1's
  // allow on every account, with rules required), so only B is shut.
  expect(await policyCheck(id, 'place_order', `sub:${subs['Sub-account B']}`)).toEqual({
    status: 403,
    code: 'agents.access_account_denied',
    outcome: null,
  });
  expect(await policyCheck(id, 'place_order', `sub:${subs['Sub-account A']}`)).toEqual({ status: 200, code: null, outcome: 'allowed' });
  // Stored, not the page's: a fresh load reads the same.
  await page.reload();
  await page.getByRole('group', { name: 'Agent pages' }).getByRole('button', { name: 'Access', exact: true }).click();
  await expect(tableIn(main(page).getByRole('region', { name: 'Account access', exact: true }), 'Granted access')).toContainText(
    'Sub-account A',
  );
});

test(`${J} #3 asks the agent to place an order before any allowance or agent permission exists: refused and nothing is sent; the page says an allowance is needed and the wallet must sign an agent permission`, async ({
  page,
}) => {
  const before = await sent();
  await openAllowance(page);
  await ask(page, 'Buy 0.0001 BTC at market');
  const alert = main(page).getByRole('region', { name: 'Ask the agent to trade' }).getByRole('alert');
  await expect(alert).toContainText('This agent needs an allowance before it can place an order');
  await expect(alert).toContainText('your wallet must sign an agent permission');
  await expect(alert).toContainText('agents.allowance_unset');
  await expect(preview(page)).toHaveCount(0);
  // Nothing was sent: the venue's own record of sub-account A and of the main account is as it was, and it holds no
  // agent permission on A.
  expect(await sent()).toEqual(before);
  expect(await permissionsOnA()).toEqual([]);
  expect(await trading(await agentId(page), 'allowances')).toEqual([]);
});

test(`${J} #4 grants an allowance with the amount blank, then TEST 20 for a week: the blank grant names the field; the real one asks the wallet to sign the agent permission (a rejected signature grants nothing), then is listed with remaining amount and expiry`, async ({
  page,
}) => {
  const testWallet = await openAllowance(page);
  const id = await agentId(page);
  const form = allowanceForm(page);
  // Blank: refused naming the field, before the wallet is asked; nothing is stored.
  await form.getByRole('textbox', { name: /^Amount/ }).fill('');
  await form.getByRole('button', { name: 'Grant allowance' }).click();
  await expect(form.getByRole('alert')).toContainText('Amount is blank');
  await expect(form.getByRole('alert')).toContainText('agents.allowance_amount_unset');
  expect(testWallet.requests).toEqual([]);
  expect(await trading(id, 'allowances')).toEqual([]);
  // TEST 20 for a week: the wallet is asked to sign; rejected, nothing is granted and the venue holds no permission.
  await form.getByRole('textbox', { name: /^Amount/ }).fill('20');
  await form.getByRole('combobox', { name: 'Period' }).selectOption({ label: 'A week' });
  testWallet.rejectNext();
  await form.getByRole('button', { name: 'Grant allowance' }).click();
  await continueInWallet(page);
  await expect(form.getByRole('alert')).toContainText('Your wallet rejected the signature, so nothing was sent.');
  expect(testWallet.requests).toHaveLength(1);
  expect(testWallet.requests[0].method).toBe('eth_signTypedData_v4');
  const rejected = await trading(id, 'allowances');
  expect(rejected.map((x) => x.status)).toEqual(['abandoned']);
  expect(await permissionsOnA()).toEqual([]);
  // Again, signed: the venue holds the agent permission for svc-trade's key on sub-account A, and only there.
  const before = Date.now();
  await form.getByRole('button', { name: 'Grant allowance' }).click();
  await continueInWallet(page);
  const row = tableIn(main(page), 'Allowances').getByRole('row').filter({ hasText: 'Active' });
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId('allowance-left')).toHaveText('20 USDC left');
  expect(testWallet.requests).toHaveLength(2);
  const [granted] = (await trading(id, 'allowances')).filter((x) => x.status === 'active');
  expect(granted).toMatchObject({ amount: '20', left: '20', asset: 'USDC', period: 'week', permissionOnVenue: true });
  expect(granted.subAccount).toBe((await subAccounts())['Sub-account A']);
  expect(await permissionsOnA()).toEqual([granted.agentAddress]);
  expect((await venueRecord(owner(), '/agents')).value.map((x) => x.address.toLowerCase())).not.toContain(granted.agentAddress);
  const week = 7 * 86_400_000;
  expect(Date.parse(granted.endsAt)).toBeGreaterThanOrEqual(before + week - 120_000);
  expect(Date.parse(granted.endsAt)).toBeLessThanOrEqual(Date.now() + week);
  await expect(row.getByTestId('allowance-expiry')).toContainText('Ends');
  await expect(row.getByTestId('allowance-expiry').locator('time')).toHaveAttribute('datetime', granted.endsAt);
  agents.run.write({ ...agents.run.read(), agentAddress: granted.agentAddress });
});

test(`${J} #5 asks the agent to buy a small TEST amount: a structured preview of side, instrument, order type, size, price and fee before anything is sent, and an approval request`, async ({
  page,
}) => {
  const before = await sent();
  await openAllowance(page);
  await ask(page, 'Buy 0.0001 BTC at market');
  const p = preview(page);
  await expect(p).toBeVisible();
  const fact = (term) =>
    p
      .getByRole('term')
      .filter({ hasText: new RegExp(`^${term}`) })
      .locator('xpath=following-sibling::dd[1]');
  await expect(fact('Side')).toHaveText('Buy');
  await expect(fact('Market')).toHaveText('BTC-USDC');
  await expect(fact('Order type')).toHaveText('Market');
  await expect(fact('Size')).toHaveText('0.0001');
  await expect(fact('Price')).toHaveText(/^[0-9]+(\.[0-9]+)? USDC$/);
  // The price is the worst a market buy may fill at, read from the venue's own book: above its best ask, and no more
  // than the owner's TEST 200 bps over the book's mid.
  const price = (await fact('Price').innerText()).replace(/ USDC$/, '');
  const best = (await testVenue('/best-prices', { symbol: 'BTC-USDC' })).body.value;
  const P = toUnits(price);
  expect(P >= toUnits(best.ask), `${price} vs ask ${best.ask}`).toBe(true);
  expect(P * 2n * 10_000n <= (toUnits(best.bid) + toUnits(best.ask)) * 10_200n, `${price} vs mid of ${best.bid}/${best.ask}`).toBe(true);
  // The fee is the venue's own: the same order previewed on the venue directly, at that price, gives the same fee.
  const onVenue = await subRecord((await subAccounts())['Sub-account A'], '/preview', {
    intent: {
      kind: 'place_order',
      symbol: 'BTC-USDC',
      side: 'buy',
      type: 'market',
      amount: '0.0001',
      price,
      timeInForce: 'IOC',
      reduceOnly: false,
      clientOrderKey: 'j-agents-08:preview-check',
      builderFee: null,
    },
  });
  expect(onVenue.value.venueFee.known).toBe(true);
  await expect(fact('Fee')).toHaveText(`${onVenue.value.venueFee.value.amount} ${onVenue.value.venueFee.value.asset}`);
  await expect(p.getByRole('button', { name: 'Approve' })).toBeVisible();
  await expect(p).toContainText('Nothing has been sent.');
  // Nothing was sent: the venue's own record is as it was.
  expect(await sent()).toEqual(before);
});

test(`${J} #6 approves the preview: the order appears on the person's own venue account in sub-account A, placed by the agent permission, as the venue reports it; the agent never has withdraw scope`, async ({
  page,
}) => {
  const before = await sent();
  const testWallet = await openAllowance(page);
  const id = await agentId(page);
  await ask(page, 'Buy 0.0001 BTC at market');
  const asked = testWallet.requests.length;
  await preview(page).getByRole('button', { name: 'Approve' }).click();
  await expect(main(page).getByRole('status')).toContainText('Order placed on your account’s sub-account by the agent permission');
  // The person's own wallet signed nothing: no sign sheet and no wallet request for the order, so the venue took it
  // under the agent permission it holds for A.
  expect(testWallet.requests.length).toBe(asked);
  await expect(page.getByRole('dialog', { name: 'Check before you sign' })).toHaveCount(0);
  const [order] = await trading(id, 'orders');
  const { agentAddress } = agents.run.read();
  const subA = (await subAccounts())['Sub-account A'];
  expect(order).toMatchObject({
    state: 'accepted',
    symbol: 'BTC-USDC',
    side: 'buy',
    size: '0.0001',
    subAccount: subA,
    signedBy: agentAddress,
  });
  // The venue's own record: the order by its client order id, and its fill, on sub-account A; the main account traded nothing.
  const cloid = order.order.venueClientOrderId;
  const onVenue = await subRecord(subA, '/order-by-client-id', { venueClientOrderId: cloid });
  expect(onVenue.value).toMatchObject({ venueClientOrderId: cloid, symbol: 'BTC-USDC', side: 'buy', amount: '0.0001' });
  const after = await sent();
  expect(after.aFills.length).toBe(before.aFills.length + 1);
  expect(after.aFills.at(-1)).toMatchObject({ symbol: 'BTC-USDC', side: 'buy' });
  expect(Number(after.aBalances.find((b) => b.asset === 'BTC')?.total ?? 0)).toBeGreaterThan(0);
  expect(after.mainFills).toEqual(before.mainFills);
  expect(after.mainOpen).toEqual(before.mainOpen);
  // Placed by the agent permission: the venue accepts only a key it holds for A, and holds exactly the allowance's key.
  expect(await permissionsOnA()).toEqual([agentAddress]);
  await expect(tableIn(main(page), 'Agent orders').getByTestId('agent-order-signer')).toHaveText(agentAddress);
  // The agent permission never withdraws: the venue refuses a withdrawal from A signed by that key.
  const withdraw = await testVenue('/prepare', {
    account: { ...(await venueAccount(owner())), subAccount: subA },
    signer: { role: 'agent', address: agentAddress },
    intent: { kind: 'withdraw', asset: 'USDC', amount: '1', destination: owner(), withdrawalKey: `j-agents-08:withdraw:${id}` },
  });
  expect(withdraw.status).toBe(422);
  expect(withdraw.body.refusal).toMatchObject({ code: 'agent_not_permitted' });
});

test(`${J} #7 revokes the allowance during a run: our copy of the agent key is dropped at once and the next admission refuses; an order already sent finishes or is read back from the venue by its client order id; the wallet is asked to sign the venue's revoke`, async ({
  page,
}) => {
  const testWallet = await openAllowance(page);
  const id = await agentId(page);
  const { agentAddress } = agents.run.read();
  const subA = (await subAccounts())['Sub-account A'];
  const earlier = (await trading(id, 'orders')).map((o) => o.orderId);
  // A run in progress: the venue holds each submit for TEST 10 seconds, so the approved order is on its way to the venue
  // while the person revokes.
  await accountSwitch({ submitDelayMs: 10_000 });
  const directOrder = (orderId) =>
    api(agents.account()).then((a) =>
      a.post(`/api/v1/venue/own-agents/${id}/orders`, { orderId, side: 'buy', base: 'BTC', size: '0.0001', type: 'market' }),
    );
  try {
    await ask(page, 'Buy 0.0001 BTC at market');
    await preview(page).getByRole('button', { name: 'Approve' }).click();
    // Sent: the agent key has signed it and the bytes are with the venue, which has not answered yet.
    const newOnes = async () => (await trading(id, 'orders')).filter((o) => !earlier.includes(o.orderId)).map((o) => o.state);
    await expect.poll(newOnes, { timeout: 4_000, intervals: [100] }).toEqual(['unknown']);
    // Before the revoke, svc-trade holds a signer for the allowance's agent key: it just signed the order in flight.
    expect((await trading(id, 'allowances'))[0]).toMatchObject({ status: 'active', agentKeyHeld: true });
    const unanswered = await sent();
    // Revoke, during the run. The wallet is asked to sign the venue's revoke; the person rejects it this once, so the
    // venue still holds the agent permission: what stops the agent is our side, at once.
    const row = tableIn(main(page), 'Allowances').getByRole('row').filter({ hasText: 'Active' });
    testWallet.rejectNext();
    await row.getByRole('button', { name: 'Revoke' }).click();
    await continueInWallet(page);
    const revoked = tableIn(main(page), 'Allowances').getByRole('row').filter({ hasText: 'Revoked' });
    await expect(revoked).toContainText('the venue’s revoke waits for your wallet’s signature');
    expect(testWallet.requests.at(-1).method).toBe('eth_signTypedData_v4');
    expect(await permissionsOnA()).toEqual([agentAddress]);
    // At once, while the order already sent is still unanswered: our copy of the agent key is dropped (svc-trade holds
    // no signer for it, and the page says so) and the next admission refuses, with a new order id, sending nothing.
    await expect(revoked).toContainText('our copy of the agent key is dropped');
    expect((await trading(id, 'allowances'))[0]).toMatchObject({ status: 'revoked', agentKeyHeld: false, permissionOnVenue: true });
    const atOnce = await directOrder('00000000-0000-4000-8000-0000000000a6');
    expect(atOnce.status, JSON.stringify(atOnce.body)).toBe(409);
    expect(atOnce.body.intafacedCode).toBe('agents.allowance_revoked');
    expect(await newOnes()).toEqual(['unknown']);
    expect(await sent()).toEqual(unanswered);
    // The order already sent: the venue holds it past svc-trade's 5 second wait, so the page says it was sent with no
    // answer yet, and it is read back from the venue by its client order id, where it finished.
    await expect(main(page).getByRole('status')).toContainText(
      'The order was sent and the venue has not answered; it is read back by its id.',
      {
        timeout: 15_000,
      },
    );
    await expect.poll(newOnes, { timeout: 20_000, intervals: [250] }).toEqual(['accepted']);
  } finally {
    await accountSwitch({ submitDelayMs: 0 });
  }
  const orders = await trading(id, 'orders');
  const inFlight = orders.filter((o) => !earlier.includes(o.orderId));
  expect(inFlight).toHaveLength(1);
  expect(inFlight[0]).toMatchObject({ state: 'accepted', signedBy: agentAddress, subAccount: subA });
  const back = await subRecord(subA, '/order-by-client-id', { venueClientOrderId: inFlight[0].order.venueClientOrderId });
  expect(back.value).toMatchObject({ venueClientOrderId: inFlight[0].order.venueClientOrderId, symbol: 'BTC-USDC', side: 'buy' });
  const before = await sent();
  // Our copy of the agent key is dropped: the venue still holds the agent permission on A, yet nothing is signed with it.
  // A new ask is refused before a preview, and an order sent straight to the API with a new order id is refused too.
  await ask(page, 'Buy 0.0001 BTC at market');
  const alert = main(page).getByRole('region', { name: 'Ask the agent to trade' }).getByRole('alert');
  await expect(alert).toContainText('agents.allowance_revoked');
  await expect(preview(page)).toHaveCount(0);
  const direct = await directOrder('00000000-0000-4000-8000-0000000000a7');
  expect(direct.status, JSON.stringify(direct.body)).toBe(409);
  expect(direct.body.intafacedCode).toBe('agents.allowance_revoked');
  expect(await permissionsOnA()).toEqual([agentAddress]);
  expect(await sent()).toEqual(before);
  expect((await trading(id, 'orders')).length).toBe(orders.length);
  // The wallet signs the venue's revoke: the venue no longer holds the agent permission on A.
  const revoked = tableIn(main(page), 'Allowances').getByRole('row').filter({ hasText: 'Revoked' });
  const signedBefore = testWallet.requests.length;
  await revoked.getByRole('button', { name: 'Sign the venue’s revoke' }).click();
  await continueInWallet(page);
  await expect(revoked).not.toContainText('the venue’s revoke waits for your wallet’s signature');
  expect(testWallet.requests.length).toBe(signedBefore + 1);
  expect(testWallet.requests.at(-1).method).toBe('eth_signTypedData_v4');
  expect(await permissionsOnA()).toEqual([]);
  const [allowance] = await trading(id, 'allowances');
  expect(allowance).toMatchObject({ status: 'revoked', permissionOnVenue: false, agentKeyHeld: false });
  expect(await sent()).toEqual(before);
});
