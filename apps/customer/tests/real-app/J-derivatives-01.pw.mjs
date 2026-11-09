// World: book, restart
import { test, expect } from './journey.mjs';
import { api, journeyState, toUnits } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { installTestWallet, testWalletKey, TEST_WALLET } from './test-wallet.mjs';
import { CHAIN_ID } from './dex.mjs';
import { testVenue, venueBalance, venueFills, venueOff, venueOn, venuePositions, venueRead, venueStatus, VENUE_PERP } from './venue.mjs';

// J-derivatives-01, in the running app (docs/roadmap/journeys.json): open a first futures position with isolated
// margin, watch it, close 40 percent and then the rest. One test per step, titled "J-derivatives-01 #<n>", run in order
// on one TEST account. The venue steps open the position in the person's own venue account on the LOCAL TEST venue's
// BTC-PERP and read every figure from the venue (venue.mjs), never from our ledger or engine. No agreement, knowledge
// check or notice gates it (owner decision 2026-10-27). Every number is a TEST number on the local stack.
const J = 'J-derivatives-01';
const DESK = '/trade/futures';
const SYMBOL = 'BTC/USDT:USDT';
const SIZE = '0.01';
const LEVERAGE = '5';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });

// The venue's own figures need the user-venue door on, in front of the LOCAL TEST venue (venue.mjs); it is put back
// off after the file, as every other journey expects it.
test.beforeAll(() => venueOn());
test.afterAll(() => venueOff());

function account() {
  const who = run.read().account;
  if (!who) throw new Error(`${J} #1 made no account, so this step has no one to act as`);
  return who;
}

async function desk(page) {
  await signIn(page, account());
  await page.goto(DESK);
  await expect(page.getByRole('button', { name: 'Open long' })).toBeVisible();
}

const access = (page) => page.getByTestId('futures-access');

async function positionsOf(who) {
  const { status, body } = await (await api(who)).get('/api/v1/positions');
  expect(status).toBe(200);
  return body;
}

/** Every write the page sends from now on (the steps that must send nothing read it back). */
function writes(page) {
  const sent = [];
  page.on('request', (r) => {
    if (r.method() !== 'GET' && r.url().includes('/api/')) sent.push(`${r.method()} ${r.url()}`);
  });
  return sent;
}

/** The person's TEST wallet in `page`: one TEST key for the whole run, kept in the run file (mode 600). */
async function personWallet(page) {
  let { walletKey } = run.read();
  if (!walletKey) {
    walletKey = testWalletKey();
    run.write({ walletKey });
  }
  return installTestWallet(page, { chainId: CHAIN_ID, privateKey: walletKey });
}

/** The futures desk with the person's TEST wallet connected to their venue account. */
async function venueDesk(page) {
  const wallet = await personWallet(page);
  await signIn(page, account());
  await page.goto(DESK);
  const connect = page.getByRole('button', { name: `Connect ${TEST_WALLET.name}` });
  const shown = page.getByText(`${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}`).first();
  // The wallet announces itself after the desk paints: wait for either the Connect button or the connected address.
  await expect(connect.or(shown)).toBeVisible();
  if (await connect.isVisible()) await connect.click();
  await expect(shown).toBeVisible();
  return { wallet, owner: wallet.address.toLowerCase() };
}

/** The figure a review or row lists next to `label` (its dt/dd pair). */
const listed = (scope, label) => scope.locator('dt', { hasText: label }).first().locator('xpath=following-sibling::dd[1]');

/** A number as the desk draws it, as scaled units. */
function shownUnits(text) {
  const found = /[+−-]?[\d,]+(\.\d+)?/.exec(text.replace(/\$/g, ''));
  if (!found) throw new Error(`no number in "${text}"`);
  return toUnits(found[0].replace(/,/g, '').replace('−', '-').replace('+', ''));
}

const units = (value) => {
  if (typeof value !== 'string') throw new Error(`not a decimal string on the wire: ${JSON.stringify(value)}`);
  return toUnits(value);
};

