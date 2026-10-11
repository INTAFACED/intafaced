/**
 * Persist open surveillance cases (PX-S03 / M16 / PTX-M16-R01–R09 / H9).
 * Named cases stay open evidence on the engine journal, not an in-process Map
 * alone. Recover re-reads journal + book cases. Spoofing/layering refuse
 * auto-adjudicate. Missing owner thresholds are a detector gap — never
 * threshold 0. Hitch: imported from index.ts so MatchingEngine is wrapped
 * without recutting engine.ts.
 */
import { MatchingEngine } from './engine.js';
import type { EngineJournal } from './journal-codec.js';
import { openSurveillanceCase, type OpenSurveillanceCaseResult } from './surveillance-case.js';
import type { AccountId, EngineOrder, EngineSurveillanceCase, MarketId, SubmitResult } from './types.js';

export const AUTO_ADJUDICATE_FORBIDDEN = 'auto_adjudicate_forbidden' as const;
export const DETECTOR_GAP = 'detector_gap' as const;

export const AUTO_ADJUDICATE_FORBIDDEN_MESSAGE = 'auto-adjudicate is forbidden; named reasons stay open as evidence';
export const DETECTOR_GAP_MESSAGE = 'detector threshold is unset; missing owner threshold disables the detector — never threshold 0';

const FLAG = Symbol.for('intafaced.matching.surveillance-persist');
const STORE = Symbol.for('intafaced.matching.surveillance-persist.store');

export type DetectorStatus = {
  readonly enabled: false;
  readonly gap: typeof DETECTOR_GAP;
  readonly reason: string;
  readonly threshold: null;
};

export type DetectorRefuse = {
  readonly ok: false;
  readonly code: typeof DETECTOR_GAP;
  readonly gap: typeof DETECTOR_GAP;
  readonly reason: string;
  readonly threshold: null;
  readonly message: string;
};

export type AdjudicateRefuse = {
  readonly ok: false;
  readonly code: typeof AUTO_ADJUDICATE_FORBIDDEN;
  readonly message: string;
};

type JournalRow = {
  readonly kind: string;
  readonly marketId?: MarketId;
  readonly accountId?: AccountId;
  readonly reason?: string;
};

type Host = MatchingEngine & {
  [STORE]?: Map<string, EngineSurveillanceCase>;
  openSurveillanceCases: () => readonly EngineSurveillanceCase[];
  recover: () => Promise<{ records: number; markets: number }>;
  submit: (marketId: MarketId, order: EngineOrder, proof?: unknown) => Promise<SubmitResult>;
  existingBook: (marketId: MarketId) => { openSurveillanceCases(): readonly EngineSurveillanceCase[] } | null;
};

function journalOf(engine: MatchingEngine): Pick<EngineJournal, 'append' | 'read'> | undefined {
  return (engine as unknown as { journal?: Pick<EngineJournal, 'append' | 'read'> }).journal;
}

function storeOf(engine: MatchingEngine): Map<string, EngineSurveillanceCase> {
  const host = engine as Host;
  if (!host[STORE]) host[STORE] = new Map();
  return host[STORE];
}

function caseKey(opened: EngineSurveillanceCase): string {
  return `${opened.accountId}\n${opened.marketId}\n${opened.reason}`;
}

function asOpenCase(opened: EngineSurveillanceCase): EngineSurveillanceCase {
  return {
    accountId: opened.accountId,
    marketId: opened.marketId,
    reason: opened.reason,
    status: 'open',
  };
}

function putCase(store: Map<string, EngineSurveillanceCase>, opened: EngineSurveillanceCase): void {
  const next = asOpenCase(opened);
  store.set(caseKey(next), next);
}

function unionCases(store: Map<string, EngineSurveillanceCase>, bookCases: readonly EngineSurveillanceCase[]): EngineSurveillanceCase[] {
  const merged = new Map<string, EngineSurveillanceCase>();
  for (const opened of store.values()) putCase(merged, opened);
  for (const opened of bookCases) putCase(merged, opened);
  return [...merged.values()].sort((a, b) => {
    if (a.marketId !== b.marketId) return a.marketId < b.marketId ? -1 : 1;
    if (a.reason !== b.reason) return a.reason < b.reason ? -1 : 1;
    return a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0;
  });
}

/** Journal failure after accept stays here. The SubmitResult already belongs to the caller. */
function persistSnapshotCase(engine: MatchingEngine, opened: EngineSurveillanceCase): void {
  try {
    persistToJournal(engine, opened);
  } catch {
    // Read or append failed. Do not roll back the match, cancel it, or hide the accepted result.
  }
}

function snapshotBook(engine: MatchingEngine, marketId: MarketId, extra?: readonly EngineSurveillanceCase[]): void {
  const store = storeOf(engine);
  const book = (engine as Host).existingBook(marketId);
  if (book) {
    for (const opened of book.openSurveillanceCases()) {
      putCase(store, opened);
      persistSnapshotCase(engine, opened);
    }
  }
  if (extra) {
    for (const opened of extra) {
      putCase(store, opened);
      persistSnapshotCase(engine, opened);
    }
  }
}

function alreadyJournalled(journal: Pick<EngineJournal, 'read'>, opened: EngineSurveillanceCase): boolean {
  const records = journal.read() as readonly JournalRow[];
  return records.some(
    (record) =>
      record.kind === 'open_surveillance' &&
      record.accountId === opened.accountId &&
      record.marketId === opened.marketId &&
      record.reason === opened.reason,
  );
}

