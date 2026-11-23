import type { Sql } from 'postgres';
import { add, compare, formatAmount, parseAmount, sub, ZERO, type Amount } from '@intafaced/ledger-client/money';

/**
 * The rows of the auto top-up on the person's own venue account (margin-topup.ts; J-derivatives-06 #4):
 * `trade.user_venue_margin_topup_permissions`, `trade.user_venue_margin_topup_rules` and
 * `trade.user_venue_margin_topups` (drizzle/20261123023000_user_venue_margin_topups.sql).
 *
 * Nothing here is a balance: the venue is the record of the position's margin. `added` on a rule and on a permission is
 * a count of what our engine was let send, held to its cap: a top-up is counted on both, under their row locks, before
 * the key signs it, and uncounted only when the venue definitely refused it. So two workers that see the same fall count
 * it once, and a count can only ever refuse more than the venue applied, never less.
 */

export type TopUpStop = 'cap' | 'permission_cap';
export type TopUpState = 'sending' | 'added' | 'refused';

export interface TopUpAccount {
  readonly userId: string;
  readonly venueId: string;
  /** The person's wallet, lowercase: their own venue account. */
  readonly owner: string;
}
export interface TopUpPosition extends TopUpAccount {
  readonly symbol: string;
}

export interface TopUpPermission extends TopUpAccount {
  /** The venue agent key INTAFACED derives for this person's top-ups on this account. */
  readonly agentAddress: string;
  /** The permission's own cap: the most the key may add in all on this account. */
  readonly cap: Amount;
  readonly added: Amount;
  readonly updatedAt: Date;
}

export interface TopUpRule extends TopUpPosition {
  readonly on: boolean;
  /** The margin level, in percent, that starts a top-up. */
  readonly level: Amount;
  readonly amount: Amount;
  readonly cap: Amount;
  /** What the rule added since it was turned on. */
  readonly added: Amount;
  /** True once the margin level was seen above `level`: the next fall to it adds once. */
  readonly armed: boolean;
  readonly stopped: TopUpStop | null;
  /** How many top-ups this position's rule ever started: the next one is `n + 1`, so a key is never used twice. */
  readonly n: number;
  /** The top-up sent and not yet answered definitely by the venue, or null. */
  readonly sending: number | null;
  readonly updatedAt: Date;
}

export interface TopUp extends TopUpPosition {
  readonly n: number;
  /** The venue margin change's business key. */
  readonly changeKey: string;
  readonly amount: Amount;
  readonly levelSeen: Amount;
  readonly state: TopUpState;
  readonly failure: string | null;
  readonly at: Date;
}

export type TopUpClaim = { readonly topUp: TopUp } | { readonly stopped: TopUpStop } | null;

export interface MarginTopUpStore {
  permission(a: TopUpAccount): Promise<TopUpPermission | null>;
  /** Store the permission's cap (and its key's address). Null, with nothing changed, when the cap is below what was added. */
  setPermissionCap(a: TopUpAccount, agentAddress: string, cap: Amount, at: Date): Promise<TopUpPermission | null>;
  rule(p: TopUpPosition): Promise<TopUpRule | null>;
  /**
   * Turn the rule on, or change it while on: armed, with no stop. Its count starts at zero when it was off or new, and is
   * kept when it was on (or still has a top-up with no definite answer, which its count holds). Null, with nothing
   * changed, when the new cap is below the count it keeps.
   */
  setRule(p: TopUpPosition, set: { level: Amount; amount: Amount; cap: Amount }, at: Date): Promise<TopUpRule | null>;
  turnOff(p: TopUpPosition, at: Date): Promise<TopUpRule | null>;
  /** Every rule that is on. */
  live(): Promise<readonly TopUpRule[]>;
  /** The margin level was seen above the rule's level: armed again. Only a rule that is on and sending nothing. */
  arm(p: TopUpPosition, at: Date): Promise<void>;
  /**
   * One fall, claimed once: under the permission's and the rule's row locks the rule must be on, armed and sending
   * nothing (else null: another worker has it, or it changed). Where the rule's count with this amount would pass its
   * cap, or the permission's count would pass the permission's own cap, nothing is counted: the rule is disarmed with
   * that stop. Otherwise both counts take the amount, the rule is disarmed and marked sending, and the top-up row is
   * written, before anything is signed.
   */
  claim(p: TopUpPosition, levelSeen: Amount, changeKeyOf: (n: number) => string, at: Date): Promise<TopUpClaim>;
  /** The venue's definite answer to the top-up the rule is sending, recorded once: a refusal gives its amount back to both counts. */
  settle(p: TopUpPosition, n: number, state: 'added' | 'refused', failure: string | null, at: Date): Promise<void>;
  topUp(p: TopUpPosition, n: number): Promise<TopUp | null>;
  /** The position's top-ups, newest first. */
  topUps(p: TopUpPosition, limit: number): Promise<readonly TopUp[]>;
}

