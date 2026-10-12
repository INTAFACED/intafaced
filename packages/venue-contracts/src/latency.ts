/**
 * LATENCY GRADING — the vocabulary (§27:760, D-S-18).
 *
 * The machinery that produces these lives in `@intafaced/venue-adapter`
 * (`fabric/latency.ts`). Only the types live here, for the reason this package's
 * header gives: `MarketDataAdapter` is declared here, and an adapter cannot
 * offer its own grade through an interface that has no word for one.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT IS MEASURED, EXACTLY — AND WHAT IS NOT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `LatencyMeasurement` is a closed union on purpose. "Latency" is different
 * numbers that differ by orders of magnitude, and a grade that does not say
 * which one it holds is a number a consumer will read as whichever one it
 * wanted. Adding a member makes every consumer's `switch` fail to compile until
 * it decides what to do — the opposite of silently changing what an existing
 * number means.
 *
 *   · **`rest-round-trip`** — wall-clock on OUR clock, from immediately before
 *     the HTTP request leaves to the moment the response body has been received.
 *     It includes network flight time both ways, the venue's own service time,
 *     and TLS/socket work the client library does per call.
 *
 *   · **`ws-round-trip`** — wall-clock on OUR clock, from immediately before
 *     `StreamPort.open` is called to the moment the handle is returned (the
 *     WebSocket handshake completed) or the open throws. A venue can serve REST
 *     quickly and handshake slowly; that is a different failure, so it is a
 *     different member. Unopened streams stay `grade: null` — silence is not a
 *     letter.
 *
 * It does **NOT** measure, and must never be read as:
 *
 *   · **Stream delivery lag** — how long a depth delta takes to reach us after
 *     the socket is already open. Handshake time is not that number: a quiet
 *     book would look like a slow stream. Depth-delta lag needs a venue
 *     timestamp on the frame, which this package does not invent.
 *   · **Book staleness** — how old the book was when we read it. That is
 *     `observedAt` on the snapshot (see `book.ts`), and #1163 settled that
 *     `observedAt` is when a quote was OBSERVED, not when it was read. A fast
 *     round-trip returning a stale book is fast and wrong.
 *   · **Venue-side matching latency** — what happens to an order after it is
 *     accepted. Nothing in this package measures that, because the trading half
 *     of every adapter is deliberately not built (`adapter.ts`).
 *   · **Time spent waiting on our own rate-limit governor.** A request the
 *     governor refuses is never timed at all. This is deliberate: charging a
 *     venue for a delay WE imposed would make our own throttling look like the
 *     venue degrading, and the grade would then argue for routing away from a
 *     venue that did nothing wrong.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * `grade: null` — AN UNGRADED ADAPTER IS NOT A BAD ADAPTER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `docs/adr/2026-08-04-predict-quant-connect-law.md` (D-S-18, Accepted) states
 * the rule this file exists to make representable:
 *
 *   *"A score for an adapter that has not run is not a low score — it is no
 *   score, and an unscored adapter must not receive routing weight. This is the
 *   same defect class as a scan that walks zero files and prints clean."*
 *
 * So an adapter with no observations has `grade: null`, and `null` is the
 * fabric's existing word for "refused to answer" — an empty venue, an unknown
 * id, an unmapped market and an empty book all return `null` already. A missing
 * measurement follows the same convention rather than inventing a new one.
 *
 * `'F'` would have been the easy choice and it is wrong in BOTH directions:
 *
 *   · It is indistinguishable from a venue we measured and found appalling. An
 *     operator reading `F` cannot tell "this venue times out" from "nobody has
 *     ever called this venue", and those demand opposite responses — one is a
 *     venue problem, the other is a wiring problem on our side.
 *   · It is a claim. We would be asserting a measured property of a venue we
 *     have never spoken to, which is precisely the fabrication the rest of this
 *     package refuses.
 *
 * Every derived statistic is `null` under the same rule. A zero reject rate on
 * zero samples reads as "never refused us once", which is a perfect score
 * awarded for silence.
 *
 * NOTE THE ASYMMETRY, because it is the safety property: ungraded is not a bad
 * grade, but it is also NOT permission to route. D-S-18's second clause — "an
 * unscored adapter must not receive routing weight" — means the consumer must
 * treat `null` as "not eligible", not as "no news is good news". `null` is
 * unrankable, and `isGraded` exists so a consumer cannot accidentally rank on it:
 * the letter is unreachable without passing the check.
 */

