// World: book, restart
import { randomBytes, randomInt } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { journeyState, stackFile, stackUrl, toUnits, fromUnits } from './stack.mjs';
import { signUp, verify } from './desk.mjs';
import { personDoor } from './person-door.mjs';
import { testWalletKey } from './test-wallet.mjs';
import { ageRecord } from './test-age.mjs';
import { doorOk, otherTraderKey, sameDecimal, testDeposit, testVenue, venueForThisFile, venueRecord, walletDoorAct } from './venue.mjs';
import { openVenueRoom, signedOnVenue, venueAt, venueNow } from './venue-door.mjs';

// J-charts-desk-21, in the running app (docs/roadmap/journeys.json): my fills and margin warnings reach me on Telegram, and
// I check my positions and P&L there without being able to trade. One test per step, titled "J-charts-desk-21 #<n>", run in
// order on one TEST account.
//
// The bot is the stack's TEST bot (tooling/scripts/local-stack-services/notify.mjs): with no owner's bot token, svc-notify
// writes every Telegram message, labelled TEST, to a file in the stack's state folder, which this file reads as the chat;
// the person's messages reach svc-notify's own webhook, /telegram/webhook, with the stack's own webhook header, as the bot
// API would send them. svc-notify sweeps each linked desk every 15 seconds (TELEGRAM_SWEEP_INTERVAL_MS).
//
// The venue is the stack's TEST venue simulator. XTGM-PERP is the TEST perpetual only this journey trades (isolated margin,
// priced by its TEST oracle), so moving its mark (`/test/set-mark`) reaches no other journey. Every figure in the chat is
// compared with the venue's own record (`/fills`, `/positions`, `/account-summary`), read directly, never through our door.
const J = 'J-charts-desk-21';
const PERP = 'XTGM-PERP';
const SETTINGS = '/notifications?view=settings';
const NOTIFY = stackUrl('notify');
const OUTBOX = stackFile('notify-telegram-outbox.log');
const BOT = '@intafaced_test_bot';
const FUNDS = '150';
const SIZE = '10';
const START_MARK = '100';
const TRADING_OFF = 'Trading is off in chat. Open INTAFACED to trade.';
/** Two sweeps and a little: long enough that a repeat, had one been raised, would have been sent. */
const TWO_SWEEPS = 35_000;
/** A few sweeps: an alert is raised on the first sweep after the change, and sent in the same sweep. */
const ALERT_WAIT = 60_000;
const runId = process.env.JOURNEY_RUN_ID ?? 'local';
const run = journeyState(`${J}-${runId}`);

test.describe.configure({ mode: 'default' });
venueForThisFile(test);
const door = personDoor(J, run, test);

test.afterAll(async () => {
  // The TEST venue up and XTGM-PERP at its start again, whatever a failed step left.
  await testVenue('/test/switches', { venueDown: false }).catch(() => undefined);
  await testVenue('/test/set-mark', { symbol: PERP, price: START_MARK }).catch(() => undefined);
});

// ── the TEST chat ──

let stack;
const stackCtx = () =>
  (stack ??= import('../../../../tooling/scripts/local-test-gates.mjs').then((gates) => gates.makeContext({ log: () => {} })));

/** Every message the TEST bot wrote to `chatId`, oldest first. */
function chatMessages(chatId) {
  if (!existsSync(OUTBOX)) return [];
  return readFileSync(OUTBOX, 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('LOCAL-TEST '))
    .map((line) => JSON.parse(line.slice('LOCAL-TEST '.length)))
    .filter((m) => m.chatId === String(chatId))
    .map((m) => m.text);
}
const isAlert = (text) => /^(TEST · )?(Fill:|Margin use \d+%:|Profit lock:)/.test(text);
const alertsTo = (chatId, kind) => chatMessages(chatId).filter((t) => isAlert(t) && t.replace(/^TEST · /, '').startsWith(kind));

