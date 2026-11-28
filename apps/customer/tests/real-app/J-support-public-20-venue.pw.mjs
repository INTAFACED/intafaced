// World: book, gates, restart, stack
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { asDesk, leadAnswers as lead, leadRefused as refused } from './help-centre.mjs';
import { signUp, verify } from './desk.mjs';
import { OWN_AGENT, createOwnAgent } from './agents.mjs';
import { body200 } from './answers.mjs';
import { TOKEN_USD, fundOnTestChain } from './dex.mjs';
import { testWalletKey } from './test-wallet.mjs';
import { chainBalance, openVenuePage, testDeposit, venueBalance, venueForThisFile, venueRecord } from './venue.mjs';
import { ownSpotMarket } from './own-market.mjs';
import { api, toUnits } from './stack.mjs';

// J-support-public-20 #7 on the venue model (docs/roadmap/journeys.json): a support agent asks, from a customer's request,
// that the customer's account be frozen. svc-identity records it as the account's trading restriction with an audit row;
// the app refuses the customer's new orders and their agent permissions are stopped; their own wallet and venue funds
// are untouched; a request status change never lifts it. J-support-public-20.pw.mjs keeps the journey's other steps.
//
// The customer's own TEST wallet holds TEST USD on the stack's TEST chain, and its own account on the stack's TEST venue
// simulator holds TEST USDC (svc-trade's user-venue door on for this file, venueForThisFile). Both are read from the chain
// and the venue themselves, before and after the freeze, never from our pages or our ledger. INTAFACED holds none of it:
// the customer is verified and funded nowhere on our ledger, so the file runs as launch does, custody off. Their orders
// are venue orders through our door, signed by their own wallet. Every figure is TEST.
const J = 'J-support-public-20';
const RUN = Date.now().toString(36);

test.describe.configure({ mode: 'default' });
venueForThisFile(test);

/** A desk read the customer makes with their own session: the URL of `procedure` with `input`. */
const query = (procedure, input) => `/api/support/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`;
/**
 * A TEST limit buy on the file's own TEST market (ownSpotMarket: its book is empty and no other file trades it), so it
 * rests and fills nothing: 1 base unit at TEST 10 USDC.
 */
const restingIntent = (symbol, clientOrderKey) => ({
  kind: 'place_order',
  symbol,
  side: 'buy',
  type: 'limit',
  amount: '1',
  price: '10',
  timeInForce: 'GTC',
  reduceOnly: false,
  clientOrderKey,
  builderFee: null,
});

