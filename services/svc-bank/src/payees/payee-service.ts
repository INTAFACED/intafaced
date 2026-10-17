import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { BankError } from '../errors.js';
import { BusinessDirectoryError, type BusinessDirectoryPort } from '../business/business-directory.js';

/**
 * Saved recipients, per customer, on the server (BANKPAY item 16).
 *
 * The row is who the customer chose to remember: a user id and an optional
 * nickname. It is not a balance and it does not authorise a payment. The
 * handle, when identity's directory is connected, is read at list time and
 * never stored here, so a renamed handle cannot go stale in this table.
 * Thirty names, matching the list the customer app already keeps on one device.
 */

export const PAYEE_LIMIT = 30;

export interface PayeeView {
  readonly userId: string;
  readonly nickname: string | null;
  readonly addedAt: string;
  readonly handle: string | null;
}

interface PayeeRow {
  payee_user_id: string;
  nickname: string | null;
  added_at: Date;
}

interface CommandRow {
  owner_user_id: string;
  op: 'add' | 'remove';
  payee_user_id: string;
  nickname: string | null;
  outcome: 'saved' | 'removed' | 'absent';
  added_at: Date | null;
}

function isUnique(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505';
}

export class PayeeService {
  constructor(
    private readonly sql: Sql,
    private readonly directory?: Pick<BusinessDirectoryPort, 'handlesOf'>,
  ) {}

  async list(ownerUserId: string): Promise<PayeeView[]> {
    const rows = await this.sql<PayeeRow[]>`
      SELECT payee_user_id, nickname, added_at
        FROM bank.payees
       WHERE owner_user_id = ${ownerUserId}
       ORDER BY added_at DESC, payee_user_id
    `;
    const handles = await this.handlesFor(rows.map((row) => row.payee_user_id));
    return rows.map((row) => ({
      userId: row.payee_user_id,
      nickname: row.nickname,
      addedAt: row.added_at.toISOString(),
      handle: handles.get(row.payee_user_id) ?? null,
    }));
  }

  async add(ownerUserId: string, input: { commandId: string; userId: string; nickname: string | null }): Promise<PayeeView> {
    const payeeUserId = input.userId.toLowerCase();
    if (payeeUserId === ownerUserId.toLowerCase()) {
      throw new BankError('You cannot save yourself as a recipient', 'bank.payee_self');
    }
    const stored = await this.replay(ownerUserId, 'add', input.commandId, payeeUserId, input.nickname);
    if (stored) return stored;
    try {
      const addedAt = await transaction(this.sql, async (tx) => {
        const count = await tx<Array<{ n: string }>>`
          SELECT count(*)::text AS n FROM bank.payees WHERE owner_user_id = ${ownerUserId}
        `;
        const existing = await tx<Array<{ payee_user_id: string }>>`
          SELECT payee_user_id FROM bank.payees
           WHERE owner_user_id = ${ownerUserId} AND payee_user_id = ${payeeUserId}
        `;
        if (!existing[0] && Number(count[0]?.n ?? '0') >= PAYEE_LIMIT) {
          throw new BankError(`Saved recipients are limited to ${PAYEE_LIMIT}`, 'bank.payee_limit');
        }
        const rows = await tx<Array<{ added_at: Date }>>`
          INSERT INTO bank.payees (owner_user_id, payee_user_id, nickname)
          VALUES (${ownerUserId}, ${payeeUserId}, ${input.nickname})
          ON CONFLICT (owner_user_id, payee_user_id)
          DO UPDATE SET nickname = EXCLUDED.nickname
          RETURNING added_at
        `;
        const at = rows[0]!.added_at;
        await tx`
          INSERT INTO bank.payee_commands
            (command_id, owner_user_id, op, payee_user_id, nickname, outcome, added_at)
          VALUES
            (${input.commandId}, ${ownerUserId}, 'add', ${payeeUserId}, ${input.nickname}, 'saved', ${at})
        `;
        return at;
      });
      const handles = await this.handlesFor([payeeUserId]);
      return { userId: payeeUserId, nickname: input.nickname, addedAt: addedAt.toISOString(), handle: handles.get(payeeUserId) ?? null };
    } catch (err) {
      if (err instanceof BankError) throw err;
      if (!isUnique(err)) throw err;
      const again = await this.replay(ownerUserId, 'add', input.commandId, payeeUserId, input.nickname);
      if (again) return again;
      throw new BankError('That command id was already used for a different recipient', 'bank.payee_command_conflict');
    }
  }

