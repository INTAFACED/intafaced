/** Owner-published risk disclosure and the accounts' acceptances of it. No money, no balance. */
export interface DisclosureVersion {
  readonly version: number;
  readonly text: string;
  readonly publishedAt: string;
}

export interface DisclosureAcceptance {
  readonly accountId: string;
  readonly strategyId: string;
  readonly strategyVersion: number;
  readonly disclosureVersion: number;
  readonly acceptedAt: string;
  readonly key: string;
}

export interface DisclosureAcceptInput {
  readonly accountId: string;
  readonly strategyId: string;
  readonly strategyVersion: number;
  readonly disclosureVersion: number;
  readonly key: string;
}

export interface DisclosurePublishInput {
  readonly text: string;
  readonly reason: string;
  readonly publishedBy: string;
  readonly idempotencyKey: string;
}

export interface DisclosureCounts {
  readonly versions: readonly { readonly version: number; readonly publishedAt: string; readonly acceptances: number }[];
}

export interface DisclosureRepository {
  /** The newest published version, or null when nothing was published. */
  current(): Promise<DisclosureVersion | null>;
  /** Appends the next version. The same idempotency key with the same wording returns the first result. */
  publish(input: DisclosurePublishInput): Promise<DisclosureVersion>;
  /** Writes once per (account, strategy, strategy version, disclosure version); a repeat returns the first row. */
  accept(input: DisclosureAcceptInput): Promise<DisclosureAcceptance>;
  acceptance(input: Omit<DisclosureAcceptInput, 'key'>): Promise<DisclosureAcceptance | null>;
  counts(): Promise<DisclosureCounts>;
}
