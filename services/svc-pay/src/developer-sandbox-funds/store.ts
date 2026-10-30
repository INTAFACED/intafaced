import type { Sql } from 'postgres';
import {
  SANDBOX_FUND_ASSET,
  type SandboxBalance,
  type SandboxChange,
  type SandboxFundRefusal,
} from '@intafaced/contracts/developer-sandboxes';
import type { SandboxFundSettings } from './settings.js';

/**
 * The developer sandbox store (DV-sandbox-02): TEST balances in svc-pay's `pay.sandbox_*` tables.
 *
 * Not money, by construction. This file and everything it imports never touch the ledger: no ledger-client, no
 * posting, no read of a real balance (isolation.test.ts holds that). Figures are decimal strings and the arithmetic is
 * Postgres numeric; nothing passes through a JS number. Rows are keyed by the person and the sandbox id, so one
 * account's presses reach only its own rows, and pay never reads identity's tables to learn whose a sandbox is.
 */
export class SandboxFundError extends Error {
  constructor(
    message: string,
    readonly code: SandboxFundRefusal,
  ) {
    super(message);
    this.name = 'SandboxFundError';
  }
}

interface Who {
  readonly userId: string;
  readonly sandboxId: string;
}

type Tx = Sql;

export class SandboxStore {
  constructor(
    private readonly sql: Sql,
    private readonly settings: SandboxFundSettings,
  ) {}

  balance(who: Who): Promise<SandboxBalance> {
    return this.read(this.sql, who);
  }

  /** One press of Fund: adds the owner's TEST amount once per request id. */
  async fund(who: Who, requestId: string): Promise<SandboxChange> {
    const amount = this.settings.fundAmount;
    if (amount === null) {
      throw new SandboxFundError("The owner's TEST amount per Fund is not set", 'pay.sandbox_funds_unset');
    }
    return this.change(who, requestId, 'fund', async (tx) => {
      await tx`
        INSERT INTO pay.sandbox_balances (user_id, sandbox_id, asset, amount)
        VALUES (${who.userId}, ${who.sandboxId}, ${SANDBOX_FUND_ASSET}, ${amount}::numeric)
        ON CONFLICT (user_id, sandbox_id, asset)
        DO UPDATE SET amount = pay.sandbox_balances.amount + EXCLUDED.amount, updated_at = now()`;
      return amount;
    });
  }

  /** One press of Reset: every balance of the sandbox back to zero, within the owner's resets per day. */
  async reset(who: Who, requestId: string): Promise<SandboxChange> {
    const cap = this.settings.resetsPerDay;
    if (cap === null) {
      throw new SandboxFundError("The owner's resets per day are not set", 'pay.sandbox_reset_cap_unset');
    }
    return this.change(who, requestId, 'reset', async (tx) => {
      if ((await this.resetsToday(tx, who)) >= cap) {
        throw new SandboxFundError(`This sandbox has used its daily reset limit of ${cap}`, 'pay.sandbox_reset_cap_reached');
      }
      await tx`
        UPDATE pay.sandbox_balances SET amount = 0, updated_at = now()
        WHERE user_id = ${who.userId} AND sandbox_id = ${who.sandboxId}`;
      return '0';
    });
  }

  /**
   * One change under its business request id, serialised per person. Request ids are the caller's own (unique per
   * person). One already used for the same sandbox and kind answers the current balance (replayed) and changes nothing; one used for anything else is a conflict.
   */
  private async change(who: Who, requestId: string, kind: 'fund' | 'reset', apply: (tx: Tx) => Promise<string>): Promise<SandboxChange> {
    return (await this.sql.begin(async (tx) => {
      // Per person, as request ids are: two presses of one id, on any of the person's sandboxes, never race.
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`pay.sandbox:${who.userId}`}, 0))`;
      const seen = await tx<Array<{ sandbox_id: string; kind: string }>>`
        SELECT sandbox_id, kind FROM pay.sandbox_events WHERE user_id = ${who.userId} AND request_id = ${requestId}`;
      if (seen[0]) {
        const same = seen[0].sandbox_id === who.sandboxId && seen[0].kind === kind;
        if (!same) throw new SandboxFundError('This request id was used for another change', 'pay.sandbox_request_conflict');
        return { ...(await this.read(tx as unknown as Sql, who)), replayed: true };
      }
      const amount = await apply(tx as unknown as Sql);
      await tx`
        INSERT INTO pay.sandbox_events (request_id, user_id, sandbox_id, kind, asset, amount)
        VALUES (${requestId}, ${who.userId}, ${who.sandboxId}, ${kind}, ${SANDBOX_FUND_ASSET}, ${amount}::numeric)`;
      return { ...(await this.read(tx as unknown as Sql, who)), replayed: false };
    })) as SandboxChange;
  }

  private async resetsToday(tx: Tx, who: Who): Promise<number> {
    const rows = await tx<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pay.sandbox_events
      WHERE user_id = ${who.userId} AND sandbox_id = ${who.sandboxId} AND kind = 'reset'
        AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;
    return rows[0]?.n ?? 0;
  }

  private async read(tx: Tx, who: Who): Promise<SandboxBalance> {
    const [row] = await tx<Array<{ amount: string | null; version: number }>>`
      SELECT
        (SELECT trim_scale(amount)::text FROM pay.sandbox_balances
          WHERE user_id = ${who.userId} AND sandbox_id = ${who.sandboxId} AND asset = ${SANDBOX_FUND_ASSET}) AS amount,
        (SELECT count(*)::int FROM pay.sandbox_events WHERE user_id = ${who.userId} AND sandbox_id = ${who.sandboxId}) AS version`;
    return {
      sandboxId: who.sandboxId,
      label: 'TEST',
      asset: SANDBOX_FUND_ASSET,
      amount: row?.amount ?? '0',
      version: row?.version ?? 0,
      fundAmount: this.settings.fundAmount,
      resetsPerDay: this.settings.resetsPerDay,
      resetsToday: await this.resetsToday(tx, who),
    };
  }
}
