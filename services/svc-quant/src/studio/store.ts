/**
 * In-process strategy book, keyed by account.
 *
 * Process map kept for the quarantine unit test. The studio router does not
 * use it. Durable rows go through StrategyRepository (Postgres in the process
 * that has DATABASE_URL). This map is still not a money book.
 *
 * A blank account id is owner-unknown. Those rows are quarantined: no user
 * list, get, or clone returns them. Nothing on disk is loaded at boot, so the
 * quarantine count starts at 0.
 */

export interface StudioRiskBlock {
  readonly maxDrawdown: string;
  readonly maxNotional: string;
  readonly kill: string;
}

export interface StudioBlock {
  readonly side: 'buy' | 'sell';
  readonly symbol: string;
  readonly qty: string;
}

export interface SavedStrategy {
  readonly id: string;
  readonly name: string;
  readonly language: 'javascript';
  readonly source: string;
  readonly cash: string;
  readonly blocks: StudioBlock[];
  readonly risk: StudioRiskBlock;
  readonly environment: 'paper' | 'backtest' | 'shadow';
  readonly kind: 'paper' | 'simulated';
  readonly claimLabel: 'Paper — not live performance' | 'Historical simulation — not a forecast' | 'Shadow — not live performance';
  readonly live: false;
  readonly simulated: true;
}

/** Operator view. No source and no blocks — those are the strategy. */
export interface StrategyMetadata {
  readonly id: string;
  readonly accountId: string | null;
  readonly name: string;
  readonly language: 'javascript';
  readonly environment: SavedStrategy['environment'];
  readonly kind: SavedStrategy['kind'];
  readonly claimLabel: SavedStrategy['claimLabel'];
  readonly live: false;
  readonly simulated: true;
}

export interface StudioStore {
  save(accountId: string, strategy: SavedStrategy): SavedStrategy;
  get(accountId: string, id: string): SavedStrategy | undefined;
  list(accountId: string): readonly SavedStrategy[];
  replace(accountId: string, id: string, strategy: SavedStrategy): SavedStrategy | undefined;
  remove(accountId: string, id: string): boolean;
  listMetadata(): readonly StrategyMetadata[];
  quarantineCount(): number;
}

function metadata(accountId: string | null, strategy: SavedStrategy): StrategyMetadata {
  return {
    id: strategy.id,
    accountId,
    name: strategy.name,
    language: strategy.language,
    environment: strategy.environment,
    kind: strategy.kind,
    claimLabel: strategy.claimLabel,
    live: false,
    simulated: true,
  };
}

export function createStudioStore(): StudioStore {
  const byAccount = new Map<string, Map<string, SavedStrategy>>();
  const quarantine = new Map<string, SavedStrategy>();

  function book(accountId: string): Map<string, SavedStrategy> {
    let rows = byAccount.get(accountId);
    if (!rows) {
      rows = new Map();
      byAccount.set(accountId, rows);
    }
    return rows;
  }

  return {
    save(accountId, strategy) {
      if (accountId.trim() === '') {
        quarantine.set(strategy.id, strategy);
        return strategy;
      }
      book(accountId).set(strategy.id, strategy);
      return strategy;
    },
    get(accountId, id) {
      if (accountId.trim() === '') return undefined;
      return byAccount.get(accountId)?.get(id);
    },
    list(accountId) {
      if (accountId.trim() === '') return [];
      return [...(byAccount.get(accountId)?.values() ?? [])];
    },
    replace(accountId, id, strategy) {
      if (accountId.trim() === '') return undefined;
      const rows = byAccount.get(accountId);
      if (!rows?.has(id)) return undefined;
      const next: SavedStrategy = { ...strategy, id };
      rows.set(id, next);
      return next;
    },
    remove(accountId, id) {
      if (accountId.trim() === '') return false;
      return byAccount.get(accountId)?.delete(id) ?? false;
    },
    listMetadata() {
      const out: StrategyMetadata[] = [];
      for (const [accountId, rows] of byAccount) {
        for (const strategy of rows.values()) out.push(metadata(accountId, strategy));
      }
      for (const strategy of quarantine.values()) out.push(metadata(null, strategy));
      return out;
    },
    quarantineCount() {
      return quarantine.size;
    },
  };
}