const accountKey = (a: TopUpAccount) => `${a.userId}\u0000${a.venueId}\u0000${a.owner}`;
const positionKey = (p: TopUpPosition) => `${accountKey(p)}\u0000${p.symbol}`;

/** The same rules in memory, for unit tests: one process, so each method runs whole, as the SQL one does under its locks. */
export class InMemoryMarginTopUpStore implements MarginTopUpStore {
  private readonly permissions = new Map<string, TopUpPermission>();
  private readonly rules = new Map<string, TopUpRule>();
  private readonly sent = new Map<string, TopUp[]>();

  async permission(a: TopUpAccount) {
    return this.permissions.get(accountKey(a)) ?? null;
  }
  async setPermissionCap(a: TopUpAccount, agentAddress: string, cap: Amount, at: Date) {
    const now = this.permissions.get(accountKey(a));
    if (now && compare(cap, now.added) < 0) return null;
    const next: TopUpPermission = {
      userId: a.userId,
      venueId: a.venueId,
      owner: a.owner,
      agentAddress,
      cap,
      added: now?.added ?? ZERO,
      updatedAt: at,
    };
    this.permissions.set(accountKey(a), next);
    return next;
  }
  async rule(p: TopUpPosition) {
    return this.rules.get(positionKey(p)) ?? null;
  }
  async setRule(p: TopUpPosition, set: { level: Amount; amount: Amount; cap: Amount }, at: Date) {
    const now = this.rules.get(positionKey(p));
    const added = now && (now.on || now.sending !== null) ? now.added : ZERO;
    if (compare(set.cap, added) < 0) return null;
    const next: TopUpRule = {
      userId: p.userId,
      venueId: p.venueId,
      owner: p.owner,
      symbol: p.symbol,
      on: true,
      ...set,
      added,
      armed: true,
      stopped: null,
      n: now?.n ?? 0,
      sending: now?.sending ?? null,
      updatedAt: at,
    };
    this.rules.set(positionKey(p), next);
    return next;
  }
  async turnOff(p: TopUpPosition, at: Date) {
    const now = this.rules.get(positionKey(p));
    if (!now) return null;
    const next = { ...now, on: false, updatedAt: at };
    this.rules.set(positionKey(p), next);
    return next;
  }
  async live() {
    return [...this.rules.values()].filter((r) => r.on);
  }
  async arm(p: TopUpPosition, at: Date) {
    const now = this.rules.get(positionKey(p));
    if (now && now.on && now.sending === null && !now.armed) this.rules.set(positionKey(p), { ...now, armed: true, stopped: null, updatedAt: at });
  }
  async claim(p: TopUpPosition, levelSeen: Amount, changeKeyOf: (n: number) => string, at: Date): Promise<TopUpClaim> {
    const rule = this.rules.get(positionKey(p));
    const permission = this.permissions.get(accountKey(p));
    if (!rule || !permission || !rule.on || !rule.armed || rule.sending !== null) return null;
    const stopped: TopUpStop | null =
      compare(add(rule.added, rule.amount), rule.cap) > 0
        ? 'cap'
        : compare(add(permission.added, rule.amount), permission.cap) > 0
          ? 'permission_cap'
          : null;
    if (stopped) {
      this.rules.set(positionKey(p), { ...rule, armed: false, stopped, updatedAt: at });
      return { stopped };
    }
    const n = rule.n + 1;
    const topUp: TopUp = {
      userId: p.userId,
      venueId: p.venueId,
      owner: p.owner,
      symbol: p.symbol,
      n,
      changeKey: changeKeyOf(n),
      amount: rule.amount,
      levelSeen,
      state: 'sending',
      failure: null,
      at,
    };
    this.rules.set(positionKey(p), { ...rule, n, sending: n, armed: false, stopped: null, added: add(rule.added, rule.amount), updatedAt: at });
    this.permissions.set(accountKey(p), { ...permission, added: add(permission.added, rule.amount), updatedAt: at });
    this.sent.set(positionKey(p), [...(this.sent.get(positionKey(p)) ?? []), topUp]);
    return { topUp };
  }
  async settle(p: TopUpPosition, n: number, state: 'added' | 'refused', failure: string | null, at: Date) {
    const list = this.sent.get(positionKey(p)) ?? [];
    const topUp = list.find((t) => t.n === n);
    if (!topUp || topUp.state !== 'sending') return;
    this.sent.set(
      positionKey(p),
      list.map((t) => (t.n === n ? { ...t, state, failure } : t)),
    );
    const rule = this.rules.get(positionKey(p))!;
    const permission = this.permissions.get(accountKey(p))!;
    const back = state === 'refused' ? topUp.amount : ZERO;
    // The rule's count still holds this top-up: it is never restarted while one is sending (setRule).
    this.rules.set(positionKey(p), { ...rule, sending: rule.sending === n ? null : rule.sending, added: sub(rule.added, back), updatedAt: at });
    this.permissions.set(accountKey(p), { ...permission, added: sub(permission.added, back), updatedAt: at });
  }
  async topUp(p: TopUpPosition, n: number) {
    return (this.sent.get(positionKey(p)) ?? []).find((t) => t.n === n) ?? null;
  }
  async topUps(p: TopUpPosition, limit: number) {
    return [...(this.sent.get(positionKey(p)) ?? [])].reverse().slice(0, limit);
  }
}

