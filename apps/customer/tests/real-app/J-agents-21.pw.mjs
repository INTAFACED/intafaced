// World: restart, stack
import { randomUUID } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { signUp, verify } from './desk.mjs';
import { EDGE, ORIGIN, api, journeyState, tool, toUnits } from './stack.mjs';
import { signedHeaders } from './developer.mjs';
import { confirmStepUp, restorePasskey, testPasskey } from './p2p.mjs';
import { testWalletKey } from './test-wallet.mjs';

// J-agents-21, in the running app (docs/roadmap/journeys.json): I let my own AI assistant trade on a capped account I
// can revoke. This file holds the steps built so far (#1 #3 #4 #5 #8 #9 #10 #13 #14 #16 #17), one test per step,
// titled "J-agents-21 #<n>", run in order by one signed-in, verified TEST person with one TEST wallet key (kept in this
// run's state) on the stack's TEST venue simulator (tooling/scripts/local-test-venue.mjs). Every figure the TEST venue
// reports is TEST.
//
// Every call goes through Edge to svc-trade's user-venue door (`/api/v1/venue/...`, on with TRADE_USER_VENUE_URL, which
// the stack sets with LOCAL_STACK_USER_VENUE=on), the way the /agents/connect screen will call it; the person's wallet
// is the TEST key signing the venue's own EIP-712 payloads, as the browser wallet does. The screen is a later piece, a
// design change shown to the owner first. The TEST venue's own record is read directly on loopback for what the venue
// reports.
//
// The assistant (#8 #9 #10) is played by this test, calling Edge with the agent API key as an outside assistant would,
// signing each request with the key's signing secret. Its key is made and connected to the agent account through the
// API (identity's developerKeys.create with the TEST passkey, then the connection with step-up): a labelled TEST
// stand-in for #6's Connect screen, which is a later piece. #13 closes against the perp the assistant opened in #8.
//
// Not here, under the passing/unbuilt rule: #2 and #6 (the Connect your assistant screen), #7 (the MCP server's order
// tool), #11 #12 (the connection's log and revoke), #15 (the founder's desk), #18 (the daily-loss cap reached) and #19
// (the key's expiry) are later pieces.
//
// #14 closes the first agent account, so #16 and #17 act on a second one the person opens the same way (cap TEST 200,
// funded 100), with a second assistant key connected to it by the same TEST stand-in.
//
// Switches: the door is on for this file only (trade restarts with LOCAL_STACK_USER_VENUE=on, and back off after). #1
// restarts trade once more with LOCAL_STACK_AGENT_ACCOUNT_CEILING=off (tooling/scripts/local-stack-services/trade.mjs),
// so the owner's ceiling is blank for that restart, and puts it back.

const J = 'J-agents-21';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
/** The stack's TEST venue (local-test-stack.mjs PORTS['test-venue']). */
const TEST_VENUE = 'http://127.0.0.1:14560';
const BASE = '/api/v1/venue/agent-accounts';
const STEP_UP = { scope: 'trade.step_up.venue.agentAccount', purpose: 'venue.agentAccount' };

test.describe.configure({ mode: 'default' });