/** The person sends `text` from their private chat, as the bot API delivers it; the bot's answer is returned. */
async function say(chat, text) {
  const before = chatMessages(chat.id).length;
  const ctx = await stackCtx();
  const res = await fetch(`${NOTIFY}/telegram/webhook`, {
    method: 'POST',
    redirect: 'error',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': ctx.secrets.notifyTelegramWebhook },
    body: JSON.stringify({
      update_id: randomInt(1, 2 ** 31),
      message: {
        message_id: randomInt(1, 2 ** 31),
        date: Math.floor(Date.now() / 1000),
        chat: { id: chat.id, type: 'private', username: chat.username, first_name: 'TEST' },
        text,
      },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  // The webhook answers once the bot's reply is written; a sweep's alert may land beside it, and is not the reply.
  const replies = chatMessages(chat.id)
    .slice(before)
    .filter((t) => !isAlert(t));
  expect(replies, `the bot's one answer to ${text}`).toHaveLength(1);
  return replies[0];
}

/** Proving nothing more is sent: the sweeps that would send a repeat run on their own clock, so the wait is real. */
async function holdTwoSweeps() {
  // oxlint-disable-next-line garden/no-real-clock-wait-in-tests -- proving no repeat is sent: svc-notify's sweep runs every 15 s on its own clock
  await new Promise((resolve) => setTimeout(resolve, TWO_SWEEPS));
}

/**
 * The TEST chat as the person sees it: every message the TEST bot wrote to it, newest last, on a page of its own (the
 * chat is Telegram's screen, not the app's), for the step's picture. The text is the bot's outbox, written by svc-notify.
 */
async function showChat(context, chat) {
  const page = await context.newPage();
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const bubbles = chatMessages(chat.id)
    .map(
      (t) =>
        `<li style="white-space:pre-wrap;margin:0 0 12px;padding:10px 14px;background:#1f2a36;border-radius:12px;max-width:760px">${esc(t)}</li>`,
    )
    .join('');
  await page.setContent(
    `<!doctype html><html lang="en"><body style="margin:0;background:#0e1621;color:#e8eef4;font:15px/1.45 system-ui,sans-serif"><main style="padding:24px"><h1 style="font-size:18px;margin:0 0 4px">TEST chat with ${BOT}</h1><p style="margin:0 0 16px;color:#8fa3b8">@${chat.username} · TEST bot: these are the messages it wrote to this test stack's TEST chat, not sent to Telegram</p><ol style="list-style:none;padding:0;margin:0">${bubbles}</ol></main></body></html>`,
  );
  await expect(page.getByRole('heading', { name: `TEST chat with ${BOT}` })).toBeVisible();
  return page;
}

/** Waits for the next alert of `kind` to `chatId` past the `seen` already counted; returns its text. */
async function nextAlert(chatId, kind, seen) {
  await expect.poll(() => alertsTo(chatId, kind).length, { timeout: ALERT_WAIT, intervals: [1_000] }).toBeGreaterThan(seen);
  const all = alertsTo(chatId, kind);
  expect(all, `exactly one new ${kind} alert`).toHaveLength(seen + 1);
  return all[seen];
}

// ── the TEST venue, read directly ──

const setMark = (price) => venueAt('/test/set-mark', { symbol: PERP, price });
const positionOf = async (owner) => (await venueRecord(owner, '/positions')).value.find((p) => p.symbol === PERP) ?? null;
const summaryOf = async (owner) => (await venueRecord(owner, '/account-summary')).value;
const fillsSince = async (owner, since) => (await venueRecord(owner, '/fills', { since })).value.filter((f) => f.symbol === PERP);
const ordersOf = async (owner) => (await venueRecord(owner, '/open-orders')).value;

/** The venue's margin use in percent, floored to two places, as svc-trade's desk read counts it (used over equity). */
function marginUse(summary) {
  const hundredths = (toUnits(summary.usedMargin) * 10000n) / toUnits(summary.equity);
  const whole = hundredths / 100n;
  const frac = (hundredths % 100n).toString().padStart(2, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/**
 * The mark at which the venue's margin use passes `level` percent, with a cent to spare: equity falls by the size for
 * each unit the mark falls, and margin use is the margin over equity. Worked from the venue's own summary at `mark`.
 */
function markAt(summary, size, mark, level) {
  const SCALE = toUnits('1');
  const used = toUnits(summary.usedMargin);
  const equity = toUnits(summary.equity);
  const needed = (used * 100n) / BigInt(level);
  const drop = ((equity - needed) * SCALE) / toUnits(size);
  const cent = toUnits('0.01');
  const at = toUnits(mark) - drop - cent;
  return fromUnits(at - (at % cent));
}

// ── the room ──

const card = (page) => page.getByTestId('nf-telegram');
const stateLine = (page) => card(page).getByTestId('nf-telegram-state');

async function openSettings(page) {
  const { who } = run.read();
  await door.signInNow(page, who);
  await page.goto(SETTINGS);
  await expect(card(page)).toBeVisible({ timeout: 30_000 });
}

/** TEST setup, not a step (the Starts line): a verified person, a TEST wallet, TEST USDC on the venue, and no Telegram linked. */
async function startsLine(page) {
  const who = await signUp(page, 'jcd21');
  await verify(page, who);
  const walletKey = testWalletKey();
  const key = privateKeyToAccount(walletKey);
  const owner = key.address.toLowerCase();
  const chat = { id: randomInt(10_000_000, 2_000_000_000), username: `jcd21_${randomBytes(3).toString('hex')}` };
  run.reset({ who, walletKey, owner, chat });
  const venue = await venueNow();
  await setMark(START_MARK);
  await venueAt('/test/seed', {});
  await testDeposit(owner, 'USDC', FUNDS, `84532:0x${randomBytes(32).toString('hex')}:0`);
  // A TEST other trader rests the ask the person's buy takes in #2: one fill, at the mark.
  const seller = otherTraderKey(`jcd21-${runId}-${randomBytes(3).toString('hex')}`);
  await testDeposit(seller.address.toLowerCase(), 'USDC', '100000', `84532:0x${randomBytes(32).toString('hex')}:0`);
  const isolated = { kind: 'update_leverage', symbol: PERP, leverageBps: 100_000, marginMode: 'isolated' };
  await signedOnVenue(venue, seller, isolated);
  await signedOnVenue(venue, seller, {
    kind: 'place_order',
    symbol: PERP,
    side: 'sell',
    type: 'limit',
    amount: SIZE,
    price: START_MARK,
    timeInForce: 'GTC',
    reduceOnly: false,
    clientOrderKey: `order:jcd21:${randomBytes(4).toString('hex')}:ask`,
    builderFee: null,
  });
  // The person's own actions go through our door, signed by their wallet: the door then knows this venue account is theirs,
  // which is how svc-notify's desk read finds it. A market listed a moment ago may not be in the door's list yet.
  const session = await door.door();
  await expect(() => walletDoorAct(session, key, { intent: isolated, actionKey: `leverage:${owner}:${PERP}` })).toPass({
    timeout: 30_000,
    intervals: [2_000],
  });
  const status = doorOk(await session.get('/api/v1/venue/status'));
  expect(status.builder, 'the TEST builder fee is set on the door').toBeTruthy();
  await walletDoorAct(session, key, {
    intent: { kind: 'approve_builder_fee', builder: status.builder.address, maxFeeBps: status.builder.feeBps },
    actionKey: `approve-builder:${owner}:jcd21`,
  });
  run.write({ userId: session.userId });
  expect(await positionOf(owner)).toBeNull();
}

test(`${J} #1 opens Settings, Notifications, presses Connect Telegram and sends the one-time code to the bot: a code valid for 5 minutes; once sent, Telegram shown linked with the chat's handle; the same code sent again, or after 5 minutes, refused in chat and nothing linked`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(420_000);
  await startsLine(page);
  const { chat, userId } = run.read();
  // Verification signed the person out (its cookies are cleared so the next sign-in carries the new level).
  await openSettings(page);
  await expect(card(page)).toHaveAttribute('data-state', 'unlinked');
  await expect(stateLine(page)).toHaveText('Not linked.');

  // A code valid for 5 minutes, to send to the TEST bot.
  const pressed = Date.now();
  await card(page).getByRole('button', { name: 'Connect Telegram', exact: true }).click();
  const command = card(page).getByTestId('nf-telegram-command');
  await expect(command).toHaveText(/^\/start [0-9a-f]{64}$/);
  await expect(card(page).getByTestId('nf-telegram-code')).toContainText(`Send this message to ${BOT} in Telegram:`);
  const expiry = card(page).getByTestId('nf-telegram-expiry');
  await expect(expiry).toContainText('Valid for 5 minutes, until');
  const expiresAt = Date.parse(await expiry.getAttribute('data-expires-at'));
  expect(expiresAt - pressed).toBeGreaterThan(4 * 60_000 + 50_000);
  expect(expiresAt - Date.now()).toBeLessThanOrEqual(5 * 60_000);
  const first = await command.innerText();

  // After 5 minutes (the TEST age door moves the code's own times back 5 minutes): refused in chat, nothing linked.
  await ageRecord('notify', 'telegram-link-code', userId, 5 * 60_000);
  expect(await say(chat, first)).toBe(
    'That code is not valid: it is wrong, used or expired. Nothing was linked. Get a new one in Settings, Notifications.',
  );
  expect(await say(chat, '/positions')).toBe(
    'This chat is not linked. Get a one-time code in the app under Settings, Notifications, then send /start <code> here.',
  );
  await page.reload();
  await expect(card(page)).toHaveAttribute('data-state', 'unlinked');

  // A new code, sent once: Telegram shown linked, with the chat's handle.
  await card(page).getByRole('button', { name: 'Connect Telegram', exact: true }).click();
  await expect(command).toHaveText(/^\/start [0-9a-f]{64}$/);
  const second = await command.innerText();
  expect(second).not.toBe(first);
  expect(await say(chat, second)).toBe(
    'Linked. This bot is read-only: it answers /positions and /pnl. It never trades, cancels or moves money. Alerts: your fills, margin use at 80% and 90%, and your weekly profit target.',
  );
  await expect(card(page)).toHaveAttribute('data-state', 'linked', { timeout: 15_000 });
  await expect(stateLine(page)).toHaveText(new RegExp(`^Linked to @${chat.username} since .+\\.$`));
  await expect(card(page).getByTestId('nf-telegram-code')).toHaveCount(0);

  // The same code again, from this chat and from another: refused in chat, and nothing more linked.
  const refused = 'That code is not valid: it is wrong, used or expired. Nothing was linked. Get a new one in Settings, Notifications.';
  expect(await say(chat, second)).toBe(refused);
  const other = { id: chat.id + 1, username: `${chat.username}_other` };
  expect(await say(other, second)).toBe(refused);
  expect(await say(other, '/positions')).toBe(
    'This chat is not linked. Get a one-time code in the app under Settings, Notifications, then send /start <code> here.',
  );
  await page.reload();
  await expect(card(page)).toHaveAttribute('data-state', 'linked', { timeout: 15_000 });
  await expect(stateLine(page)).toHaveText(new RegExp(`^Linked to @${chat.username} since `));
  run.write({ linkedAt: new Date(pressed).toISOString() });
  await stepPicture();
});

test(`${J} #2 a TEST order fills on the venue: one Telegram message with market, side, size, price and fee as the venue reports them, sent once`, async ({
  context,
  stepPicture,
}) => {
  test.setTimeout(240_000);
  const { chat, owner, walletKey, linkedAt } = run.read();
  if (!linkedAt) throw new Error(`${J} #1 linked no chat, so no fill can reach one`);
  const key = privateKeyToAccount(walletKey);
  const seen = alertsTo(chat.id, 'Fill').length;
  const since = new Date().toISOString();
  await walletDoorAct(await door.door(), key, {
    intent: {
      kind: 'place_order',
      symbol: PERP,
      side: 'buy',
      type: 'limit',
      amount: SIZE,
      price: START_MARK,
      timeInForce: 'IOC',
      reduceOnly: false,
      clientOrderKey: `order:jcd21:${randomBytes(4).toString('hex')}:open`,
      builderFee: null,
    },
  });
  const fills = await fillsSince(owner, since);
  expect(fills, "the venue's one fill of the buy").toHaveLength(1);
  const [fill] = fills;

  const text = await nextAlert(chat.id, 'Fill', seen);
  const m = /^TEST · Fill: (\S+) (buy|sell) (\S+) at (\S+), fee (\S+) (\S+)\.$/.exec(text);
  expect(m, text).not.toBeNull();
  const [, market, side, size, price, fee, feeAsset] = m;
  expect(market).toBe(fill.symbol);
  expect(side).toBe(fill.side);
  expect(sameDecimal(size, fill.amount)).toBe(true);
  expect(sameDecimal(price, fill.price)).toBe(true);
  expect(toUnits(fee)).toBe(toUnits(fill.venueFee) + toUnits(fill.builderFee));
  expect(feeAsset).toBe(fill.feeAsset);

  // Sent once: the sweeps that see the same fill again send nothing more.
  await holdTwoSweeps();
  expect(alertsTo(chat.id, 'Fill')).toHaveLength(seen + 1);
  const p = await positionOf(owner);
  expect(p).toMatchObject({ side: 'long', marginMode: 'isolated' });
  expect(p.liquidationPrice.known, 'the venue names the position’s liquidation price').toBe(true);
  await stepPicture(await showChat(context, chat));
});

test(`${J} #3 the mark moves until the account's margin use passes 80 percent, then 90 percent (TEST): one warning at each, naming the margin use and the position nearest liquidation, from the venue; neither repeats while the level holds`, async ({
  context,
  stepPicture,
}) => {
  test.setTimeout(600_000);
  const { chat, owner } = run.read();
  const start = await positionOf(owner);
  if (!start) throw new Error(`${J} #2 left no ${PERP} position, so no margin use can move`);

  /** One warning at `level`, read against the venue's own summary and position at that moment. */
  async function warnsAt(level) {
    const seen = alertsTo(chat.id, `Margin use ${level}%`).length;
    const mark = markAt(await summaryOf(owner), start.size, (await positionOf(owner)).markPrice, level);
    await setMark(mark);
    const summary = await summaryOf(owner);
    const use = marginUse(summary);
    expect(toUnits(use) >= toUnits(String(level)), `the venue's margin use ${use}% has passed ${level}%`).toBe(true);
    const p = await positionOf(owner);
    expect(p.liquidationPrice.known).toBe(true);
    expect(toUnits(p.markPrice) > toUnits(p.liquidationPrice.value), 'the mark is still above the liquidation price').toBe(true);

    const text = await nextAlert(chat.id, `Margin use ${level}%`, seen);
    const m =
      /^TEST · Margin use (\d+)%: account (\S+) is at (\S+)% \(margin (\S+) of (\S+)\)\. Nearest liquidation: (\S+) (long|short) (\S+), mark (\S+), liquidation (\S+)\. From the venue, as of (\S+)\.$/.exec(
        text,
      );
    expect(m, text).not.toBeNull();
    const [, shownLevel, account, shownUse, used, of, symbol, side, size, shownMark, liq, asOf] = m;
    expect(shownLevel).toBe(String(level));
    expect(account).toBe(`${owner.slice(0, 6)}…${owner.slice(-4)}`);
    expect(shownUse).toBe(use);
    expect(sameDecimal(used, summary.usedMargin)).toBe(true);
    expect(sameDecimal(of, summary.equity)).toBe(true);
    expect([symbol, side]).toEqual([PERP, p.side]);
    expect(sameDecimal(size, p.size)).toBe(true);
    expect(sameDecimal(shownMark, p.markPrice)).toBe(true);
    expect(sameDecimal(liq, p.liquidationPrice.value)).toBe(true);
    expect(Number.isNaN(Date.parse(asOf))).toBe(false);
    return mark;
  }

  const at80 = await warnsAt(80);
  // The level holds: the mark moves a little more against the long, still under 90%; no second 80% warning.
  await setMark(fromUnits(toUnits(at80) - toUnits('0.05')));
  expect(toUnits(marginUse(await summaryOf(owner))) < toUnits('90')).toBe(true);
  await holdTwoSweeps();
  expect(alertsTo(chat.id, 'Margin use 80%')).toHaveLength(1);
  expect(alertsTo(chat.id, 'Margin use 90%')).toHaveLength(0);

  const at90 = await warnsAt(90);
  await setMark(fromUnits(toUnits(at90) - toUnits('0.05')));
  await holdTwoSweeps();
  expect(alertsTo(chat.id, 'Margin use 80%')).toHaveLength(1);
  expect(alertsTo(chat.id, 'Margin use 90%')).toHaveLength(1);
  run.write({ markAt90: at90 });
  await stepPicture(await showChat(context, chat));
});

test(`${J} #4 sends /positions and /pnl: the same positions and today's P&L as the desk shows, from the venue with its as-of time; a venue that can't be read is named, never shown as no positions`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(300_000);
  const s = run.read();
  if (!s.linkedAt) throw new Error(`${J} #1 linked no chat`);
  const { chat, owner } = s;
  const venue = await venueNow();
  await openVenueRoom(page, { ...s, account: s.who }, '/trade/positions');
  const row = page.getByTestId('positions-all').locator(`tr[data-venue="${venue.id}"][data-symbol="${PERP}"]`);
  await expect(row).toBeVisible({ timeout: 30_000 });
  const cell = async (name) => (await row.locator(`[data-cell="${name}"]`).innerText()).replace(/,/g, '').trim();
  const p = await positionOf(owner);
  await expect(row.locator('[data-cell="mark"]')).toHaveText(new RegExp(`^${p.markPrice.replace('.', '\\.')}`), { timeout: 20_000 });

  // /positions: the position as the desk shows it and as the venue reports it, with the as-of time.
  const positions = await say(chat, '/positions');
  const lines = positions.split('\n');
  expect(lines[0]).toMatch(/^TEST · Positions as of \S+Z$/);
  const asOf = Date.parse(lines[0].replace('TEST · Positions as of ', ''));
  expect(Math.abs(asOf - Date.now())).toBeLessThan(120_000);
  const line = lines.find((l) => l.startsWith(`${PERP} `));
  const m = new RegExp(`^${PERP} (long|short) (\\S+) · entry (\\S+) · mark (\\S+) · unrealised (\\S+) · liquidation (\\S+)$`).exec(
    line ?? '',
  );
  expect(m, positions).not.toBeNull();
  const [, side, size, entry, mark, unrealised, liq] = m;
  expect(side).toBe(p.side);
  for (const [shown, desk, venueFigure] of [
    [size, await cell('size'), p.size],
    [entry, await cell('entry'), p.entryPrice],
    [mark, await cell('mark'), p.markPrice],
    [unrealised, await cell('unrealised'), p.unrealisedPnl],
  ]) {
    expect(sameDecimal(shown, venueFigure), `${shown} is the venue's ${venueFigure}`).toBe(true);
    expect(sameDecimal(shown, desk), `${shown} is what the desk shows, ${desk}`).toBe(true);
  }
  expect(sameDecimal(liq, p.liquidationPrice.value)).toBe(true);

  // /pnl: today's realised result and fees from the venue's own fills since 00:00 UTC, and the open result the desk shows.
  const day = new Date();
  const dayStart = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate())).toISOString();
  const today = await fillsSince(owner, dayStart);
  const realised = today.reduce((t, f) => t + (f.realisedPnl === null ? 0n : toUnits(f.realisedPnl)), 0n);
  const fees = today.reduce((t, f) => t + toUnits(f.venueFee) + toUnits(f.builderFee), 0n);
  const pnl = await say(chat, '/pnl');
  const pnlLines = pnl.split('\n');
  expect(pnlLines[0]).toMatch(/^TEST · P&L as of \S+Z$/);
  const t = /^Today from (\S+): realised (\S+), fees (\S+), profit (\S+) USDC$/.exec(pnlLines[1] ?? '');
  expect(t, pnl).not.toBeNull();
  expect(t[1]).toBe(dayStart);
  expect(toUnits(t[2])).toBe(realised);
  expect(toUnits(t[3])).toBe(fees);
  expect(toUnits(t[4])).toBe(realised - fees);
  const open = new RegExp(`^Account ${owner.slice(0, 6)}…${owner.slice(-4)} open positions: unrealised (\\S+) USDC$`).exec(
    pnlLines.find((l) => l.startsWith('Account ')) ?? '',
  );
  expect(open, pnl).not.toBeNull();
  expect(sameDecimal(open[1], await cell('unrealised'))).toBe(true);
  await stepPicture(await showChat(page.context(), chat));

  // The venue can't be read (the TEST venue's down switch): it is named, and no figures or "no positions" are shown.
  try {
    await venueAt('/test/switches', { venueDown: true });
    const named = `TEST · ${venue.name} could not be read just now, so no figures are shown. Try again in a moment.`;
    expect(await say(chat, '/positions')).toBe(named);
    expect(await say(chat, '/pnl')).toBe(named);
  } finally {
    await venueAt('/test/switches', { venueDown: false });
  }
  expect(await say(chat, '/positions')).toContain(`${PERP} ${p.side}`);
});

test(`${J} #5 sends /buy, /close and /cancel: "Trading is off in chat. Open INTAFACED to trade."; nothing is sent to the venue`, async ({
  context,
  stepPicture,
}) => {
  test.setTimeout(120_000);
  const { chat, owner } = run.read();
  const since = new Date(Date.now() - 1000).toISOString();
  const position = await positionOf(owner);
  if (!position) throw new Error(`${J} #2 left no ${PERP} position to leave untouched`);
  const orders = await ordersOf(owner);
  for (const command of [`/buy ${PERP} 1`, `/close ${PERP}`, '/cancel all']) expect(await say(chat, command)).toBe(TRADING_OFF);
  // Nothing reached the venue: no fill, the same open orders and the same position, by the venue's own record.
  expect(await fillsSince(owner, since)).toEqual([]);
  expect(await ordersOf(owner)).toEqual(orders);
  const after = await positionOf(owner);
  expect(sameDecimal(after.size, position.size)).toBe(true);
  expect(after.side).toBe(position.side);
  await stepPicture(await showChat(context, chat));
});

test(`${J} #6 presses Unlink in Settings, then sends /positions: Telegram shown unlinked; no further messages; the bot answers that the chat is not linked, with no figures`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(240_000);
  const { chat, owner, walletKey } = run.read();
  await openSettings(page);
  await expect(card(page)).toHaveAttribute('data-state', 'linked');
  await card(page).getByRole('button', { name: 'Unlink', exact: true }).click();
  await expect(card(page).getByTestId('nf-telegram-note')).toHaveText('Telegram unlinked. Nothing more is sent to that chat.');
  await expect(card(page)).toHaveAttribute('data-state', 'unlinked', { timeout: 15_000 });
  await expect(stateLine(page)).toHaveText('Not linked.');
  await page.reload();
  await expect(card(page)).toHaveAttribute('data-state', 'unlinked', { timeout: 30_000 });

  const reply = await say(chat, '/positions');
  expect(reply).toBe(
    'This chat is not linked. Get a one-time code in the app under Settings, Notifications, then send /start <code> here.',
  );
  expect(reply).not.toMatch(/\d/);

  // No further messages: a new fill on the venue, and the sweeps after it, send nothing to the chat.
  const count = chatMessages(chat.id).length;
  const since = new Date().toISOString();
  await walletDoorAct(await door.door(), privateKeyToAccount(walletKey), {
    intent: {
      kind: 'place_order',
      symbol: PERP,
      side: 'sell',
      type: 'limit',
      amount: '1',
      // Under the TEST makers' bids, so it fills on the best of them.
      price: '90',
      timeInForce: 'IOC',
      reduceOnly: true,
      clientOrderKey: `order:jcd21:${randomBytes(4).toString('hex')}:after-unlink`,
      builderFee: null,
    },
  });
  expect((await fillsSince(owner, since)).length, 'the venue filled the TEST sell').toBeGreaterThan(0);
  await holdTwoSweeps();
  expect(chatMessages(chat.id)).toHaveLength(count);
  await stepPicture();
});
