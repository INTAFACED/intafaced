/**
 * WHY A VENUE COULD NOT BE USED — the vocabulary every response reports in.
 *
 * §27's honesty requirement is not "handle errors". It is that a venue which is
 * down, stale, or rate-limited must be **excluded and reported**, never quietly
 * substituted by another. A caller that receives a price with no idea that four
 * of five venues dropped out has been told something false by omission.
 *
 * So every exclusion is typed, and the reasons are deliberately NOT collapsed:
 *
 *   · `unreachable` — the venue did not answer.
 *   · `stale` — the venue answered with data too old to price against.
 *   · `rate_limited` — WE stopped asking, to avoid a ban.
 *   · `desynced` — a sequence gap; the book we hold is no longer the venue's.
 *
 * Those demand four different responses from whoever is on call, and merging
 * any two of them hides the one incident that matters. "The indexer is down"
 * and "the indexer is up and forty seconds behind" look identical in a metric
 * that only counts failures.
 */

export type VenueUnavailableReason =
  /** No answer, a non-2xx, a socket that closed, or a transport error. */
  | 'unreachable'
  /** Answered, but the payload is not something money can be read from. */
  | 'malformed'
  /** The venue says its own data is not usable — a halted feed, an empty index. */
  | 'not_ready'
  /** Answered with data older than the caller's freshness ceiling. */
  | 'stale'
  /** Answered with data dated in the future. A broken clock is not freshness. */
  | 'clock_skew'
  /**
   * We are holding back to stay inside the venue's limits, or the venue has
   * told us to. Distinct from `unreachable` because the venue is fine and the
   * constraint is ours — see `rate-limit.ts` for why this is never a silent wait.
   */
  | 'rate_limited'
  /**
   * A sequence gap. The local book stopped matching the venue's and has not been
   * re-snapshotted yet.
   *
   * This is the failure with no natural symptom: a desynced book answers every
   * question instantly and looks entirely healthy. It is only ever caught by a
   * sequence check, which is why the fabric refuses to serve a book in this
   * state rather than serving it with a warning attached.
   */
  | 'desynced'
  /** Live, fresh, in sync, and nothing resting on the side the caller needs. */
  | 'no_depth'
  /** The venue disagrees with every other venue by more than the tolerance. */
  | 'diverged';

export class VenueUnavailableError extends Error {
  /**
   * Whether the place POST had already been handed to the transport.
   * `false` means the call never left. Missing means the caller did not prove
   * that, and conversion treats it as sent.
   *
   * This is a constructor parameter, not a separate field. A field declaration
   * would be initialized after this assignment and wipe the flag.
   */
  constructor(
    readonly venueId: string,
    readonly reason: VenueUnavailableReason,
    message: string,
    readonly sent?: boolean,
  ) {
    super(message);
    this.name = 'VenueUnavailableError';
  }
}

/**
 * A trading or account call was made against a venue with no credentials.
 *
 * §27 puts external API keys in the Venue Vault, per user, HSM-backed. Until
 * that exists and the owner has issued keys, `TradeAdapter` and `AccountAdapter`
 * have nothing to authenticate with — and this is the error they throw.
 *
 * ── Why this is loud rather than a plausible rejection ──────────────────────
 *
 * The tempting alternative is to return `{ status: 'rejected' }`, which type-
 * checks and lets a caller proceed. It is the worst option available: an
 * execution port that answers plausibly while doing nothing reports fills that
 * never happened, and a router that "tried" a venue and got a rejection will
 * happily route the rest of the order elsewhere and call the result a fill.
 *
 * A missing key is not a market condition. It is a deployment that is not
 * finished, and it must read like one.
 */
export class VenueCredentialsMissingError extends Error {
  constructor(
    readonly venueId: string,
    readonly operation: string,
    message: string,
  ) {
    super(message);
    this.name = 'VenueCredentialsMissingError';
  }
}

/**
 * A credential was supplied that the policy refuses to hold.
 *
 * §27: *"withdrawal-permission refused by policy — connect keys must be
 * trade-only."* A key that can withdraw is a key that can drain a user's
 * external account, and no amount of care in our code makes holding one safe.
 * The refusal is at the point of loading, not at the point of use: a key we
 * never accepted cannot be misused by a bug we have not written yet.
 */
export class VenueCredentialScopeError extends Error {
  constructor(
    readonly venueId: string,
    readonly refusedScopes: readonly string[],
    message: string,
  ) {
    super(message);
    this.name = 'VenueCredentialScopeError';
  }
}

/**
 * An adapter was asked to do something it does not do.
 *
 * Not a silent no-op and not `undefined`. Whoever wires the capability later has
 * to delete a throw to do it, and that is the point.
 */
export class VenueCapabilityError extends Error {
  constructor(
    readonly venueId: string,
    readonly capability: string,
    message: string,
  ) {
    super(message);
    this.name = 'VenueCapabilityError';
  }
}
