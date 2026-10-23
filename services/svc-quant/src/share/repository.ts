/** One share link of a stored run. The token itself is never on this row; only its hash is. */
export interface ShareLink {
  readonly runId: string;
  readonly accountId: string;
  readonly seq: number;
  readonly key: string;
  readonly tokenHash: string;
  readonly createdAt: string;
  readonly revokedAt: string | null;
}

export interface ShareCreateInput {
  readonly accountId: string;
  readonly runId: string;
  readonly seq: number;
  readonly now: string;
}

export interface ShareCreated {
  readonly link: ShareLink;
  readonly links: number;
  /** Set only when this call inserted the row. A replay does not show the token again. */
  readonly token: string | null;
}

export interface ShareOpenInput {
  readonly token: string;
  readonly rate: number;
  readonly windowMs: number;
  readonly nowMs: number;
}

export type ShareOpened = { readonly kind: 'ok'; readonly link: ShareLink } | { readonly kind: 'missing' } | { readonly kind: 'limited' };

/**
 * Share links for a backtest result. No money, no balance. One active link per run. The write key is
 * `result.share:<runId>:<seq>` and is never reused after a revoke.
 */
export interface ShareRepository {
  list(input: { readonly accountId: string; readonly runId: string }): Promise<readonly ShareLink[]>;
  create(input: ShareCreateInput): Promise<ShareCreated>;
  revoke(input: { readonly accountId: string; readonly runId: string; readonly now: string }): Promise<{ readonly links: number }>;
  /** The active link whose hash matches, or null. Revoked and unknown are both null. */
  matchActive(input: { readonly accountId: string; readonly runId: string; readonly token: string }): Promise<ShareLink | null>;
  /**
   * Counts a public read of an active link on that link's own bucket. An unknown token and a revoked token are both
   * `missing` and are not counted, including when other misses have already filled a bucket. Over the rate on an
   * active link is `limited`.
   */
  openPublic(input: ShareOpenInput): Promise<ShareOpened>;
}

/** Missing unless the token is an active link still inside its own cap. Callers count only that link's bucket. */
export function shareOpenKind(active: ShareLink | null, used: number, rate: number): ShareOpened {
  if (!active) return { kind: 'missing' };
  if (used >= rate) return { kind: 'limited' };
  return { kind: 'ok', link: active };
}

export function resultShareKey(runId: string, seq: number): string {
  return `result.share:${runId}:${seq}`;
}
