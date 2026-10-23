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
   * Counts this public read against the owner's rate and resolves the token. An unknown token and a revoked token are
   * both `missing`. Over the rate is `limited` and does not say which.
   */
  openPublic(input: ShareOpenInput): Promise<ShareOpened>;
}

export function resultShareKey(runId: string, seq: number): string {
  return `result.share:${runId}:${seq}`;
}