  async remove(ownerUserId: string, input: { commandId: string; userId: string }): Promise<{ removed: boolean }> {
    const payeeUserId = input.userId.toLowerCase();
    const prior = await this.command(input.commandId);
    if (prior) {
      this.assertSameCommand(prior, ownerUserId, 'remove', payeeUserId, null);
      return { removed: prior.outcome === 'removed' };
    }
    try {
      const removed = await transaction(this.sql, async (tx) => {
        const gone = await tx<Array<{ payee_user_id: string }>>`
          DELETE FROM bank.payees
           WHERE owner_user_id = ${ownerUserId} AND payee_user_id = ${payeeUserId}
          RETURNING payee_user_id
        `;
        const outcome = gone[0] ? 'removed' : 'absent';
        await tx`
          INSERT INTO bank.payee_commands
            (command_id, owner_user_id, op, payee_user_id, nickname, outcome, added_at)
          VALUES (${input.commandId}, ${ownerUserId}, 'remove', ${payeeUserId}, ${null}, ${outcome}, ${null})
        `;
        return outcome === 'removed';
      });
      return { removed };
    } catch (err) {
      if (!isUnique(err)) throw err;
      const again = await this.command(input.commandId);
      if (again) {
        this.assertSameCommand(again, ownerUserId, 'remove', payeeUserId, null);
        return { removed: again.outcome === 'removed' };
      }
      throw new BankError('That command id was already used for a different recipient', 'bank.payee_command_conflict');
    }
  }

  private async replay(
    ownerUserId: string,
    op: 'add' | 'remove',
    commandId: string,
    payeeUserId: string,
    nickname: string | null,
  ): Promise<PayeeView | null> {
    const prior = await this.command(commandId);
    if (!prior) return null;
    this.assertSameCommand(prior, ownerUserId, op, payeeUserId, nickname);
    if (prior.outcome !== 'saved' || prior.added_at === null) {
      throw new BankError('That command id was already used for a different recipient', 'bank.payee_command_conflict');
    }
    const handles = await this.handlesFor([payeeUserId]);
    return {
      userId: payeeUserId,
      nickname: prior.nickname,
      addedAt: prior.added_at.toISOString(),
      handle: handles.get(payeeUserId) ?? null,
    };
  }

  private async command(commandId: string): Promise<CommandRow | null> {
    const rows = await this.sql<CommandRow[]>`
      SELECT owner_user_id, op, payee_user_id, nickname, outcome, added_at
        FROM bank.payee_commands WHERE command_id = ${commandId}
    `;
    return rows[0] ?? null;
  }

  private assertSameCommand(
    prior: CommandRow,
    ownerUserId: string,
    op: 'add' | 'remove',
    payeeUserId: string,
    nickname: string | null,
  ): void {
    if (
      prior.owner_user_id !== ownerUserId ||
      prior.op !== op ||
      prior.payee_user_id !== payeeUserId ||
      (prior.nickname ?? null) !== nickname
    ) {
      throw new BankError('That command id was already used for a different recipient', 'bank.payee_command_conflict');
    }
  }

  private async handlesFor(userIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
    if (!this.directory || userIds.length === 0) return new Map();
    try {
      return await this.directory.handlesOf(userIds);
    } catch (err) {
      if (err instanceof BusinessDirectoryError) return new Map();
      return new Map();
    }
  }
}
