// World: book, restart
import { randomBytes } from 'node:crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { api, journeyState } from './stack.mjs';
import { keyHolder, makeKey, withKey } from './developer.mjs';
import { testWalletKey } from './test-wallet.mjs';
import { testDeposit, venueForThisFile, venueRecord } from './venue.mjs';

// J-cex-spot-15, the steps a developer's bot takes through our API on the venue (docs/roadmap/journeys.json): one test
// per step, titled "J-cex-spot-15 #<n>". The journey's start is made once, as TEST setup: a verified TEST account with
// a live Trade key made in the browser, its TEST wallet, and one agent permission the wallet signed for the bot's own
// agent key (an `approve_agent` on the person's venue account, through the person's signed-in session: an API key can
// never approve an agent). From then on the bot is a program holding only the API key and the agent key: every call
// goes straight to Edge with the key, and every order it sends is signed by the agent key. The venue is the record of
// every order; the ledger posts nothing. Every figure is TEST.
const J = 'J-cex-spot-15';
const RUN = process.env.JOURNEY_RUN_ID ?? 'local';
const run = journeyState(`${J}-api-${RUN}`);
const SYMBOL = 'BTC-USDC';
/** A TEST limit buy resting under the TEST ladder and inside the venue's price band, so it stays open on the venue. */
const BUY = { amount: '0.001', price: '59000' };

test.describe.configure({ mode: 'default' });
venueForThisFile(test);

function state() {
  const s = run.read();
  if (!s.key || !s.walletKey || !s.agentKey)
    throw new Error(`${J}'s TEST setup made no key, wallet and agent permission, so there is no bot`);
  const owner = privateKeyToAccount(s.walletKey).address.toLowerCase();
  const agent = privateKeyToAccount(s.agentKey);
  return { ...s, owner, agent, agentAddress: agent.address.toLowerCase() };
}

/** The prepared payload, signed by one key: the bot's own signing, no SDK. */
async function signWith(account, prepared) {
  const t = prepared.typedData;
  const signature = await account.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
  return { digest: prepared.digest, signature, signedBy: account.address.toLowerCase() };
}

/** Prepare, sign with `signerAccount` and submit one action through the API key, as the bot sends it. */
async function send(s, intent, signerAccount = s.agent) {
  const prepared = await withKey(s.key, {
    method: 'POST',
    path: '/api/v1/venue/prepare',
    body: { owner: s.owner, signer: { role: 'agent', address: signerAccount.address.toLowerCase() }, intent },
  });
  if (prepared.status !== 200) return { prepared, sent: null };
  const signature = await signWith(signerAccount, prepared.body.prepared);
  const sent = await withKey(s.key, {
    method: 'POST',
    path: '/api/v1/venue/submit',
    body: { actionKey: prepared.body.actionKey, signature },
  });
  return { prepared, signature, sent };
}

const buy = (clientOrderKey) => ({
  kind: 'place_order',
  symbol: SYMBOL,
  side: 'buy',
  type: 'limit',
  amount: BUY.amount,
  price: BUY.price,
  timeInForce: 'GTC',
  reduceOnly: false,
  builderFee: null,
  clientOrderKey,
});

/** The bot reads its order by its own client id: the venue's record of it. */
const lookUp = (s, clientOrderKey) =>
  withKey(s.key, {
    path: `/api/v1/venue/orders/by-client-id?owner=${s.owner}&clientOrderKey=${encodeURIComponent(clientOrderKey)}`,
  });

/**
 * TEST setup, not a journey step (the journey's Starts): a verified passkey account, one live Trade key made through
 * /uc/safe/api-keys/new, this run's TEST wallet with TEST 1000 USDC on its own venue account (the TEST venue's deposit
 * control), and the agent permission: the wallet signs `approve_agent` for a fresh agent key the bot holds.
 */
test.beforeAll(async ({ browser }) => {
  if (process.env.JOURNEY_RUN_ID && run.read().agentKey) return;
  test.setTimeout(300_000);
  const { page, who } = await keyHolder(browser, 'cs15a');
  try {
    const key = await makeKey(page, { name: 'spot-bot' });
    expect(key).toBeTruthy();
    const walletKey = testWalletKey();
    const wallet = privateKeyToAccount(walletKey);
    const owner = wallet.address.toLowerCase();
    expect(await testDeposit(owner, 'USDC', '1000', `84532:0x${randomBytes(32).toString('hex')}:0`)).toBe(true);
    const agentKey = generatePrivateKey();
    const agentAddress = privateKeyToAccount(agentKey).address.toLowerCase();
    const person = await api(who);
    const actionKey = `bot-agent:${person.userId}:${J}:${RUN}`;
    const prepared = await person.post('/api/v1/venue/prepare', {
      owner,
      signer: { role: 'owner', address: owner },
      intent: { kind: 'approve_agent', agentAddress, agentName: 'TEST spot bot', validUntil: null },
      actionKey,
    });
    expect(prepared.status, JSON.stringify(prepared.body)).toBe(200);
    const approved = await person.post('/api/v1/venue/submit', { actionKey, signature: await signWith(wallet, prepared.body.prepared) });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.outcome).toMatchObject({ definite: true, accepted: true });
    run.reset({ who, key, walletKey, agentKey });
  } finally {
    await page.close();
  }
});