/** Append named evidence before listing. Replay skips this kind — it is not a cancel. */
export function persistToJournal(engine: MatchingEngine, opened: EngineSurveillanceCase): void {
  const journal = journalOf(engine);
  if (!journal?.append) return;
  if (alreadyJournalled(journal, opened)) return;
  journal.append({
    kind: 'open_surveillance',
    marketId: opened.marketId,
    at: new Date().toISOString(),
    accountId: opened.accountId,
    reason: opened.reason,
  });
}

function hydrateFromJournal(engine: MatchingEngine): void {
  const records = journalOf(engine)?.read?.();
  if (!Array.isArray(records)) return;
  const store = storeOf(engine);
  for (const record of records) {
    if ((record as JournalRow).kind !== 'open_surveillance') continue;
    const opened = openSurveillanceCase({
      accountId: (record as JournalRow).accountId,
      marketId: (record as JournalRow).marketId,
      reason: (record as JournalRow).reason,
    });
    if (opened.ok) putCase(store, opened.case);
  }
}

/**
 * Owner spoofing / layering thresholds. No env on this process publishes them.
 * MATCHING_SURVEILLANCE_* is not added — a default number would invent a 0 band.
 * UNSET is the live product — missing owner threshold disables that detector.
 */
export function spoofingThresholdUnset(): boolean {
  return true;
}

export function layeringThresholdUnset(): boolean {
  return true;
}

/** Explicit gap. Never a threshold of 0 presented as a live detector. */
export function detectorGap(reason: string): DetectorStatus {
  return {
    enabled: false,
    gap: DETECTOR_GAP,
    reason,
    threshold: null,
  };
}

/** Unset refuses. Does not invent a case. */
export function runDetector(reason: string): DetectorRefuse {
  return {
    ok: false,
    code: DETECTOR_GAP,
    gap: DETECTOR_GAP,
    reason,
    threshold: null,
    message: DETECTOR_GAP_MESSAGE,
  };
}

/** Named reasons stay open. Auto-adjudicate is forbidden. */
export function adjudicateSurveillanceCase(_cmd: { readonly reason?: string | null }): AdjudicateRefuse {
  return {
    ok: false,
    code: AUTO_ADJUDICATE_FORBIDDEN,
    message: AUTO_ADJUDICATE_FORBIDDEN_MESSAGE,
  };
}

/** Persist a named open case via the existing mill. Never auto-closes. */
export function recordOpenSurveillanceCase(
  engine: MatchingEngine,
  input: {
    readonly accountId?: string | null;
    readonly marketId?: string | null;
    readonly reason?: string | null;
  },
): OpenSurveillanceCaseResult {
  const opened = openSurveillanceCase(input);
  if (!opened.ok) return opened;
  persistToJournal(engine, opened.case);
  putCase(storeOf(engine), opened.case);
  return opened;
}

export function installSurveillancePersist(ctor: typeof MatchingEngine = MatchingEngine): void {
  const proto = ctor.prototype as {
    openSurveillanceCases: Host['openSurveillanceCases'];
    recover: Host['recover'];
    submit: Host['submit'];
    adjudicateSurveillanceCase?: (cmd: { readonly reason?: string | null }) => AdjudicateRefuse;
    detectorStatus?: (reason: string) => DetectorStatus;
    runDetector?: (reason: string) => DetectorRefuse;
    recordOpenSurveillanceCase?: (input: {
      readonly accountId?: string | null;
      readonly marketId?: string | null;
      readonly reason?: string | null;
    }) => OpenSurveillanceCaseResult;
    [FLAG]?: boolean;
  };
  if (proto[FLAG]) return;
  proto[FLAG] = true;

  const origOpen = proto.openSurveillanceCases;
  const origRecover = proto.recover;
  const origSubmit = proto.submit;

  proto.openSurveillanceCases = function (this: MatchingEngine) {
    return unionCases(storeOf(this), origOpen.call(this));
  };

  proto.recover = async function (this: MatchingEngine) {
    const result = await origRecover.call(this);
    const store = storeOf(this);
    store.clear();
    hydrateFromJournal(this);
    for (const opened of origOpen.call(this)) putCase(store, opened);
    return result;
  };

  proto.submit = async function (this: MatchingEngine, marketId: MarketId, order: EngineOrder, proof?: unknown) {
    const result = await origSubmit.call(this, marketId, order, proof);
    snapshotBook(this, marketId, result.surveillanceCases);
    return result;
  };

  proto.adjudicateSurveillanceCase = function (this: MatchingEngine, cmd: { readonly reason?: string | null }) {
    return adjudicateSurveillanceCase(cmd);
  };

  proto.detectorStatus = function (this: MatchingEngine, reason: string) {
    return detectorGap(reason);
  };

  proto.runDetector = function (this: MatchingEngine, reason: string) {
    return runDetector(reason);
  };

  proto.recordOpenSurveillanceCase = function (
    this: MatchingEngine,
    input: {
      readonly accountId?: string | null;
      readonly marketId?: string | null;
      readonly reason?: string | null;
    },
  ) {
    return recordOpenSurveillanceCase(this, input);
  };
}

try {
  installSurveillancePersist();
} catch {
  queueMicrotask(() => installSurveillancePersist());
}
