// World: restart, stack
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { EDGE, ORIGIN, api, fromUnits, journeyState, tool, toUnits } from './stack.mjs';
import { signedHeaders } from './developer.mjs';
import { confirmStepUp, restorePasskey, testPasskey } from './p2p.mjs';
import { testWalletKey } from './test-wallet.mjs';

// J-agents-21, in the running app (docs/roadmap/journeys.json): I let my own AI assistant trade on a capped account I
// can revoke. This file holds the steps built so far (#1 #3 #4 #5 #8 #9 #10 #12 #13 #14 #16 #17 #18 #19 #7), one test per step,
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
// #7 runs last, on the second agent account: the assistant runs the MCP server (packages/assistant-mcp) as its own
// process over stdio with the agent key, and buys TEST spot through its order tool. Not on the first account, because
// the venue takes a spot buy's fee in BTC, and BTC left under one lot would keep #14's close refused. #18 left the
// second account at its daily-loss cap, so the person first sets that cap back to TEST 25.
//
// Not here, under the passing/unbuilt rule: #2 and #6 (the Connect your assistant screen), #11 (the connection's log)
// and #15 (the founder's desk) are later pieces.
//
// #19 acts on the second agent account (#16), with two more agent keys the person makes with end dates through identity's
// API (the same TEST stand-in): the venue's longest agent permission is the TEST venue's own declaration (GET /venue).
//
// #12's Revoke is the person's own two calls, as the connection's screen (a later piece, a design change) will send
// them: identity switches the API key off (developerKeys.revoke), and svc-trade revokes the assistant on the agent
// account (POST /api/v1/venue/agent-accounts/connections/:keyId/revoke), then the wallet signs the venue's revoke.
//
// #14 closes the first agent account, so #16, #17 and #18 act on a second one the person opens the same way (cap TEST 200,
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
async function onSubAccount(session, intent, actionKey = null, subAccount = state().subAccount) {
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

test(`${J} #12 Revokes the assistant while it has a resting TEST order: the next call with the key refuses auth.api_key_revoked; the resting order is cancelled once on the venue; our copy of the venue agent key is dropped and the wallet is asked to sign the venue's revoke; the perp position stays in the agent account`, async () => {
  test.setTimeout(240_000);
  const { session } = await person();
  const { accountId, subAccount } = state();
  const { agentKeyId } = await assistantKey();
  const sub = await acct(owner(), subAccount);
  const agentAddress = body200(await session.get(`${BASE}/${accountId}`)).agentAddress;
  // The perp the assistant opened in #8 is open on the agent account.
  const positions = (await venue('/positions', { account: sub })).value;
  expect(positions).toHaveLength(1);
  expect(positions[0]).toMatchObject({ symbol: 'BTC-PERP', side: 'long' });

  // The assistant rests a TEST limit buy of 0.0002 BTC at 50000, below the book, on the agent account.
  const rest = body200(
    await asAssistant('POST', '/api/v1/venue/agent/orders', {
      clientOrderId: 'revoke-rest',
      symbol: 'BTC-USDC',
      side: 'buy',
      type: 'limit',
      amount: '0.0002',
      price: '50000',
      timeInForce: 'GTC',
    }),
  );
  expect(rest).toMatchObject({ state: 'accepted', origin: `agent:${agentKeyId}`, account: { owner: owner(), subAccount } });
  const cloid = rest.order.venueClientOrderId;
  expect((await venue('/open-orders', { account: sub })).value.map((o) => [o.venueClientOrderId, o.status])).toEqual([[cloid, 'open']]);
  const lockedBefore = toUnits(usdcOf((await venue('/balances', { account: sub })).value).locked);
  // The venue lists the agent permission behind the assistant's key on the agent account.
  expect((await venue('/agents', { account: sub })).value.map((x) => x.address.toLowerCase())).toContain(agentAddress);

  // The person revokes the assistant: identity switches its API key off, and the assistant is revoked on the agent account.
  const off = await session.post('/api/identity/trpc/developerKeys.revoke', { keyId: agentKeyId });
  expect(off.status, JSON.stringify(off.body).slice(0, 300)).toBe(200);
  expect(off.body.result.data.record).toMatchObject({ id: agentKeyId, revoked: true });
  const revoked = body200(await session.post(`${BASE}/connections/${agentKeyId}/revoke`, {}));
  expect(revoked).toMatchObject({ keyId: agentKeyId, accountId, subAccount });

  // The next call with the key refuses auth.api_key_revoked, at the door, before anything is placed.
  const next = await asAssistant('POST', '/api/v1/venue/agent/orders', {
    clientOrderId: 'after-revoke',
    symbol: 'BTC-USDC',
    side: 'buy',
    type: 'limit',
    amount: '0.0002',
    price: '50000',
    timeInForce: 'GTC',
  });
  expect(next.status, JSON.stringify(next.body).slice(0, 300)).toBe(401);
  expect(next.body.intafacedCode).toBe('auth.api_key_revoked');
  refused(
    await session.get(`/api/v1/venue/orders/by-key?actionKey=${encodeURIComponent(`agent:order:${agentKeyId}:after-revoke`)}`),
    404,
    'trade.venue_action_unknown',
  );

  // The resting order is cancelled on the venue, once: the venue's record says canceled, nothing rests, and its lock is
  // released; the revoke names that one cancel.
  expect(revoked.cancels).toEqual([
    { orderKey: `agent:order:${agentKeyId}:revoke-rest`, venueClientOrderId: cloid, symbol: 'BTC-USDC', state: 'cancelled' },
  ]);
  expect((await venue('/order-by-client-id', { account: sub, venueClientOrderId: cloid })).value).toMatchObject({ status: 'canceled' });
  expect((await venue('/open-orders', { account: sub })).value).toEqual([]);
  expect(toUnits(usdcOf((await venue('/balances', { account: sub })).value).locked) < lockedBefore).toBe(true);

  // Our copy of the venue agent key is dropped, and the wallet is asked to sign the venue's revoke of that agent: the
  // person's own wallet, on the agent account.
  expect(revoked.agentKeyDropped).toBe(true);
  expect(revoked.agent).toEqual({ address: agentAddress, onVenue: true });
  expect(revoked.next).toMatchObject({ step: 'revoke_agent', actionKey: `agent:account:${accountId}:revoke`, signed: false });
  expect(revoked.next.prepared.intent).toEqual({ kind: 'revoke_agent', agentAddress });
  expect(revoked.next.prepared.signer).toEqual({ role: 'owner', address: owner() });
  expect(revoked.next.prepared.account).toMatchObject({ owner: owner(), subAccount });
  const signed = body200(
    await session.post(`${BASE}/connections/${agentKeyId}/revoke`, {
      actionKey: revoked.next.actionKey,
      signature: await sign(revoked.next.prepared),
    }),
  );
  expect(signed.agent).toEqual({ address: agentAddress, onVenue: false });
  expect(signed.next).toBeNull();
  expect((await venue('/agents', { account: sub })).value.map((x) => x.address.toLowerCase())).not.toContain(agentAddress);

  // Once: the revoke again sends nothing more, and still names the one cancel.
  const again = body200(await session.post(`${BASE}/connections/${agentKeyId}/revoke`, {}));
  expect(again.cancels).toEqual(revoked.cancels);
  expect(again.next).toBeNull();

  // The perp position stays in the agent account, as the venue reports it.
  expect((await venue('/positions', { account: sub })).value).toEqual(positions);
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

test(`${J} #18 The agent account's loss for the day reaches the daily-loss cap: the assistant's next order is refused naming the cap; open positions are untouched`, async () => {
  test.setTimeout(300_000);
  const { session } = await person();
  const { second } = state();
  const subAcct = await acct(owner(), second.subAccount);
  // The person's own wallet approves our builder fee on the second agent sub-account, once, as #8 did on the first.
  const status = body200(await session.get('/api/v1/venue/status'));
  await onSubAccount(
    session,
    { kind: 'approve_builder_fee', builder: status.builder.address, maxFeeBps: status.builder.feeBps },
    `approve:${second.accountId}:builder`,
    second.subAccount,
  );
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  const todays = async () => (await venue('/fills', { account: subAcct, since: since.toISOString() })).value;
  /** The day's loss from the venue's own fills: realised results less every fee (each in USDC on this perp). */
  const lossOf = (fills) => {
    let result = 0n;
    for (const f of fills) {
      expect(f.feeAsset).toBe('USDC');
      if (f.realisedPnl !== null) result += toUnits(f.realisedPnl);
      result -= toUnits(f.venueFee) + toUnits(f.builderFee);
    }
    return result < 0n ? -result : 0n;
  };
  expect(await todays()).toEqual([]);

  // The assistant opens a TEST 0.0008 BTC-PERP long at 2x (under the per-order cap of 50 and the leverage cap of 2x).
  const open = await asAssistant(
    'POST',
    '/api/v1/venue/agent/orders',
    {
      clientOrderId: 'loss-open',
      symbol: 'BTC-PERP',
      side: 'buy',
      type: 'market',
      amount: '0.0008',
      price: '60100',
      timeInForce: 'IOC',
      leverage: '2',
    },
    'second',
  );
  expect(body200(open).state).toBe('accepted');
  const opened = lossOf(await todays());
  expect(opened > 0n, 'the opening fill cost its fees').toBe(true);

  // The person tightens the daily-loss cap (still under the owner's TEST ceiling) to half again what the day has lost so
  // far, to the cent's ten-thousandth: the day's loss is under it, and the assistant may still order.
  const step = 10n ** 12n;
  const cap = fromUnits((((opened * 3n) / 2n + step - 1n) / step) * step);
  const set = body200(await session.post(`${BASE}/${second.accountId}/limits`, { maxDailyLoss: cap }));
  expect(same(set.limits.maxDailyLoss, cap)).toBe(true);
  expect(opened < toUnits(cap)).toBe(true);

  // The assistant closes three quarters of it across the spread: a realised loss and its fee take the day's loss to the cap.
  const close = await asAssistant(
    'POST',
    '/api/v1/venue/agent/orders',
    {
      clientOrderId: 'loss-close',
      symbol: 'BTC-PERP',
      side: 'sell',
      type: 'market',
      amount: '0.0006',
      price: '59900',
      timeInForce: 'IOC',
      reduceOnly: true,
    },
    'second',
  );
  expect(body200(close).state).toBe('accepted');
  const fills = await todays();
  expect(fills.map((f) => [f.symbol, f.side])).toEqual([
    ['BTC-PERP', 'buy'],
    ['BTC-PERP', 'sell'],
  ]);
  const loss = lossOf(fills);
  expect(loss >= toUnits(cap), `the day's loss ${fromUnits(loss)} reaches the cap ${cap}`).toBe(true);
  const before = await everything(session, second.subAccount);
  expect(before.subPositions).toHaveLength(1);
  expect(before.subPositions[0]).toMatchObject({ symbol: 'BTC-PERP', side: 'long' });
  expect(same(before.subPositions[0].size, '0.0002')).toBe(true);

  // The assistant's next order: refused naming the cap and the day's loss, before anything is set or signed.
  const next = await asAssistant(
    'POST',
    '/api/v1/venue/agent/orders',
    {
      clientOrderId: 'loss-next',
      symbol: 'BTC-PERP',
      side: 'buy',
      type: 'market',
      amount: '0.0001',
      price: '60100',
      timeInForce: 'IOC',
      leverage: '2',
    },
    'second',
  );
  refused(next, 422, 'agents.daily_loss_cap_reached');
  expect(same(next.body.cap, cap)).toBe(true);
  expect(toUnits(next.body.loss)).toBe(loss);
  expect(next.body.message).toContain('daily-loss cap');
  expect(next.body.message).toContain(`USDC`);
  const { agentKeyId } = await assistantKey('second');
  refused(
    await session.get(`/api/v1/venue/orders/by-key?actionKey=${encodeURIComponent(`agent:order:${agentKeyId}:loss-next`)}`),
    404,
    'trade.venue_action_unknown',
  );
  // Open positions untouched: the perp stays as it was, nothing is cancelled, and nothing moved anywhere.
  expect(await everything(session, second.subAccount)).toEqual(before);
});

/** #19: the person makes an agent key with an end date, through identity's API with the TEST passkey, as assistantKey does. */
async function datedAgentKey(session, passkey, tag, name, expiresAt) {
  const options = await session.post('/api/identity/trpc/auth.stepUpOptions', {});
  const challenge = options.body?.result?.data?.challenge;
  expect(challenge, JSON.stringify(options.body).slice(0, 300)).toBeTruthy();
  const made = await session.post('/api/identity/trpc/developerKeys.create', {
    name,
    scopes: ['trade:read', 'trade:write'],
    kind: 'agent',
    expiresAt,
    requestId: `${J}:${run.read().second.accountId}:${tag}-key`,
    factorProof: { webauthn: await passkey.assertion(challenge) },
  });
  run.write({ passkey: passkey.saved() });
  expect(made.status, JSON.stringify(made.body).slice(0, 300)).toBe(200);
  const { record, key, signingSecret } = made.body.result.data;
  expect(record).toMatchObject({ kind: 'agent', scopes: ['trade:read', 'trade:write'] });
  return { keyId: record.id, key, signingSecret };
}

test(`${J} #19 Connects the assistant with an expiry longer than the venue allows, then with a valid one: the first is refused naming the venue's maximum; the second shows its expiry date; after that date the key's calls are refused`, async () => {
  test.setTimeout(300_000);
  const { session, passkey } = await person();
  const { second } = state();
  const venueInfo = (await venue('/venue')).venue;
  const maxMs = venueInfo.agentValidityMaxMs;
  expect(Number.isSafeInteger(maxMs) && maxMs > 0, 'the TEST venue declares its longest agent permission').toBe(true);
  const maxDays = maxMs / 86_400_000;

  // An expiry a day longer than the venue allows: refused naming the venue's maximum, before any step-up is asked, and
  // nothing connected.
  const tooLong = await datedAgentKey(
    session,
    passkey,
    'too-long',
    'TEST assistant (too long)',
    new Date(Date.now() + maxMs + 86_400_000).toISOString(),
  );
  const longRes = refused(
    await session.post(`${BASE}/${second.accountId}/connections`, { keyId: tooLong.keyId }),
    422,
    'agents.key_expiry_above_venue_max',
  );
  expect(longRes.maxDays).toBe(maxDays);
  expect(longRes.message).toContain(`at most ${maxDays} days`);
  expect(longRes.message).toContain(venueInfo.displayName);
  expect(body200(await session.get(`${BASE}/connections`)).connections.map((c) => c.keyId)).not.toContain(tooLong.keyId);

  // A valid one, ending in a minute: connected, and its expiry date shown on the connection and in the list.
  const endsAt = new Date(Date.now() + 60_000).toISOString();
  const valid = await datedAgentKey(session, passkey, 'dated', 'TEST assistant (dated)', endsAt);
  const fields = { keyId: valid.keyId, accountId: second.accountId };
  const stepUpApprovalId = await confirmStepUp(session, passkey, {
    scope: 'trade.step_up.venue.agentConnect',
    purpose: 'venue.agentConnect',
    target: valid.keyId,
    fields,
  });
  run.write({ passkey: passkey.saved() });
  const connected = body200(await session.post(`${BASE}/${second.accountId}/connections`, { keyId: valid.keyId, stepUpApprovalId }));
  expect(connected).toMatchObject({ keyId: valid.keyId, accountId: second.accountId, expiry: { known: true } });
  expect(new Date(connected.expiry.expiresAt).toISOString()).toBe(endsAt);
  const row = body200(await session.get(`${BASE}/connections`)).connections.find((c) => c.keyId === valid.keyId);
  expect(row?.expiry?.known).toBe(true);
  expect(new Date(row.expiry.expiresAt).toISOString()).toBe(endsAt);

  // Before that date the key reaches the assistant's order route: refused there by the account's own daily-loss cap (#18),
  // which is the trade service answering, not the door.
  const order = {
    clientOrderId: 'dated-next',
    symbol: 'BTC-PERP',
    side: 'buy',
    type: 'market',
    amount: '0.0001',
    price: '60100',
    timeInForce: 'IOC',
    leverage: '2',
  };
  const call = async () => {
    const raw = JSON.stringify(order);
    const route = '/api/v1/venue/agent/orders';
    const res = await fetch(`${EDGE}${route}`, {
      method: 'POST',
      headers: {
        origin: ORIGIN,
        authorization: `Bearer ${valid.key}`,
        'content-type': 'application/json',
        ...(valid.signingSecret ? signedHeaders(valid.signingSecret, { method: 'POST', path: route, body: raw }) : {}),
      },
      body: raw,
    });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, body };
  };
  const before = await call();
  expect(Date.now() < Date.parse(endsAt), 'the call before the end date was made before it').toBe(true);
  refused(before, 422, 'agents.daily_loss_cap_reached');

  // After that date the key's calls are refused.
  const wait = Date.parse(endsAt) + 2_000 - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  refused(await call(), 401, 'auth.api_key_expired');
});

// ── #7: the assistant's order through the MCP server (packages/assistant-mcp) ─────────────────────────────────────────

/** The MCP server's source, run by Node as it is (type stripping), as the assistant runs it on its own machine. */
const MCP_SERVER = fileURLToPath(new URL('../../../../packages/assistant-mcp/src/server.ts', import.meta.url));

/**
 * The assistant's own MCP client: the server as its own process over stdio, with the agent key in its environment and
 * nothing else of ours, one JSON-RPC message per line each way.
 */
function mcpClient({ agentKey, agentSecret }) {
  const child = spawn(process.execPath, [MCP_SERVER], {
    env: {
      PATH: process.env.PATH ?? '',
      INTAFACED_API_URL: EDGE,
      INTAFACED_AGENT_KEY: agentKey,
      INTAFACED_AGENT_SIGNING_SECRET: agentSecret ?? '',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const waiting = new Map();
  let buffer = '';
  let stderr = '';
  child.stderr.on('data', (c) => (stderr += c.toString()));
  child.stdout.on('data', (c) => {
    buffer += c.toString();
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      const message = JSON.parse(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      waiting.get(message.id)?.(message);
      waiting.delete(message.id);
    }
  });
  let next = 0;
  return {
    request(method, params) {
      const id = (next += 1);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no answer to ${method} from the MCP server; stderr: ${stderr}`)), 60_000);
        waiting.set(id, (message) => {
          clearTimeout(timer);
          resolve(message);
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) })}\n`);
    },
    close() {
      child.kill();
    },
  };
}

test(`${J} #7 The assistant buys TEST spot through the MCP server's order tool: the fill is on the agent's venue account, as the venue reports it; /trade/orders shows the order tagged "by your assistant"; the main venue account is unchanged`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const { session } = await person();
  const { second, account } = state();
  const { agentKeyId, agentKey, agentSecret } = await assistantKey('second');
  const sub = await acct(owner(), second.subAccount);
  // #18 left this account at its daily-loss cap for today; the person sets the cap back to TEST 25 (under the owner's
  // ceiling, as in #16), so the assistant may order again. Nothing moves.
  expect(same(body200(await session.post(`${BASE}/${second.accountId}/limits`, { maxDailyLoss: '25' })).limits.maxDailyLoss, '25')).toBe(
    true,
  );
  const before = await everything(session, second.subAccount);
  const since = new Date(Date.now() - 1_000).toISOString();
  const btcOf = (balances) => balances.find((b) => b.asset === 'BTC') ?? { total: '0', free: '0', locked: '0' };

  // The assistant's MCP client: the server over stdio, its one order tool, and a TEST market buy of 0.0005 BTC-USDC
  // (30.05 USDC at its worst price, under the per-order cap of 50).
  const mcp = mcpClient({ agentKey, agentSecret });
  let placed;
  try {
    const init = await mcp.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'TEST assistant', version: '0' },
    });
    expect(init.result?.capabilities?.tools, JSON.stringify(init)).toBeTruthy();
    mcp.notify('notifications/initialized');
    const listed = await mcp.request('tools/list', {});
    expect(listed.result.tools.map((t) => t.name)).toEqual(['place_order']);
    placed = await mcp.request('tools/call', {
      name: 'place_order',
      arguments: {
        clientOrderId: 'mcp-spot-buy',
        symbol: 'BTC-USDC',
        side: 'buy',
        type: 'market',
        amount: '0.0005',
        price: '60100',
        timeInForce: 'IOC',
      },
    });
  } finally {
    mcp.close();
  }
  expect(placed.result?.isError, JSON.stringify(placed).slice(0, 600)).toBe(false);
  const answer = placed.result.structuredContent;
  expect(answer).toMatchObject({
    state: 'accepted',
    origin: `agent:${agentKeyId}`,
    account: { owner: owner(), subAccount: second.subAccount },
  });
  const cloid = answer.order.venueClientOrderId;
  expect(cloid).toBeTruthy();

  // The fill is on the agent's venue account, as the venue reports it: its order filled there, its fills there, and the
  // sub-account's BTC rose by exactly what filled less the venue's fee in BTC, its USDC fell by exactly what was paid.
  const venueOrder = (await venue('/order-by-client-id', { account: sub, venueClientOrderId: cloid })).value;
  expect(venueOrder).toMatchObject({ symbol: 'BTC-USDC', side: 'buy', status: 'filled' });
  expect(same(venueOrder.filled, '0.0005')).toBe(true);
  const fills = (await venue('/fills', { account: sub, since })).value.filter((f) => f.venueClientOrderId === cloid);
  expect(fills.length > 0).toBe(true);
  let gotBtc = 0n;
  let paidUsdc = 0n;
  for (const f of fills) {
    expect([f.symbol, f.side, f.feeAsset]).toEqual(['BTC-USDC', 'buy', 'BTC']);
    gotBtc += toUnits(f.amount) - toUnits(f.venueFee) - toUnits(f.builderFee);
    paidUsdc += (toUnits(f.amount) * toUnits(f.price)) / 10n ** 18n;
  }
  const after = await everything(session, second.subAccount);
  expect(toUnits(btcOf(after.sub).total) - toUnits(btcOf(before.sub).total)).toBe(gotBtc);
  expect(toUnits(usdcOf(before.sub).total) - toUnits(usdcOf(after.sub).total)).toBe(paidUsdc);
  // The main venue account is unchanged, as the venue reports it, and so is the person's balance with us.
  expect(after.main).toEqual(before.main);
  expect(after.mainPositions).toEqual(before.mainPositions);
  expect(after.ledger).toEqual(before.ledger);

  // /trade/orders shows the order tagged "by your assistant", with the venue's market, side and amount.
  await signIn(page, account);
  await page.goto('/trade/orders');
  const list = page.getByTestId('assistant-orders');
  await expect(list.getByRole('heading', { name: 'Orders by your assistant' })).toBeVisible();
  const row = list.locator(`tr[data-venue-client-order-id="${cloid}"]`);
  await expect(row).toHaveCount(1);
  await expect(row.locator('td').nth(0)).toHaveText('BTC-USDC');
  await expect(row.locator('td').nth(1)).toHaveText('Buy');
  await expect(row.locator('td').nth(5)).toHaveText('Filled');
  await expect(row.locator('[data-placed-by="assistant"]')).toHaveText('by your assistant');
});