type PermissionRow = { user_id: string; venue_id: string; owner: string; agent_address: string; cap: string; added: string; updated_at: Date };
type RuleRow = {
  user_id: string;
  venue_id: string;
  owner: string;
  symbol: string;
  is_on: boolean;
  level: string;
  amount: string;
  cap: string;
  added: string;
  armed: boolean;
  stopped: TopUpStop | null;
  n: number;
  sending: number | null;
  updated_at: Date;
};
type TopUpRow = {
  user_id: string;
  venue_id: string;
  owner: string;
  symbol: string;
  n: number;
  change_key: string;
  amount: string;
  level_seen: string;
  state: TopUpState;
  failure: string | null;
  created_at: Date;
};

const permissionOf = (r: PermissionRow): TopUpPermission => ({
  userId: r.user_id,
  venueId: r.venue_id,
  owner: r.owner,
  agentAddress: r.agent_address,
  cap: parseAmount(r.cap),
  added: parseAmount(r.added),
  updatedAt: r.updated_at,
});
const ruleOf = (r: RuleRow): TopUpRule => ({
  userId: r.user_id,
  venueId: r.venue_id,
  owner: r.owner,
  symbol: r.symbol,
  on: r.is_on,
  level: parseAmount(r.level),
  amount: parseAmount(r.amount),
  cap: parseAmount(r.cap),
  added: parseAmount(r.added),
  armed: r.armed,
  stopped: r.stopped,
  n: r.n,
  sending: r.sending,
  updatedAt: r.updated_at,
});
const topUpOf = (r: TopUpRow): TopUp => ({
  userId: r.user_id,
  venueId: r.venue_id,
  owner: r.owner,
  symbol: r.symbol,
  n: r.n,
  changeKey: r.change_key,
  amount: parseAmount(r.amount),
  levelSeen: parseAmount(r.level_seen),
  state: r.state,
  failure: r.failure,
  at: r.created_at,
});

export class SqlMarginTopUpStore implements MarginTopUpStore {
  constructor(private readonly sql: Sql) {}

  async permission(a: TopUpAccount) {
    const rows = await this.sql<PermissionRow[]>`
      SELECT * FROM trade.user_venue_margin_topup_permissions
      WHERE user_id = ${a.userId} AND venue_id = ${a.venueId} AND owner = ${a.owner}`;
    return rows[0] ? permissionOf(rows[0]) : null;
  }

  async setPermissionCap(a: TopUpAccount, agentAddress: string, cap: Amount, at: Date) {
    const rows = await this.sql<PermissionRow[]>`
      INSERT INTO trade.user_venue_margin_topup_permissions (user_id, venue_id, owner, agent_address, cap, added, created_at, updated_at)
      VALUES (${a.userId}, ${a.venueId}, ${a.owner}, ${agentAddress}, ${formatAmount(cap)}, 0, ${at}, ${at})
      ON CONFLICT (user_id, venue_id, owner) DO UPDATE SET cap = EXCLUDED.cap, updated_at = EXCLUDED.updated_at
        WHERE trade.user_venue_margin_topup_permissions.added <= EXCLUDED.cap
      RETURNING *`;
    return rows[0] ? permissionOf(rows[0]) : null;
  }