/** Which latency this grade is about. A closed union — see the header. */
export type LatencyMeasurement = 'rest-round-trip' | 'ws-round-trip';

/**
 * The letter scale. Only ever produced from real observations — there is no
 * member for "unknown", because that is `grade: null` and the difference
 * between "off the scale" and "not on the scale" is the point of this file.
 */
export type LatencyGrade = 'A' | 'B' | 'C' | 'D' | 'F';

export type ObservationOutcome =
  /** Answered with usable data. */
  | 'ok'
  /** Answered, and said no. A rejected order, a refused subscription, a 429. */
  | 'reject'
  /** Did not answer usefully: timeout, socket close, non-2xx, malformed payload. */
  | 'error';

/**
 * One timed interaction with a venue.
 *
 * `at` is when the interaction COMPLETED, on the caller's injected clock. It is
 * required and has no default: a defaulted `new Date()` would stamp the moment
 * the observation was RECORDED, and the gap between those two is exactly the
 * error #1163 removed from `observedAt`.
 */
export interface LatencyObservation {
  readonly roundTripMs: number;
  readonly outcome: ObservationOutcome;
  readonly at: Date;
}

/**
 * A grade for one venue, over one window, of one measurement.
 *
 * `grade === null` means UNGRADED — no observations in the window. Use
 * `isGraded` rather than comparing to `null` by hand; it narrows the derived
 * statistics too.
 */
export interface VenueLatencyGrade {
  readonly venueId: string;
  /** Which latency this is. Never assume — a consumer that cares must check. */
  readonly measurement: LatencyMeasurement;
  /** `null` when ungraded. Never `'F'` for absence of data — see the header. */
  readonly grade: LatencyGrade | null;
  readonly samples: number;
  /** `null` with no SUCCESSFUL sample — not zero, which reads as "instant". */
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  /** `null` when ungraded — a 0% reject rate on no samples is a score for silence. */
  readonly rejectRateBps: number | null;
  readonly errorRateBps: number | null;
  /** Since the last observation of any kind. `null` before the first one. */
  readonly staleMs: number | null;
  /**
   * True when there are too few samples for the letter to mean much. Distinct
   * from ungraded: a provisional grade HAS evidence, just not enough of it, and
   * it is always accompanied by a non-null `grade`.
   */
  readonly provisional: boolean;
  /**
   * Why the grade is what it is, in the order the signals were applied. Prose,
   * for an operator. Never parsed — the machine-readable answer is the fields
   * above, and a consumer branching on this text is a consumer that will break
   * when the wording improves.
   */
  readonly reasons: readonly string[];
}

/** A grade that survived `isGraded` — the letter is present. */
export type GradedVenueLatency = VenueLatencyGrade & {
  readonly grade: LatencyGrade;
  readonly rejectRateBps: number;
  readonly errorRateBps: number;
};

/** REST grade — `MarketDataAdapter.latencyGrade` never silently returns WS. */
export type RestLatencyGrade = VenueLatencyGrade & { readonly measurement: 'rest-round-trip' };

/** WS handshake grade — `MarketDataAdapter.streamLatencyGrade`. Not depth-delta lag. */
export type WsLatencyGrade = VenueLatencyGrade & { readonly measurement: 'ws-round-trip' };

/**
 * True when this grade rests on at least one observation and both rates are numbers.
 *
 * This is the gate, and it is a type guard rather than a boolean field so the
 * compiler enforces it: `grade.grade` is `LatencyGrade | null` until a consumer
 * passes this check, so code that ranks venues on the letter cannot be written
 * without first handling the ungraded case. A letter with zero samples, or a
 * letter whose reject or error rate is still null, is not graded. A
 * `provisional` grade passes — it has evidence — and the caller decides
 * separately whether it is enough.
 */
export function isGraded(grade: VenueLatencyGrade): grade is GradedVenueLatency {
  return grade.grade !== null && grade.samples >= 1 && grade.rejectRateBps !== null && grade.errorRateBps !== null;
}

/** Type-narrow to REST. A consumer that cares which latency must check. */
export function isRestGrade(grade: VenueLatencyGrade): grade is RestLatencyGrade {
  return grade.measurement === 'rest-round-trip';
}

/** Type-narrow to WS handshake. Not interchangeable with REST. */
export function isWsGrade(grade: VenueLatencyGrade): grade is WsLatencyGrade {
  return grade.measurement === 'ws-round-trip';
}
