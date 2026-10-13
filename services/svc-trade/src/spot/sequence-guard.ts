import type { Sql } from 'postgres';
import { MatchingNoBookError, MatchingUnavailableError, type EngineDepth } from './matching-client.js';

/**
 * HAS THE ENGINE FORGOTTEN WHAT WE ALREADY SETTLED?
 *
 * ── The failure ─────────────────────────────────────────────────────────
 *
 * `OrderBook.sequence` is an in-memory counter that starts at 0. It survives a
 * restart only through the journal: `replay()` re-executes the recorded inputs,
 * and `fromState()` restores it from a snapshot. In the deployed shape the
 * journal is a named volume (`matchingjournal`), so it normally does survive.
 *
 * It does not survive ASYMMETRIC data loss — the engine's volume cleared while
 * Postgres keeps `trade.fills`. A wiped `.data` on a laptop, a re-created
 * container with an anonymous volume, a restore of one and not the other. The
 * engine then hands out sequence 1, 2, 3 for a market whose fills already run
 * to five hundred, and `fillIdFor(market, sequence)` — which is also the
 * ledger's `trade.fill:<id>` idempotency key — starts pointing at trades that
 * settled weeks ago.
 *
 * ── What already catches it, and what does not ──────────────────────────
 *
 * `insertFillLeg` catches the collision at settlement (#899): the second claim
 * on a `(market, sequence, role)` is refused by name instead of a Postgres 500.
 * That is the safety net and it works.
 *
 * But it fires on a USER'S ORDER. The first person to trade after a bad restart
 * gets the refusal, and the operator learns from that, which is the wrong way
 * round: the replica was already unfit to serve when it finished booting.
 *
 * `/ready` observes this before a load balancer routes new traffic. The same
 * comparison also runs before a new admitted order inserts its intent or posts
 * its hold. Existing order retries retain their original row.
 *
 * ── The invariant ───────────────────────────────────────────────────────
 *
 *   engine sequence for a market  >=  MAX(trade.fills.sequence) for that market
 *
 * Sound in one direction only, which is the direction that matters. The engine
 * consumes a sequence for every accept, cancel and fill, while `trade.fills`
 * records only the fills — so a healthy engine is always AHEAD, usually far
 * ahead. Behind is not a close call or a race; it means the counter restarted.
 *
 * A market with no recorded fills cannot be judged and is skipped rather than
 * guessed at. A market that already has fills, whose book is missing, is not
 * that case: the next submit would start the counter again. That absence is a
 * regression. Do not invent a sequence to stand in for the missing book.
 */

/**
 * Ask the engine for its counter on one market. Three outcomes, and they stay
 * distinct:
 *
 *   - a valid counter (a non-negative safe integer from a successful reply);
 *   - null, ONLY when matching positively answers that it holds no book (404);
 *   - a throw for everything else. A transport failure or 5xx is already a
 *     MatchingUnavailableError from the client. A successful reply whose
 *     `sequence` is null, missing or not a counter is malformed, and is
 *     reported as unavailable rather than read as a missing book.
 */
export async function probeEngineSequence(
  depth: (marketId: string) => Promise<Pick<EngineDepth, 'sequence'>>,
  marketId: string,
): Promise<number | null> {
  let reply: Pick<EngineDepth, 'sequence'>;
  try {
    reply = await depth(marketId);
  } catch (err) {
    if (err instanceof MatchingNoBookError) return null;
    throw err;
  }
  const sequence: unknown = (reply as { sequence?: unknown } | null | undefined)?.sequence;
  if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 0) {
    throw new MatchingUnavailableError('matching depth did not report a valid sequence counter');
  }
  return sequence;
}

/**
 * No recorded fill: unjudged. Recorded fills with no book, or a live counter
 * behind that max: regression. Otherwise the engine is ahead or equal, which
 * is healthy.
 */
export function judgeEngineSequence(
  recordedSequence: number | undefined,
  engineSequence: number | null,
): 'unjudged' | 'healthy' | 'regression' {
  if (recordedSequence === undefined) return 'unjudged';
  if (!Number.isSafeInteger(recordedSequence) || recordedSequence < 0) {
    throw new MatchingUnavailableError('stored fill sequence cannot be compared safely');
  }
  if (engineSequence !== null && (!Number.isSafeInteger(engineSequence) || engineSequence < 0)) {
    throw new MatchingUnavailableError('matching depth did not report a valid sequence counter');
  }
  if (engineSequence === null || engineSequence < recordedSequence) return 'regression';
  return 'healthy';
}

export interface SequenceRegression {
  readonly marketId: string;
  readonly symbol: string;
  /**
   * Where the live book's counter is now. Null means the engine holds no book.
   * That is not a stand-in number: a missing book is not sequence 0.
   */
  readonly engineSequence: number | null;
  /** The highest sequence we have already settled and recorded. */
  readonly recordedSequence: number;
}

