/**
 * Saved pay recipients. The name a screen shows is the handle. `label` is the
 * owner's private nickname for that handle, not a legal name.
 */
import type { Sql } from 'postgres';
import { HANDLE_PATTERN } from './handle-lookup.js';

export const RECIPIENT_UNKNOWN = 'identity.recipient_unknown';
export const RECIPIENT_SELF = 'identity.recipient_self';
export const RECIPIENT_LABEL_INVALID = 'identity.recipient_label_invalid';
export const RECIPIENT_CONFLICT = 'identity.recipient_conflict';
export const RECIPIENT_LIST_LIMIT_UNSET = 'identity.saved_recipient_list_limit_unset';

export class SavedRecipientError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'SavedRecipientError';
  }
}

export interface SavedRecipient {
  readonly handle: string;
  readonly label: string;
  readonly addedAt: string;
}

interface CommandRow {
  action: 'add' | 'remove';
  recipient_id: string;
  label: string | null;
  result: 'saved' | 'removed' | 'absent';
}

function plainLabel(value: string): string {
  const label = value.trim();
  if (label === '' || [...label].length > 40 || /[\u0000-\u001F\u007F]/.test(label)) {
    throw new SavedRecipientError(
      `A recipient label is plain text up to 40 characters (${RECIPIENT_LABEL_INVALID})`,
      RECIPIENT_LABEL_INVALID,
    );
  }
  return label;
}

function normaliseHandle(value: string): string {
  const handle = value.trim().replace(/^@/, '');
  if (!HANDLE_PATTERN.test(handle)) {
    throw new SavedRecipientError(`No such person (${RECIPIENT_UNKNOWN})`, RECIPIENT_UNKNOWN);
  }
  return handle;
}

export function listLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new SavedRecipientError(
      `recipients.list needs a limit from 1 to 100 (${RECIPIENT_LIST_LIMIT_UNSET})`,
      RECIPIENT_LIST_LIMIT_UNSET,
    );
  }
  return limit;
}

export class SavedRecipientService {
  constructor(private readonly sql: Sql) {}

  async list(ownerId: string, limit: number | undefined): Promise<SavedRecipient[]> {
    const page = listLimit(limit);
    const rows = await this.sql<Array<{ handle: string; label: string; created_at: Date }>>`
      SELECT u.handle::text AS handle, s.label, s.created_at
        FROM saved_recipients s
        JOIN users u ON u.id = s.recipient_id
       WHERE s.owner_id = ${ownerId}
       ORDER BY s.updated_at DESC
       LIMIT ${page}
    `;
    return rows.map((row) => ({ handle: row.handle, label: row.label, addedAt: row.created_at.toISOString() }));
  }

  async add(ownerId: string, handleInput: string, labelInput: string, idempotencyKey: string): Promise<SavedRecipient> {
    const label = plainLabel(labelInput);
    const handle = normaliseHandle(handleInput);
    const prior = await this.command(ownerId, idempotencyKey);
    if (prior) {
      if (prior.action !== 'add' || prior.label !== label) {
        throw new SavedRecipientError(
          `Key ${idempotencyKey} was already used on different terms (${RECIPIENT_CONFLICT})`,
          RECIPIENT_CONFLICT,
        );
      }
      const current = await this.byRecipient(ownerId, prior.recipient_id);
      if (!current || current.handle.toLowerCase() !== handle.toLowerCase()) {
        throw new SavedRecipientError(
          `Key ${idempotencyKey} was already used on different terms (${RECIPIENT_CONFLICT})`,
          RECIPIENT_CONFLICT,
        );
      }
      return current;
    }
    const person = await this.activeByHandle(handle, ownerId);
    if (!person) throw new SavedRecipientError(`No such person (${RECIPIENT_UNKNOWN})`, RECIPIENT_UNKNOWN);
    if (person.id === ownerId) throw new SavedRecipientError(`You cannot save yourself (${RECIPIENT_SELF})`, RECIPIENT_SELF);
    await this.sql.begin(async (tx) => {
      const inserted = await tx`
        INSERT INTO saved_recipient_commands (owner_id, idempotency_key, action, recipient_id, label, result)
        VALUES (${ownerId}, ${idempotencyKey}, 'add', ${person.id}, ${label}, 'saved')
        ON CONFLICT (owner_id, idempotency_key) DO NOTHING
        RETURNING recipient_id
      `;
      if (inserted.length === 0) return;
      await tx`
        INSERT INTO saved_recipients (owner_id, recipient_id, label)
        VALUES (${ownerId}, ${person.id}, ${label})
        ON CONFLICT (owner_id, recipient_id) DO UPDATE
          SET label = EXCLUDED.label, updated_at = now()
      `;
    });
    const saved = await this.byRecipient(ownerId, person.id);
    if (!saved) throw new SavedRecipientError(`No such person (${RECIPIENT_UNKNOWN})`, RECIPIENT_UNKNOWN);
    return saved;
  }