test(`${J} #1 opens /trade/futures: the full desk with the contracts each venue lists for this account and region, each with its venue named`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const who = await signUp(page, 'jd');
  await verify(page, who);
  run.reset({ account: who });
  const status = await venueStatus(who);
  // The person's own venue account holds TEST 1000 USDC (the Starts line), credited by the venue's own TEST deposit
  // control, never through our ledger.
  const { owner } = await venueDesk(page);
  run.write({ owner });
  const credited = await testVenue('/test/deposit', {
    account: { venueId: status.venue.id, owner, subAccount: null },
    asset: 'USDC',
    amount: '1000',
    depositRef: `test-start:${owner}:1000`,
  });
  expect(credited.status, JSON.stringify(credited.body)).toBe(200);
  expect(toUnits((await venueBalance(who, owner, 'USDC')).free)).toBe(toUnits('1000'));
  // The full desk.
  await expect(page.getByRole('region', { name: 'Order ticket' })).toBeVisible();
  for (const tab of ['Positions', 'Orders', 'History']) await expect(page.getByRole('tab', { name: tab })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Chart' })).toBeVisible();
  // The contracts the venue lists for this account, each with its venue named.
  const { status: read, body: markets } = await (await api(who)).get('/api/v1/venue/markets');
  expect(read, JSON.stringify(markets).slice(0, 300)).toBe(200);
  const perps = markets.value.filter((m) => m.kind === 'perpetual');
  expect(perps.map((m) => m.symbol)).toContain(VENUE_PERP);
  const picker = page.getByRole('combobox', { name: 'Choose a contract' });
  await picker.click();
  for (const m of perps) {
    const option = page.getByRole('option', { name: new RegExp(m.symbol) });
    await expect(option).toBeVisible();
    await expect(option).toContainText(status.venue.displayName);
  }
  await page.keyboard.press('Escape');
  // A venue that is down is named, and its controls give a typed refusal.
  const down = await testVenue('/test/switches', { venueDown: true });
  expect(down.status).toBe(200);
  try {
    await page.reload();
    await expect(page.getByText(new RegExp(`${status.venue.displayName}.*(down|unavailable|not answering)`, 'i')).first()).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.locator('[data-code="trade.venue.venue_down"]').first()).toBeVisible();
  } finally {
    await testVenue('/test/switches', { venueDown: false });
  }
});

// The legal and suitability reasons the list used to carry. None of them is a reason any more (owner decision 2026-10-27).
const LEGAL_CODES = ['trade.derivatives_eligibility_unset', 'trade.agreement_required', 'trade.adl_disclosure_required'];

test(`${J} #2 reads the gated list: each contract open or blocked as the service says, with each reason; no legal step is a reason`, async ({
  page,
}) => {
  const who = account();
  await desk(page);
  const panel = access(page);
  // The screen shows what the service says for this account, contract by contract: each one in the service's gated
  // list, chosen on the desk, reads open or blocked as the service says, and a blocked one names each of its reasons
  // by code. No legal step is ever among them.
  const { status, body } = await (await api(who)).get('/api/v1/account/gated-list');
  expect(status).toBe(200);
  expect(body.contracts.length, 'the gated list names the contracts').toBeGreaterThan(0);
  // The desk offers the live listings (never a paper one): every contract it offers is in the gated list.
  const picker = page.getByRole('combobox', { name: 'Choose a contract' });
  await picker.click();
  // The list opens in a popup drawn after the click, and allInnerTexts reads at once without waiting: read the options
  // once the stack's TEST perpetual is on screen among them, or a slow frame reads none (run 1138, #7112).
  await expect(page.getByRole('option', { name: SYMBOL, exact: true })).toBeVisible();
  const offered = (await page.getByRole('option').allInnerTexts()).map((o) => o.trim());
  await page.keyboard.press('Escape');
  expect(offered).toContain(SYMBOL);
  const listed = body.contracts.map((c) => c.symbol);
  for (const symbol of offered) expect(listed, `${symbol} is offered but not in the gated list`).toContain(symbol);
  for (const contract of body.contracts.filter((c) => offered.includes(c.symbol))) {
    await picker.click();
    await page.getByRole('option', { name: contract.symbol, exact: true }).click();
    // The desk has switched to this contract before its gate is read.
    await expect(picker).toContainText(contract.symbol);
    const gate = panel.getByTestId('futures-gate');
    await expect(gate, contract.symbol).toContainText(contract.open ? 'Open for your account' : 'Blocked for your account');
    for (const blocker of contract.blockers) await expect(gate.locator(`[data-code="${blocker.code}"]`), contract.symbol).toBeVisible();
    await expect(gate.locator('[data-code]')).toHaveCount(contract.blockers.length);
    for (const code of LEGAL_CODES) {
      expect(contract.blockers.map((b) => b.code)).not.toContain(code);
      await expect(gate.locator(`[data-code="${code}"]`)).toHaveCount(0);
    }
  }
  // This verified account may trade the stack's TEST perpetual.
  expect(body.contracts.find((c) => c.symbol === SYMBOL)).toMatchObject({ open: true, blockers: [] });
});

