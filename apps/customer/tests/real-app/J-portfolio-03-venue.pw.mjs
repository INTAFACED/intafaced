// World: book, restart
import { randomBytes } from 'node:crypto';
import { createWalletClient, encodeFunctionData, http, parseAbi, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { api, journeyState } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { CHAIN_ID, fundOnTestChain, testChain } from './dex.mjs';
import { installTestWallet, TEST_WALLET, testWalletKey } from './test-wallet.mjs';
import { setPartner } from './partner.mjs';
import { otherTraderKey, otherTraderRun, testVenue, venueAccount, venueForThisFile, venueInfo, venueRecord } from './venue.mjs';

// J-portfolio-03 #1 on the launch model (OWNER 226; docs/roadmap/journeys.json; project-state operation-zero/modules/
// portfolio/acceptance/journeys.md): "Opens /money/activity" / "Every movement from the wallet, venues and partner in one
// list (trade, deposit, withdrawal, earn, convert, transfer, other), each labelled with its source, in plain words with
// signed amounts and local time". INTAFACED holds none of this person's money: with svc-trade's user-venue door on for
// this file (venueForThisFile), the list is what each place holding it reports, and every expected line is read from that
// place's own record, never from the page: the TEST chain's indexer for the wallet, the stack's TEST venue simulator for
// the venue account, and the TEST partner bank's record (svc-bank `activity.list`, the lines carrying the partner's name).
// The other steps, on our own ledger's feed (the custodial branch, "Later" in the journey's Money line), are
// J-portfolio-03.pw.mjs's.
//
// TEST setup (beforeAll, not a step), so every source has moved money:
// - wallet: TEST USD minted into the TEST wallet on the TEST chain (`fund <address> venue`), then a TEST USD transfer
//   from that wallet to the venue's published deposit address, signed by the wallet's own key;
// - venue: that deposit, which the venue sees and credits after its confirmations, and one TEST buy of BTC the wallet's
//   key signs on the venue, filled against a sell another TEST trader rests there first;
// - partner: the person's bank money moved to the TEST partner bank (`testPartner.set({ custody: 'off' })`) and TEST
//   USDT paid in there (`testPartner.fund`).
// The ledger is read before and after: none of this is posted on it, and the list shows none of its lines.
const J = 'J-portfolio-03';
const SYMBOL = 'BTC-USDC';
const PARTNER_BANK = 'TEST partner bank';
/** The TEST chain's network as the app names it (features/protocol/blockers networkLabel). */
const NETWORK = 'Base Sepolia test network';
const DEPOSIT = '50';
const BUY = { amount: '0.0005', price: '60100' };
const PARTNER_IN = '25';
const run = journeyState(`${J}-venue-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });
venueForThisFile(test);

function state() {
  const s = run.read();
  if (!s.account || !s.walletKey) throw new Error(`${J}'s TEST setup made no account and wallet, so this step has no one to act as`);
  return { ...s, owner: privateKeyToAccount(s.walletKey).address.toLowerCase() };
}

/** A decimal as the list prints it: thousands grouped, no trailing zeros. */
function shown(decimal) {
  const [whole, frac = ''] = String(decimal).split('.');
  const f = frac.replace(/0+$/, '');
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${f ? `.${f}` : ''}`;
}
const SCALE = 10n ** 18n;
const units = (d) => {
  const [w, f = ''] = String(d).split('.');
  const v = BigInt(w.replace('-', '')) * SCALE + BigInt((f + '0'.repeat(18)).slice(0, 18));
  return String(d).startsWith('-') ? -v : v;
};
const decimal = (v) => {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const frac = (a % SCALE).toString().padStart(18, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${a / SCALE}${frac ? `.${frac}` : ''}`;
};

/** The time as the list writes it on this device: "14 Nov, 21:29" (with the year when it is not this year). */
const localTime = (page, iso) =>
  page.evaluate((at) => {
    const ms = Date.parse(at);
    const year = (x) => new Intl.DateTimeFormat('en-GB', { year: 'numeric' }).format(x);
    const text = new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'short',
      ...(year(ms) === year(Date.now()) ? {} : { year: 'numeric' }),
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
      .format(ms)
      .replace(',', '');
    return `${text.slice(0, text.lastIndexOf(' '))}, ${text.slice(text.lastIndexOf(' ') + 1)}`;
  }, iso);

/** The person signs one action on the TEST venue with their own wallet key, as their wallet would (TEST setup only). */
async function signOnVenue(walletKey, intent) {
  const key = privateKeyToAccount(walletKey);
  const owner = key.address.toLowerCase();
  const prepared = await testVenue('/prepare', { account: await venueAccount(owner), signer: { role: 'owner', address: owner }, intent });
  expect(prepared.status, JSON.stringify(prepared.body)).toBe(200);
  const typed = prepared.body.typedData;
  const signature = await key.signTypedData({
    domain: typed.domain,
    types: typed.types,
    primaryType: typed.primaryType,
    message: typed.message,
  });
  const sent = await testVenue('/submit', {
    prepared: prepared.body,
    signature: { digest: prepared.body.digest, signature, signedBy: owner },
  });
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  return sent.body;
}

/** The wallet's own record: its token transfers as the TEST chain's indexer has them, newest first. */
async function walletRecord(who, owner) {
  const session = await api(who);
  const input = encodeURIComponent(JSON.stringify({ chainId: CHAIN_ID, address: owner }));
  const res = await session.get(`/api/indexer/trpc/explorer.address.txs?input=${input}`);
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data;
}

/** The partner's own record of its moves for this person: the bank's lines that carry the partner's name. */
async function partnerRecord(who) {
  const session = await api(who);
  const input = encodeURIComponent(JSON.stringify({ limit: 200 }));
  const res = await session.get(`/api/bank/trpc/activity.list?input=${input}`);
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data.items.filter((item) => item.heldAt);
}

test.beforeAll(async ({ browser }) => {
  if (process.env.JOURNEY_RUN_ID && run.read().account) return;
  test.setTimeout(300_000);
  const page = await browser.newPage();
  try {
    const who = await signUp(page, 'pf3v');
    await verify(page, who);
    const walletKey = testWalletKey();
    run.reset({ account: who, walletKey });
    const session = await api(who);
    const ledgerStart = await session.balances();
    const key = privateKeyToAccount(walletKey);
    const owner = key.address.toLowerCase();
    expect(testChain().chain, 'the stack runs its TEST chain').toBe('running');

    // Wallet: TEST USD minted into it, then sent from it to the venue's deposit address.
    fundOnTestChain(owner, 'venue');
    const door = await session.get('/api/v1/venue/status');
    expect(door.status, JSON.stringify(door.body)).toBe(200);
    const deposit = door.body.deposit;
    expect(deposit, 'the TEST venue publishes where a wallet deposits').toMatchObject({ chainId: CHAIN_ID, asset: 'USDC' });
    const wallet = createWalletClient({
      account: key,
      transport: http(testChain().gateUrl),
      chain: {
        id: CHAIN_ID,
        name: 'TEST',
        nativeCurrency: { name: 'TEST ETH', symbol: 'ETH', decimals: 18 },
        rpcUrls: { default: { http: [testChain().gateUrl] } },
      },
    });
    const txHash = await wallet.sendTransaction({
      to: deposit.token,
      data: encodeFunctionData({
        abi: parseAbi(['function transfer(address to, uint256 amount) returns (bool)']),
        functionName: 'transfer',
        args: [deposit.address, parseUnits(DEPOSIT, deposit.tokenDecimals)],
      }),
    });
    // Venue: the deposit seen and credited after its confirmations (the TEST chain mines a block every second).
    await expect
      .poll(
        async () => (await venueRecord(owner, '/deposits')).value.find((d) => d.txHash.toLowerCase() === txHash.toLowerCase())?.status,
        {
          timeout: 120_000,
        },
      )
      .toBe('credited');

    // Venue: one TEST buy, signed by the wallet's key, against a sell another TEST trader rests first.
    const seller = `${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}-${owner.slice(2, 10)}`;
    await testVenue('/test/deposit', {
      account: await venueAccount(otherTraderKey(seller).address),
      asset: 'BTC',
      amount: '1',
      depositRef: `seed:${seller}:BTC`,
    });
    const rested = await otherTraderRun(seller, {
      kind: 'place_order',
      symbol: SYMBOL,
      side: 'sell',
      type: 'limit',
      amount: BUY.amount,
      price: BUY.price,
      timeInForce: 'GTC',
      reduceOnly: false,
      clientOrderKey: `order:${seller}:pf3-ask-${randomBytes(4).toString('hex')}`,
      builderFee: null,
    });
    expect(rested.definite && rested.accepted, JSON.stringify(rested)).toBe(true);
    const bought = await signOnVenue(walletKey, {
      kind: 'place_order',
      symbol: SYMBOL,
      side: 'buy',
      type: 'limit',
      amount: BUY.amount,
      price: BUY.price,
      timeInForce: 'IOC',
      reduceOnly: false,
      clientOrderKey: `order:${owner}:btc-usdc:pf3${randomBytes(4).toString('hex')}`,
      builderFee: null,
    });
    expect(bought.definite && bought.accepted, JSON.stringify(bought)).toBe(true);
    await expect.poll(async () => (await venueRecord(owner, '/fills', { since: new Date(0).toISOString() })).value.length).toBe(1);

    // Partner: the person's bank money at the TEST partner bank, with TEST USDT paid in there.
    await setPartner(who, { custody: 'off' });
    const tag = `${process.env.JOURNEY_RUN_ID ?? 'local'}${session.userId}`.replace(/[^A-Za-z0-9-]/g, '').slice(-40);
    const funded = await session.post('/api/bank/trpc/testPartner.fund', { fundId: `pf3v-${tag}`, assetId: 'USDT', amount: PARTNER_IN });
    expect(funded.status, JSON.stringify(funded.body)).toBe(200);
    expect(funded.body.result.data).toMatchObject({ label: PARTNER_BANK, assetId: 'USDT' });
    run.write({ ledgerStart, txHash: txHash.toLowerCase() });
  } finally {
    await page.close();
  }
});

test(`${J} #1 opens /money/activity on the launch model: every movement from the wallet, the venue and the partner in one list, each labelled with its source, in plain words with signed amounts and local time`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { account: who, walletKey, owner, ledgerStart, txHash } = state();
  const { displayName: venueName } = await venueInfo();

  // Each source's own record of what moved.
  const chain = await walletRecord(who, owner);
  const walletMoves = chain.rows.flatMap((row) =>
    row.transfers
      .filter((t) => t.direction !== 'self')
      .map((t) => ({
        ref: row.hash.toLowerCase(),
        at: new Date(row.timestamp * 1000).toISOString(),
        direction: t.direction,
        asset: t.token.symbol,
        raw: BigInt(t.amount),
        decimals: t.token.decimals,
      })),
  );
  expect(walletMoves.map((m) => m.direction).sort(), 'the wallet received its TEST USD and sent the deposit').toEqual(['in', 'out']);
  const sentOut = walletMoves.find((m) => m.direction === 'out');
  expect(sentOut.ref).toBe(txHash);
  const fills = (await venueRecord(owner, '/fills', { since: new Date(0).toISOString() })).value;
  const deposits = (await venueRecord(owner, '/deposits')).value;
  expect(fills).toHaveLength(1);
  expect(deposits.map((d) => [d.txHash.toLowerCase(), d.amount, d.status])).toEqual([[txHash, DEPOSIT, 'credited']]);
  const partner = await partnerRecord(who);
  expect(partner.length, 'the partner reports the pay-in').toBeGreaterThan(0);
  for (const line of partner) expect(line.heldAt.label).toBe(PARTNER_BANK);

  // Open Activity with the wallet connected.
  await installTestWallet(page, { chainId: CHAIN_ID, privateKey: walletKey, rpcUrl: testChain().gateUrl });
  await signIn(page, who);
  await page.goto('/money/activity');
  const list = page.getByTestId('activity-by-source');
  await expect(list).toBeVisible({ timeout: 30_000 });
  const address = page.getByTestId('venue-wallet-address');
  const connect = page.getByRole('button', { name: `Connect ${TEST_WALLET.name}` });
  await expect(async () => {
    if (await address.isVisible()) return;
    await connect.click({ timeout: 2_000 });
    await expect(address).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 30_000 });

  const rows = list.getByTestId('money-act');
  const expected = walletMoves.length + fills.length + deposits.length + partner.length;
  // One list: exactly one row per movement the sources report, and nothing else (no line of our own ledger).
  await expect(rows).toHaveCount(expected, { timeout: 30_000 });
  await expect(list.locator('[data-testid="money-act"][data-source="wallet"]')).toHaveCount(walletMoves.length);
  await expect(list.locator('[data-testid="money-act"][data-source="venue"]')).toHaveCount(fills.length + deposits.length);
  await expect(list.locator('[data-testid="money-act"][data-source="partner"]')).toHaveCount(partner.length);
  // Every row is labelled with its source.
  await expect(list.getByTestId('money-act__source')).toHaveCount(expected);

  /** The one row a source's reference names, with its words, signed amount, local time and source label. */
  async function rowSays(source, ref, { title, amount, at, label, sub = null, kind }) {
    const row = list.locator(`[data-testid="money-act"][data-source="${source}"][data-ref="${ref}"]`);
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute('data-kind', kind);
    await expect(row.getByTestId('money-act__title')).toHaveText(title);
    await expect(row.locator('[data-direction]').first()).toHaveText(amount);
    await expect(row.getByTestId('money-act__time').locator('time')).toHaveAttribute('datetime', new Date(at).toISOString());
    await expect(row.getByTestId('money-act__time')).toHaveText(await localTime(page, at));
    await expect(row.getByTestId('money-act__source')).toHaveText(label);
    await expect(row.getByTestId('money-act__status')).toHaveText('Completed');
    if (sub) await expect(row.getByTestId('money-act__sub').first()).toHaveText(sub);
    return row;
  }

  // Wallet: what it received and what it sent, on its network, as the chain's indexer has them.
  for (const move of walletMoves) {
    const amount = decimal((move.raw * SCALE) / 10n ** BigInt(move.decimals));
    await rowSays('wallet', move.ref, {
      kind: move.direction === 'in' ? 'transfer_in' : 'transfer_out',
      title: move.direction === 'in' ? 'Received in your wallet' : 'Sent from your wallet',
      amount: `${move.direction === 'in' ? '+' : '−'}${shown(amount)} ${move.asset}`,
      at: move.at,
      label: `Your wallet on ${NETWORK}`,
    });
  }

  // Venue: the deposit it credited and the fill, as the venue records them, with what was paid and the fee.
  const venueLabel = `Your venue account on ${venueName} TEST`;
  for (const d of deposits)
    await rowSays('venue', d.txHash.toLowerCase(), {
      kind: 'deposit',
      title: 'Deposit to your venue account',
      amount: `+${shown(d.amount)} ${d.asset}`,
      at: d.seenAt,
      label: venueLabel,
    });
  for (const f of fills) {
    const [base, quote] = f.symbol.split('-');
    const paid = decimal((units(f.price) * units(f.amount) + SCALE - 1n) / SCALE);
    const fee = units(f.venueFee) + units(f.builderFee);
    const feeText = fee === 0n ? '' : ` · ${fee < 0n ? 'Rebate' : 'Fee'} ${shown(decimal(fee < 0n ? -fee : fee))} ${f.feeAsset}`;
    await rowSays('venue', f.fillId, {
      kind: 'trade',
      title: `${f.side === 'buy' ? 'Bought' : 'Sold'} ${base}`,
      amount: `${f.side === 'buy' ? '+' : '−'}${shown(f.amount)} ${base}`,
      at: f.filledAt,
      label: venueLabel,
      sub: `${f.side === 'buy' ? 'Paid' : 'Got'} ${shown(paid)} ${quote}${feeText}`,
    });
  }
  // Partner: each move it reports, named with the partner.
  for (const p of partner)
    await rowSays('partner', p.txId, {
      kind: ['deposit', 'withdrawal', 'transfer_in', 'transfer_out', 'space_move', 'fee', 'earn'].includes(p.kind) ? p.kind : 'other',
      title: p.kind === 'deposit' ? 'Deposit' : /.+/,
      amount: `${p.direction === 'in' ? '+' : '−'}${shown(p.amount)} ${p.asset}`,
      at: p.postedAt,
      label: `Your account at ${PARTNER_BANK}`,
    });

  // One list, newest first across the sources.
  const times = await rows.locator('time').evaluateAll((els) => els.map((el) => Date.parse(el.getAttribute('datetime'))));
  expect(times).toEqual([...times].sort((a, b) => b - a));
  // Each source's note names where its lines were read.
  await expect(list.locator('[data-testid="money-source-note"][data-source="wallet"]')).toHaveText(
    /^Your wallet’s token transfers, read from the chain at block \d+\.$/,
  );
  await expect(list.locator('[data-testid="money-source-note"][data-source="venue"]')).toContainText(`as ${venueName} reports them at`);
  await expect(list.locator('[data-testid="money-source-note"][data-source="partner"]')).toHaveText(
    `Your account’s movements, as ${PARTNER_BANK} reports them.`,
  );

  // Money: the list's per-source totals are the movements each source reports, and our own ledger posted nothing.
  const sum = (texts) =>
    texts.reduce((acc, text) => {
      const [signed, asset] = text.trim().split(/\s+/);
      const v = units(signed.replace('+', '').replace('−', '-').replaceAll(',', ''));
      acc[asset] = (acc[asset] ?? 0n) + v;
      return acc;
    }, {});
  const amountsOf = (source) =>
    list.locator(`[data-testid="money-act"][data-source="${source}"] td.money-num [data-direction]`).allInnerTexts();
  const venueSum = sum(await amountsOf('venue'));
  expect(venueSum.USDC).toBe(deposits.reduce((acc, d) => acc + units(d.amount), 0n));
  expect(venueSum.BTC).toBe(fills.reduce((acc, f) => acc + (f.side === 'buy' ? 1n : -1n) * units(f.amount), 0n));
  const partnerSum = sum(await amountsOf('partner'));
  expect(partnerSum.USDT).toBe(partner.reduce((acc, p) => acc + (p.direction === 'in' ? 1n : -1n) * units(p.amount), 0n));
  expect(await (await api(who)).balances()).toEqual(ledgerStart);
});

test.afterAll(async () => {
  const s = run.read();
  if (s.account) await setPartner(s.account, { custody: 'on' }).catch(() => undefined);
});
