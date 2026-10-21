/**
 * Owner-set ticket attachment limits: the largest file, the allowed content types and how many files one request may hold.
 *
 * Each is a value or `null`. Nothing is seeded and no size, count or type is built in, so a blank limit reads `null` and
 * an attach refuses naming it. A change names the revision it read; the same change replayed under the same revision
 * returns the stored state, and a change from a stale revision is refused. The store and the scanner are deployment
 * configuration (`attachments.ts`) and are not held here.
 */
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { supportAttachmentSetKey, type SupportAttachmentSetting, type SupportAttachmentSettingsSetInput } from '@intafaced/contracts';

export interface AttachmentLimitValues {
  readonly maxBytes: number | null;
  readonly allowedTypes: readonly string[] | null;
  readonly maxCount: number | null;
}

export interface AttachmentLimitState extends AttachmentLimitValues {
  readonly revision: number;
  readonly updatedAt: string | null;
}

export interface AttachmentSettingsChange {
  /** A field left out is unchanged; null clears it. */
  readonly changes: Partial<AttachmentLimitValues>;
  readonly expectedRevision: number;
  readonly by: string;
  readonly reason: string;
  readonly at: string;
}

export class AttachmentSettingsStaleError extends Error {
  constructor() {
    super('support.attachment_revision_stale');
    this.name = 'AttachmentSettingsStaleError';
  }
}

export interface AttachmentSettingsBook {
  get(): Promise<AttachmentLimitState>;
  /** Writes and logs one row only when something actually changed. Throws AttachmentSettingsStaleError from a stale revision. */
  set(change: AttachmentSettingsChange): Promise<AttachmentLimitState>;
}

const SETTINGS: readonly SupportAttachmentSetting[] = ['maxBytes', 'allowedTypes', 'maxCount'];
const blank = (): AttachmentLimitState => ({ maxBytes: null, allowedTypes: null, maxCount: null, revision: 0, updatedAt: null });

/** The changes of an operator call, with `undefined` fields left out. */
export function attachmentChangesOf(input: SupportAttachmentSettingsSetInput): Partial<AttachmentLimitValues> {
  const out: { -readonly [K in keyof AttachmentLimitValues]?: AttachmentLimitValues[K] } = {};
  for (const setting of SETTINGS) {
    const value = input[setting];
    if (value !== undefined) (out as Record<string, unknown>)[setting] = value;
  }
  return out;
}

function applyChanges(prior: AttachmentLimitValues, changes: Partial<AttachmentLimitValues>): AttachmentLimitValues {
  return {
    maxBytes: changes.maxBytes === undefined ? prior.maxBytes : changes.maxBytes,
    allowedTypes: changes.allowedTypes === undefined ? prior.allowedTypes : changes.allowedTypes,
    maxCount: changes.maxCount === undefined ? prior.maxCount : changes.maxCount,
  };
}

const sameValues = (a: AttachmentLimitValues, b: AttachmentLimitValues): boolean =>
  a.maxBytes === b.maxBytes && a.maxCount === b.maxCount && JSON.stringify(a.allowedTypes) === JSON.stringify(b.allowedTypes);

/** What identifies one change: the fields it sets, in a fixed order, and the reason. The actor and the time are not part of it. */
export function attachmentFingerprint(changes: Partial<AttachmentLimitValues>, reason: string): string {
  const parts = SETTINGS.map((setting) => (changes[setting] === undefined ? null : [setting, changes[setting]]));
  return createHash('sha256')
    .update(JSON.stringify([parts, reason]))
    .digest('hex');
}

export class MemoryAttachmentSettingsBook implements AttachmentSettingsBook {
  private state: AttachmentLimitState = blank();
  private readonly byKey = new Map<string, string>();
  readonly log: { key: string; before: AttachmentLimitState; after: AttachmentLimitState; by: string; reason: string; at: string }[] = [];

  async get(): Promise<AttachmentLimitState> {
    return this.state;
  }

  async set(change: AttachmentSettingsChange): Promise<AttachmentLimitState> {
    const key = supportAttachmentSetKey(change.expectedRevision);
    const fingerprint = attachmentFingerprint(change.changes, change.reason);
    if (change.expectedRevision !== this.state.revision) {
      if (this.byKey.get(key) === fingerprint) return this.state;
      throw new AttachmentSettingsStaleError();
    }
    const next = applyChanges(this.state, change.changes);
    if (sameValues(this.state, next)) return this.state;
    const after: AttachmentLimitState = { ...next, revision: this.state.revision + 1, updatedAt: change.at };
    this.log.push({ key, before: this.state, after, by: change.by, reason: change.reason, at: change.at });
    this.byKey.set(key, fingerprint);
    this.state = after;
    return after;
  }
}

type Row = {
  max_bytes: number | null;
  allowed_types: string[] | null;
  max_count: number | null;
  revision: number;
  updated_at: Date | string | null;
};

const fromRow = (row: Row | undefined): AttachmentLimitState =>
  row
    ? {
        maxBytes: row.max_bytes,
        allowedTypes: row.allowed_types,
        maxCount: row.max_count,
        revision: row.revision,
        updatedAt: row.updated_at === null ? null : new Date(row.updated_at).toISOString(),
      }
    : blank();

export class SqlAttachmentSettingsBook implements AttachmentSettingsBook {
  constructor(private readonly sql: Sql) {}

  async get(): Promise<AttachmentLimitState> {
    const rows = await this.sql<Row[]>`SELECT max_bytes, allowed_types, max_count, revision, updated_at FROM support.attachment_settings`;
    return fromRow(rows[0]);
  }

  async set(change: AttachmentSettingsChange): Promise<AttachmentLimitState> {
    const key = supportAttachmentSetKey(change.expectedRevision);
    const fingerprint = attachmentFingerprint(change.changes, change.reason);
    return this.sql.begin(async (tx) => {
      // The single row is the lock: every writer serialises on it.
      await tx`INSERT INTO support.attachment_settings (singleton) VALUES (true) ON CONFLICT DO NOTHING`;
      const [locked] = await tx<Row[]>`
        SELECT max_bytes, allowed_types, max_count, revision, updated_at FROM support.attachment_settings WHERE singleton FOR UPDATE
      `;
      const prior = fromRow(locked);
      if (change.expectedRevision !== prior.revision) {
        const [logged] = await tx<{ fingerprint: string }[]>`SELECT fingerprint FROM support.attachment_settings_log WHERE key = ${key}`;
        if (logged?.fingerprint === fingerprint) return prior;
        throw new AttachmentSettingsStaleError();
      }
      const next = applyChanges(prior, change.changes);
      if (sameValues(prior, next)) return prior;
      const after: AttachmentLimitState = { ...next, revision: prior.revision + 1, updatedAt: change.at };
      await tx`
        UPDATE support.attachment_settings
        SET max_bytes = ${after.maxBytes}, allowed_types = ${after.allowedTypes === null ? null : [...after.allowedTypes]},
            max_count = ${after.maxCount}, revision = ${after.revision}, updated_by = ${change.by}, updated_at = ${change.at}
        WHERE singleton
      `;
      await tx`
        INSERT INTO support.attachment_settings_log (key, fingerprint, revision_after, before, after, set_by, reason, set_at)
        VALUES (${key}, ${fingerprint}, ${after.revision}, ${tx.json(prior as never)}, ${tx.json(after as never)}, ${change.by}, ${change.reason}, ${change.at})
      `;
      return after;
    }) as Promise<AttachmentLimitState>;
  }
}
