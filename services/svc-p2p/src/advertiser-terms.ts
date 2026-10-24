/**
 * THE ADVERTISER TERMS A PERSON ACCEPTS BEFORE POSTING AN AD (P-ads-merchant-01).
 *
 * The version is owner-published (`P2P_ADVERTISER_TERMS_VERSION`); compliance owns
 * the text that goes with it. Each acceptance is a row per person and version,
 * written once. Posting an ad, by the form or by a merchant key, refuses until
 * the person accepted the current version:
 *   · blank version: `p2p.config_unset` naming the setting. A gate that admits
 *     posting treats an unpublished setting as closed (spec C3).
 *   · not accepted: `p2p.terms_not_accepted`, so the form opens the terms.
 *   · a form that showed an older version: `p2p.terms_version_stale`, so the
 *     person reads the version they are agreeing to now.
 */
import type { Sql } from 'postgres';

export const ADVERTISER_TERMS_SETTING = 'P2P_ADVERTISER_TERMS_VERSION';

export type AdvertiserTermsCode = 'p2p.config_unset' | 'p2p.terms_not_accepted' | 'p2p.terms_version_stale';

export class AdvertiserTermsError extends Error {
  constructor(
    message: string,
    readonly code: AdvertiserTermsCode,
  ) {
    super(message);
    this.name = 'AdvertiserTermsError';
  }
}

/** The owner-published advertiser terms version: trimmed, or null when blank. */
export function advertiserTermsVersion(raw: string | undefined): string | null {
  const value = raw?.trim();
  return value ? value : null;
}

export interface AdvertiserTermsState {
  readonly version: string;
  readonly acceptedAt: Date | null;
}

export interface AdvertiserTermsAcceptance {
  readonly version: string;
  readonly acceptedAt: Date;
}

/** Versioned acceptance rows: one per person and version, written once. */
export class AdvertiserTermsAcceptances {
  constructor(private readonly sql: Sql) {}

  async current(userId: string, version: string): Promise<AdvertiserTermsAcceptance | null> {
    const rows = await this.sql<{ version: string; accepted_at: Date }[]>`
      SELECT version, accepted_at FROM p2p.advertiser_terms_acceptances WHERE user_id = ${userId} AND version = ${version}`;
    const row = rows[0];
    return row ? { version: row.version, acceptedAt: row.accepted_at } : null;
  }

  /** Idempotent: accepting a version again returns the first acceptance, unchanged. */
  async accept(userId: string, version: string): Promise<AdvertiserTermsAcceptance> {
    await this.sql`
      INSERT INTO p2p.advertiser_terms_acceptances (user_id, version) VALUES (${userId}, ${version})
      ON CONFLICT (user_id, version) DO NOTHING`;
    const accepted = await this.current(userId, version);
    if (!accepted) throw new Error('advertiser terms acceptance row missing after insert');
    return accepted;
  }
}

export interface AdvertiserTerms {
  /** The version to accept and the caller's acceptance of it, or `p2p.config_unset`. */
  state(userId: string): Promise<AdvertiserTermsState>;
  /** Accept exactly the published version; any other refuses `p2p.terms_version_stale`. */
  accept(userId: string, version: string): Promise<AdvertiserTermsAcceptance>;
  /**
   * Refuses unless `userId` accepted the published version. `shown` is the version the form showed, when it sends
   * one: it must be the published one.
   */
  assertAccepted(userId: string, shown?: string): Promise<void>;
}

export function createAdvertiserTerms(deps: { acceptances: AdvertiserTermsAcceptances; version: string | null }): AdvertiserTerms {
  const published = (): string => {
    if (!deps.version) throw new AdvertiserTermsError(`${ADVERTISER_TERMS_SETTING} is not set, so no ad can be posted`, 'p2p.config_unset');
    return deps.version;
  };
  const stale = (version: string, current: string) =>
    new AdvertiserTermsError(`Advertiser terms ${version} are not the current version ${current}`, 'p2p.terms_version_stale');
  return {
    async state(userId) {
      const version = published();
      const accepted = await deps.acceptances.current(userId, version);
      return { version, acceptedAt: accepted?.acceptedAt ?? null };
    },
    async accept(userId, version) {
      const current = published();
      if (version.trim() !== current) throw stale(version, current);
      return deps.acceptances.accept(userId, current);
    },
    async assertAccepted(userId, shown) {
      const current = published();
      if (shown !== undefined && shown.trim() !== current) throw stale(shown, current);
      if (!(await deps.acceptances.current(userId, current)))
        throw new AdvertiserTermsError(`Accept advertiser terms ${current} before posting an ad`, 'p2p.terms_not_accepted');
    },
  };
}
