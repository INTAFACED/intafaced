import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAddress, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import type { OrderPair } from '../vault/model.js';
import type { ChainPlan, RecurringChain, RoundFill, SendOutcome } from './chain.js';
import { DROP_RECORD_FAULT, RecurringBuys } from './plans.js';
import { RecurringStore } from './store.js';

const A = getAddress('0x00000000000000000000000000000000000a11ce');
const B = getAddress('0x00000000000000000000000000000000000b0b00');
const POOL = getAddress('0x00000000000000000000000000000000000000bb');
const MAKER = '0x1111111111111111111111111111111111111111';
const pair: OrderPair = {
  base: { address: A, symbol: 'TEST A', decimals: 6, name: 'TEST Token A' },
  quote: { address: B, symbol: 'TEST B', decimals: 18, name: 'TEST Token B' },
  pool: POOL,
};
const HOUR = 3_600n;
const WAD = 10n ** 18n;

/** The vault's rules for one plan, in memory. */
class FakeChain implements RecurringChain {
  readonly wired = true;
  readonly vault = getAddress('0x00000000000000000000000000000000000000cc') as Address;
  time = 1_800_000_000n;
  priceWad = WAD;
  plans = new Map<Hex, ChainPlan & { fills: RoundFill[] }>();
  sent: { kind: 'fill' | 'skip'; id: Hex }[] = [];
  receipts = new Map<Hex, SendOutcome>();
  private n = 0;
  private block = 0n;
  private made: { id: Hex; block: bigint }[] = [];

  make(id: Hex, low = 0n, high = 0n) {
    this.block += 1n;
    this.made.push({ id, block: this.block });
    this.plans.set(id, {
      maker: getAddress(MAKER),
      tokenIn: A,
      tokenOut: B,
      pool: POOL,
      amountPerRound: 40_000_000n,
      rounds: 4,
      filled: 0,
      interval: HOUR,
      nextDue: this.time,
      retryWindow: 1_200n,
      open: true,
      lowWad: low,
      highWad: high,
      fills: [],
    });
  }
  async created(fromBlock: bigint) {
    return { ids: this.made.filter((m) => m.block >= fromBlock).map((m) => m.id), toBlock: this.block };
  }
  async plan(id: Hex) {
    return this.plans.get(id)!;
  }
  async fills(id: Hex) {
    return this.plans.get(id)!.fills;
  }
  async price() {
    return this.priceWad;
  }
  async inBand(id: Hex) {
    const p = this.plans.get(id)!;
    return (p.lowWad === 0n || this.priceWad >= p.lowWad) && (p.highWad === 0n || this.priceWad <= p.highWad);
  }
  async now() {
    return this.time;
  }
  private hash(): Hex {
    return `0x${(++this.n).toString(16).padStart(64, '0')}`;
  }
  async sendFill(id: Hex) {
    const hash = this.hash();
    this.sent.push({ kind: 'fill', id });
    const p = this.plans.get(id)!;
    if (!p.open || this.time < p.nextDue || !(await this.inBand(id))) {
      this.receipts.set(hash, { status: 'reverted' });
      return hash;
    }
    const fill = { round: p.filled, amountOut: 39_000_000_000_000_000_000n, txHash: hash };
    this.plans.set(id, {
      ...p,
      filled: p.filled + 1,
      nextDue: p.nextDue + p.interval,
      open: p.filled + 1 < p.rounds,
      fills: [...p.fills, fill],
    });
    this.receipts.set(hash, { status: 'success', fill });
    return hash;
  }
  async sendSkip(id: Hex) {
    const hash = this.hash();
    this.sent.push({ kind: 'skip', id });
    const p = this.plans.get(id)!;
    if (this.time > p.nextDue + p.retryWindow) this.plans.set(id, { ...p, nextDue: p.nextDue + p.interval });
    this.receipts.set(hash, { status: 'success', fill: null });
    return hash;
  }
  async outcome(hash: Hex) {
    return this.receipts.get(hash) ?? { status: 'pending' as const };
  }
  async simulateFill() {
    return null;
  }
  cancel(id: Hex) {
    const p = this.plans.get(id)!;
    this.plans.set(id, { ...p, open: false });
  }
}

const ID = `0x${'ab'.repeat(32)}` as Hex;

