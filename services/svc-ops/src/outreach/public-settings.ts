/**
 * Owner-set outreach public settings (SP-pages-02): where the invitation site is served and the partner programme terms.
 *
 * Each value is set or `null`. Nothing is seeded and no address or wording is built in, so a blank value reads `null` and
 * the partner page says it is not set. A change names the revision it read; the same change replayed under the same
 * revision returns the stored state, and a change from a stale revision is refused.
 */
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import {
  OUTREACH_PUBLIC_SETTINGS,
  outreachPublicSetKey,
  type OutreachPublicSetting,
  type OutreachPublicSettings,
  type OutreachPublicSettingsSetInput,
} from '@intafaced/contracts';

export type PublicValues = Pick<OutreachPublicSettings, OutreachPublicSetting>;

export interface PublicSettingsChange {
  /** A field left out is unchanged; null clears it. Values arrive already trimmed and checked by the contract. */
  readonly changes: Partial<PublicValues>;
  readonly expectedRevision: number;
  readonly by: string;
  readonly reason: string;
  readonly at: string;
}

export class PublicSettingsStaleError extends Error {
  constructor() {
    super('ops.public_settings_revision_stale');
    this.name = 'PublicSettingsStaleError';
  }
}

export interface PublicSettingsBook {
  get(): Promise<OutreachPublicSettings>;
  /** Writes and logs one row only when something actually changed. Throws PublicSettingsStaleError from a stale revision. */
  set(change: PublicSettingsChange): Promise<OutreachPublicSettings>;
}

const blank = (): OutreachPublicSettings => ({ joinUrl: null, partnerTerms: null, revision: 0, updatedAt: null });

/** The changes of a founder call, with `undefined` fields left out. */
export function publicChangesOf(input: OutreachPublicSettingsSetInput): Partial<PublicValues> {
  const out: { -readonly [K in keyof PublicValues]?: string | null } = {};
  for (const setting of OUTREACH_PUBLIC_SETTINGS) if (input[setting] !== undefined) out[setting] = input[setting];
  return out;
}

const applyChanges = (prior: PublicValues, changes: Partial<PublicValues>): PublicValues => ({
  joinUrl: changes.joinUrl === undefined ? prior.joinUrl : changes.joinUrl,
  partnerTerms: changes.partnerTerms === undefined ? prior.partnerTerms : changes.partnerTerms,
});

const sameValues = (a: PublicValues, b: PublicValues): boolean => a.joinUrl === b.joinUrl && a.partnerTerms === b.partnerTerms;

/** What identifies one change: the fields it sets, in a fixed order, and the reason. The actor and the time are not part of it. */
export function publicFingerprint(changes: Partial<PublicValues>, reason: string): string {
  const parts = OUTREACH_PUBLIC_SETTINGS.map((setting) => (changes[setting] === undefined ? null : [setting, changes[setting]]));
  return createHash('sha256')
    .update(JSON.stringify([parts, reason]))
    .digest('hex');
}

export class MemoryPublicSettingsBook implements PublicSettingsBook {
  private state: OutreachPublicSettings = blank();
  private readonly byKey = new Map<string, string>();
  readonly log: { key: string; before: OutreachPublicSettings; after: OutreachPublicSettings; by: string; reason: string; at: string }[] =
    [];

  async get(): Promise<OutreachPublicSettings> {
    return this.state;
  }

  async set(change: PublicSettingsChange): Promise<OutreachPublicSettings> {
    const key = outreachPublicSetKey(change.expectedRevision);
    const fingerprint = publicFingerprint(change.changes, change.reason);
    if (change.expectedRevision !== this.state.revision) {
      if (this.byKey.get(key) === fingerprint) return this.state;
      throw new PublicSettingsStaleError();
    }
    const next = applyChanges(this.state, change.changes);
    if (sameValues(this.state, next)) return this.state;
    const after: OutreachPublicSettings = { ...next, revision: this.state.revision + 1, updatedAt: change.at };
    this.log.push({ key, before: this.state, after, by: change.by, reason: change.reason, at: change.at });
    this.byKey.set(key, fingerprint);
    this.state = after;
    return after;
  }
}

type Row = {
  join_url: string | null;
  partner_terms: string | null;
  revision: number;
  updated_at: Date | string | null;
};

const fromRow = (row: Row | undefined): OutreachPublicSettings =>
  row
    ? {
        joinUrl: row.join_url,
        partnerTerms: row.partner_terms,
        revision: row.revision,
        updatedAt: row.updated_at === null ? null : new Date(row.updated_at).toISOString(),
      }
    : blank();

export class SqlPublicSettingsBook implements PublicSettingsBook {
  constructor(private readonly sql: Sql) {}

  async get(): Promise<OutreachPublicSettings> {
    const rows = await this.sql<Row[]>`SELECT join_url, partner_terms, revision, updated_at FROM ops.public_settings`;
    return fromRow(rows[0]);
  }

  async set(change: PublicSettingsChange): Promise<OutreachPublicSettings> {
    const key = outreachPublicSetKey(change.expectedRevision);
    const fingerprint = publicFingerprint(change.changes, change.reason);
    return this.sql.begin(async (tx) => {
      // The single row is the lock: every writer serialises on it.
      await tx`INSERT INTO ops.public_settings (singleton) VALUES (true) ON CONFLICT DO NOTHING`;
      const [locked] = await tx<Row[]>`
        SELECT join_url, partner_terms, revision, updated_at FROM ops.public_settings WHERE singleton FOR UPDATE
      `;
      const prior = fromRow(locked);
      if (change.expectedRevision !== prior.revision) {
        const [logged] = await tx<{ fingerprint: string }[]>`SELECT fingerprint FROM ops.public_settings_log WHERE key = ${key}`;
        if (logged?.fingerprint === fingerprint) return prior;
        throw new PublicSettingsStaleError();
      }
      const next = applyChanges(prior, change.changes);
      if (sameValues(prior, next)) return prior;
      const after: OutreachPublicSettings = { ...next, revision: prior.revision + 1, updatedAt: change.at };
      await tx`
        UPDATE ops.public_settings
        SET join_url = ${after.joinUrl}, partner_terms = ${after.partnerTerms}, revision = ${after.revision},
            updated_by = ${change.by}, updated_at = ${change.at}
        WHERE singleton
      `;
      await tx`
        INSERT INTO ops.public_settings_log (key, fingerprint, revision_after, before, after, set_by, reason, set_at)
        VALUES (${key}, ${fingerprint}, ${after.revision}, ${tx.json(prior as never)}, ${tx.json(after as never)}, ${change.by}, ${change.reason}, ${change.at})
      `;
      return after;
    }) as Promise<OutreachPublicSettings>;
  }
}