test(`${J} #5 places an order with a client id through our API, looks it up by client id, cancels by client id: the venue order, then its state, then its cancel; a repeat returns the first outcome; the API signs with the user's agent permission only`, async () => {
  test.setTimeout(180_000);
  const s = state();
  // The agent permission is on the venue's own record of the account: the bot's key, named, approved by the wallet.
  const agents = (await venueRecord(s.owner, '/agents')).value;
  expect(agents.map((a) => a.address)).toContain(s.agentAddress);
  const clientId = `bot:${RUN}:${test.info().retry}:${Date.now().toString(36)}`;

  // ── Place: one venue order, under the bot's client id, signed by the agent key ──────────────────────────────────
  const placed = await send(s, buy(clientId));
  expect(placed.prepared.status, JSON.stringify(placed.prepared.body)).toBe(200);
  expect(placed.prepared.body.prepared.intent.clientOrderKey).toBe(clientId);
  expect(placed.sent.status, JSON.stringify(placed.sent.body)).toBe(200);
  expect(placed.sent.body.outcome).toMatchObject({ definite: true, accepted: true });
  const venueOrderId = placed.sent.body.outcome.order.venueOrderId;
  expect(venueOrderId).toBeTruthy();
  expect(placed.signature.signedBy).toBe(s.agentAddress);
  const cloid = placed.prepared.body.prepared.venueClientOrderId;
  const onVenue = (await venueRecord(s.owner, '/open-orders')).value.filter((o) => o.venueClientOrderId === cloid);
  expect(onVenue).toHaveLength(1);
  expect(onVenue[0]).toMatchObject({ venueOrderId, status: 'open', symbol: SYMBOL, side: 'buy' });

  // ── Look up by client id: the venue's own state of that order ──────────────────────────────────────────────────
  const found = await lookUp(s, clientId);
  expect(found.status, JSON.stringify(found.body)).toBe(200);
  expect(found.body.value).toMatchObject({ venueOrderId, venueClientOrderId: cloid, status: 'open', symbol: SYMBOL, side: 'buy' });
  expect(Number(found.body.value.amount)).toBe(Number(BUY.amount));
  expect(Number(found.body.value.price)).toBe(Number(BUY.price));

  // ── A repeat of the same client id returns the first outcome, and the venue still has one order ────────────────
  const again = await send(s, buy(clientId));
  expect(again.prepared.status, JSON.stringify(again.prepared.body)).toBe(200);
  expect(again.prepared.body).toMatchObject({ reused: true, signed: true });
  expect(again.sent.status, JSON.stringify(again.sent.body)).toBe(200);
  expect(again.sent.body.outcome).toEqual(placed.sent.body.outcome);
  expect((await venueRecord(s.owner, '/open-orders')).value.filter((o) => o.venueClientOrderId === cloid)).toHaveLength(1);

  // ── Cancel by client id, signed by the agent key: the venue's cancel, then the order's state reads cancelled ───
  const cancel = { kind: 'cancel_order', symbol: SYMBOL, clientOrderKey: clientId };
  const cancelled = await send(s, cancel);
  expect(cancelled.prepared.status, JSON.stringify(cancelled.prepared.body)).toBe(200);
  expect(cancelled.sent.status, JSON.stringify(cancelled.sent.body)).toBe(200);
  expect(cancelled.sent.body.outcome).toMatchObject({ definite: true, accepted: true });
  expect(cancelled.signature.signedBy).toBe(s.agentAddress);
  const after = await lookUp(s, clientId);
  expect(after.status, JSON.stringify(after.body)).toBe(200);
  expect(after.body.value).toMatchObject({ venueOrderId, status: 'canceled' });
  expect((await venueRecord(s.owner, '/open-orders')).value.filter((o) => o.venueClientOrderId === cloid)).toHaveLength(0);
  // A repeat of the cancel returns the first cancel's outcome; nothing more is sent.
  const cancelAgain = await send(s, cancel);
  expect(cancelAgain.prepared.body).toMatchObject({ reused: true, signed: true });
  expect(cancelAgain.sent.body.outcome).toEqual(cancelled.sent.body.outcome);

  // ── The agent permission only: a key the wallet never approved can't place, and the agent key can't withdraw ──
  const stranger = privateKeyToAccount(generatePrivateKey());
  const unapproved = await send(s, buy(`${clientId}:stranger`), stranger);
  // Refused before anything is signed: the venue lists no such agent on the account.
  expect(unapproved.prepared.status, JSON.stringify(unapproved.prepared.body)).toBe(422);
  expect(unapproved.prepared.body.intafacedCode).toBe('trade.venue.signer_not_authorised');
  expect(unapproved.sent).toBeNull();
  // Nothing of it rests on the venue: the account has no open order at all after the bot's cancel.
  expect((await venueRecord(s.owner, '/open-orders')).value).toHaveLength(0);
  const usdcBefore = (await venueRecord(s.owner, '/balances')).value.find((b) => b.asset === 'USDC');
  const withdraw = await send(s, {
    kind: 'withdraw',
    asset: 'USDC',
    amount: '10',
    destination: s.owner,
    withdrawalKey: `withdraw:${RUN}:${clientId}`,
  });
  // A withdrawal is the wallet's alone: an API key can never even prepare one.
  expect(withdraw.prepared.status, JSON.stringify(withdraw.prepared.body)).toBe(403);
  expect(withdraw.prepared.body.intafacedCode).toBe('scope.interactive_only');
  expect(withdraw.sent).toBeNull();
  expect((await venueRecord(s.owner, '/balances')).value.find((b) => b.asset === 'USDC')).toEqual(usdcBefore);
});