// Step 3 was "reads and accepts the risk agreement and margin terms". Deferred until launch prep (owner decision
// 2026-10-27): this step proves nothing asks for an agreement, a knowledge check or the auto-deleveraging notice.
test(`${J} #3 nothing asks for a risk agreement, a knowledge check or a notice before an open`, async ({ page }) => {
  const who = account();
  const me = await api(who);
  await desk(page);
  const panel = access(page);
  await expect(panel.getByText('Open for your account')).toBeVisible();
  await expect(page.getByTestId('agreement-derivatives_risk')).toHaveCount(0);
  await expect(page.getByTestId('agreement-margin_terms')).toHaveCount(0);
  await expect(page.getByTestId('futures-quiz')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'I have read this' })).toHaveCount(0);
  // The customer doors for them are gone.
  expect((await me.get('/api/v1/account/agreements')).status).toBe(404);
  expect((await me.get('/api/v1/account/derivatives-eligibility')).status).toBe(404);
  expect(await positionsOf(who)).toHaveLength(0);
});

test(`${J} #4 picks the contract and reads its strip: family, settle asset, contract size, mark and funding`, async ({ page }) => {
  await desk(page);
  const strip = page.getByRole('region', { name: SYMBOL, exact: true });
  await expect(strip.getByText('Perpetual · Linear')).toBeVisible();
  await expect(strip.getByText('Settles in')).toBeVisible();
  await expect(strip).toContainText('USDT');
  await expect(strip.getByText('0.001 BTC')).toBeVisible();
  await expect(strip.getByText('Mark price')).toBeVisible();
  await expect(strip.getByText(/^\d{1,3}(,\d{3})*\.\d{2}$/).first()).toBeVisible();
  // Funding: the rate the service publishes, or a dash that says it is not published. Never an invented rate.
  await expect(strip.getByText('Funding rate')).toBeVisible();
  const markets = (await (await api(account())).get('/api/v1/markets?limit=500')).body;
  const listed = markets.find((m) => m.symbol === SYMBOL);
  expect([listed.family, listed.settleAsset, listed.contractSize]).toEqual(['linear', 'USDT', '0.001']);
});

test(`${J} #5 chooses the margin mode: the modes the venue offers, the others "not offered by this venue", nothing changes`, async ({
  page,
}) => {
  const who = account();
  const { owner } = run.read();
  await venueDesk(page);
  const sent = writes(page);
  const { body: markets } = await (await api(who)).get('/api/v1/venue/markets');
  const perp = markets.value.find((m) => m.symbol === VENUE_PERP);
  expect(perp.marginModes).toEqual(['isolated']);
  const mode = page.getByRole('group', { name: 'Margin mode' });
  await expect(mode.getByRole('button', { name: 'Isolated' })).toHaveAttribute('aria-pressed', 'true');
  await mode.getByRole('button', { name: 'Cross' }).click();
  await expect(page.getByText('not offered by this venue').first()).toBeVisible();
  await expect(mode.getByRole('button', { name: 'Isolated' })).toHaveAttribute('aria-pressed', 'true');
  expect(sent).toEqual([]);
  // Nothing changes on the venue.
  expect((await venueRead(who, 'leverage', owner, { symbol: VENUE_PERP })).value).toBeNull();
});

