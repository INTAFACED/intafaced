/**
 * RECURRING BUYS (D-limit-dca-05, J-dex-protocol-11): a person buys a little of one token with another on a schedule.
 *
 * The money and the schedule are on chain (RecurringBuyVault): starting a plan moves every round's input from the
 * person's wallet into the plan; each round swaps one round's input through the plan's pool, the output straight to the
 * wallet; cancelling returns the unfilled remainder exactly. This service builds the calls the wallet sends, keeps a
 * record of each plan's rounds and log, and runs the keeper that fills a due round inside its price band, or moves it to
 * the next interval once its retry window has passed. The keeper's sends need no signature per round: the vault lets a
 * round do only what the plan says.
 *
 * A round's record is written from the send that made it. A round the chain shows filled with no record (the keeper
 * stopped between its send and its record) is found again by the plan's own id in the vault's `RoundFilled` log and
 * recorded "from the chain": when the person opens the page, and before the keeper sends any later round. Nothing is
 * ever sent twice: the vault's schedule moves on with each fill, so a second send of the same round reverts.
 */
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { encodeFunctionData, formatUnits, getAddress, parseUnits, type Address, type Hex } from 'viem';
import type { DexRecurringInterval, DexRecurringPlan } from '@intafaced/contracts/protocol-dex-orders';
import type { OrderPrincipal } from '../auth/order-session.js';
import { ERC20_ABI } from '../vault/abi.js';
import type { OrderPair } from '../vault/model.js';
import { RECURRING_ABI, type RecurringChain } from './chain.js';
import { recurringCodes, refuseRecurring } from './errors.js';
import type { PlanRecord, RecurringStore } from './store.js';

export const INTERVAL_SECONDS: Record<DexRecurringInterval, number> = { hour: 3_600, day: 86_400, week: 604_800 };
const BPS = 10_000n;
/** The local TEST fault (`local-test-gates.mjs dca-drop-record`): the next round is sent and its record lost. */
export const DROP_RECORD_FAULT = 'dca-drop-record';

export interface RecurringSettings {
  readonly pair: OrderPair | undefined;
  readonly retryWindowSeconds: number | undefined;
  readonly slippageBps: number | undefined;
  /** Where the local TEST fault's marker is looked for; unset outside dev and test. */
  readonly faultDir: string | undefined;
}

const decimalOf = (raw: string | undefined, decimals: number, what: string): bigint => {
  const text = (raw ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return refuseRecurring(recurringCodes.badRequest, `${what} must be a positive decimal number.`);
  const [, frac = ''] = text.split('.');
  if (frac.length > decimals) return refuseRecurring(recurringCodes.badRequest, `${what} has more than ${decimals} decimals.`);
  return parseUnits(text, decimals);
};
const text = (units: bigint, decimals: number) => {
  const s = formatUnits(units, decimals);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
};
const PRICE = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 6,
  roundingMode: 'trunc',
  useGrouping: false,
});
const priceText = (wad: bigint) => PRICE.format(formatUnits(wad, 18) as `${number}`);
/** A token as the recurring buy page names it: its full name, else its symbol. */
const nameOf = (t: { symbol: string; name?: string }) => t.name ?? t.symbol;
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
const intervalOf = (seconds: number): DexRecurringInterval =>
  (Object.entries(INTERVAL_SECONDS).find(([, s]) => s === seconds)?.[0] as DexRecurringInterval | undefined) ?? 'hour';

export class RecurringBuys {
  private running = false;

