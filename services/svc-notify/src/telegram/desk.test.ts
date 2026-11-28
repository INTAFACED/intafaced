/**
 * The launch desk's read-only Telegram alerts, at the lowest layer: the desk with its in-memory store, a recording
 * transport and a desk reader the test drives. What the issue asks, one test each:
 *
 * - each alert fires once at its threshold: a fill once per fill, the 80% and 90% margin-use warnings once per crossing,
 *   the profit lock once per week when the week's realised profit reaches the person's target;
 * - the bot refuses every command but `/positions` and `/pnl`, and never trades, cancels or moves money;
 * - linking needs a one-time code the app's account settings shows, valid five minutes, and keeps the chat's handle;
 * - with no bot token the channel is off with a typed reason.
 */
import { describe, expect, it } from 'vitest';
import type { TradeDeskSnapshot, TradeDeskSnapshotResult } from '@intafaced/contracts/trade-desk-snapshot';
import { MemoryTelegramStore } from './store.js';
import { nearestLiquidation, TelegramDesk, TELEGRAM_OFF_TOKEN_UNSET, TelegramDeskOffError, TRADING_OFF_REPLY } from './desk.js';

const T0 = new Date('2026-11-25T10:00:00Z');
const WEEK = '2026-11-23T00:00:00.000Z';
const USER = 'user-1';
const CHAT = '700100';

function snapshot(over: Partial<TradeDeskSnapshot> = {}): TradeDeskSnapshot {
  return {
    state: 'read',
    test: true,
    asOf: T0.toISOString(),
    weekStart: WEEK,
    accounts: [
      {
        owner: '0x1111111111111111111111111111111111111111',
        subAccount: null,
        accountValue: '1000',
        marginUsed: '500',
        marginUse: '50',
        unrealisedPnl: '10',
        positions: [
          {
            symbol: 'BTC-PERP',
            side: 'long',
            size: '0.01',
            entryPrice: '90000',
            markPrice: '91000',
            unrealisedPnl: '10',
            margin: '500',
            liquidationPrice: '60000',
          },
        ],
      },
    ],
    fills: [],
    week: { asset: 'USDC', realisedPnl: '0', fees: '0', profit: '0' },
    dayStart: '2026-11-25T00:00:00.000Z',
    today: { asset: 'USDC', realisedPnl: '0', fees: '0', profit: '0' },
    ...over,
  };
}

function rig(opts: { token?: boolean } = {}) {
  let now = T0;
  let desk: TradeDeskSnapshotResult = snapshot();
  const sent: { chatId: string; text: string }[] = [];
  const reads: { userId: string; since: string }[] = [];
  const store = new MemoryTelegramStore();
  const codes = ['code-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'code-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'code-cccccccccccccccccccccccccccccccc'];
  const service = new TelegramDesk({
    store,
    transport:
      opts.token === false
        ? null
        : {
            send: async (chatId, text) => {
              sent.push({ chatId, text });
            },
          },
    reader: {
      read: async (input) => {
        reads.push(input);
        return desk;
      },
    },
    now: () => now,
    bot: '@intafaced_test_bot',
    testBot: true,
    newCode: () => codes.shift() ?? 'code-exhausted',
  });
  return {
    service,
    store,
    sent,
    reads,
    at: (d: Date) => {
      now = d;
    },
    desk: (next: TradeDeskSnapshotResult) => {
      desk = next;
    },
    message: (text: string, chatId = CHAT, type = 'private') =>
      service.handleUpdate({ update_id: 1, message: { chat: { id: Number(chatId), type, username: 'jcd21_trader' }, text } }),
  };
}

async function linked() {
  const r = rig();
  const { code } = await r.service.issueLinkCode(USER);
  await r.message(`/start ${code}`);
  r.sent.length = 0;
  return r;
}

