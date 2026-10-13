import { parseAmount } from '@intafaced/ledger-client/money';
import type { EngineLiveOrder } from './engine/types.js';

/**
 * ENGINE ↔ COUNTERPART RECONCILE.
 *
 * ── The bug this exists for ─────────────────────────────────────────────────
 *
 * The engine's state and the order/ledger state have independent lifecycles and
 * nothing compared them. The engine's books live in memory, rebuilt at boot by
 * replaying `engine_journal.ndjson`; svc-trade's `trade.orders` and the ledger's
 * hold accounts live in Postgres. Reset one, and the other does not notice.
 *
 * Measured on the dev fleet on 2026-08-03, with everything green:
 *
 *   · engine `GET /markets` → 10 market ids, 26 journal records
 *   · `trade.markets`       → 16 markets, and **not one of the engine's 10 is
 *                             among them** — the intersection is empty
 *   · `trade.orders`        → 0 rows
 *   · `ledger.accounts`     → 17 live `order:<id>` hold accounts, every one of
 *                             them naming an order id that appears in the
 *                             journal and in no `trade.orders` row
 *
 * Nothing was stranded, because all 17 balances happened to be zero. That is
 * luck, not a property. Flip one of those balances positive and the value is
 * unreachable: it belongs to an order svc-trade cannot find, so no cancel path
 * will ever release it, and `reconcileOrder` — which starts by looking the
 * order up — returns `not_found` and stops.
 *
 * ── Why the answer is a report and not a repair ─────────────────────────────
 *
 * Every disagreement below could be "fixed" by picking a side. None of them
 * should be. The engine holding an order the caller has never heard of and the
 * caller holding funds for an order the engine has never heard of are the same
 * observation from two ends, and which one is *wrong* is not derivable from the
 * two states — it depends on which write was lost, and a lost fill looks
 * exactly like an order that was never live.
 *
 * So this classifies and refuses. It writes nothing, cancels nothing, and moves
 * no value; §0.6 value movement is a ledger recipe and recipes are an owner
 * carve-out. What it produces is a finding that names the order and **both**
 * states, which is the thing an operator needs and did not have.
 *
 * ── Purity ──────────────────────────────────────────────────────────────────
 *
 * The counterpart's view arrives as an argument. This service opens no database
 * (`env.ts`: "there is no `DATABASE_URL`"), reads no other schema (§2), and
 * learns nothing about assets, users or holds — `funded` is a boolean the
 * caller asserts and this file only relays. The engine stays a thing that
 * speaks in account ids and quantities.
 */

/**
 * What the caller believes about one order.
 *
 * `state` is deliberately three values and not svc-trade's status enum: mapping
 * `filled | cancelled | rejected | expired` down to `terminal` is the caller's
 * job, and doing it here would teach the engine an enum that belongs to another
 * service.
 */
export interface CounterpartOrder {
  readonly orderId: string;
  readonly marketId: string;
  /** `pending` = intent recorded, not yet live. `open` = should be live now. `terminal` = done. */
  readonly state: 'pending' | 'open' | 'terminal';
  /** Decimal string. What the caller believes is still working. */
  readonly remaining: string;
  /**
   * Does the caller hold value against this order right now?
   *
   * The engine never computes this and never learns what it is denominated in.
   * It is the one bit that separates "an intent row nobody funded" — safely
   * deletable — from "money is sitting against this", which is never safely
   * anything without a human.
   */
  readonly funded: boolean;
  /** Free text the caller wants echoed into a refusal, e.g. `hold=200 USDT`. */
  readonly detail?: string;
}