function world() {
  const dir = mkdtempSync(join(tmpdir(), 'dex-recurring-'));
  const chain = new FakeChain();
  const buys = new RecurringBuys(new RecurringStore(dir), chain, { pair, retryWindowSeconds: 1_200, slippageBps: 50, faultDir: dir });
  return { dir, chain, buys };
}

describe('recurring buys (D-limit-dca-05)', () => {
  it('round 1 fills at the start; the next is due one interval later; nothing is sent before it is due', async () => {
    const { chain, buys } = world();
    chain.make(ID);
    await buys.tick();
    await buys.tick();
    const [plan] = (await buys.list(MAKER, false)).plans;
    expect(plan!.roundsList.map((r) => r.state)).toEqual(['filled', 'scheduled', 'scheduled', 'scheduled']);
    expect(Date.parse(plan!.roundsList[1]!.due) - Date.parse(plan!.roundsList[0]!.due)).toBe(3_600_000);
    expect(plan!.roundsList[0]!.txHash).toMatch(/^0x/);
    await buys.tick();
    expect(chain.sent.filter((s) => s.kind === 'fill')).toHaveLength(1);
  });

  it('outside its band a round waits and says so once; after the retry window it moves to the next interval', async () => {
    const { chain, buys } = world();
    chain.make(ID, 2n * WAD, 3n * WAD);
    await buys.tick();
    await buys.tick();
    let [plan] = (await buys.list(MAKER, false)).plans;
    expect(plan!.roundsList[0]!.state).toBe('waiting');
    expect(plan!.log.filter((l) => /outside your price band/.test(l.text))).toHaveLength(1);
    const due1 = Date.parse(plan!.roundsList[0]!.due) / 1000;
    chain.time = BigInt(due1 + 1_201);
    await buys.tick();
    [plan] = (await buys.list(MAKER, false)).plans;
    expect(plan!.log.some((l) => /moves to the next interval/.test(l.text))).toBe(true);
    expect(plan!.roundsList[0]!.state).toBe('scheduled');
    expect(Date.parse(plan!.nextFill!) / 1000).toBe(due1 + 3_600);
    expect(chain.sent.filter((s) => s.kind === 'fill')).toHaveLength(0);
  });

  it('a round sent with its record lost is recorded from the chain when the page opens, and never sent twice', async () => {
    const { dir, chain, buys } = world();
    chain.make(ID);
    await buys.tick();
    await buys.tick();
    writeFileSync(join(dir, DROP_RECORD_FAULT), 'x');
    chain.time += HOUR;
    await buys.tick();
    await buys.tick();
    let [plan] = (await buys.list(MAKER, false)).plans;
    expect(chain.plans.get(ID)!.filled).toBe(2);
    expect(plan!.roundsList[1]!.state).not.toBe('filled');
    [plan] = (await buys.list(MAKER, true)).plans;
    expect(plan!.roundsList[1]!.state).toBe('filled');
    expect(plan!.roundsList[1]!.txHash).toBe(chain.plans.get(ID)!.fills[1]!.txHash);
    expect(plan!.log.some((l) => /Round 2 recorded from the chain/.test(l.text))).toBe(true);
    await buys.tick();
    await buys.tick();
    expect(chain.sent.filter((s) => s.kind === 'fill')).toHaveLength(2);
  });

  it('edit and pause refuse in words; a cancel returns the unfilled remainder exactly and ends the rounds left', async () => {
    const { chain, buys } = world();
    chain.make(ID);
    await buys.tick();
    await buys.tick();
    expect(() => buys.refuseChange(MAKER, ID)).toThrow(/cannot be paused or edited.*Cancel.*create a new one/);
    const call = await buys.cancelCall(MAKER, ID);
    expect(call.refund).toBe('120');
    expect(call.symbol).toBe('TEST Token A');
    chain.cancel(ID);
    await buys.tick();
    const [plan] = (await buys.list(MAKER, false)).plans;
    expect(plan!.state).toBe('cancelled');
    expect(plan!.roundsList.slice(1).map((r) => r.state)).toEqual(['cancelled', 'cancelled', 'cancelled']);
  });

  it('idle-deposit yield is off and names the owner decision and the lending contract', async () => {
    const { buys } = world();
    const o = await buys.options();
    expect(o.idleYield.available).toBe(false);
    expect(o.idleYield.reason).toMatch(/owner\.decision/);
    expect(o.idleYield.reason).toMatch(/lending contract/i);
  });
});