async function fillTicket(page) {
  const ticket = page.getByRole('region', { name: 'Order ticket' });
  await ticket.getByRole('textbox', { name: 'Size' }).fill(SIZE);
  await ticket.getByRole('textbox', { name: 'Leverage' }).fill(LEVERAGE);
  await ticket.getByRole('button', { name: 'Review', exact: true }).click();
  return ticket;
}

test(`${J} #6 types a TEST size and leverage and reviews: initial margin, the venue's fee, our builder fee, liquidation price and total to commit, from the venue's figures`, async ({
  page,
}) => {
  const who = account();
  const { owner } = run.read();
  await venueDesk(page);
  const previews = [];
  page.on('response', async (r) => {
    if (r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/v1/venue/preview')
      previews.push({ sent: r.request().postDataJSON(), answer: await r.json().catch(() => null) });
  });
  const ticket = await fillTicket(page);
  await expect.poll(() => previews.length, { timeout: 15_000 }).toBeGreaterThan(0);
  const { sent } = previews.at(-1);
  expect(sent.owner).toBe(owner);
  expect(sent.intent).toMatchObject({ kind: 'place_order', symbol: VENUE_PERP, side: 'buy' });
  expect(toUnits(sent.intent.amount)).toBe(toUnits(SIZE));
  const { status, body } = await (await api(who)).post('/api/v1/venue/preview', sent);
  expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
  const p = body.value;
  expect(p.perpetual.marginMode).toBe('isolated');
  expect(p.perpetual.leverageBps).toBe(Number(LEVERAGE) * 10_000);
  expect(p.perpetual.initialMargin.known).toBe(true);
  expect(shownUnits(await listed(ticket, 'Initial margin').innerText())).toBe(units(p.perpetual.initialMargin.value));
  expect(p.venueFee.known).toBe(true);
  expect(shownUnits(await listed(ticket, /venue.?s fee/i).innerText())).toBe(units(p.venueFee.value.amount));
  expect(p.builderFee.known).toBe(true);
  expect(shownUnits(await listed(ticket, /builder fee/i).innerText())).toBe(units(p.builderFee.value.amount));
  expect(p.perpetual.liquidationPrice.known).toBe(true);
  expect(shownUnits(await listed(ticket, 'Liquidation price').innerText())).toBe(units(p.perpetual.liquidationPrice.value));
  const total = units(p.perpetual.initialMargin.value) + units(p.venueFee.value.amount) + units(p.builderFee.value.amount);
  expect(shownUnits(await listed(ticket, 'Total to commit now').innerText())).toBe(total);
  // A margin-currency mismatch is refused with both assets named.
  await page.getByRole('combobox', { name: /margin (asset|currency)/i }).selectOption({ label: 'BTC' });
  await expect(ticket.locator('[data-code]').filter({ hasText: /BTC.*USDC|USDC.*BTC/ })).toBeVisible();
});

test(`${J} #7 looks at the order types: market and limit offered, the rest listed with the reason and nothing sent`, async ({ page }) => {
  await desk(page);
  const sent = writes(page);
  const types = page.getByRole('group', { name: 'Order type' });
  await expect(types.getByRole('button', { name: 'Market' })).toBeEnabled();
  await expect(types.getByRole('button', { name: 'Limit' })).toBeEnabled();
  await types.getByRole('button', { name: 'Limit' }).click();
  await expect(page.getByRole('textbox', { name: 'Limit price' })).toBeVisible();
  await types.getByRole('button', { name: 'Market' }).click();
  await page.getByRole('button', { name: 'Order types not offered' }).click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  expect(await menu.getByRole('menuitem').count()).toBeGreaterThan(0);
  await page.keyboard.press('Escape');
  expect(sent).toEqual([]);
});

test(`${J} #8 confirms "Open long" and signs: the venue opens one position; a double press asks for one signature and sends one order`, async ({
  page,
}) => {
  const who = account();
  const { owner } = run.read();
  const { wallet } = await venueDesk(page);
  const submits = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/v1/venue/submit') submits.push(r.postDataJSON());
  });
  await fillTicket(page);
  const asked = wallet.requests.length;
  await page.getByRole('button', { name: 'Open long' }).click();
  const confirm = page.getByRole('alertdialog');
  await confirm.getByRole('button', { name: 'Confirm open long' }).dblclick();
  await expect.poll(async () => (await venuePositions(who, owner)).length, { timeout: 20_000 }).toBe(1);
  // One signature for the order (the leverage setting, where the venue needs it first, is its own signed action).
  const orderSignatures = wallet.requests.slice(asked).filter((r) => JSON.stringify(r.params).includes('place_order'));
  expect(orderSignatures).toHaveLength(1);
  // One order sent: every submit of the open is the same prepared action (a resend of the same key is the same order).
  const opens = submits.filter((s) => !/leverage/.test(String(s.actionKey)));
  expect(new Set(opens.map((s) => s.actionKey)).size).toBe(1);
  const [position] = await venuePositions(who, owner);
  expect(position).toMatchObject({ symbol: VENUE_PERP, side: 'long', marginMode: 'isolated' });
  expect(toUnits(position.size)).toBe(toUnits(SIZE));
  expect(position.leverageBps).toBe(Number(LEVERAGE) * 10_000);
  // The venue locked the margin out of free.
  const usdc = await venueBalance(who, owner, 'USDC');
  expect(units(usdc.locked)).toBe(units(position.margin));
});