  async remove(ownerId: string, handleInput: string, idempotencyKey: string): Promise<{ removed: boolean; handle: string }> {
    const handle = normaliseHandle(handleInput);
    const prior = await this.command(ownerId, idempotencyKey);
    if (prior) {
      if (prior.action !== 'remove') {
        throw new SavedRecipientError(
          `Key ${idempotencyKey} was already used on different terms (${RECIPIENT_CONFLICT})`,
          RECIPIENT_CONFLICT,
        );
      }
      const person = await this.anyById(prior.recipient_id);
      if (!person || person.handle.toLowerCase() !== handle.toLowerCase()) {
        throw new SavedRecipientError(
          `Key ${idempotencyKey} was already used on different terms (${RECIPIENT_CONFLICT})`,
          RECIPIENT_CONFLICT,
        );
      }
      return { removed: prior.result === 'removed', handle: person.handle };
    }
    const person = await this.removableByHandle(handle, ownerId);
    if (!person) throw new SavedRecipientError(`No such person (${RECIPIENT_UNKNOWN})`, RECIPIENT_UNKNOWN);
    const deleted = await this.sql.begin(async (tx) => {
      const inserted = await tx`
        INSERT INTO saved_recipient_commands (owner_id, idempotency_key, action, recipient_id, label, result)
        VALUES (
          ${ownerId}, ${idempotencyKey}, 'remove', ${person.id}, ${null},
          CASE WHEN EXISTS (
            SELECT 1 FROM saved_recipients WHERE owner_id = ${ownerId} AND recipient_id = ${person.id}
          ) THEN 'removed' ELSE 'absent' END
        )
        ON CONFLICT (owner_id, idempotency_key) DO NOTHING
        RETURNING result
      `;
      if (inserted.length === 0) return null;
      await tx`DELETE FROM saved_recipients WHERE owner_id = ${ownerId} AND recipient_id = ${person.id}`;
      return inserted[0]!.result === 'removed';
    });
    if (deleted === null) {
      const again = await this.command(ownerId, idempotencyKey);
      return { removed: again?.result === 'removed', handle: person.handle };
    }
    return { removed: deleted, handle: person.handle };
  }

  private async command(ownerId: string, idempotencyKey: string): Promise<CommandRow | null> {
    const rows = await this.sql<CommandRow[]>`
      SELECT action, recipient_id, label, result
        FROM saved_recipient_commands
       WHERE owner_id = ${ownerId} AND idempotency_key = ${idempotencyKey}
    `;
    return rows[0] ?? null;
  }

  /** An undiscoverable handle (PP-send-request-03) is the same miss as an unknown one, except to its owner. */
  private async activeByHandle(handle: string, ownerId: string): Promise<{ id: string; handle: string } | null> {
    const rows = await this.sql<Array<{ id: string; handle: string }>>`
      SELECT id, handle::text AS handle FROM users
       WHERE handle = ${handle} AND status = 'active' AND (handle_discoverable OR id = ${ownerId})
       LIMIT 1
    `;
    return rows[0] ?? null;
  }

  /** Remove finds any status, but an undiscoverable handle the owner never saved is the same miss as an unknown one. */
  private async removableByHandle(handle: string, ownerId: string): Promise<{ id: string; handle: string } | null> {
    const rows = await this.sql<Array<{ id: string; handle: string }>>`
      SELECT u.id, u.handle::text AS handle FROM users u
       WHERE u.handle = ${handle}
         AND (u.handle_discoverable OR u.id = ${ownerId}
              OR EXISTS (SELECT 1 FROM saved_recipients s WHERE s.owner_id = ${ownerId} AND s.recipient_id = u.id))
       LIMIT 1
    `;
    return rows[0] ?? null;
  }

  private async anyById(id: string): Promise<{ id: string; handle: string } | null> {
    const rows = await this.sql<Array<{ id: string; handle: string }>>`
      SELECT id, handle::text AS handle FROM users WHERE id = ${id} LIMIT 1
    `;
    return rows[0] ?? null;
  }

  private async byRecipient(ownerId: string, recipientId: string): Promise<SavedRecipient | null> {
    const rows = await this.sql<Array<{ handle: string; label: string; created_at: Date }>>`
      SELECT u.handle::text AS handle, s.label, s.created_at
        FROM saved_recipients s
        JOIN users u ON u.id = s.recipient_id
       WHERE s.owner_id = ${ownerId} AND s.recipient_id = ${recipientId}
    `;
    const row = rows[0];
    if (!row) return null;
    return { handle: row.handle, label: row.label, addedAt: row.created_at.toISOString() };
  }
}