describe('linking needs a one-time code from the account settings', () => {
  it('links the chat that sends /start with the code, and only once', async () => {
    const r = rig();
    const issued = await r.service.issueLinkCode(USER);
    expect(issued.code).toBe('code-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(issued.command).toBe(`/start ${issued.code}`);
    expect(issued.expiresAt).toBe(new Date(T0.getTime() + 5 * 60_000).toISOString());
    expect(await r.service.status(USER)).toEqual({ state: 'unlinked', bot: '@intafaced_test_bot', test: true, profitTarget: null });

    await r.message(`/start ${issued.code}`);
    expect(r.sent.at(-1)).toEqual({ chatId: CHAT, text: expect.stringContaining('Linked') });
    expect(await r.service.status(USER)).toEqual({
      state: 'linked',
      bot: '@intafaced_test_bot',
      test: true,
      linkedAt: T0.toISOString(),
      handle: '@jcd21_trader',
      profitTarget: null,
    });
    // The same code again from the linked chat is refused too.
    await r.message(`/start ${issued.code}`);
    expect(r.sent.at(-1)?.text).toContain('Nothing was linked');

    // The same code a second time, from another chat, links nothing.
    await r.message(`/start ${issued.code}`, '700200');
    expect(r.sent.at(-1)).toEqual({ chatId: '700200', text: expect.stringContaining('not valid') });
    expect(await r.store.linkByChat('700200')).toBeNull();
  });

  it('a group or channel chat is never linked and never gets figures, so only the person sees them', async () => {
    const r = rig();
    const { code } = await r.service.issueLinkCode(USER);
    for (const type of ['group', 'supergroup', 'channel']) {
      await r.message(`/start ${code}`, '-100500', type);
      expect(r.sent.at(-1)).toEqual({ chatId: '-100500', text: expect.stringContaining('only in a private chat') });
    }
    expect(await r.store.linkByChat('-100500')).toBeNull();
    // The code is still unused: the person can link their private chat with it.
    await r.message(`/start ${code}`);
    expect(r.sent.at(-1)?.text).toContain('Linked');
    await r.message('/positions', CHAT, 'group');
    expect(r.sent.at(-1)?.text).toContain('only in a private chat');
    expect(r.reads).toEqual([]);
  });

  it('refuses a /start with no code, a wrong code and an expired code', async () => {
    const r = rig();
    const { code } = await r.service.issueLinkCode(USER);
    await r.message('/start');
    expect(r.sent.at(-1)?.text).toContain('one-time code');
    await r.message('/start code-wrong');
    expect(r.sent.at(-1)?.text).toContain('not valid');
    r.at(new Date(T0.getTime() + 5 * 60_000));
    await r.message(`/start ${code}`);
    expect(r.sent.at(-1)?.text).toContain('not valid');
    expect(await r.service.status(USER)).toMatchObject({ state: 'unlinked' });
  });

  it('a new code replaces the last unused one, and the store keeps only its digest', async () => {
    const r = rig();
    const first = await r.service.issueLinkCode(USER);
    const second = await r.service.issueLinkCode(USER);
    expect(JSON.stringify(r.store.dump())).not.toContain(second.code);
    await r.message(`/start ${first.code}`);
    expect(r.sent.at(-1)?.text).toContain('not valid');
    await r.message(`/start ${second.code}`);
    expect(r.sent.at(-1)?.text).toContain('Linked');
  });

  it('unlinking stops the alerts and the commands for that chat', async () => {
    const r = await linked();
    await r.service.unlink(USER);
    expect(await r.service.status(USER)).toMatchObject({ state: 'unlinked' });
    await r.message('/positions');
    expect(r.sent.at(-1)?.text).toContain('not linked');
    r.desk(snapshot({ fills: [fill('f1')] }));
    expect((await r.service.sweep()).raised).toBe(0);
  });

  it('a chat with no username is shown by its first name', async () => {
    const r = rig();
    const { code } = await r.service.issueLinkCode(USER);
    await r.service.handleUpdate({ message: { chat: { id: 1, type: 'private', first_name: 'Ana' }, text: `/start ${code}` } });
    expect(await r.service.status(USER)).toMatchObject({ state: 'linked', handle: 'Ana' });
  });
});

describe('with no bot token the channel is off with a typed reason', () => {
  it('status says off and a link code is refused', async () => {
    const r = rig({ token: false });
    expect(await r.service.status(USER)).toEqual({ state: 'off', reason: TELEGRAM_OFF_TOKEN_UNSET });
    await expect(r.service.issueLinkCode(USER)).rejects.toBeInstanceOf(TelegramDeskOffError);
    expect((await r.service.sweep()).linked).toBe(0);
  });
});

describe('the bot answers /positions and /pnl and refuses every other command', () => {
  it('/positions lists the open positions from the venue read, labelled TEST on a test venue', async () => {
    const r = await linked();
    await r.message('/positions');
    const text = r.sent.at(-1)?.text ?? '';
    expect(text).toContain('TEST');
    expect(text).toContain('BTC-PERP long 0.01');
    expect(text).toContain('entry 90000');
    expect(text).toContain('mark 91000');
    expect(text).toContain('unrealised 10');
    expect(text).toContain('margin use 50%');
    expect(r.reads.at(-1)).toEqual({ userId: USER, since: WEEK_SINCE_LINK });
  });

  it('/pnl gives today and this week: realised profit, fees and the open unrealised result, with the as-of time', async () => {
    const r = await linked();
    r.desk(
      snapshot({
        week: { asset: 'USDC', realisedPnl: '120.5', fees: '0.5', profit: '120' },
        today: { asset: 'USDC', realisedPnl: '7', fees: '0.25', profit: '6.75' },
      }),
    );
    await r.message('/pnl@intafaced_desk_bot');
    const text = r.sent.at(-1)?.text ?? '';
    expect(text).toContain('realised 120.5');
    expect(text).toContain('fees 0.5');
    expect(text).toContain('profit 120 USDC');
    expect(text).toContain('Today from 2026-11-25T00:00:00.000Z: realised 7, fees 0.25, profit 6.75 USDC');
    expect(text).toContain(`as of ${T0.toISOString()}`);
    expect(text).toContain('unrealised 10');
  });

  it('a venue that cannot be read is said, never an empty list', async () => {
    const r = await linked();
    r.desk({ state: 'unavailable', code: 'trade.desk_snapshot_unavailable' });
    await r.message('/positions');
    expect(r.sent.at(-1)?.text).toContain('could not be read');
    expect(r.sent.at(-1)?.text).not.toContain('No open positions');
  });

  it('a venue that refuses the read is named, with no figures', async () => {
    const r = await linked();
    r.desk({ state: 'unreadable', venue: 'TEST venue simulator', test: true });
    for (const command of ['/positions', '/pnl']) {
      await r.message(command);
      expect(r.sent.at(-1)?.text).toBe(
        'TEST · TEST venue simulator could not be read just now, so no figures are shown. Try again in a moment.',
      );
    }
  });

  it.each([
    '/buy BTC 1',
    '/sell BTC 1',
    '/close BTC-PERP',
    '/cancel all',
    '/withdraw 100',
    '/transfer 100',
    '/order BTC-PERP long 1',
    '/leverage 20',
    '/stop',
    '/buy@intafaced_test_bot BTC-PERP 1',
    'buy 1 btc',
  ])('answers %s that trading is off in chat, and reads nothing from the venue', async (command) => {
    const r = await linked();
    const before = r.reads.length;
    await r.message(command);
    expect(r.sent.at(-1)?.text).toBe('Trading is off in chat. Open INTAFACED to trade.');
    expect(TRADING_OFF_REPLY).toBe('Trading is off in chat. Open INTAFACED to trade.');
    expect(r.reads.length).toBe(before);
  });

  it.each(['/help', 'hello'])('answers %s with what the bot does, and reads nothing', async (command) => {
    const r = await linked();
    const before = r.reads.length;
    await r.message(command);
    expect(r.sent.at(-1)?.text).toBe('This bot is read-only: it answers /positions and /pnl. It never trades, cancels or moves money.');
    expect(r.reads.length).toBe(before);
  });

  it('a chat that is not linked gets no figures', async () => {
    const r = rig();
    await r.message('/positions', '700300');
    expect(r.sent.at(-1)?.text).toContain('not linked');
    expect(r.reads).toEqual([]);
  });

  it('the desk exposes no write to the venue at all', () => {
    const r = rig();
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(r.service));
    for (const m of methods) expect(m).not.toMatch(/order|trade|cancel|withdraw|transfer|place|close/i);
  });
});