test(`${J} #9 opens the positions room: entry, mark, unrealised result, margin, leverage and liquidation price as exact decimals as the venue reports them, with an as-of time`, async ({
  page,
}) => {
  const who = account();
  const { owner } = run.read();
  await venueDesk(page);
  await page.getByRole('tab', { name: 'Positions' }).click();
  const read = await venueRead(who, 'positions', owner);
  const [position] = read.value;
  expect(position, 'one position on the venue').toBeTruthy();
  const row = page.getByRole('row').filter({ hasText: VENUE_PERP }).first();
  await expect(row).toContainText(`Long ${LEVERAGE}x`);
  const heads = (await row.locator('xpath=ancestor::table[1]').getByRole('columnheader').allInnerTexts()).map((h) => h.trim());
  const cells = await row.getByRole('cell').allInnerTexts();
  const col = (name) => {
    const i = heads.findIndex((h) => name.test(h));
    expect(i, `${name} in ${heads.join(' | ')}`).toBeGreaterThanOrEqual(0);
    return cells[i];
  };
  // Exact decimals: the venue's figure, digit for digit (grouped), never rounded to a shorter form.
  const exact = (v) => {
    const [whole, fraction] = v.replace(/^-/, '').split('.');
    return `${v.startsWith('-') ? '[-−]' : '\\+?'}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction ? `\\.${fraction}` : ''}`;
  };
  expect(col(/^Entry/)).toMatch(new RegExp(exact(position.entryPrice)));
  expect(col(/^Mark/)).toMatch(new RegExp(exact(position.markPrice)));
  expect(col(/unrealised|unrealized/i)).toMatch(new RegExp(exact(position.unrealisedPnl)));
  expect(col(/^Margin/)).toMatch(new RegExp(exact(position.margin)));
  expect(position.liquidationPrice.known).toBe(true);
  expect(col(/liquidation/i)).toMatch(new RegExp(exact(position.liquidationPrice.value)));
  await expect(page.getByText(/as of \d{1,2}:\d{2}/i).first()).toBeVisible();
});

