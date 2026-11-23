import type { Sql } from 'postgres';
import { z } from 'zod';
import { add, compare, formatAmount, parseAmount, ZERO, type Amount } from '@intafaced/ledger-client/money';

/**
 * Auto top-up of an isolated position's margin on the person's own venue account (J-derivatives-06 #4), held in
 * `trade.user_venue_auto_top_up_*` (drizzle/20261123124904_user_venue_auto_top_up.sql). No balance, no post: the venue
 * holds the margin, and every amount here is what the person set or what one signed venue change added.
 */

/** The agent permission for auto top-up on one venue account, with its own cap. Set once, with the wallet's approval. */
export interface AutoTopUpPermission {
  readonly userId: string;
  readonly venueId: string;
  readonly owner: string;
  readonly agentAddress: string;
  readonly asset: string;
  readonly cap: Amount;
  readonly createdAt: Date;
}

export type AutoTopUpStop = 'cap' | 'permission_cap';

/** One position's auto top-up: the level that starts it, the amount each adds, its cap, and where it stands. */
export interface AutoTopUpSetting {
  readonly id: string;
  readonly userId: string;
  readonly venueId: string;
  readonly owner: string;
  readonly symbol: string;
  readonly triggerLevel: Amount;
  readonly amountEach: Amount;
  readonly cap: Amount;
  readonly enabled: boolean;
  readonly run: number;
  readonly armed: boolean;
  readonly stopped: AutoTopUpStop | null;
  readonly nextSequence: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type AutoTopUpAddState = 'sending' | 'added' | 'refused';

/** One top-up our engine sent (or is sending): one agent-signed `update_isolated_margin` under its own key. */
export interface AutoTopUpAdd {
  readonly settingId: string;
  readonly sequence: number;
  readonly run: number;
  readonly userId: string;
  readonly venueId: string;
  readonly owner: string;
  readonly symbol: string;
  readonly agentAddress: string;
  readonly amount: Amount;
  readonly changeKey: string;
  readonly marginAt: Amount;
  readonly state: AutoTopUpAddState;
  readonly refusal: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface AutoTopUpSave {
  /** Used only when the position has no setting yet. */
  readonly id: string;
  readonly userId: string;
  readonly venueId: string;
  readonly owner: string;
  readonly symbol: string;
  readonly triggerLevel: Amount;
  readonly amountEach: Amount;
  readonly cap: Amount;
  readonly at: Date;
}

/** One position on one venue account of one person. */
export interface AutoTopUpPosition {
  readonly userId: string;
  readonly venueId: string;
  readonly owner: string;
  readonly symbol: string;
}

export interface AutoTopUpSettle {
  readonly settingId: string;
  readonly sequence: number;
  readonly state: 'added' | 'refused';
  readonly refusal: string | null;
  readonly at: Date;
}

export interface AutoTopUpClaim {
  readonly settingId: string;
  readonly marginAt: Amount;
  readonly changeKeyOf: (sequence: number) => string;
  readonly at: Date;
}

export type AutoTopUpClaimed =
  | { readonly kind: 'claimed'; readonly add: AutoTopUpAdd }
  | { readonly kind: 'stopped'; readonly reason: AutoTopUpStop }
  /** Off, not armed, or no permission: nothing to do. */
  | { readonly kind: 'none' };

export interface AutoTopUpStore {
  permission(userId: string, venueId: string, owner: string): Promise<AutoTopUpPermission | null>;
  /** Stores the permission, or returns the one already stored for the account (its cap never changes). */
  createPermissionOnce(p: AutoTopUpPermission): Promise<AutoTopUpPermission>;
  setting(position: AutoTopUpPosition): Promise<AutoTopUpSetting | null>;
  settingById(id: string): Promise<AutoTopUpSetting | null>;
  /** Every setting that is on, oldest first: the engine's work. */
  enabled(): Promise<readonly AutoTopUpSetting[]>;
  /**
   * Turns the position's auto top-up on with these terms, or changes the terms of one that is on (its run, its armed
   * state and its sequence kept). Turning on again after off starts a new run, armed. Either way a stop is cleared.
   */
  save(input: AutoTopUpSave): Promise<AutoTopUpSetting>;
  turnOff(id: string, at: Date): Promise<void>;
  setArmed(id: string, armed: boolean, at: Date): Promise<void>;
  /**
   * The one crossing of an armed setting, decided atomically against both caps (the permission's row and the setting's
   * row locked, so two workers or two positions never pass a cap together): a top-up row written `sending` under the
   * next sequence, or the cap it would pass recorded as the stop. Either way the setting is no longer armed.
   */
  claim(input: AutoTopUpClaim): Promise<AutoTopUpClaimed>;
  adds(settingId: string): Promise<readonly AutoTopUpAdd[]>;
  /** Moves a sending top-up to its definite state, once; false when it was already settled. */
  settle(input: AutoTopUpSettle): Promise<boolean>;
  /** What the permission's top-ups added, or are adding, together on every position (refused ones moved nothing). */
  used(permission: Pick<AutoTopUpPermission, 'userId' | 'venueId' | 'owner' | 'agentAddress'>): Promise<Amount>;
}

/** The one row a statement must return; its absence is a bug, never a silent empty answer. */
function one<T>(rows: readonly T[], what: string): T {
  const row = rows[0];
  if (row === undefined) throw new Error(`trade.user_venue_auto_top_up: ${what} returned no row`);
  return row;
}

const counts = (a: AutoTopUpAdd) => a.state === 'sending' || a.state === 'added';
const total = (xs: readonly AutoTopUpAdd[]) => xs.reduce((s, a) => add(s, a.amount), ZERO);

/** The decision `claim` makes, the same in memory and in SQL. */
function decide(
  setting: AutoTopUpSetting,
  permission: AutoTopUpPermission | null,
  added: { readonly run: Amount; readonly used: Amount },
): { kind: 'none' } | { kind: 'stopped'; reason: AutoTopUpStop } | { kind: 'claim' } {
  if (!setting.enabled || !setting.armed || !permission) return { kind: 'none' };
  if (compare(add(added.run, setting.amountEach), setting.cap) > 0) return { kind: 'stopped', reason: 'cap' };
  if (compare(add(added.used, setting.amountEach), permission.cap) > 0) return { kind: 'stopped', reason: 'permission_cap' };
  return { kind: 'claim' };
}

export class InMemoryAutoTopUpStore implements AutoTopUpStore {
  readonly permissions = new Map<string, AutoTopUpPermission>();
  readonly settings = new Map<string, AutoTopUpSetting>();
  readonly rows: AutoTopUpAdd[] = [];