export interface SequenceUnavailable {
  readonly marketId: string;
  readonly symbol: string;
  /**
   * Why the engine counter could not be read (outage, 5xx, malformed reply), for
   * logs only: it can carry upstream response text, so never send it to a
   * client. Not evidence of a lost journal. (`trade.fills.sequence` is a
   * Postgres integer, so the stored side is always a safe integer.)
   */
  readonly reason: string;
}

export interface SequenceGuardResult {
  /** Markets judged — recorded fills, including a missing book after those fills. */
  readonly checked: number;
  /**
   * Markets whose engine counter is behind what we have settled. Empty is the
   * only healthy answer.
   */
  readonly regressions: readonly SequenceRegression[];
  /**
   * Markets with no recorded fill. A missing book there is not a regression:
   * the first submit may open the counter. Not counted as healthy and not
   * counted as failing.
   */
  readonly unjudged: number;
  /**
   * Markets with recorded fills whose engine counter could not be read: an
   * outage, a 5xx, or a malformed reply. Not ready, but not a regression —
   * the engine may be fine and merely unreachable.
   */
  readonly unavailable: readonly SequenceUnavailable[];
}

export interface SequenceGuardDeps {
  readonly sql: Sql;
  /** Live markets to check. */
  readonly markets: () => Promise<ReadonlyArray<{ id: string; symbol: string }>>;
  /**
   * The engine's current counter for a market, or null ONLY when matching
   * positively reports no book. Throw when the answer is unknown (outage, 5xx,
   * malformed reply); see `probeEngineSequence`. `depth(marketId, 1)` is the
   * cheapest way to ask — and since the memo landed it is close to free.
   */
  readonly engineSequence: (marketId: string) => Promise<number | null>;
}

/**
 * Check every market once. Cheap enough for boot and for `/ready`: one grouped
 * query plus one depth call per market.
 */
export async function checkEngineSequences(deps: SequenceGuardDeps): Promise<SequenceGuardResult> {
  const markets = await deps.markets();
  if (markets.length === 0) return { checked: 0, regressions: [], unjudged: 0, unavailable: [] };

  const rows = await deps.sql<Array<{ market_id: string; max_sequence: string | null }>>`
    SELECT market_id, MAX(sequence)::text AS max_sequence
      FROM trade.fills
     GROUP BY market_id
  `;
  const recorded = new Map(rows.map((r) => [r.market_id, Number(r.max_sequence)]));

  const regressions: SequenceRegression[] = [];
  const unavailable: SequenceUnavailable[] = [];
  let checked = 0;
  let unjudged = 0;

  for (const market of markets) {
    const recordedSequence = recorded.get(market.id);
    // Never traded: there is nothing to be behind of, and no book is honest.
    if (recordedSequence === undefined) {
      unjudged += 1;
      continue;
    }

    // Fills exist. A missing book is the counter about to start again, which
    // is the same regression as a live counter sitting below the recorded max.
    // An unknown answer is not a missing book: keep it out of the regression
    // list, so an outage is never reported as a lost journal.
    let engineSequence: number | null;
    let verdict: ReturnType<typeof judgeEngineSequence>;
    try {
      engineSequence = await deps.engineSequence(market.id);
      verdict = judgeEngineSequence(recordedSequence, engineSequence);
    } catch (err) {
      unavailable.push({ marketId: market.id, symbol: market.symbol, reason: (err as Error).message });
      continue;
    }
    checked += 1;
    if (verdict === 'regression') {
      regressions.push({ marketId: market.id, symbol: market.symbol, engineSequence, recordedSequence });
    }
  }

  return { checked, regressions, unjudged, unavailable };
}

/** One line an operator can act on, naming the market and both numbers. */
export function describeRegressions(regressions: readonly SequenceRegression[]): string {
  const detail = regressions
    .map((r) =>
      r.engineSequence === null
        ? `${r.symbol} (engine book missing, settled ${r.recordedSequence})`
        : `${r.symbol} (engine ${r.engineSequence} < settled ${r.recordedSequence})`,
    )
    .join(', ');
  return (
    `the matching engine's sequence counter is BEHIND what this service has already settled: ${detail}. ` +
    `Its journal has been lost or replaced while trade.fills was kept, so it will re-issue sequences that already ` +
    `identify settled trades — and fillIdFor(market, sequence) is the ledger's idempotency key. ` +
    `Restore the engine's journal volume, or replay it, before serving traffic.`
  );
}

/**
 * Not ready because the engine could not be asked. No journal or replay advice:
 * nothing says it was lost. Public text names only the markets; the full cause
 * (which may echo upstream bodies) stays in the log.
 */
export function describeUnavailable(unavailable: readonly SequenceUnavailable[]): string {
  const detail = unavailable.map((u) => u.symbol).join(', ');
  return `the matching engine's sequence counter could not be read (unreachable or malformed reply) for: ${detail}. Readiness is unknown until matching answers.`;
}