test(`${J} #10 closes 40 percent, then the rest: the venue's split results sum to the full close; a repeated close id is sent and answered once; our ledger posts only our builder fee`, async ({
  page,
}) => {
  const who = account();
  const { owner } = run.read();
  const ledgerBefore = await (await api(who)).balances();
  const since = new Date(Date.now() - 1_000);
  const { wallet } = await venueDesk(page);
  const submits = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/v1/venue/submit') submits.push(r.postDataJSON());
  });
  const [position] = await venuePositions(who, owner);
  const part = '0.004';
  const row = page.getByRole('row').filter({ hasText: VENUE_PERP }).first();
  await row.getByRole('button', { name: `Close, ${VENUE_PERP}` }).click();
  let dialog = page.getByRole('alertdialog').or(page.getByRole('dialog')).first();
  await dialog.getByRole('textbox', { name: 'Size to close' }).fill(part);
  await dialog.getByRole('button', { name: 'Close this size' }).click();
  await expect.poll(async () => (await venuePositions(who, owner))[0]?.size, { timeout: 20_000 }).toMatch(/^0\.006(0*)$/);
  // The same close id sent again (a replay of the first close's signed action) is answered once: nothing more closes.
  const firstClose = submits.at(-1);
  expect(firstClose, 'the close was submitted to the venue').toBeTruthy();
  const replay = await (await api(who)).post('/api/v1/venue/submit', firstClose);
  expect(replay.status, JSON.stringify(replay.body).slice(0, 300)).toBe(200);
  expect(toUnits((await venuePositions(who, owner))[0].size)).toBe(toUnits('0.006'));
  await page.reload();
  await row.getByRole('button', { name: `Close, ${VENUE_PERP}` }).click();
  dialog = page.getByRole('alertdialog').or(page.getByRole('dialog')).first();
  await dialog.getByRole('button', { name: 'Close position' }).click();
  await expect.poll(async () => (await venuePositions(who, owner)).length, { timeout: 20_000 }).toBe(0);
  // The venue's split results sum to the full close.
  const closes = (await venueFills(who, owner, since)).filter((f) => f.side === 'sell');
  expect(closes.reduce((s, f) => s + units(f.amount), 0n)).toBe(toUnits(SIZE));
  expect(closes.every((f) => f.realisedPnl !== null)).toBe(true);
  const realised = closes.reduce((s, f) => s + units(f.realisedPnl), 0n);
  run.write({ realised: String(realised), closeFills: closes.map((f) => f.fillId), positionEntry: position.entryPrice });
  // Our ledger posts only our builder fee: one posting per fill, the fee the venue charged.
  const builderFees = closes.reduce((s, f) => s + units(f.builderFee), 0n);
  expect(builderFees).toBeGreaterThan(0n);
  const { status, body } = await (await api(who)).get('/api/v1/venue/builder-fees?limit=50');
  expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
  const posted = (body.items ?? body).filter((e) => closes.some((f) => f.fillId === e.fillId));
  expect(posted).toHaveLength(closes.length);
  expect(posted.reduce((s, e) => s + units(e.amount), 0n)).toBe(builderFees);
  // Nothing of the person's money moves on our ledger.
  expect(await (await api(who)).balances()).toEqual(ledgerBefore);
  expect(wallet.requests.length).toBeGreaterThan(0);
});

test(`${J} #11 opens History: the closed position with its realised result, the venue's fee and our builder fee, from the venue`, async ({
  page,
}) => {
  const who = account();
  const { owner, realised } = run.read();
  expect(realised, '#10 closed the position').toBeDefined();
  const fills = await venueFills(who, owner, new Date(Date.now() - 3_600_000));
  const venueFees = fills.reduce((s, f) => s + units(f.venueFee), 0n);
  const builderFees = fills.reduce((s, f) => s + units(f.builderFee), 0n);
  await venueDesk(page);
  await page.getByRole('tab', { name: 'History' }).click();
  const table = page.getByRole('table', { name: 'Position history' });
  const row = table.getByRole('row').filter({ hasText: VENUE_PERP }).first();
  await expect(row).toContainText('Closed');
  await expect(row).toContainText(SIZE);
  const headers = (await table.getByRole('columnheader').allInnerTexts()).map((h) => h.trim());
  const cells = await row.getByRole('cell').allInnerTexts();
  const col = (name) => {
    const i = headers.findIndex((h) => name.test(h));
    expect(i, `${name} in ${headers.join(' | ')}`).toBeGreaterThanOrEqual(0);
    return cells[i];
  };
  expect(shownUnits(col(/realised/i))).toBe(BigInt(realised));
  expect(shownUnits(col(/venue.?s fee/i))).toBe(venueFees);
  expect(shownUnits(col(/builder fee/i))).toBe(builderFees);
});
