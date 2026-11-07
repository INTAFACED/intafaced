/**
 * The record of each recurring buy (D-limit-dca-05): its rounds, their transactions and its log, kept off chain beside
 * the plan the vault holds on chain. One JSON file, `dex.recurring.json`, under `DEX_ORDER_STORE_DIR`, written whole and
 * renamed into place. Amounts are kept as strings of the token's smallest units. It never holds a balance (the plan's
 * money is in the vault) and never a key.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Hex } from 'viem';

export type RoundState = 'filled' | 'scheduled' | 'waiting' | 'due' | 'cancelled';

export interface RoundRecord {
  readonly n: number;
  /** Seconds, by the chain's block time. */
  due: number;
  state: RoundState;
  txHash: Hex | null;
  amountOut: string | null;
}

export interface PlanRecord {
  readonly id: Hex;
  readonly maker: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly perRound: string;
  readonly rounds: number;
  readonly interval: number;
  readonly lowWad: string;
  readonly highWad: string;
  readonly retryWindow: number;
  readonly createdAt: string;
  roundsList: RoundRecord[];
  log: { at: string; text: string }[];
  /** A round the keeper is sending: its hash once the node took it. */
  pending: { round: number; txHash: Hex | null } | null;
  cancelled: { refund: string } | null;
  /** The round whose "outside the band" line is already in the log. */
  outsideLogged: number | null;
}

export class RecurringStore {
  private readonly path: string;
  private readonly plans = new Map<Hex, PlanRecord>();
  private block = 0n;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, 'dex.recurring.json');
    if (existsSync(this.path)) {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as { scannedBlock: string; plans: PlanRecord[] };
      this.block = BigInt(parsed.scannedBlock);
      for (const p of parsed.plans) this.plans.set(p.id, p);
    }
  }

  get(id: Hex): PlanRecord | undefined {
    return this.plans.get(id.toLowerCase() as Hex);
  }
  put(plan: PlanRecord): void {
    this.plans.set(plan.id.toLowerCase() as Hex, plan);
  }
  all(): PlanRecord[] {
    return [...this.plans.values()].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  }
  byMaker(maker: string): PlanRecord[] {
    const m = maker.toLowerCase();
    return this.all().filter((p) => p.maker === m);
  }
  scannedBlock(): bigint {
    return this.block;
  }
  setScannedBlock(block: bigint): void {
    this.block = block;
  }
  save(): void {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ scannedBlock: this.block.toString(), plans: this.all() })}\n`);
    renameSync(tmp, this.path);
  }
}