/**
 * ── THE FAILURE MODES, IN BOTH DIRECTIONS ───────────────────────────────────
 *
 * | case                                        | engine        | counterpart          | verdict |
 * | ------------------------------------------- | ------------- | -------------------- | ------- |
 * | `agreed`                                    | live, qty N   | open, qty N          | clean   |
 * | `counterpart_unfunded_engine_missing`       | absent        | pending, unfunded    | auto    |
 * | `counterpart_open_engine_missing`           | absent        | open, funded         | REFUSE  |
 * | `engine_only`                               | live          | unknown              | REFUSE  |
 * | `quantity_disagreement`                     | live, qty N   | open, qty M (N≠M)    | REFUSE  |
 * | `counterpart_terminal_engine_live`          | live          | terminal             | REFUSE  |
 * | `counterpart_pending_engine_live`           | live, qty N   | pending, qty N       | REFUSE  |
 * | `market_disagreement`                       | live in A     | open in B            | REFUSE  |
 * | `unreadable_amount`                         | —             | malformed decimal    | REFUSE  |
 * | `duplicate_counterpart_id`                  | any           | same id twice        | REFUSE  |
 */
export const RECONCILE_CASES = [
  'agreed',
  'counterpart_unfunded_engine_missing',
  'counterpart_open_engine_missing',
  'engine_only',
  'quantity_disagreement',
  'counterpart_terminal_engine_live',
  'counterpart_pending_engine_live',
  'market_disagreement',
  'unreadable_amount',
  'duplicate_counterpart_id',
] as const;

export type ReconcileCase = (typeof RECONCILE_CASES)[number];

/**
 * `clean`  — the two sides agree; say nothing.
 * `auto`   — safe for the owning service to repair without asking, because the
 *            repair provably moves no value.
 * `refuse` — a human must look. Resolving it means choosing which side is
 *            wrong, and that choice is not in the data.
 */
export type ReconcileVerdict = 'clean' | 'auto' | 'refuse';

export interface ReconcileFinding {
  readonly orderId: string;
  readonly case: ReconcileCase;
  readonly verdict: ReconcileVerdict;
  /** The engine's state, in words. Present in every finding — a refusal that names one side is not actionable. */
  readonly engine: string;
  /** The counterpart's state, in words. */
  readonly counterpart: string;
  /** Why it cannot be resolved automatically, or why it safely can. */
  readonly reason: string;
}

export interface ReconcileReport {
  /** Distinct order ids considered, from both sides. */
  readonly checked: number;
  readonly agreed: number;
  /** Everything that is not `agreed`. Sorted by order id so two runs read the same. */
  readonly findings: readonly ReconcileFinding[];
  readonly refusals: number;
  /** True when nothing needs a human. `auto` findings do not make this false. */
  readonly ok: boolean;
}

/** Decimal strings are not comparable as strings — `1` and `1.0` are one amount, two strings. */
function sameAmount(a: string, b: string): boolean | null {
  try {
    return parseAmount(a) === parseAmount(b);
  } catch {
    return null;
  }
}

const describeEngine = (o: EngineLiveOrder): string =>
  `engine: LIVE ${o.kind} ${o.side} remaining=${o.remaining} price=${o.price} market=${o.marketId} seq=${o.sequence}`;

const describeCounterpart = (o: CounterpartOrder): string =>
  `counterpart: ${o.state.toUpperCase()} remaining=${o.remaining} market=${o.marketId} funded=${o.funded}${o.detail ? ` (${o.detail})` : ''}`;

const ENGINE_ABSENT = 'engine: NOT LIVE — no resting order with this id in any book';
const COUNTERPART_ABSENT = 'counterpart: UNKNOWN — no record of this order id';

/**
 * Compare what the engine is holding against what the caller believes.
 *
 * `engine` should be the whole engine (`restingOrders()` with no market filter),
 * not one market's slice: an order resting under a market id the caller does not
 * expect is `market_disagreement`, and a per-market view would report it as two
 * unrelated findings instead of one real one.
 */