  constructor(
    private readonly store: RecurringStore,
    private readonly chain: RecurringChain,
    private readonly settings: RecurringSettings,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private pair(): OrderPair {
    if (!this.chain.wired || !this.settings.pair)
      return refuseRecurring(recurringCodes.unwired, 'Recurring buys are not connected on this network.');
    return this.settings.pair;
  }
  private retryWindow(): number {
    const w = this.settings.retryWindowSeconds;
    if (w === undefined) return refuseRecurring(recurringCodes.retryWindowUnset, 'The retry window for a recurring buy is not published.');
    return w;
  }
  private tokenOf(address: string) {
    const pair = this.pair();
    const a = getAddress(address);
    if (a === pair.base.address) return pair.base;
    if (a === pair.quote.address) return pair.quote;
    return refuseRecurring(recurringCodes.badRequest, 'That token is not offered for recurring buys here.');
  }

  async options() {
    const pair = this.pair();
    const tokens = [pair.base, pair.quote].map((t) => ({ address: t.address, symbol: nameOf(t), decimals: t.decimals }));
    const p = await this.chain.price(pair.base.address, pair.quote.address);
    return {
      tokens,
      intervals: Object.keys(INTERVAL_SECONDS) as DexRecurringInterval[],
      retryWindowSeconds: this.retryWindow(),
      price: p === null ? null : priceText(p),
      priceUnit: `${nameOf(pair.base)} per ${nameOf(pair.quote)}`,
      idleYield: {
        available: false,
        reason:
          'Earning on idle deposits is off: it waits on owner.decision.dca_idle_yield (whether and where idle deposits earn) and on a lending contract that is not published yet.',
      },
    };
  }

  /** The two calls the wallet sends to start a plan: allow the vault the whole input, then create the plan. */
  async prepare(
    _principal: OrderPrincipal,
    input: {
      spend: string;
      buy: string;
      amountEachRound: string;
      rounds: number;
      every: DexRecurringInterval;
      lowestPrice?: string;
      highestPrice?: string;
    },
  ) {
    const pair = this.pair();
    const spend = this.tokenOf(input.spend);
    const buy = this.tokenOf(input.buy);
    if (spend.address === buy.address) return refuseRecurring(recurringCodes.badRequest, 'Spend and buy must be two different tokens.');
    const slip = this.settings.slippageBps;
    if (slip === undefined) return refuseRecurring(recurringCodes.retryWindowUnset, 'The slippage default is not published.');
    const per = decimalOf(input.amountEachRound, spend.decimals, 'The amount each round');
    if (per === 0n) return refuseRecurring(recurringCodes.badRequest, 'The amount each round must be more than zero.');
    const low = input.lowestPrice ? decimalOf(input.lowestPrice, 18, 'The lowest price') : 0n;
    const high = input.highestPrice ? decimalOf(input.highestPrice, 18, 'The highest price') : 0n;
    if (high !== 0n && low > high) return refuseRecurring(recurringCodes.badRequest, 'The lowest price must not be above the highest.');
    const total = per * BigInt(input.rounds);
    const vault = this.chain.vault!;
    const terms = {
      tokenIn: spend.address,
      tokenOut: buy.address,
      pool: pair.pool,
      amountPerRound: per,
      rounds: input.rounds,
      interval: BigInt(INTERVAL_SECONDS[input.every]),
      lowWad: low,
      highWad: high,
      retryWindow: BigInt(this.retryWindow()),
      slippageBps: slip,
    };
    return {
      total: text(total, spend.decimals),
      symbol: nameOf(spend),
      calls: [
        {
          label: `Allow the recurring buy vault to take ${text(total, spend.decimals)} ${nameOf(spend)} (${input.rounds} rounds)`,
          to: spend.address,
          data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [vault, total] }),
        },
        {
          label: `Start the recurring buy: ${text(per, spend.decimals)} ${nameOf(spend)} into ${nameOf(buy)}, ${input.rounds} rounds, every ${input.every}`,
          to: vault,
          data: encodeFunctionData({ abi: RECURRING_ABI, functionName: 'create', args: [terms] }),
        },
      ],
    };
  }

  /** Reads plans made on chain since the last read into the record. */
  private async scan(): Promise<void> {
    const from = this.store.scannedBlock();
    const { ids, toBlock } = await this.chain.created(from);
    for (const id of ids) {
      if (this.store.get(id)) continue;
      const p = await this.chain.plan(id);
      const first = Number(p.nextDue);
      this.store.put({
        id: id.toLowerCase() as Hex,
        maker: p.maker.toLowerCase(),
        tokenIn: p.tokenIn,
        tokenOut: p.tokenOut,
        perRound: p.amountPerRound.toString(),
        rounds: p.rounds,
        interval: Number(p.interval),
        lowWad: p.lowWad.toString(),
        highWad: p.highWad.toString(),
        retryWindow: Number(p.retryWindow),
        createdAt: this.now().toISOString(),
        roundsList: Array.from({ length: p.rounds }, (_, n) => ({
          n: n + 1,
          due: first + n * Number(p.interval),
          state: 'scheduled' as const,
          txHash: null,
          amountOut: null,
        })),
        log: [],
        pending: null,
        cancelled: null,
        outsideLogged: null,
      });
    }
    this.store.setScannedBlock(toBlock + 1n);
    this.store.save();
  }

  private say(rec: PlanRecord, words: string) {
    rec.log.push({ at: this.now().toISOString(), text: words });
    if (rec.log.length > 100) rec.log.splice(0, rec.log.length - 100);
  }

  /** Records every round the chain filled that the record lacks, from the vault's own log by the plan's id. */
  private async recordFromChain(rec: PlanRecord): Promise<void> {
    const fills = await this.chain.fills(rec.id);
    for (const f of fills) {
      const row = rec.roundsList[f.round];
      if (!row || row.state === 'filled') continue;
      row.state = 'filled';
      row.txHash = f.txHash;
      row.amountOut = f.amountOut.toString();
      this.say(rec, `Round ${f.round + 1} recorded from the chain (transaction ${f.txHash}).`);
    }
    if (rec.pending) rec.pending = null;
  }

  private filledCount = (rec: PlanRecord) => rec.roundsList.filter((r) => r.state === 'filled').length;

  /** The record's round schedule follows the chain's: a moved round moves every later one. */
  private moveFrom(rec: PlanRecord, index: number, due: number) {
    for (let i = index; i < rec.roundsList.length; i += 1) {
      const row = rec.roundsList[i]!;
      if (row.state === 'filled' || row.state === 'cancelled') continue;
      row.due = due + (i - index) * rec.interval;
      row.state = 'scheduled';
    }
  }

  async list(wallet: string, fresh: boolean): Promise<{ plans: DexRecurringPlan[] }> {
    this.pair();
    await this.scan();
    const mine = this.store.byMaker(wallet);
    if (fresh) {
      for (const rec of mine) if (!rec.cancelled) await this.recordFromChain(rec);
      this.store.save();
    }
    return { plans: mine.map((rec) => this.view(rec)) };
  }

  private view(rec: PlanRecord): DexRecurringPlan {
    const pair = this.pair();
    const tok = (a: string) => {
      const t = getAddress(a) === pair.base.address ? pair.base : pair.quote;
      return { address: t.address, symbol: nameOf(t), decimals: t.decimals };
    };
    const spend = tok(rec.tokenIn);
    const buy = tok(rec.tokenOut);
    const filled = this.filledCount(rec);
    const next = rec.cancelled ? undefined : rec.roundsList.find((r) => r.state !== 'filled' && r.state !== 'cancelled');
    return {
      id: rec.id,
      spend,
      buy,
      amountEachRound: text(BigInt(rec.perRound), spend.decimals),
      rounds: rec.rounds,
      filled,
      every: intervalOf(rec.interval),
      lowestPrice: rec.lowWad === '0' ? null : priceText(BigInt(rec.lowWad)),
      highestPrice: rec.highWad === '0' ? null : priceText(BigInt(rec.highWad)),
      retryWindowSeconds: rec.retryWindow,
      nextFill: next ? iso(next.due) : null,
      state: rec.cancelled ? 'cancelled' : filled === rec.rounds ? 'done' : 'open',
      refund: rec.cancelled ? text(BigInt(rec.cancelled.refund), spend.decimals) : null,
      roundsList: rec.roundsList.map((r) => ({
        n: r.n,
        due: iso(r.due),
        state: r.state,
        txHash: r.txHash,
        amountOut: r.amountOut === null ? null : text(BigInt(r.amountOut), buy.decimals),
      })),
      log: [...rec.log].reverse(),
    };
  }

  private mine(wallet: string, id: string): PlanRecord {
    const rec = /^0x[0-9a-fA-F]{64}$/.test(id) ? this.store.get(id as Hex) : undefined;
    if (!rec || rec.maker !== wallet.toLowerCase())
      return refuseRecurring(recurringCodes.notFound, 'There is no such recurring buy for this wallet.');
    return rec;
  }

  /** A plan's terms are fixed on chain: it cannot be paused or edited, only cancelled and made again. */
  refuseChange(wallet: string, id: string): never {
    this.mine(wallet, id);
    return refuseRecurring(
      recurringCodes.notEditable,
      'A recurring buy cannot be paused or edited. Cancel it, and its unfilled remainder comes back to your wallet; then create a new one.',
    );
  }

  /** The wallet's cancel call, and the remainder it returns: the rounds not filled, exactly. */
  async cancelCall(wallet: string, id: string) {
    const rec = this.mine(wallet, id);
    if (rec.cancelled) return refuseRecurring(recurringCodes.closed, 'This recurring buy has already ended.');
    const p = await this.chain.plan(rec.id);
    if (!p.open) return refuseRecurring(recurringCodes.closed, 'This recurring buy has already ended.');
    const spend = this.tokenOf(rec.tokenIn);
    const refund = p.amountPerRound * BigInt(p.rounds - p.filled);
    return {
      refund: text(refund, spend.decimals),
      symbol: nameOf(spend),
      calls: [
        {
          label: `Cancel the recurring buy and return ${text(refund, spend.decimals)} ${nameOf(spend)} to your wallet`,
          to: this.chain.vault!,
          data: encodeFunctionData({ abi: RECURRING_ABI, functionName: 'cancel', args: [rec.id] }),
        },
      ],
    };
  }

  /** The keeper's pass over every open plan. Never two passes at once. */
  async tick(): Promise<void> {
    if (this.running || !this.chain.wired || !this.settings.pair) return;
    this.running = true;
    try {
      await this.scan();
      for (const rec of this.store.all()) {
        try {
          await this.serve(rec);
        } catch (err) {
          this.say(rec, `The keeper could not read this plan: ${err instanceof Error ? err.message.slice(0, 80) : 'unknown'}.`);
        }
      }
      this.store.save();
    } finally {
      this.running = false;
    }
  }

  private async serve(rec: PlanRecord): Promise<void> {
    if (rec.cancelled || this.filledCount(rec) === rec.rounds) return;
    const p = await this.chain.plan(rec.id);
    if (!p.open && this.filledCount(rec) < p.filled) await this.recordFromChain(rec);
    if (!p.open) {
      // Cancelled on chain (by the maker): the rounds left end here, with what came back.
      if (p.filled < p.rounds && !rec.cancelled) {
        rec.cancelled = { refund: (p.amountPerRound * BigInt(p.rounds - p.filled)).toString() };
        for (const row of rec.roundsList) if (row.state !== 'filled') row.state = 'cancelled';
        this.say(
          rec,
          `Cancelled: ${text(BigInt(rec.cancelled.refund), this.tokenOf(rec.tokenIn).decimals)} ${nameOf(this.tokenOf(rec.tokenIn))} returned to your wallet.`,
        );
      }
      return;
    }
    if (rec.pending) {
      if (!rec.pending.txHash) return void (rec.pending = null);
      const out = await this.chain.outcome(rec.pending.txHash, rec.id);
      if (out.status === 'pending') return;
      const n = rec.pending.round;
      rec.pending = null;
      if (out.status === 'reverted' || !out.fill) return this.say(rec, `Round ${n + 1}: the network refused the swap; it is tried again.`);
      const row = rec.roundsList[out.fill.round]!;
      row.state = 'filled';
      row.txHash = out.fill.txHash;
      row.amountOut = out.fill.amountOut.toString();
      this.say(rec, `Round ${out.fill.round + 1} filled (transaction ${out.fill.txHash}).`);
      return;
    }

    const now = Number(await this.chain.now());
    const index = p.filled;
    const row = rec.roundsList[index];
    if (!row || now < Number(p.nextDue)) {
      // Nothing is due on chain yet; the record keeps the chain's schedule.
      if (row && row.state !== 'filled' && row.due !== Number(p.nextDue) && this.filledCount(rec) === p.filled)
        this.moveFrom(rec, index, Number(p.nextDue));
      return;
    }
    // A round is due. A round the chain filled with no record is recorded first; nothing is sent twice.
    if (this.filledCount(rec) < p.filled) await this.recordFromChain(rec);

    if (!(await this.chain.inBand(rec.id))) {
      if (now > Number(p.nextDue) + Number(p.retryWindow)) {
        await this.chain.sendSkip(rec.id);
        const moved = Number(p.nextDue) + rec.interval;
        this.moveFrom(rec, index, moved);
        rec.outsideLogged = null;
        this.say(
          rec,
          `Round ${index + 1} stayed outside your price band for the whole retry window, so it moves to the next interval (${iso(moved)}).`,
        );
        return;
      }
      row.state = 'waiting';
      if (rec.outsideLogged !== index) {
        rec.outsideLogged = index;
        const price = await this.chain.price(p.tokenIn, p.tokenOut);
        this.say(
          rec,
          `Round ${index + 1} waits: the price${price === null ? '' : ` (${priceText(price)})`} is outside your price band. It is tried until the retry window ends.`,
        );
      }
      return;
    }

    const why = await this.chain.simulateFill(rec.id);
    if (why) return this.say(rec, `Round ${index + 1} could not swap now (${why}); it is tried again.`);
    row.state = 'due';
    const drop = this.settings.faultDir ? join(this.settings.faultDir, DROP_RECORD_FAULT) : null;
    if (drop && existsSync(drop)) {
      // LOCAL TEST fault: the round is sent and its record lost, as a keeper that stops right after its send.
      unlinkSync(drop);
      await this.chain.sendFill(rec.id);
      row.state = 'scheduled';
      return;
    }
    rec.pending = { round: index, txHash: null };
    this.store.save();
    rec.pending = { round: index, txHash: await this.chain.sendFill(rec.id) };
    this.store.save();
  }
}

/** Starts the recurring keeper on its interval; a blank interval does not start it. */
export function startRecurringKeeper(buys: RecurringBuys, intervalMs: number | undefined, onError: (err: unknown) => void): () => void {
  if (!intervalMs) return () => undefined;
  const timer = setInterval(() => {
    buys.tick().catch(onError);
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