  async rule(p: TopUpPosition) {
    const rows = await this.sql<RuleRow[]>`
      SELECT * FROM trade.user_venue_margin_topup_rules
      WHERE user_id = ${p.userId} AND venue_id = ${p.venueId} AND owner = ${p.owner} AND symbol = ${p.symbol}`;
    return rows[0] ? ruleOf(rows[0]) : null;
  }

  async setRule(p: TopUpPosition, set: { level: Amount; amount: Amount; cap: Amount }, at: Date) {
    const rows = await this.sql<RuleRow[]>`
      INSERT INTO trade.user_venue_margin_topup_rules AS r
        (user_id, venue_id, owner, symbol, is_on, level, amount, cap, added, armed, stopped, n, sending, created_at, updated_at)
      VALUES (${p.userId}, ${p.venueId}, ${p.owner}, ${p.symbol}, true, ${formatAmount(set.level)}, ${formatAmount(set.amount)},
        ${formatAmount(set.cap)}, 0, true, NULL, 0, NULL, ${at}, ${at})
      ON CONFLICT (user_id, venue_id, owner, symbol) DO UPDATE SET
        is_on = true, level = EXCLUDED.level, amount = EXCLUDED.amount, cap = EXCLUDED.cap, armed = true, stopped = NULL,
        added = CASE WHEN r.is_on OR r.sending IS NOT NULL THEN r.added ELSE 0 END,
        updated_at = EXCLUDED.updated_at
        WHERE (NOT r.is_on AND r.sending IS NULL) OR r.added <= EXCLUDED.cap
      RETURNING *`;
    return rows[0] ? ruleOf(rows[0]) : null;
  }

  async turnOff(p: TopUpPosition, at: Date) {
    const rows = await this.sql<RuleRow[]>`
      UPDATE trade.user_venue_margin_topup_rules SET is_on = false, updated_at = ${at}
      WHERE user_id = ${p.userId} AND venue_id = ${p.venueId} AND owner = ${p.owner} AND symbol = ${p.symbol}
      RETURNING *`;
    return rows[0] ? ruleOf(rows[0]) : null;
  }

  async live() {
    const rows = await this.sql<RuleRow[]>`
      SELECT * FROM trade.user_venue_margin_topup_rules WHERE is_on ORDER BY user_id, venue_id, owner, symbol`;
    return rows.map(ruleOf);
  }

  async arm(p: TopUpPosition, at: Date) {
    await this.sql`
      UPDATE trade.user_venue_margin_topup_rules SET armed = true, stopped = NULL, updated_at = ${at}
      WHERE user_id = ${p.userId} AND venue_id = ${p.venueId} AND owner = ${p.owner} AND symbol = ${p.symbol}
        AND is_on AND NOT armed AND sending IS NULL`;
  }