test(`${J} #7 an account freeze asked from the request is recorded by the identity service with an audit row; the customer's new orders are refused and their agent permissions stopped; their own funds are untouched; a status change never lifts it`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(240_000);
  // Its own customer, verified, so the freeze touches no other step's account. INTAFACED funds them with nothing.
  const who = await signUp(page, 'j20a');
  await verify(page, who);
  // Their own TEST wallet: TEST USD on the TEST chain, TEST USDC in its own account on the TEST venue, connected in the app.
  const walletKey = testWalletKey();
  const owner = privateKeyToAccount(walletKey).address.toLowerCase();
  fundOnTestChain(owner, 'stable');
  await testDeposit(owner, 'USDC', '50', `deposit:${J}:${owner}:${RUN}`);
  await openVenuePage(page, who, '/trade/convert', walletKey);
  const ownFunds = async () => ({
    wallet: (await chainBalance(TOKEN_USD.address, owner)).toString(),
    venue: await venueBalance(owner, 'USDC'),
  });
  const client = await api(who);
  // An agent permission the customer gave: their own agent, allowed to use their own data (svc-agents keeps it).
  await createOwnAgent(page);
  const agents = body200(await client.get(`/api/agents/trpc/own.list?input=${encodeURIComponent(JSON.stringify({ limit: 50 }))}`));
  const agentId = agents.result.data.find((row) => row.name === OWN_AGENT).id;
  body200(await client.post('/api/agents/trpc/own.consents.grant', { id: agentId, dataClass: 'own_data' }));
  const consents = async () =>
    body200(await client.get(`/api/agents/trpc/own.consents.list?input=${encodeURIComponent(JSON.stringify({ id: agentId }))}`)).result
      .data;
  expect((await consents()).map((c) => c.state)).toEqual(['granted']);

  const made = await client.post('/api/support/trpc/create', {
    category: 'deposit_withdraw',
    subject: `TEST ${J} ${RUN} withdrawal missing, account freeze`,
    body: 'TEST My withdrawal never arrived and I think someone else is in my account.',
    clientRequestId: `j20a:${RUN}`,
  });
  expect(made.status, JSON.stringify(made.body).slice(0, 300)).toBe(200);
  const ticket = made.body.result.data;
  await lead('mutation', 'claim', { ticketId: ticket.id }).catch(() => null);
  const restrictions = async () => {
    const res = await client.get('/api/identity/trpc/accountStatus.mine');
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
    return res.body.result.data.restrictions.map((r) => r.kind);
  };
  // An order already resting on their own venue account, placed through our door and signed by their own wallet.
  const { symbol } = await ownSpotMarket(J, 'JSP', 'F');
  const door = async (intent) => {
    const signer = { role: 'owner', address: owner };
    return client.post('/api/v1/venue/prepare', { owner, signer, intent });
  };
  const placed = await door(restingIntent(symbol, `order:${owner}:jsp:j20r${RUN}`));
  expect(placed.status, JSON.stringify(placed.body).slice(0, 400)).toBe(200);
  const t = placed.body.prepared.typedData;
  const signature = await privateKeyToAccount(walletKey).signTypedData({
    domain: t.domain,
    types: t.types,
    primaryType: t.primaryType,
    message: t.message,
  });
  const sent = await client.post('/api/v1/venue/submit', {
    actionKey: placed.body.actionKey,
    signature: { digest: placed.body.prepared.digest, signature, signedBy: owner },
  });
  expect(sent.status, JSON.stringify(sent.body).slice(0, 400)).toBe(200);
  expect(sent.body.outcome, JSON.stringify(sent.body.outcome).slice(0, 400)).toMatchObject({ definite: true, accepted: true });
  const order = placed.body.prepared.venueClientOrderId;
  const openOrders = async () => (await venueRecord(owner, '/open-orders')).value.map((o) => o.venueClientOrderId);
  const orderStatus = async () => ((await openOrders()).includes(order) ? 'open' : 'not open');
  const before = { balances: await client.balances(), order: await orderStatus(), own: await ownFunds() };
  expect(before.own.wallet).not.toBe('0');
  expect(toUnits(before.own.venue.total)).toBe(toUnits('50'));
  expect(before.order).toBe('open');
  expect(await restrictions()).not.toContain('trading_restricted');

  // The customer can't ask it, or read its record, through the desk's doors.
  const self = await client.post('/api/support/trpc/requestAccountFreeze', { ticketId: ticket.id, reason: 'TEST' });
  expect(self.status, JSON.stringify(self.body).slice(0, 300)).toBe(403);
  expect(await restrictions()).not.toContain('trading_restricted');

  // The desk asks; svc-identity records it as the account's trading restriction, with its audit row.
  const reason = `TEST ${J} #7 account taken over`;
  const res = await asDesk('lead', 'mutation', 'requestAccountFreeze', { ticketId: ticket.id, reason });
  expect(res.status, `requestAccountFreeze: ${res.text.slice(0, 300)}`).toBe(200);
  const frozen = res.json.result.data;
  expect(frozen).toEqual({
    recordedBy: 'svc-identity',
    userId: client.userId,
    tradingRestricted: true,
    changed: true,
    auditId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    recordedAt: expect.any(String),
  });
  // Asking again from the same request answers the first record.
  const again = (await asDesk('lead', 'mutation', 'requestAccountFreeze', { ticketId: ticket.id, reason })).json.result.data;
  expect(again).toEqual({ ...frozen, changed: false });
  // The audit row, read back from svc-identity through the desk: one row for this request, naming the agent and the reason.
  const audit = async () => lead('query', 'accountFreezeRecords', { ticketId: ticket.id });
  expect(await audit()).toEqual({
    recordedBy: 'svc-identity',
    records: [
      {
        id: frozen.auditId,
        ticketId: ticket.id,
        operatorId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        reason,
        restrictionSet: true,
        recordedAt: frozen.recordedAt,
      },
    ],
  });
  const peek = await client.get(query('accountFreezeRecords', { ticketId: ticket.id }));
  expect(peek.status, JSON.stringify(peek.body).slice(0, 300)).toBe(403);

  // The app refuses the customer's new order with identity's trading restriction: our door prepares nothing for their
  // wallet to sign, and nothing new rests on their venue account.
  const restingBefore = await openOrders();
  const refusedOrder = await door(restingIntent(symbol, `order:${owner}:jsp:j20f${RUN}`));
  expect(refusedOrder.status, JSON.stringify(refusedOrder.body).slice(0, 300)).toBe(403);
  expect(refusedOrder.body.intafacedCode).toBe('trade.account_restricted');
  expect(refusedOrder.body.prepared).toBeUndefined();
  expect(await openOrders()).toEqual(restingBefore);
  // Their agent permission is stopped: svc-agents revoked the consent on identity's announcement of the freeze.
  await expect
    .poll(async () => (await consents()).map((c) => c.state), { timeout: 20_000, message: 'the agent kept its permission' })
    .toEqual(['withdrawn']);
  // Their own funds are untouched: their wallet's TEST USD on the chain and their TEST venue account's USDC, each read
  // where it is held, are as they were; INTAFACED's balances for them are as they were; the order already resting is
  // still theirs, open.
  expect(await ownFunds()).toEqual(before.own);
  expect(await client.balances()).toEqual(before.balances);
  expect(await orderStatus()).toBe('open');

  // Moving the request through pending, on hold and closed never lifts it (a deposit or withdrawal request can't be
  // marked resolved, #4); the walk starts from wherever the request stands now.
  const walk = ['pending', 'on_hold', 'closed'];
  const now = (await lead('query', 'get', { ticketId: ticket.id })).status;
  expect(['open', ...walk.slice(0, -1)]).toContain(now);
  for (const status of walk.slice(walk.indexOf(now) + 1)) {
    const note = status === 'on_hold' ? `TEST ${J} #7 waiting on the customer's identity check` : undefined;
    expect((await lead('mutation', 'setStatus', { ticketId: ticket.id, status, ...(note ? { note } : {}) })).status).toBe(status);
    expect(await restrictions()).toContain('trading_restricted');
  }
  expect(await refused('mutation', 'requestAccountFreeze', { ticketId: ticket.id, reason: 'TEST' })).toContain('support.ticket_closed');
  expect((await audit()).records.map((row) => row.id)).toEqual([frozen.auditId]);
  expect(await client.balances()).toEqual(before.balances);
  expect(await ownFunds()).toEqual(before.own);

  // What the customer sees: their account status names the trading restriction and that they cannot trade.
  await page.goto('/uc/account');
  const shown = page.getByTestId('account-status');
  await expect(shown.getByTestId('account-status__state')).toHaveAttribute('data-state', 'restricted');
  await expect(shown.getByTestId('account-status__restrictions').locator('li[data-kind="trading_restricted"]')).toBeVisible();
  await expect(shown.getByTestId('account-status__cannot').locator('li')).toHaveText(['Trade']);
  await stepPicture();
});