const WEEK_SINCE_LINK = T0.toISOString();

function fill(fillId: string, over: Partial<TradeDeskSnapshot['fills'][number]> = {}): TradeDeskSnapshot['fills'][number] {
  return {
    fillId,
    symbol: 'BTC-PERP',
    side: 'buy',
    price: '91000',
    amount: '0.01',
    realisedPnl: null,
    fee: '0.4',
    feeAsset: 'USDC',
    filledAt: new Date(T0.getTime() + 1000).toISOString(),
    ...over,
  };
}

function marginAt(use: string): TradeDeskSnapshot {
  const s = snapshot();
  return { ...s, accounts: s.accounts.map((a) => ({ ...a, marginUse: use })) };
}

describe('each alert fires once at its threshold', () => {
  it('a fill is pushed once, however many sweeps see it', async () => {
    const r = await linked();
    r.desk(snapshot({ fills: [fill('f1')] }));
    expect((await r.service.sweep()).raised).toBe(1);
    expect((await r.service.sweep()).raised).toBe(0);
    r.desk(snapshot({ fills: [fill('f1'), fill('f2', { side: 'sell', realisedPnl: '5' })] }));
    expect((await r.service.sweep()).raised).toBe(1);
    expect(r.sent.map((s) => s.text)).toEqual([
      expect.stringContaining('Fill: BTC-PERP buy 0.01 at 91000'),
      expect.stringContaining('Fill: BTC-PERP sell 0.01 at 91000, realised 5'),
    ]);
    expect(r.sent.every((s) => s.chatId === CHAT)).toBe(true);
  });

  it('reads fills only since the chat was linked', async () => {
    const r = await linked();
    await r.service.sweep();
    expect(r.reads.at(-1)).toEqual({ userId: USER, since: T0.toISOString() });
  });

  it('margin use warns once at 80% and once at 90%, and again only after falling back below', async () => {
    const r = await linked();
    r.desk(marginAt('79.99'));
    expect((await r.service.sweep()).raised).toBe(0);
    r.desk(marginAt('80'));
    expect((await r.service.sweep()).raised).toBe(1);
    r.desk(marginAt('85'));
    expect((await r.service.sweep()).raised).toBe(0);
    r.desk(marginAt('90'));
    expect((await r.service.sweep()).raised).toBe(1);
    r.desk(marginAt('95'));
    expect((await r.service.sweep()).raised).toBe(0);
    expect(r.sent.map((s) => s.text)).toEqual([expect.stringContaining('Margin use 80%'), expect.stringContaining('Margin use 90%')]);
    expect(r.sent[0]?.text).toContain('Nearest liquidation: BTC-PERP long 0.01, mark 91000, liquidation 60000.');
    expect(r.sent[0]?.text).toContain(`From the venue, as of ${T0.toISOString()}.`);
    // Back below 80% re-arms both; the next crossing warns again.
    r.desk(marginAt('70'));
    expect((await r.service.sweep()).raised).toBe(0);
    r.desk(marginAt('92'));
    expect((await r.service.sweep()).raised).toBe(2);
  });

  it('a margin use the venue does not report raises nothing and is never read as zero', async () => {
    const r = await linked();
    r.desk(marginAt('95'));
    const s = snapshot();
    r.desk({ ...s, accounts: s.accounts.map((a) => ({ ...a, marginUse: null, accountValue: null })) });
    expect((await r.service.sweep()).raised).toBe(0);
  });

  it('the profit lock fires once in a week when realised profit reaches the target, and again next week', async () => {
    const r = await linked();
    await r.service.setProfitTarget(USER, '100');
    r.desk(snapshot({ week: { asset: 'USDC', realisedPnl: '99.99', fees: '0', profit: '99.99' } }));
    expect((await r.service.sweep()).raised).toBe(0);
    r.desk(snapshot({ week: { asset: 'USDC', realisedPnl: '101', fees: '1', profit: '100' } }));
    expect((await r.service.sweep()).raised).toBe(1);
    r.desk(snapshot({ week: { asset: 'USDC', realisedPnl: '150', fees: '1', profit: '149' } }));
    expect((await r.service.sweep()).raised).toBe(0);
    expect(r.sent.at(-1)?.text).toContain('Profit lock: this week');
    r.desk(snapshot({ weekStart: '2026-11-30T00:00:00.000Z', week: { asset: 'USDC', realisedPnl: '100', fees: '0', profit: '100' } }));
    expect((await r.service.sweep()).raised).toBe(1);
  });

  it('no target, no profit lock; a malformed target is refused', async () => {
    const r = await linked();
    r.desk(snapshot({ week: { asset: 'USDC', realisedPnl: '1000', fees: '0', profit: '1000' } }));
    expect((await r.service.sweep()).raised).toBe(0);
    await expect(r.service.setProfitTarget(USER, '-5')).rejects.toThrow(/target/);
    await expect(r.service.setProfitTarget(USER, '1e3')).rejects.toThrow(/target/);
  });

  it('an alert the transport did not take is sent on the next sweep, and raised only once', async () => {
    const r = await linked();
    let fail = true;
    const sent: string[] = [];
    const flaky = new TelegramDesk({
      store: r.store,
      transport: {
        send: async (_chat, text) => {
          if (fail) throw new Error('transport down');
          sent.push(text);
        },
      },
      reader: { read: async () => snapshot({ fills: [fill('f9')] }) },
      now: () => T0,
    });
    expect(await flaky.sweep()).toMatchObject({ raised: 1, sent: 0 });
    fail = false;
    expect(await flaky.sweep()).toMatchObject({ raised: 0, sent: 1 });
    expect(sent).toEqual([expect.stringContaining('Fill: BTC-PERP buy')]);
  });
});

describe('the position nearest liquidation', () => {
  const p = (symbol: string, mark: string, liq: string | null) => ({
    symbol,
    side: 'long' as const,
    size: '1',
    entryPrice: mark,
    markPrice: mark,
    unrealisedPnl: '0',
    margin: '1',
    liquidationPrice: liq,
  });
  it('is the one whose mark is nearest its liquidation price as a share of the mark; one with none reported is left out', () => {
    // BTC is 10% from liquidation, ETH 5%, SOL has no liquidation price from the venue.
    expect(nearestLiquidation([p('BTC-PERP', '60000', '54000'), p('ETH-PERP', '3000', '2850'), p('SOL-PERP', '100', null)])?.symbol).toBe(
      'ETH-PERP',
    );
    expect(nearestLiquidation([p('SOL-PERP', '100', null)])).toBeNull();
  });

  it('a warning with no liquidation price reported says so', async () => {
    const r = await linked();
    const s = marginAt('85');
    r.desk({ ...s, accounts: s.accounts.map((a) => ({ ...a, positions: a.positions.map((x) => ({ ...x, liquidationPrice: null })) })) });
    await r.service.sweep();
    expect(r.sent.at(-1)?.text).toContain('The venue reports no liquidation price for any open position.');
  });
});
