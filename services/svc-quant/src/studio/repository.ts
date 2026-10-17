import type { BacktestRunResult } from '../backtest/run.js';
import type { SavedStrategy, StrategyMetadata, StudioBlock, StudioRiskBlock } from './store.js';

/** The body of one immutable version. Money fields are decimal strings. */
export interface StrategyDraft {
  readonly name: string;
  readonly language: 'javascript';
  readonly source: string;
  readonly cash: string;
  readonly blocks: StudioBlock[];
  readonly risk: StudioRiskBlock;
  readonly environment: SavedStrategy['environment'];
  readonly kind: SavedStrategy['kind'];
  readonly claimLabel: SavedStrategy['claimLabel'];
  readonly live: false;
  readonly simulated: true;
}

export interface StrategyVersionRecord extends StrategyDraft {
  readonly version: number;
  readonly createdAt: string;
}

export interface StrategyHead extends StrategyVersionRecord {
  readonly id: string;
  readonly accountId: string;
  readonly clientStrategyId: string;
  readonly deletedAt: string | null;
}

export interface StrategyDetail extends StrategyHead {
  readonly versions: StrategyVersionRecord[];
}

export interface StrategyListPage {
  readonly strategies: readonly StrategyHead[];
  readonly nextCursor: string | null;
}

export interface OperatorListPage {
  readonly strategies: readonly StrategyMetadata[];
  readonly nextCursor: string | null;
  readonly quarantineCount: number;
}

export type OwnedBacktest = BacktestRunResult & { readonly strategyVersion: number };

export type WriteReceipt =
  | { readonly operation: 'create' | 'revise'; readonly response: StrategyDetail }
  | { readonly operation: 'delete'; readonly response: { readonly ok: true } }
  | { readonly operation: 'backtest'; readonly response: OwnedBacktest };

export interface StrategyRepository {
  replay(accountId: string, idempotencyKey: string): Promise<WriteReceipt | null>;
  create(input: { accountId: string; clientStrategyId: string; idempotencyKey: string; draft: StrategyDraft }): Promise<StrategyDetail>;
  revise(input: { accountId: string; id: string; idempotencyKey: string; draft: StrategyDraft }): Promise<StrategyDetail>;
  softDelete(input: { accountId: string; id: string; idempotencyKey: string }): Promise<{ ok: true }>;
  list(input: { accountId: string; limit: number; cursor?: string | null }): Promise<StrategyListPage>;
  get(input: { accountId: string; id: string }): Promise<StrategyDetail | null>;
  /** Owner's versions, including after soft delete. Null when the id is not theirs. */
  versions(input: { accountId: string; id: string }): Promise<readonly StrategyVersionRecord[] | null>;
  operatorList(input: { limit: number; cursor?: string | null }): Promise<OperatorListPage>;
  saveBacktest(input: {
    accountId: string;
    idempotencyKey: string;
    strategyId: string;
    strategyVersion: number;
    symbol: string;
    result: OwnedBacktest;
  }): Promise<OwnedBacktest>;
}

export function draftOf(saved: SavedStrategy): StrategyDraft {
  return {
    name: saved.name,
    language: saved.language,
    source: saved.source,
    cash: saved.cash,
    blocks: saved.blocks.map((block) => ({ side: block.side, symbol: block.symbol, qty: block.qty })),
    risk: { maxDrawdown: saved.risk.maxDrawdown, maxNotional: saved.risk.maxNotional, kill: saved.risk.kill },
    environment: saved.environment,
    kind: saved.kind,
    claimLabel: saved.claimLabel,
    live: false,
    simulated: true,
  };
}