  private pk = (userId: string, venueId: string, owner: string) => `${userId}\u0000${venueId}\u0000${owner}`;

  async permission(userId: string, venueId: string, owner: string) {
    return this.permissions.get(this.pk(userId, venueId, owner)) ?? null;
  }
  async createPermissionOnce(p: AutoTopUpPermission) {
    const k = this.pk(p.userId, p.venueId, p.owner);
    const had = this.permissions.get(k);
    if (had) return had;
    this.permissions.set(k, p);
    return p;
  }
  async setting({ userId, venueId, owner, symbol }: AutoTopUpPosition) {
    for (const s of this.settings.values())
      if (s.userId === userId && s.venueId === venueId && s.owner === owner && s.symbol === symbol) return s;
    return null;
  }
  async settingById(id: string) {
    return this.settings.get(id) ?? null;
  }
  async enabled() {
    return [...this.settings.values()].filter((s) => s.enabled);
  }
  async save(input: AutoTopUpSave) {
    const had = await this.setting(input);
    const terms = { triggerLevel: input.triggerLevel, amountEach: input.amountEach, cap: input.cap, stopped: null, updatedAt: input.at };
    const next: AutoTopUpSetting = had
      ? had.enabled
        ? { ...had, ...terms }
        : { ...had, ...terms, enabled: true, run: had.run + 1, armed: true }
      : {
          id: input.id,
          userId: input.userId,
          venueId: input.venueId,
          owner: input.owner,
          symbol: input.symbol,
          ...terms,
          enabled: true,
          run: 1,
          armed: true,
          nextSequence: 1,
          createdAt: input.at,
        };
    this.settings.set(next.id, next);
    return next;
  }
  async turnOff(id: string, at: Date) {
    const s = this.settings.get(id);
    if (s) this.settings.set(id, { ...s, enabled: false, updatedAt: at });
  }
  async setArmed(id: string, armed: boolean, at: Date) {
    const s = this.settings.get(id);
    if (s && s.enabled) this.settings.set(id, { ...s, armed, updatedAt: at });
  }
  async claim(input: AutoTopUpClaim): Promise<AutoTopUpClaimed> {
    // No await between the reads and the writes: one claim at a time, as the SQL locks make it.
    const s = this.settings.get(input.settingId);
    if (!s) return { kind: 'none' };
    const permission = this.permissions.get(this.pk(s.userId, s.venueId, s.owner)) ?? null;
    const runAdded = total(this.rows.filter((a) => a.settingId === s.id && a.run === s.run && counts(a)));
    const used = permission
      ? total(
          this.rows.filter(
            (a) =>
              a.userId === s.userId &&
              a.venueId === s.venueId &&
              a.owner === s.owner &&
              a.agentAddress === permission.agentAddress &&
              counts(a),
          ),
        )
      : ZERO;
    const d = decide(s, permission, { run: runAdded, used });
    if (d.kind === 'none' || !permission) return { kind: 'none' };
    if (d.kind === 'stopped') {
      this.settings.set(s.id, { ...s, armed: false, stopped: d.reason, updatedAt: input.at });
      return d;
    }
    const row: AutoTopUpAdd = {
      settingId: s.id,
      sequence: s.nextSequence,
      run: s.run,
      userId: s.userId,
      venueId: s.venueId,
      owner: s.owner,
      symbol: s.symbol,
      agentAddress: permission.agentAddress,
      amount: s.amountEach,
      changeKey: input.changeKeyOf(s.nextSequence),
      marginAt: input.marginAt,
      state: 'sending',
      refusal: null,
      createdAt: input.at,
      updatedAt: input.at,
    };
    this.rows.push(row);
    this.settings.set(s.id, { ...s, armed: false, stopped: null, nextSequence: s.nextSequence + 1, updatedAt: input.at });
    return { kind: 'claimed', add: row };
  }
  async adds(settingId: string) {
    return this.rows.filter((a) => a.settingId === settingId).sort((a, b) => a.sequence - b.sequence);
  }
  async settle({ settingId, sequence, state, refusal, at }: AutoTopUpSettle) {
    const i = this.rows.findIndex((a) => a.settingId === settingId && a.sequence === sequence);
    const row = this.rows[i];
    if (!row || row.state !== 'sending') return false;
    this.rows[i] = { ...row, state, refusal, updatedAt: at };
    return true;
  }
  async used({ userId, venueId, owner, agentAddress }: Pick<AutoTopUpPermission, 'userId' | 'venueId' | 'owner' | 'agentAddress'>) {
    return total(
      this.rows.filter(
        (a) => a.userId === userId && a.venueId === venueId && a.owner === owner && a.agentAddress === agentAddress && counts(a),
      ),
    );
  }
}

const PermissionRow = z.object({
  user_id: z.string(),
  venue_id: z.string(),
  owner: z.string(),
  agent_address: z.string(),
  asset: z.string(),
  cap: z.string(),
  created_at: z.date(),
});
type PermissionRow = z.infer<typeof PermissionRow>;
const SettingRow = z.object({
  id: z.string(),
  user_id: z.string(),
  venue_id: z.string(),
  owner: z.string(),
  symbol: z.string(),
  trigger_level: z.string(),
  amount_each: z.string(),
  cap: z.string(),
  enabled: z.boolean(),
  run: z.number().int(),
  armed: z.boolean(),
  stopped: z.enum(['cap', 'permission_cap']).nullable(),
  next_sequence: z.number().int(),
  created_at: z.date(),
  updated_at: z.date(),
});
type SettingRow = z.infer<typeof SettingRow>;
const AddRow = z.object({
  setting_id: z.string(),
  sequence: z.number().int(),
  run: z.number().int(),
  user_id: z.string(),
  venue_id: z.string(),
  owner: z.string(),
  symbol: z.string(),
  agent_address: z.string(),
  amount: z.string(),
  change_key: z.string(),
  margin_at: z.string(),
  state: z.enum(['sending', 'added', 'refused']),
  refusal: z.string().nullable(),
  created_at: z.date(),
  updated_at: z.date(),
});
type AddRow = z.infer<typeof AddRow>;
const TotalRow = z.object({ total: z.string() });
const SequenceRow = z.object({ sequence: z.number().int() });

const permissionOf = (r: PermissionRow): AutoTopUpPermission => ({
  userId: r.user_id,
  venueId: r.venue_id,
  owner: r.owner,
  agentAddress: r.agent_address,
  asset: r.asset,
  cap: parseAmount(r.cap),
  createdAt: r.created_at,
});
const settingOf = (r: SettingRow): AutoTopUpSetting => ({
  id: r.id,
  userId: r.user_id,
  venueId: r.venue_id,
  owner: r.owner,
  symbol: r.symbol,
  triggerLevel: parseAmount(r.trigger_level),
  amountEach: parseAmount(r.amount_each),
  cap: parseAmount(r.cap),
  enabled: r.enabled,
  run: r.run,
  armed: r.armed,
  stopped: r.stopped,
  nextSequence: r.next_sequence,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
const addOf = (r: AddRow): AutoTopUpAdd => ({
  settingId: r.setting_id,
  sequence: r.sequence,
  run: r.run,
  userId: r.user_id,
  venueId: r.venue_id,
  owner: r.owner,
  symbol: r.symbol,
  agentAddress: r.agent_address,
  amount: parseAmount(r.amount),
  changeKey: r.change_key,
  marginAt: parseAmount(r.margin_at),
  state: r.state,
  refusal: r.refusal,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class SqlAutoTopUpStore implements AutoTopUpStore {
  constructor(private readonly sql: Sql) {}

  async permission(userId: string, venueId: string, owner: string) {
    const rows = PermissionRow.array().parse(
      await this.sql`
      SELECT * FROM trade.user_venue_auto_top_up_permissions WHERE user_id = ${userId} AND venue_id = ${venueId} AND owner = ${owner}`,
    );
    return rows[0] ? permissionOf(rows[0]) : null;
  }

  async createPermissionOnce(p: AutoTopUpPermission) {
    await this.sql`
      INSERT INTO trade.user_venue_auto_top_up_permissions (user_id, venue_id, owner, agent_address, asset, cap, created_at)
      VALUES (${p.userId}, ${p.venueId}, ${p.owner}, ${p.agentAddress}, ${p.asset}, ${formatAmount(p.cap)}, ${p.createdAt})
      ON CONFLICT (user_id, venue_id, owner) DO NOTHING`;
    const stored = await this.permission(p.userId, p.venueId, p.owner);
    if (!stored) throw new Error('trade.user_venue_auto_top_up_permissions: the permission was not stored');
    return stored;
  }

  async setting({ userId, venueId, owner, symbol }: AutoTopUpPosition) {
    const rows = SettingRow.array().parse(
      await this.sql`
      SELECT * FROM trade.user_venue_auto_top_ups
      WHERE user_id = ${userId} AND venue_id = ${venueId} AND owner = ${owner} AND symbol = ${symbol}`,
    );
    return rows[0] ? settingOf(rows[0]) : null;
  }

  async settingById(id: string) {
    const rows = SettingRow.array().parse(await this.sql`SELECT * FROM trade.user_venue_auto_top_ups WHERE id = ${id}`);
    return rows[0] ? settingOf(rows[0]) : null;
  }

  async enabled() {
    const rows = SettingRow.array().parse(
      await this.sql`
      SELECT * FROM trade.user_venue_auto_top_ups WHERE enabled ORDER BY created_at, id`,
    );
    return rows.map(settingOf);
  }

  async save(input: AutoTopUpSave) {
    const level = formatAmount(input.triggerLevel);
    const each = formatAmount(input.amountEach);
    const cap = formatAmount(input.cap);
    const rows = SettingRow.array().parse(
      await this.sql`
      -- conflict-keys-ok: user_venue_auto_top_ups_pkey — the id is a fresh random uuid made for each save (auto-top-up.ts), so two saves never share one; the row is named by (user_id, venue_id, owner, symbol), the key this statement absorbs
      INSERT INTO trade.user_venue_auto_top_ups
        (id, user_id, venue_id, owner, symbol, trigger_level, amount_each, cap, enabled, run, armed, stopped, next_sequence,
         created_at, updated_at)
      VALUES (${input.id}, ${input.userId}, ${input.venueId}, ${input.owner}, ${input.symbol}, ${level}, ${each}, ${cap},
        true, 1, true, NULL, 1, ${input.at}, ${input.at})
      ON CONFLICT (user_id, venue_id, owner, symbol) DO UPDATE SET
        trigger_level = EXCLUDED.trigger_level,
        amount_each = EXCLUDED.amount_each,
        cap = EXCLUDED.cap,
        stopped = NULL,
        run = CASE WHEN trade.user_venue_auto_top_ups.enabled THEN trade.user_venue_auto_top_ups.run ELSE trade.user_venue_auto_top_ups.run + 1 END,
        armed = CASE WHEN trade.user_venue_auto_top_ups.enabled THEN trade.user_venue_auto_top_ups.armed ELSE true END,
        enabled = true,
        updated_at = EXCLUDED.updated_at
      RETURNING *`,
    );
    return settingOf(one(rows, 'save'));
  }

  async turnOff(id: string, at: Date) {
    await this.sql`UPDATE trade.user_venue_auto_top_ups SET enabled = false, updated_at = ${at} WHERE id = ${id}`;
  }

  async setArmed(id: string, armed: boolean, at: Date) {
    await this.sql`UPDATE trade.user_venue_auto_top_ups SET armed = ${armed}, updated_at = ${at} WHERE id = ${id} AND enabled`;
  }

  async claim(input: AutoTopUpClaim): Promise<AutoTopUpClaimed> {
    const claimed = await this.sql.begin(async (tx): Promise<AutoTopUpClaimed> => {
      const first = SettingRow.array().parse(await tx`SELECT * FROM trade.user_venue_auto_top_ups WHERE id = ${input.settingId}`);
      if (!first[0]) return { kind: 'none' };
      // The permission first, then the setting: every claim on the account takes the locks in the same order.
      const perms = PermissionRow.array().parse(
        await tx`
        SELECT * FROM trade.user_venue_auto_top_up_permissions
        WHERE user_id = ${first[0].user_id} AND venue_id = ${first[0].venue_id} AND owner = ${first[0].owner} FOR UPDATE`,
      );
      const locked = SettingRow.array().parse(
        await tx`SELECT * FROM trade.user_venue_auto_top_ups WHERE id = ${input.settingId} FOR UPDATE`,
      );
      const s = settingOf(one(locked, 'the locked setting'));
      const permission = perms[0] ? permissionOf(perms[0]) : null;
      const [run] = TotalRow.array().parse(
        await tx`
        SELECT COALESCE(SUM(amount), 0)::text AS total FROM trade.user_venue_auto_top_up_adds
        WHERE setting_id = ${s.id} AND run = ${s.run} AND state IN ('sending', 'added')`,
      );
      const [perm] = permission
        ? TotalRow.array().parse(
            await tx`
            SELECT COALESCE(SUM(amount), 0)::text AS total FROM trade.user_venue_auto_top_up_adds
            WHERE user_id = ${s.userId} AND venue_id = ${s.venueId} AND owner = ${s.owner}
              AND agent_address = ${permission.agentAddress} AND state IN ('sending', 'added')`,
          )
        : [{ total: '0' }];
      const d = decide(s, permission, { run: parseAmount(run?.total ?? '0'), used: parseAmount(perm?.total ?? '0') });
      if (d.kind === 'none' || !permission) return { kind: 'none' };
      if (d.kind === 'stopped') {
        await tx`UPDATE trade.user_venue_auto_top_ups SET armed = false, stopped = ${d.reason}, updated_at = ${input.at} WHERE id = ${s.id}`;
        return d;
      }
      const inserted = AddRow.array().parse(
        await tx`
        INSERT INTO trade.user_venue_auto_top_up_adds
          (setting_id, sequence, run, user_id, venue_id, owner, symbol, agent_address, amount, change_key, margin_at, state,
           created_at, updated_at)
        VALUES (${s.id}, ${s.nextSequence}, ${s.run}, ${s.userId}, ${s.venueId}, ${s.owner}, ${s.symbol},
          ${permission.agentAddress}, ${formatAmount(s.amountEach)}, ${input.changeKeyOf(s.nextSequence)},
          ${formatAmount(input.marginAt)}, 'sending', ${input.at}, ${input.at})
        RETURNING *`,
      );
      await tx`
        UPDATE trade.user_venue_auto_top_ups
        SET armed = false, stopped = NULL, next_sequence = ${s.nextSequence + 1}, updated_at = ${input.at}
        WHERE id = ${s.id}`;
      return { kind: 'claimed', add: addOf(one(inserted, 'the top-up insert')) };
    });
    return claimed;
  }

  async adds(settingId: string) {
    const rows = AddRow.array().parse(
      await this.sql`
      SELECT * FROM trade.user_venue_auto_top_up_adds WHERE setting_id = ${settingId} ORDER BY sequence`,
    );
    return rows.map(addOf);
  }

  async settle({ settingId, sequence, state, refusal, at }: AutoTopUpSettle) {
    const rows = SequenceRow.array().parse(
      await this.sql`
      UPDATE trade.user_venue_auto_top_up_adds SET state = ${state}, refusal = ${refusal}, updated_at = ${at}
      WHERE setting_id = ${settingId} AND sequence = ${sequence} AND state = 'sending'
      RETURNING sequence`,
    );
    return rows.length === 1;
  }

  async used({ userId, venueId, owner, agentAddress }: Pick<AutoTopUpPermission, 'userId' | 'venueId' | 'owner' | 'agentAddress'>) {
    const [row] = TotalRow.array().parse(
      await this.sql`
      SELECT COALESCE(SUM(amount), 0)::text AS total FROM trade.user_venue_auto_top_up_adds
      WHERE user_id = ${userId} AND venue_id = ${venueId} AND owner = ${owner} AND agent_address = ${agentAddress}
        AND state IN ('sending', 'added')`,
    );
    return parseAmount(row?.total ?? '0');
  }
}
