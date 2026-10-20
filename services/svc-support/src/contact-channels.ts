/**
 * Owner-set support contact channels: email, phone and chat hours.
 *
 * Each channel is a value or `null`. Nothing is seeded and no address, number or hour is built in, so a blank channel
 * reads `null` and the screens say "not set". A change names the revision it read; the same change replayed under the
 * same revision returns the stored state, and a change from a stale revision is refused.
 */
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import {
  supportContactSetKey,
  type SupportContactChannels,
  type SupportContactSetInput,
  type SupportContactSetting,
} from '@intafaced/contracts';

export type ContactValues = Pick<SupportContactChannels, SupportContactSetting>;

export interface ContactChange {
  /** A field left out is unchanged; null clears it. Values arrive already trimmed. */
  readonly changes: Partial<ContactValues>;
  readonly expectedRevision: number;
  readonly by: string;
  readonly reason: string;
  readonly at: string;
}

export class ContactStaleError extends Error {
  constructor() {
    super('support.contact_revision_stale');
    this.name = 'ContactStaleError';
  }
}

export interface ContactBook {
  get(): Promise<SupportContactChannels>;
  /** Writes and logs one row only when something actually changed. Throws ContactStaleError from a stale revision. */
  set(change: ContactChange): Promise<SupportContactChannels>;
}

const blank = (): SupportContactChannels => ({ email: null, phone: null, chatHours: null, revision: 0, updatedAt: null });
const SETTINGS: readonly SupportContactSetting[] = ['email', 'phone', 'chatHours'];

/** The trimmed changes of an operator call, with `undefined` fields left out. */
export function contactChangesOf(input: SupportContactSetInput): Partial<ContactValues> {
  const out: { -readonly [K in keyof ContactValues]?: string | null } = {};
  for (const setting of SETTINGS) {
    const value = input[setting];
    if (value !== undefined) out[setting] = value === null ? null : value.trim();
  }
  return out;
}

function applyChanges(prior: SupportContactChannels, changes: Partial<ContactValues>): ContactValues {
  return {
    email: changes.email === undefined ? prior.email : changes.email,
    phone: changes.phone === undefined ? prior.phone : changes.phone,
    chatHours: changes.chatHours === undefined ? prior.chatHours : changes.chatHours,
  };
}

const sameValues = (a: ContactValues, b: ContactValues): boolean =>
  a.email === b.email && a.phone === b.phone && a.chatHours === b.chatHours;

/** What identifies one change: the fields it sets, in a fixed order, and the reason. The actor and the time are not part of it. */
export function contactFingerprint(changes: Partial<ContactValues>, reason: string): string {
  const parts = SETTINGS.map((setting) => (changes[setting] === undefined ? null : [setting, changes[setting]]));
  return createHash('sha256')
    .update(JSON.stringify([parts, reason]))
    .digest('hex');
}

export class MemoryContactBook implements ContactBook {
  private state: SupportContactChannels = blank();
  private readonly byKey = new Map<string, string>();
  readonly log: { key: string; before: SupportContactChannels; after: SupportContactChannels; by: string; reason: string; at: string }[] =
    [];

  async get(): Promise<SupportContactChannels> {
    return this.state;
  }

  async set(change: ContactChange): Promise<SupportContactChannels> {
    const key = supportContactSetKey(change.expectedRevision);
    const fingerprint = contactFingerprint(change.changes, change.reason);
    if (change.expectedRevision !== this.state.revision) {
      if (this.byKey.get(key) === fingerprint) return this.state;
      throw new ContactStaleError();
    }
    const next = applyChanges(this.state, change.changes);
    if (sameValues(this.state, next)) return this.state;
    const after: SupportContactChannels = { ...next, revision: this.state.revision + 1, updatedAt: change.at };
    this.log.push({ key, before: this.state, after, by: change.by, reason: change.reason, at: change.at });
    this.byKey.set(key, fingerprint);
    this.state = after;
    return after;
  }
}

type Row = {
  email: string | null;
  phone: string | null;
  chat_hours: string | null;
  revision: number;
  updated_at: Date | string | null;
};

const fromRow = (row: Row | undefined): SupportContactChannels =>
  row
    ? {
        email: row.email,
        phone: row.phone,
        chatHours: row.chat_hours,
        revision: row.revision,
        updatedAt: row.updated_at === null ? null : new Date(row.updated_at).toISOString(),
      }
    : blank();

export class SqlContactBook implements ContactBook {
  constructor(private readonly sql: Sql) {}

  async get(): Promise<SupportContactChannels> {
    const rows = await this.sql<Row[]>`SELECT email, phone, chat_hours, revision, updated_at FROM support.contact_channels`;
    return fromRow(rows[0]);
  }

  async set(change: ContactChange): Promise<SupportContactChannels> {
    const key = supportContactSetKey(change.expectedRevision);
    const fingerprint = contactFingerprint(change.changes, change.reason);
    return this.sql.begin(async (tx) => {
      // The single row is the lock: every writer serialises on it.
      await tx`INSERT INTO support.contact_channels (singleton) VALUES (true) ON CONFLICT DO NOTHING`;
      const [locked] = await tx<Row[]>`
        SELECT email, phone, chat_hours, revision, updated_at FROM support.contact_channels WHERE singleton FOR UPDATE
      `;
      const prior = fromRow(locked);
      if (change.expectedRevision !== prior.revision) {
        const [logged] = await tx<{ fingerprint: string }[]>`SELECT fingerprint FROM support.contact_channel_log WHERE key = ${key}`;
        if (logged?.fingerprint === fingerprint) return prior;
        throw new ContactStaleError();
      }
      const next = applyChanges(prior, change.changes);
      if (sameValues(prior, next)) return prior;
      const after: SupportContactChannels = { ...next, revision: prior.revision + 1, updatedAt: change.at };
      await tx`
        UPDATE support.contact_channels
        SET email = ${after.email}, phone = ${after.phone}, chat_hours = ${after.chatHours}, revision = ${after.revision},
            updated_by = ${change.by}, updated_at = ${change.at}
        WHERE singleton
      `;
      await tx`
        INSERT INTO support.contact_channel_log (key, fingerprint, revision_after, before, after, set_by, reason, set_at)
        VALUES (${key}, ${fingerprint}, ${after.revision}, ${tx.json(prior as never)}, ${tx.json(after as never)}, ${change.by}, ${change.reason}, ${change.at})
      `;
      return after;
    }) as Promise<SupportContactChannels>;
  }
}