  async claim(p: TopUpPosition, levelSeen: Amount, changeKeyOf: (n: number) => string, at: Date): Promise<TopUpClaim> {
    return this.sql.begin(async (tx): Promise<TopUpClaim> => {
      // The permission first, then the rule, in every transaction that takes both: no two can wait on each other.
      const permissions = await tx<PermissionRow[]>`
        SELECT * FROM trade.user_venue_margin_topup_permissions
        WHERE user_id = ${p.userId} AND venue_id = ${p.venueId} AND owner = ${p.owner} FOR UPDATE`;
      const rules = await tx<RuleRow[]>`
        SELECT * FROM trade.user_venue_margin_topup_rules
        WHERE user_id = ${p.userId} AND venue_id = ${p.venueId} AND owner = ${p.owner} AND symbol = ${p.symbol} FOR UPDATE`;
      if (!permissions[0] || !rules[0]) return null;
      const permission = permissionOf(permissions[0]);
      const rule = ruleOf(rules[0]);
      if (!rule.on || !rule.armed || rule.sending !== null) return null;
      const stopped: TopUpStop | null =
        compare(add(rule.added, rule.amount), rule.cap) > 0
          ? 'cap'
          : compare(add(permission.added, rule.amount), permission.cap) > 0
            ? 'permission_cap'
            : null;
      if (stopped) {
        await tx`
          UPDATE trade.user_venue_margin_topup_rules SET armed = false, stopped = ${stopped}, updated_at = ${at}
          WHERE user_id = ${p.userId} AND venue_id = ${p.venueId} AND owner = ${p.owner} AND symbol = ${p.symbol}`;
        return { stopped };
      }
      const n = rule.n + 1;
      const amount = formatAmount(rule.amount);
      await tx`
        UPDATE trade.user_venue_margin_topup_rules
        SET n = ${n}, sending = ${n}, armed = false, stopped = NULL, added = added + ${amount}::numeric, updated_at = ${at}
        WHERE user_id = ${p.userId} AND venue_id = ${p.venueId} AND owner = ${p.owner} AND symbol = ${p.symbol}`;
      await tx`
        UPDATE trade.user_venue_margin_topup_permissions SET added = added + ${amount}::numeric, updated_at = ${at}
        WHERE user_id = ${p.userId} AND venue_id = ${p.venueId} AND owner = ${p.owner}`;
      const rows = await tx<TopUpRow[]>`
        INSERT INTO trade.user_venue_margin_topups
          (user_id, venue_id, owner, symbol, n, change_key, amount, level_seen, state, created_at)
        VALUES (${p.userId}, ${p.venueId}, ${p.owner}, ${p.symbol}, ${n}, ${changeKeyOf(n)}, ${amount},
          ${formatAmount(levelSeen)}, 'sending', ${at})
        RETURNING *`;
      return { topUp: topUpOf(rows[0]!) };
    });
  }

  async settle(p: TopUpPosition, n: number, state: 'added' | 'refused', failure: string | null, at: Date) {
    await this.sql.begin(async (tx) => {
      await tx`
        SELECT 1 FROM trade.user_venue_margin_topup_permissions
        WHERE user_id = ${p.userId} AND venue_id = ${p.venueId} AND owner = ${p.owner} FOR UPDATE`;
      await tx`
        SELECT 1 FROM trade.user_venue_margin_topup_rules
        WHERE user_id = ${p.userId} AND venue_id = ${p.venueId} AND owner = ${p.owner} AND symbol = ${p.symbol} FOR UPDATE`;
      const moved = await tx<{ amount: string }[]>`
        UPDATE trade.user_venue_margin_topups SET state = ${state}, failure = ${failure}, settled_at = ${at}
        WHERE user_id = ${p.userId} AND venue_id = ${p.venueId} AND owner = ${p.owner} AND symbol = ${p.symbol} AND n = ${n}
          AND state = 'sending'
        RETURNING amount`;
      if (!moved[0]) return;
      const back = state === 'refused' ? moved[0].amount : '0';
      // The rule's count still holds this top-up: it is never restarted while one is sending (setRule).
      await tx`
        UPDATE trade.user_venue_margin_topup_rules
        SET sending = CASE WHEN sending = ${n} THEN NULL ELSE sending END, added = added - ${back}::numeric, updated_at = ${at}
        WHERE user_id = ${p.userId} AND venue_id = ${p.venueId} AND owner = ${p.owner} AND symbol = ${p.symbol}`;
      await tx`
        UPDATE trade.user_venue_margin_topup_permissions SET added = added - ${back}::numeric, updated_at = ${at}
        WHERE user_id = ${p.userId} AND venue_id = ${p.venueId} AND owner = ${p.owner}`;
    });
  }

  async topUp(p: TopUpPosition, n: number) {
    const rows = await this.sql<TopUpRow[]>`
      SELECT * FROM trade.user_venue_margin_topups
      WHERE user_id = ${p.userId} AND venue_id = ${p.venueId} AND owner = ${p.owner} AND symbol = ${p.symbol} AND n = ${n}`;
    return rows[0] ? topUpOf(rows[0]) : null;
  }

  async topUps(p: TopUpPosition, limit: number) {
    const rows = await this.sql<TopUpRow[]>`
      SELECT * FROM trade.user_venue_margin_topups
      WHERE user_id = ${p.userId} AND venue_id = ${p.venueId} AND owner = ${p.owner} AND symbol = ${p.symbol}
      ORDER BY n DESC LIMIT ${limit}`;
    return rows.map(topUpOf);
  }
}