/** svc-trade restarted with these stack settings set for the restart only; this process's environment is put back. */
function restartTrade(settings) {
  const before = Object.fromEntries(Object.keys(settings).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(settings)) {
    if (v === null) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    tool('local-test-stack.mjs', 'restart', 'trade');
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

let doorOn = false;
const doorOffOnExit = () => {
  if (!doorOn) return;
  doorOn = false;
  try {
    restartTrade({ LOCAL_STACK_USER_VENUE: 'off' });
  } catch {
    /* the worker is exiting: a failed switch-off has no one left to report to */
  }
};
test.beforeAll(() => {
  test.setTimeout(240_000);
  doorOn = true;
  process.once('exit', doorOffOnExit);
  restartTrade({ LOCAL_STACK_USER_VENUE: 'on' });
});
test.afterAll(() => {
  test.setTimeout(240_000);
  restartTrade({ LOCAL_STACK_USER_VENUE: 'off' });
  doorOn = false;
  process.off('exit', doorOffOnExit);
});

/** One call to the TEST venue: its JSON answer. Amounts travel as decimal strings. */
async function venue(path, body) {
  const res = await fetch(`${TEST_VENUE}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  expect(res.status, JSON.stringify(json)).toBe(200);
  return json;
}
const venueId = async () => (await venue('/venue')).venue.id;
const acct = async (owner, subAccount = null) => ({ venueId: await venueId(), owner, subAccount });
/** The venue's own USDC total for the account, as it reports it. */
async function venueUsdc(owner, subAccount = null) {
  const body = await venue('/balances', { account: await acct(owner, subAccount) });
  return body.value.find((b) => b.asset === 'USDC')?.total ?? '0';
}
const same = (a, b) => toUnits(String(a)) === toUnits(String(b));

function state() {
  const s = run.read();
  if (!s.account || !s.walletKey) throw new Error(`${J} #1 made no account and wallet, so this step has no one to act as`);
  return s;
}
const wallet = () => privateKeyToAccount(state().walletKey);
const owner = () => wallet().address.toLowerCase();

/** The person's wallet signs a prepared venue action: the venue's own EIP-712 payload. */
async function sign(prepared) {
  const t = prepared.typedData;
  const signature = await wallet().signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
  return { digest: prepared.digest, signature, signedBy: owner() };
}

/** The person's own session (through Edge), and the TEST passkey their step-ups answer with. */
async function person() {
  const s = state();
  const session = await api(s.account);
  return { session, passkey: s.passkey ? await restorePasskey(s.passkey) : null };
}

/** A step-up for one agent account: its id, venue account, asset, cap and first funding. */
async function stepUpFor(session, passkey, fields) {
  const id = await confirmStepUp(session, passkey, { ...STEP_UP, target: fields.accountId, amount: fields.fund, fields });
  run.write({ passkey: passkey.saved() });
  return id;
}

const body200 = (res) => {
  expect(res.status, JSON.stringify(res.body).slice(0, 600)).toBe(200);
  return res.body;
};
const refused = (res, status, code) => {
  expect(res.status, JSON.stringify(res.body).slice(0, 600)).toBe(status);
  expect(res.body.intafacedCode).toBe(code);
  return res.body;
};

test(`${J} #1 With the owner's agent-account ceiling switched off for one restart, presses Create agent account: refused agents.account_ceiling_unset; no account made`, async ({
  page,
}) => {
  test.setTimeout(420_000);
  const account = await signUp(page, 'jagents21');
  await verify(page, account);
  run.reset({ account, walletKey: testWalletKey() });
  // The journey's start: TEST 1000 USDC in the wallet's own main venue account, by the TEST venue's deposit control.
  const credited = await venue('/test/deposit', {
    account: await acct(owner()),
    asset: 'USDC',
    amount: '1000',
    depositRef: `j-agents-21:${account.handle}:usdc`,
  });
  expect(credited.credited).toBe(true);
  expect(same(await venueUsdc(owner()), '1000')).toBe(true);

  const subsBefore = (await venue('/sub-accounts', { account: await acct(owner()) })).value;
  restartTrade({ LOCAL_STACK_USER_VENUE: 'on', LOCAL_STACK_AGENT_ACCOUNT_CEILING: 'off' });
  try {
    const { session } = await person();
    const terms = body200(await session.get(`${BASE}/terms`));
    expect(terms.ceiling).toBeNull();
    const accountId = randomUUID();
    const res = await session.post(BASE, { accountId, owner: owner(), asset: 'USDC', cap: '200', fund: '150' });
    refused(res, 422, 'agents.account_ceiling_unset');
    // No account made: none listed, nothing asked of the venue, nothing moved.
    expect(body200(await session.get(BASE)).accounts).toEqual([]);
    refused(await session.get(`${BASE}/${accountId}`), 404, 'agents.account_unknown');
    expect((await venue('/sub-accounts', { account: await acct(owner()) })).value).toEqual(subsBefore);
    expect(same(await venueUsdc(owner()), '1000')).toBe(true);
  } finally {
    restartTrade({ LOCAL_STACK_USER_VENUE: 'on', LOCAL_STACK_AGENT_ACCOUNT_CEILING: null });
  }
  const { session } = await person();
  expect(body200(await session.get(`${BASE}/terms`)).ceiling).not.toBeNull();
});

test(`${J} #3 Creates an agent account with a cap of TEST 200 USDC and funds it with 150, with step-up: a venue sub-account under the wallet; the wallet signs the move of 150 and the agent permission; balance 150.00 as the venue reports it, cap 200.00; the main venue account falls by exactly 150.00; a rejected signature moves nothing and makes no account`, async () => {
  test.setTimeout(300_000);
  const { session } = await person();
  const passkey = await testPasskey(session);
  run.write({ passkey: passkey.saved() });
  const ledgerBefore = await session.balances();
  const mainBefore = await venueUsdc(owner());
  const subsBefore = (await venue('/sub-accounts', { account: await acct(owner()) })).value;
  const terms = body200(await session.get(`${BASE}/terms`));
  expect(terms.asset).toBe('USDC');

  // Without step-up: refused, nothing made.
  const bare = await session.post(BASE, { accountId: randomUUID(), owner: owner(), asset: 'USDC', cap: '200', fund: '150' });
  refused(bare, 403, 'identity.step_up_required');
  expect(body200(await session.get(BASE)).accounts).toEqual([]);

  // A rejected signature: the wallet is asked to open the sub-account and the person rejects it. Nothing is sent, the
  // person ends it, and nothing moved and no account was made.
  const rejectedId = randomUUID();
  const fields = (accountId) => ({ accountId, owner: owner(), asset: 'USDC', cap: '200', fund: '150' });
  const asked = body200(
    await session.post(BASE, { ...fields(rejectedId), stepUpApprovalId: await stepUpFor(session, passkey, fields(rejectedId)) }),
  );
  expect(asked.status).toBe('opening');
  expect(asked.next.step).toBe('open_sub_account');
  const ended = body200(await session.post(`${BASE}/${rejectedId}/abandon`, {}));
  expect(ended.status).toBe('abandoned');
  expect(ended.subAccount).toBeNull();
  expect((await venue('/sub-accounts', { account: await acct(owner()) })).value).toEqual(subsBefore);
  expect(same(await venueUsdc(owner()), mainBefore)).toBe(true);
  // Its prepared action is never sent afterwards.
  refused(
    await session.post(`${BASE}/${rejectedId}/submit`, { actionKey: asked.next.actionKey, signature: await sign(asked.next.prepared) }),
    409,
    'agents.account_not_open',
  );
  expect(body200(await session.get(BASE)).accounts.filter((a) => a.status === 'open')).toEqual([]);

  // The account: cap 200, first funding 150, with step-up.
  const accountId = randomUUID();
  let view = body200(
    await session.post(BASE, { ...fields(accountId), stepUpApprovalId: await stepUpFor(session, passkey, fields(accountId)) }),
  );
  const signed = [];
  for (let i = 0; view.next && i < 5; i += 1) {
    signed.push(view.next);
    view = body200(
      await session.post(`${BASE}/${accountId}/submit`, { actionKey: view.next.actionKey, signature: await sign(view.next.prepared) }),
    );
  }
  // The wallet signed, on its own main account: opening the sub-account, the agent permission for that sub-account (a
  // key that is not the wallet), and the move of 150 from the main venue account into it, under agent:move:<moveId>.
  expect(signed.map((s) => s.step)).toEqual(['open_sub_account', 'approve_agent', 'move_in']);
  expect(signed.every((s) => s.prepared.signer.role === 'owner' && s.prepared.signer.address === owner())).toBe(true);
  const [open, approve, move] = signed.map((s) => s.prepared);
  expect(open.intent.kind).toBe('create_sub_account');
  expect(open.account.subAccount).toBeNull();
  expect(approve.intent.kind).toBe('approve_agent');
  expect(approve.account.subAccount).toBe(view.subAccount);
  expect(approve.intent.agentAddress).not.toBe(owner());
  expect(move.intent).toMatchObject({
    kind: 'sub_account_transfer',
    direction: 'into_sub_account',
    asset: 'USDC',
    subAccount: view.subAccount,
  });
  expect(same(move.intent.amount, '150')).toBe(true);
  expect(signed[2].actionKey).toBe(`agent:move:${accountId}`);
  expect(move.intent.moveKey).toBe(`agent:move:${accountId}`);

  // A venue sub-account under the person's wallet, with the agent permission on it and not on the main account.
  expect(view.status).toBe('open');
  const subs = (await venue('/sub-accounts', { account: await acct(owner()) })).value;
  expect(subs.map((s) => s.subAccount)).toContain(view.subAccount);
  expect((await venue('/agents', { account: await acct(owner(), view.subAccount) })).value.map((a) => a.address)).toEqual([
    approve.intent.agentAddress,
  ]);
  expect((await venue('/agents', { account: await acct(owner()) })).value.map((a) => a.address)).not.toContain(approve.intent.agentAddress);
  // The agent account reads balance 150.00, as the venue reports it, and cap 200.00.
  const venueSub = await venueUsdc(owner(), view.subAccount);
  expect(same(venueSub, '150.00')).toBe(true);
  expect(same(view.balances.value.find((b) => b.asset === 'USDC').total, venueSub)).toBe(true);
  expect(same(view.cap, '200.00')).toBe(true);
  // The main venue account falls by exactly 150.00, as the venue reports it.
  expect(toUnits(mainBefore) - toUnits(await venueUsdc(owner()))).toBe(toUnits('150'));
  // The move was sent once: its venue transfer record is one move of 150 under the signed nonce; sending the same signed
  // bytes again moves nothing more.
  const transfer = (await venue('/transfer', { account: await acct(owner()), nonce: move.nonce })).value;
  expect(transfer).toMatchObject({ subAccount: view.subAccount, direction: 'into_sub_account', asset: 'USDC', status: 'done' });
  expect(same(transfer.amount, '150')).toBe(true);
  refused(
    await session.post(`${BASE}/${accountId}/submit`, { actionKey: `agent:move:${accountId}`, signature: await sign(move) }),
    409,
    'agents.account_not_open',
  );
  expect(same(await venueUsdc(owner(), view.subAccount), '150')).toBe(true);
  // INTAFACED holds and moves nothing: our ledger posted nothing for any of it.
  expect(await session.balances()).toEqual(ledgerBefore);
  run.write({ accountId, subAccount: view.subAccount });
});

test(`${J} #4 Funds 100 more: refused agents.account_cap_exceeded naming 50.00 of room, before the wallet is asked to sign; nothing moves`, async () => {
  const { session } = await person();
  const { accountId, subAccount } = state();
  const before = { main: await venueUsdc(owner()), sub: await venueUsdc(owner(), subAccount) };
  const moveId = randomUUID();
  const res = refused(await session.post(`${BASE}/${accountId}/fund`, { moveId, amount: '100' }), 422, 'agents.account_cap_exceeded');
  expect(same(res.room, '50.00')).toBe(true);
  expect(res.message).toContain('50 USDC of room');
  // Before the wallet is asked: nothing to sign, and no move kept under its key.
  const view = body200(await session.get(`${BASE}/${accountId}`));
  expect(view.next).toBeNull();
  expect(view.moves.map((m) => m.actionKey)).toEqual([`agent:move:${accountId}`]);
  expect(same(view.room, '50')).toBe(true);
  // Nothing moves.
  expect({ main: await venueUsdc(owner()), sub: await venueUsdc(owner(), subAccount) }).toEqual(before);
});

test(`${J} #5 Raises the cap above the owner's TEST ceiling: refused agents.account_cap_above_ceiling naming the ceiling; the cap stays 200.00`, async () => {
  const { session } = await person();
  const { accountId } = state();
  const terms = body200(await session.get(`${BASE}/terms`));
  const above = String(toUnits(terms.ceiling) / 10n ** 18n + 1n);
  const res = refused(await session.post(`${BASE}/${accountId}/cap`, { cap: above }), 422, 'agents.account_cap_above_ceiling');
  expect(same(res.ceiling, terms.ceiling)).toBe(true);
  expect(res.message).toContain(`ceiling of ${terms.ceiling}`);
  expect(same(body200(await session.get(`${BASE}/${accountId}`)).cap, '200.00')).toBe(true);
});

/** The person's own wallet signs one action on the agent sub-account through the plain door. */
async function onSubAccount(session, intent, actionKey = null) {
  const { subAccount } = state();
  const prepared = body200(
    await session.post('/api/v1/venue/prepare', {
      owner: owner(),
      subAccount,
      signer: { role: 'owner', address: owner() },
      intent,
      actionKey,
    }),
  );
  const sent = body200(
    await session.post('/api/v1/venue/submit', { actionKey: prepared.actionKey, signature: await sign(prepared.prepared) }),
  );
  expect(sent.outcome).toMatchObject({ definite: true, accepted: true });
  return sent;
}
const PERP = { kind: 'place_order', symbol: 'BTC-PERP', type: 'market', amount: '0.001', timeInForce: 'IOC', builderFee: null };

// ── The assistant (#8 #9 #10): the test plays the person's own outside assistant, holding the agent API key ──────────

/**
 * TEST stand-in for #6 (its Connect screen is a later piece): the person makes an agent key with trade scopes through
 * identity's API, answering the fresh-factor check with their TEST passkey, and connects it to the agent account with
 * step-up. Kept in this run's state; made once.
 */
async function assistantKey(which = 'first') {
  const s = state();
  if (which !== 'first') {
    if (!s.second) throw new Error(`${J} #16 opened no second agent account, so this step has no account to trade`);
    if (s.second.agentKey) return { ...s, ...s.second };
  } else if (s.agentKey) return s;
  const target = which === 'first' ? { accountId: s.accountId, subAccount: s.subAccount } : s.second;
  const { session, passkey } = await person();
  const options = await session.post('/api/identity/trpc/auth.stepUpOptions', {});
  const challenge = options.body?.result?.data?.challenge;
  expect(challenge, JSON.stringify(options.body).slice(0, 300)).toBeTruthy();
  const asked = {
    name: which === 'first' ? 'TEST assistant' : `TEST assistant (${which})`,
    scopes: ['trade:read', 'trade:write'],
    kind: 'agent',
  };
  const made = await session.post('/api/identity/trpc/developerKeys.create', {
    ...asked,
    requestId: `${J}:${target.accountId}:assistant-key`,
    factorProof: { webauthn: await passkey.assertion(challenge) },
  });
  run.write({ passkey: passkey.saved() });
  expect(made.status, JSON.stringify(made.body).slice(0, 300)).toBe(200);
  const { record, key, signingSecret } = made.body.result.data;
  expect(record).toMatchObject({ kind: 'agent', scopes: ['trade:read', 'trade:write'] });
  const fields = { keyId: record.id, accountId: target.accountId };
  const stepUpApprovalId = await confirmStepUp(session, passkey, {
    scope: 'trade.step_up.venue.agentConnect',
    purpose: 'venue.agentConnect',
    target: record.id,
    fields,
  });
  run.write({ passkey: passkey.saved() });
  const connected = body200(await session.post(`${BASE}/${target.accountId}/connections`, { keyId: record.id, stepUpApprovalId }));
  expect(connected).toMatchObject({ keyId: record.id, accountId: target.accountId, subAccount: target.subAccount });
  const keys = { agentKey: key, agentKeyId: record.id, agentSecret: signingSecret };
  if (which === 'first') run.write(keys);
  else run.write({ second: { ...target, ...keys } });
  return assistantKey(which);
}

/** One call to Edge as the assistant: its agent key, each request signed with the key's signing secret. */
async function asAssistant(method, route, body, which = 'first') {
  const { agentKey, agentSecret } = await assistantKey(which);
  const raw = body === undefined ? undefined : JSON.stringify(body);
  const res = await fetch(`${EDGE}${route}`, {
    method,
    headers: {
      origin: ORIGIN,
      authorization: `Bearer ${agentKey}`,
      ...(raw ? { 'content-type': 'application/json' } : {}),
      ...(agentSecret ? signedHeaders(agentSecret, { method, path: route, body: raw ?? '' }) : {}),
    },
    body: raw,
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

/** Everything a step must leave as it was: both venue accounts as the venue reports them, and our ledger. */
async function everything(session, subAccount = state().subAccount) {
  return {
    main: (await venue('/balances', { account: await acct(owner()) })).value,
    mainPositions: (await venue('/positions', { account: await acct(owner()) })).value,
    sub: (await venue('/balances', { account: await acct(owner(), subAccount) })).value,
    subPositions: (await venue('/positions', { account: await acct(owner(), subAccount) })).value,
    subOrders: (await venue('/open-orders', { account: await acct(owner(), subAccount) })).value,
    ledger: await session.balances(),
  };
}
const usdcOf = (balances) => balances.find((b) => b.asset === 'USDC') ?? { total: '0', free: '0', locked: '0' };

test(`${J} #8 The assistant opens a TEST perp position: opened isolated on the agent's venue account, its margin taken there by the venue and from nowhere else`, async () => {
  test.setTimeout(240_000);
  const { session } = await person();
  const { accountId, subAccount } = state();
  // The person's own wallet approves our builder fee on the agent sub-account, once, as on any account they trade
  // (a perp carries our builder fee; the assistant's key can't sign an approval).
  const status = body200(await session.get('/api/v1/venue/status'));
  await onSubAccount(
    session,
    { kind: 'approve_builder_fee', builder: status.builder.address, maxFeeBps: status.builder.feeBps },
    `approve:${accountId}:builder`,
  );
  const { agentKeyId } = await assistantKey();
  const before = await everything(session);
  expect(before.subPositions).toEqual([]);

  // The assistant opens a TEST 0.001 BTC-PERP long at 1x through our API with its agent key.
  const res = await asAssistant('POST', '/api/v1/venue/agent/orders', {
    clientOrderId: 'perp-open',
    symbol: 'BTC-PERP',
    side: 'buy',
    type: 'market',
    amount: '0.001',
    price: '60100',
    timeInForce: 'IOC',
    leverage: '1',
  });
  expect(res.status, JSON.stringify(res.body).slice(0, 600)).toBe(200);
  expect(res.body).toMatchObject({ state: 'accepted', origin: `agent:${agentKeyId}`, account: { owner: owner(), subAccount } });

  // Isolated, on the agent's venue account, as the venue reports it: its setting on the market and its one position.
  const setting = (await venue('/leverage', { account: await acct(owner(), subAccount), symbol: 'BTC-PERP' })).value;
  expect(setting).toMatchObject({ symbol: 'BTC-PERP', leverageBps: 10000, marginMode: 'isolated' });
  const positions = (await venue('/positions', { account: await acct(owner(), subAccount) })).value;
  expect(positions).toHaveLength(1);
  expect(positions[0]).toMatchObject({ symbol: 'BTC-PERP', side: 'long', leverageBps: 10000, marginMode: 'isolated' });
  expect(same(positions[0].size, '0.001')).toBe(true);
  expect(toUnits(positions[0].margin) > 0n).toBe(true);
  // Its margin taken there by the venue: the sub-account's USDC used as margin is exactly the position's margin, and its
  // free USDC fell by exactly that margin and the fees on the venue's own fill, no more.
  const sub = usdcOf((await venue('/balances', { account: await acct(owner(), subAccount) })).value);
  expect(toUnits(sub.locked) - toUnits(usdcOf(before.sub).locked)).toBe(toUnits(positions[0].margin));
  // Every fill the agent sub-account has ever had: this one.
  const fills = (await venue('/fills', { account: await acct(owner(), subAccount), since: '2020-01-01T00:00:00.000Z' })).value;
  expect(fills.map((f) => [f.symbol, f.side])).toEqual([['BTC-PERP', 'buy']]);
  expect(fills[0].feeAsset).toBe('USDC');
  const fees = toUnits(fills[0].venueFee) + toUnits(fills[0].builderFee);
  expect(toUnits(usdcOf(before.sub).free) - toUnits(sub.free)).toBe(toUnits(positions[0].margin) + fees);
  // And from nowhere else: the main venue account and our ledger are exactly as they were.
  expect((await venue('/balances', { account: await acct(owner()) })).value).toEqual(before.main);
  expect((await venue('/positions', { account: await acct(owner()) })).value).toEqual(before.mainPositions);
  expect(await session.balances()).toEqual(before.ledger);
  // The person's own record of it names the assistant's key as its origin.
  const read = body200(
    await session.get(`/api/v1/venue/orders/by-key?actionKey=${encodeURIComponent(`agent:order:${agentKeyId}:perp-open`)}`),
  );
  expect(read).toMatchObject({ state: 'accepted', origin: `agent:${agentKeyId}` });
});

test(`${J} #9 The assistant tries to move money, withdraw, read the main account and pay by card: each of the four calls refused auth.scope_denied; no balance changes`, async () => {
  test.setTimeout(180_000);
  const { session } = await person();
  const { accountId, subAccount } = state();
  const { agentKeyId } = await assistantKey();
  const before = await everything(session);
  const agentAddress = body200(await session.get(`${BASE}/${accountId}`)).agentAddress;
  const calls = {
    // Move money: the agent account's balance back to the main venue account.
    'move money': ['POST', `${BASE}/${accountId}/withdraw`, { moveId: randomUUID(), amount: '10' }],
    // Withdraw: a venue withdrawal from the agent account to the wallet.
    withdraw: [
      'POST',
      '/api/v1/venue/prepare',
      {
        owner: owner(),
        subAccount,
        signer: { role: 'agent', address: agentAddress },
        intent: { kind: 'withdraw', asset: 'USDC', amount: '10', destination: owner(), withdrawalKey: `withdraw:${agentKeyId}:try` },
      },
    ],
    // Read the main account: the main venue account's balances.
    'read the main account': ['GET', `/api/v1/venue/balances?owner=${owner()}`],
    // Pay by card: confirm a card payment.
    'pay by card': ['POST', '/api/bank/trpc/cards.threeDS.answer', { cardId: randomUUID(), challengeId: randomUUID(), code: '123456' }],
  };
  for (const [what, [method, route, body]] of Object.entries(calls)) {
    const res = await asAssistant(method, route, body);
    expect(res.status, `${what}: ${JSON.stringify(res.body).slice(0, 400)}`).toBe(403);
    expect(res.body?.intafacedCode ?? res.body?.code, what).toBe('auth.scope_denied');
  }
  // No balance changes: both venue accounts, the position, and our ledger are exactly as they were.
  expect(await everything(session)).toEqual(before);
  // Nothing was kept to sign or send: no move beyond the first funding, and nothing next for the wallet.
  const view = body200(await session.get(`${BASE}/${accountId}`));
  expect(view.next).toBeNull();
  expect(view.moves.map((m) => m.actionKey)).toEqual([`agent:move:${accountId}`]);
});

test(`${J} #10 The assistant places an order costing more than the agent account holds: the venue's insufficient-margin refusal, shown in words with the venue named; nothing locked; the main venue account never drawn`, async () => {
  test.setTimeout(180_000);
  const { session } = await person();
  await assistantKey();
  const before = await everything(session);
  const venueName = (await venue('/venue')).venue.displayName;
  // TEST 0.0016 BTC-PERP at 1x: about 96 USDC of margin, inside the cap of 200 with the open position and inside the
  // owner's largest assistant order, but more than the agent account holds free.
  expect(toUnits(usdcOf(before.sub).free) < toUnits('96.16')).toBe(true);
  const res = await asAssistant('POST', '/api/v1/venue/agent/orders', {
    clientOrderId: 'perp-too-big',
    symbol: 'BTC-PERP',
    side: 'buy',
    type: 'market',
    amount: '0.0016',
    price: '60100',
    timeInForce: 'IOC',
    leverage: '1',
  });
  expect(res.status, JSON.stringify(res.body).slice(0, 600)).toBe(422);
  expect(res.body.intafacedCode).toBe('trade.venue.insufficient_balance');
  expect(res.body.venue.displayName).toBe(venueName);
  // In words, with the venue named: the venue's own reason, that its free USDC does not cover the margin.
  expect(res.body.message).toContain(venueName);
  expect(res.body.message).toContain('margin');
  expect(res.body.refusal.detail).toContain('margin');
  // Nothing locked, and the main venue account never drawn: both accounts, the position and our ledger as they were.
  expect(await everything(session)).toEqual(before);
});

test(`${J} #13 Presses Close agent account while the perp is still open: refused, naming the open position; nothing changes`, async () => {
  test.setTimeout(180_000);
  const { session } = await person();
  const { accountId, subAccount } = state();
  // The perp the assistant opened in #8 is still open on the agent sub-account.
  const positions = (await venue('/positions', { account: await acct(owner(), subAccount) })).value;
  expect(positions).toHaveLength(1);
  const before = { positions, sub: await venue('/balances', { account: await acct(owner(), subAccount) }), main: await venueUsdc(owner()) };

  const res = refused(await session.post(`${BASE}/${accountId}/close`, {}), 409, 'agents.account_close_open_position');
  expect(res).toMatchObject({ symbol: 'BTC-PERP', side: 'long' });
  expect(same(res.size, '0.001')).toBe(true);
  expect(res.message).toContain('BTC-PERP');
  // Nothing changes: the account stays open, the position and both balances are as they were.
  expect(body200(await session.get(`${BASE}/${accountId}`)).status).toBe('open');
  expect((await venue('/positions', { account: await acct(owner(), subAccount) })).value).toEqual(before.positions);
  expect((await venue('/balances', { account: await acct(owner(), subAccount) })).value).toEqual(before.sub.value);
  expect(await venueUsdc(owner())).toBe(before.main);
});

test(`${J} #14 Closes the perp, moves the agent account's balance back and closes the account: the wallet signs the move back; the main venue account rises by exactly what the venue reports moved; the agent account reads Closed`, async () => {
  test.setTimeout(180_000);
  const { session } = await person();
  const { accountId, subAccount } = state();
  const ledgerBefore = await session.balances();
  await onSubAccount(session, { ...PERP, side: 'sell', price: '59900', reduceOnly: true, clientOrderKey: `order:${accountId}:perp:close` });
  expect((await venue('/positions', { account: await acct(owner(), subAccount) })).value).toEqual([]);

  // Move back what the venue reports free in the sub-account.
  const left = (await venue('/balances', { account: await acct(owner(), subAccount) })).value.find((b) => b.asset === 'USDC');
  expect(toUnits(left.locked)).toBe(0n);
  const mainBefore = await venueUsdc(owner());
  const moveId = randomUUID();
  let view = body200(await session.post(`${BASE}/${accountId}/withdraw`, { moveId, amount: left.free }));
  expect(view.next).toMatchObject({ step: 'move_out', actionKey: `agent:move:${moveId}` });
  const moveBack = view.next.prepared;
  expect(moveBack.intent).toMatchObject({ kind: 'sub_account_transfer', direction: 'out_of_sub_account', asset: 'USDC', subAccount });
  expect(moveBack.signer).toEqual({ role: 'owner', address: owner() });
  view = body200(await session.post(`${BASE}/${accountId}/submit`, { actionKey: `agent:move:${moveId}`, signature: await sign(moveBack) }));
  expect(view.moves.find((m) => m.moveId === moveId).state).toBe('done');
  const moved = (await venue('/transfer', { account: await acct(owner()), nonce: moveBack.nonce })).value;
  expect(moved).toMatchObject({ direction: 'out_of_sub_account', status: 'done' });
  expect(toUnits(await venueUsdc(owner())) - toUnits(mainBefore)).toBe(toUnits(moved.amount));
  expect(toUnits(await venueUsdc(owner(), subAccount))).toBe(0n);

  const closed = body200(await session.post(`${BASE}/${accountId}/close`, {}));
  expect(closed.status).toBe('closed');
  const listed = body200(await session.get(BASE)).accounts.find((a) => a.accountId === accountId);
  expect(listed.status).toBe('closed');
  refused(await session.post(`${BASE}/${accountId}/fund`, { moveId: randomUUID(), amount: '1' }), 409, 'agents.account_not_open');
  // Our ledger posted nothing for any of it.
  expect(await session.balances()).toEqual(ledgerBefore);
});

test(`${J} #16 Sets a per-order size cap, a daily-loss cap and a leverage cap on the agent account, each under the owner's TEST ceiling: the three caps are saved and shown with the funding cap`, async () => {
  test.setTimeout(300_000);
  const { session, passkey } = await person();
  // #14 closed the first agent account: the person opens a second the same way, cap TEST 200 funded with 100.
  const accountId = randomUUID();
  const fields = { accountId, owner: owner(), asset: 'USDC', cap: '200', fund: '100' };
  let view = body200(await session.post(BASE, { ...fields, stepUpApprovalId: await stepUpFor(session, passkey, fields) }));
  for (let i = 0; view.next && i < 5; i += 1) {
    view = body200(
      await session.post(`${BASE}/${accountId}/submit`, { actionKey: view.next.actionKey, signature: await sign(view.next.prepared) }),
    );
  }
  expect(view.status).toBe('open');
  run.write({ second: { accountId, subAccount: view.subAccount } });
  expect(view.limits).toEqual({ maxOrderNotional: null, maxLeverage: null, maxDailyLoss: null });

  // The owner's TEST ceilings for the three caps, and the person's caps under each.
  const { limitCeilings } = body200(await session.get(`${BASE}/terms`));
  const caps = { maxOrderNotional: '50', maxLeverage: '2', maxDailyLoss: '25' };
  for (const [name, value] of Object.entries(caps)) {
    expect(limitCeilings[name], name).not.toBeNull();
    expect(toUnits(value) < toUnits(limitCeilings[name]), `${name} ${value} under ${limitCeilings[name]}`).toBe(true);
  }
  const before = await everything(session, view.subAccount);
  const set = body200(await session.post(`${BASE}/${accountId}/limits`, caps));
  // The three caps are saved and shown with the funding cap: read back on the account and in the list.
  for (const shown of [
    set,
    body200(await session.get(`${BASE}/${accountId}`)),
    body200(await session.get(BASE)).accounts.find((a) => a.accountId === accountId),
  ]) {
    expect(same(shown.limits.maxOrderNotional, '50.00')).toBe(true);
    expect(shown.limits.maxLeverage).toBe('2');
    expect(same(shown.limits.maxDailyLoss, '25.00')).toBe(true);
    expect(same(shown.cap, '200.00')).toBe(true);
  }
  // Setting caps moves nothing and asks the wallet for nothing.
  expect(set.next).toBeNull();
  expect(await everything(session, view.subAccount)).toEqual(before);
});

test(`${J} #17 The assistant sends an order above the per-order cap, then one above the leverage cap: each refused naming the cap, before anything is signed`, async () => {
  test.setTimeout(240_000);
  const { session } = await person();
  const { second } = state();
  const { agentKeyId } = await assistantKey('second');
  const before = await everything(session, second.subAccount);
  const leverageBefore = (await venue('/leverage', { account: await acct(owner(), second.subAccount), symbol: 'BTC-PERP' })).value;

  // Above the per-order cap: TEST 0.001 BTC at 60100 is 60.10 USDC, over the person's cap of 50 (inside the funding cap
  // and the owner's largest assistant order).
  const size = await asAssistant(
    'POST',
    '/api/v1/venue/agent/orders',
    { clientOrderId: 'over-size', symbol: 'BTC-USDC', side: 'buy', type: 'limit', amount: '0.001', price: '60100', timeInForce: 'IOC' },
    'second',
  );
  refused(size, 422, 'agents.order_size_cap_exceeded');
  expect(same(size.body.cap, '50')).toBe(true);
  expect(size.body.message).toContain('per-order size cap');
  expect(size.body.message).toContain('50 USDC');

  // Above the leverage cap: a TEST perp at 3x, its size inside the per-order cap, over the person's leverage cap of 2x.
  const lev = await asAssistant(
    'POST',
    '/api/v1/venue/agent/orders',
    {
      clientOrderId: 'over-leverage',
      symbol: 'BTC-PERP',
      side: 'buy',
      type: 'market',
      amount: '0.0005',
      price: '60100',
      timeInForce: 'IOC',
      leverage: '3',
    },
    'second',
  );
  refused(lev, 422, 'agents.leverage_cap_exceeded');
  expect(lev.body.cap).toBe('2');
  expect(lev.body.message).toContain('leverage cap');
  expect(lev.body.message).toContain('2x');

  // Before anything is signed: no order is kept under either order's key, the venue shows no leverage set for the perp
  // and no new order or position, and nothing moved on either venue account or in our ledger.
  for (const key of [`agent:order:${agentKeyId}:over-size`, `agent:order:${agentKeyId}:over-leverage`]) {
    refused(await session.get(`/api/v1/venue/orders/by-key?actionKey=${encodeURIComponent(key)}`), 404, 'trade.venue_action_unknown');
  }
  expect((await venue('/leverage', { account: await acct(owner(), second.subAccount), symbol: 'BTC-PERP' })).value).toEqual(leverageBefore);
  expect(await everything(session, second.subAccount)).toEqual(before);
});
