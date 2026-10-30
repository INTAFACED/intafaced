import type { QuantSignalRules } from '@intafaced/contracts';
import type { BacktestRunResult } from '../backtest/run.js';
import type { SavedStrategy, StrategyMetadata, StudioBlock, StudioRiskBlock } from './store.js';

/** The body of one immutable version. Money fields are decimal strings. */
export interface StrategyDraft {
  readonly name: string;
  readonly language: 'javascript';
  readonly source: string;
  readonly cash: string;
  readonly blocks: StudioBlock[];
  readonly modules: QuantSignalRules | null;
  readonly risk: StudioRiskBlock;
  readonly environment: SavedStrategy['environment'];
  readonly kind: SavedStrategy['kind'];
  readonly claimLabel: SavedStrategy['claimLabel'];
  readonly live: false;
  readonly simulated: true;
  /** What the person wrote about this version when saving it; blank is no note. */
  readonly releaseNote: string;
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
  /** One level of folder; blank is the root. Set on the head, so a move adds no version. */
  readonly folder: string;
  readonly description: string;
  /** How many times the head was renamed, moved or described: the screen keys its next organise with it. */
  readonly organised: number;
  /** How many times it came back from the recycle bin: the screen keys its next delete with it. */
  readonly restores: number;
}

/** What an organise sets on the head. All three are sent every time, so a replay states the whole head. */
export interface StrategyOrganisation {
  readonly name: string;
  readonly folder: string;
  readonly description: string;
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
  | { readonly operation: 'create' | 'revise' | 'organise' | 'restore'; readonly response: StrategyDetail }
  | { readonly operation: 'delete'; readonly response: { readonly ok: true } }
  | { readonly operation: 'backtest'; readonly response: OwnedBacktest };

export interface StrategyRepository {
  replay(accountId: string, idempotencyKey: string): Promise<WriteReceipt | null>;
  create(input: { accountId: string; clientStrategyId: string; idempotencyKey: string; draft: StrategyDraft }): Promise<StrategyDetail>;
  revise(input: { accountId: string; id: string; idempotencyKey: string; draft: StrategyDraft }): Promise<StrategyDetail>;
  softDelete(input: { accountId: string; id: string; idempotencyKey: string }): Promise<{ ok: true }>;
  /** Sets the head's name, folder and description. No version is added. A deleted strategy is not found. */
  organise(input: { accountId: string; id: string; idempotencyKey: string; head: StrategyOrganisation }): Promise<StrategyDetail>;
  /** Brings a deleted strategy back with the versions it had. One that is not deleted returns its head unchanged. */
  restore(input: { accountId: string; id: string; idempotencyKey: string }): Promise<StrategyDetail>;
  list(input: { accountId: string; limit: number; cursor?: string | null }): Promise<StrategyListPage>;
  /** The recycle bin: the caller's deleted strategies, oldest first by creation, like the list. */
  listDeleted(input: { accountId: string; limit: number; cursor?: string | null }): Promise<StrategyListPage>;
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
    modules: saved.modules,
    risk: { maxDrawdown: saved.risk.maxDrawdown, maxNotional: saved.risk.maxNotional, kill: saved.risk.kill },
    environment: saved.environment,
    kind: saved.kind,
    claimLabel: saved.claimLabel,
    live: false,
    simulated: true,
    releaseNote: '',
  };
}