export function reconcile(engine: readonly EngineLiveOrder[], counterpart: readonly CounterpartOrder[]): ReconcileReport {
  const byId = new Map<string, EngineLiveOrder>();
  for (const order of engine) byId.set(order.orderId, order);

  const seen = new Set<string>();
  const findings: ReconcileFinding[] = [];
  let agreed = 0;

  // ── The caller's view has to be internally consistent first ───────────────
  //
  // This takes an array, not a result set. Two entries for one order id cannot
  // come out of a primary-key lookup, so if it happens the caller assembled its
  // view wrong — and judging the id twice would report one order as agreed AND
  // stranded, from a `checked` count that already deduplicated it. Refuse the
  // id and say both states, rather than picking whichever row arrived first.
  const claimsById = new Map<string, CounterpartOrder[]>();
  for (const claim of counterpart) {
    const bucket = claimsById.get(claim.orderId);
    if (bucket) bucket.push(claim);
    else claimsById.set(claim.orderId, [claim]);
  }

  for (const claim of counterpart) {
    seen.add(claim.orderId);

    const duplicates = claimsById.get(claim.orderId);
    if (duplicates !== undefined && duplicates.length > 1) {
      // Emit once per id, on the first occurrence, not once per copy.
      if (duplicates[0] === claim) {
        const live = byId.get(claim.orderId);
        findings.push({
          orderId: claim.orderId,
          case: 'duplicate_counterpart_id',
          verdict: 'refuse',
          engine: live ? describeEngine(live) : ENGINE_ABSENT,
          counterpart: duplicates.map(describeCounterpart).join(' | '),
          reason:
            'the caller sent this order id more than once, with states that cannot both be true — its view of its own ' +
            'orders is inconsistent, so no verdict computed from that view is trustworthy for this id. Fix the query before acting.',
        });
      }
      continue;
    }

    const live = byId.get(claim.orderId);

    // ── The engine does not have it ──────────────────────────────────────────
    if (!live) {
      if (claim.state === 'terminal') {
        // Both sides agree the order is over. Nothing to say.
        agreed += 1;
        continue;
      }

      if (!claim.funded) {
        // The ONLY safe automatic case. An intent row that the ledger never
        // funded and the engine never accepted holds no value by definition, so
        // deleting it cannot strand or invent anything. This is exactly
        // svc-trade's `orphan_pending`, which is already implemented and tested.
        findings.push({
          orderId: claim.orderId,
          case: 'counterpart_unfunded_engine_missing',
          verdict: 'auto',
          engine: ENGINE_ABSENT,
          counterpart: describeCounterpart(claim),
          reason: 'intent row the ledger never funded and the engine never accepted — deleting it moves no value',
        });
        continue;
      }

      // ── THE ONE THAT STRANDS USER MONEY ───────────────────────────────────
      //
      // The caller is holding value for an order the engine is not working.
      // Releasing looks obviously right and is not: an engine fill whose
      // `orderFilled` event was lost leaves precisely this shape, and in that
      // world the funds are owed to a counterparty, not to the user. The two
      // are indistinguishable from these two states — the difference lives in
      // the fills, which this function cannot see and must not guess at.
      findings.push({
        orderId: claim.orderId,
        case: 'counterpart_open_engine_missing',
        verdict: 'refuse',
        engine: ENGINE_ABSENT,
        counterpart: describeCounterpart(claim),
        reason:
          'value is held for an order the engine is not working — funds are stranded until this is resolved. ' +
          'Cannot auto-release: a lost fill event is indistinguishable from an order that was never live, ' +
          'and releasing a filled order pays the user money it owes the taker. Check fills for this order id before acting.',
      });
      continue;
    }

    // ── Both sides have it ───────────────────────────────────────────────────
    if (claim.state === 'terminal') {
      findings.push({
        orderId: claim.orderId,
        case: 'counterpart_terminal_engine_live',
        verdict: 'refuse',
        engine: describeEngine(live),
        counterpart: describeCounterpart(claim),
        reason:
          'the engine can still match an order the caller has already closed — free book risk, and any fill it takes ' +
          'settles against a released hold. Cannot auto-cancel: if the counterpart is the side that is wrong, ' +
          'cancelling destroys a live funded order.',
      });
      continue;
    }

    if (live.marketId !== claim.marketId) {
      findings.push({
        orderId: claim.orderId,
        case: 'market_disagreement',
        verdict: 'refuse',
        engine: describeEngine(live),
        counterpart: describeCounterpart(claim),
        reason: 'one order id resting under two different markets — a cancel sent to either market is aimed at the wrong book',
      });
      continue;
    }

    const equal = sameAmount(live.remaining, claim.remaining);

    if (equal === null) {
      findings.push({
        orderId: claim.orderId,
        case: 'unreadable_amount',
        verdict: 'refuse',
        engine: describeEngine(live),
        counterpart: describeCounterpart(claim),
        reason: 'one side reported a quantity that is not a decimal amount — refusing rather than coercing a number out of it',
      });
      continue;
    }

    if (!equal) {
      findings.push({
        orderId: claim.orderId,
        case: 'quantity_disagreement',
        verdict: 'refuse',
        engine: describeEngine(live),
        counterpart: describeCounterpart(claim),
        reason:
          'the two sides are working different quantities — one has mis-tracked a partial fill. ' +
          'Whichever is wrong, the held amount no longer matches the exposure, and picking a winner here writes that error into the book.',
      });
      continue;
    }

    // Agreed is only engine-live plus counterpart state open at the same qty.
    // A pending claim is intent recorded and not yet live. Its id already
    // resting is not agreement, funded or not — the caller has not opened it.
    if (claim.state === 'pending') {
      findings.push({
        orderId: claim.orderId,
        case: 'counterpart_pending_engine_live',
        verdict: 'refuse',
        engine: describeEngine(live),
        counterpart: describeCounterpart(claim),
        reason:
          'the engine is already resting an order the caller has not opened — pending is intent recorded, not yet live. ' +
          'Same market and the same remaining are not agreement. Cannot auto-cancel: cancelling would destroy a live order. ' +
          'Cannot auto-release: funded false is not a fill, and this report does not invent a quantity.',
      });
      continue;
    }

    agreed += 1;
  }

  // ── The engine is holding orders nobody claims ─────────────────────────────
  for (const live of engine) {
    if (seen.has(live.orderId)) continue;
    findings.push({
      orderId: live.orderId,
      case: 'engine_only',
      verdict: 'refuse',
      engine: describeEngine(live),
      counterpart: COUNTERPART_ABSENT,
      reason:
        'the engine is working an order no caller claims — it can fill against a hold that does not exist. ' +
        'Cannot auto-cancel: an incomplete counterpart view is indistinguishable from a genuinely orphaned order, ' +
        'and cancelling on a partial view is the "for-loop over ids empties a book" failure the write routes are authenticated to prevent.',
    });
  }

  findings.sort((a, b) => (a.orderId < b.orderId ? -1 : a.orderId > b.orderId ? 1 : 0));
  const refusals = findings.filter((f) => f.verdict === 'refuse').length;

  return { checked: seen.size + findings.filter((f) => f.case === 'engine_only').length, agreed, findings, refusals, ok: refusals === 0 };
}

/**
 * L3 — operator-facing summary of a reconcile report.
 * Counts by case; never invents findings. Empty findings → empty byCase.
 */
export type ReconcileSummary = {
  readonly ok: boolean;
  readonly checked: number;
  readonly agreed: number;
  readonly refusals: number;
  readonly byCase: Readonly<Record<string, number>>;
};

export function summarizeReconcile(report: ReconcileReport): ReconcileSummary {
  const byCase: Record<string, number> = {};
  for (const f of report.findings) {
    byCase[f.case] = (byCase[f.case] ?? 0) + 1;
  }
  return {
    ok: report.ok,
    checked: report.checked,
    agreed: report.agreed,
    refusals: report.refusals,
    byCase,
  };
}

/**
 * L3 — filter findings to selected cases for operator focus.
 * Empty allowlist → empty list (not invent full report).
 * Does not re-run reconcile or invent findings.
 */
export function filterFindingsByCase(
  report: ReconcileReport,
  cases: ReadonlySet<ReconcileCase> | readonly ReconcileCase[],
): readonly ReconcileReport['findings'][number][] {
  const set = cases instanceof Set ? cases : new Set(cases);
  if (set.size === 0) return [];
  return report.findings.filter((f) => set.has(f.case));
}
