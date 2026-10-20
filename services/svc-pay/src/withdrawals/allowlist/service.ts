import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import type { BankApproverEligibilityPort } from '@intafaced/contracts';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { AllowlistError } from './errors.js';
import type {
  ChangeOp,
  ChangeStatus,
  ChangeView,
  EntryView,
  ListForTeamInput,
  ListInput,
  ModeView,
  PolicyView,
  ProposeAddInput,
  ProposeDeleteInput,
  ProposePolicyInput,
  QuorumView,
  SetModeInput,
  SetModeResult,
  SetQuorumInput,
} from './schemas.js';

/**
 * The withdrawal allowlist (W-withdraw-10, wallet-withdraw-025 / 026 / 027). NO BALANCE LIVES HERE.
 *
 * - ENTRIES are crypto addresses the owner may withdraw to while ALLOWLIST-ONLY MODE is on, grouped internal wallet, external
 *   wallet or contract. Fiat (bank) destinations are not addressed by this list. The mode is the owner's switch, off until
 *   the owner turns it on; turning it ON applies at once (it only tightens) and turning it OFF is a governed change. With it
 *   on, a withdrawal to an address that is not an active entry refuses `pay.destination_not_allowlisted`, unless a one-time
 *   send is allowed (below).
 * - GOVERNED CHANGES: adding an entry, deleting one, turning the mode off and changing the one-time policy are each a CHANGE
 *   with a request hash (a digest of exactly what changes, for this user). It waits for the owner-set number of approvers on
 *   an owner-set team; an approver names the hash they read, so an approval cannot ride another change; the requester can
 *   never approve; ONE rejection ends it. When the last approval lands the change is applied in the same transaction.
 *   The quorum is owner-set per user; none refuses `quorum_unset`.
 * - ONE-TIME SENDS to an unlisted address are off by default; a governed change turns them on for this user, one asset and
 *   one amount ceiling per send. Eligibility of approvers is svc-bank's and is asked through a port; no answer refuses.
 * - SUSPENDED: an operator can suspend an entry (it refuses like an unlisted one) and resume it.
 *
 * The check a withdrawal meets lives in `guard.ts`, inside the claim's own transaction. This file owns the lists and decisions.
 */

export interface AllowlistServiceDeps {
  readonly sql: Sql;
  /** Absent: every approval refuses `eligibility_unwired`. */
  readonly eligibility?: BankApproverEligibilityPort;
  readonly now?: () => Date;
}

interface ChangeRow {
  id: string;
  user_id: string;
  client_ref: string;
  op: ChangeOp;
  entry_id: string | null;
  payload: Record<string, unknown>;
  request_hash: string;
  team_account_id: string;
  required_approvals: number;
  status: ChangeStatus;
  failure_code: string | null;
  created_at: Date;
  decided_at: Date | null;
}

interface EntryRow {
  id: string;
  user_id: string;
  group_kind: EntryView['group'];
  asset_id: string;
  address: string;
  label: string;
  state: EntryView['state'];
  created_by: string;
  suspended_reason: string | null;
  created_at: Date;
  last_used_at: Date | null;
}

const CHANGE_COLUMNS = `id, user_id, client_ref, op, entry_id, payload, request_hash, team_account_id, required_approvals, status,
  failure_code, created_at, decided_at`;
const ENTRY_COLUMNS = `id, user_id, group_kind, asset_id, address, label, state, created_by, suspended_reason, created_at, last_used_at`;

/** The key of the lock that orders a user's list edits against each other and against withdrawal claims. */
export const allowlistLockKey = (userId: string): string => `pay.allowlist:${userId}`;

const EVM = /^0x[0-9a-fA-F]{40}$/;
const GENERIC = /^[A-Za-z0-9:_.-]{14,128}$/;

/** EVM addresses compare case-insensitively; every other form compares as written. Null when the text is not an address. */
export function normalizeAddress(address: string): string | null {
  const trimmed = address.trim();
  if (EVM.test(trimmed)) return trimmed.toLowerCase();
  return GENERIC.test(trimmed) ? trimmed : null;
}

/** A digest of exactly what a change does, for one user. A changed address is a different hash and so a new request. */
export function requestHashOf(userId: string, op: ChangeOp, entryId: string | null, subject: Record<string, unknown>): string {
  const sorted = Object.fromEntries(Object.entries(subject).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return createHash('sha256')
    .update(JSON.stringify([userId, op, entryId, sorted]))
    .digest('hex');
}

interface ModeRow {
  enabled: boolean;
  set_at: Date;
}
interface OneTimeRow {
  enabled: boolean;
  asset_id: string;
  max_amount: string;
  set_at: Date;
}

export async function latestModeRow(q: Sql, userId: string): Promise<ModeRow | null> {
  const [row] = await q<ModeRow[]>`
    SELECT enabled, set_at FROM pay.allowlist_mode_events WHERE user_id = ${userId} ORDER BY seq DESC LIMIT 1`;
  return row ?? null;
}

export async function latestOneTimeRow(q: Sql, userId: string): Promise<OneTimeRow | null> {
  const [row] = await q<OneTimeRow[]>`
    SELECT enabled, asset_id, max_amount::text AS max_amount, set_at
      FROM pay.allowlist_onetime_policy_events WHERE user_id = ${userId} ORDER BY seq DESC LIMIT 1`;
  return row ?? null;
}

export type DestinationDecision =
  | { readonly allowed: true; readonly via: 'mode_off' | 'not_crypto' | 'entry' | 'one_time'; readonly entryId?: string }
  | { readonly allowed: false };

/**
 * May this user withdraw this amount of this asset to this destination? Mode off: yes. Mode on: only to an ACTIVE entry of the
 * same asset, or as a one-time send within the owner-approved ceiling. Reads on `q`, so the guard asks again inside its claim.
 */
export async function decideDestination(
  q: Sql,
  userId: string,
  assetId: string,
  amount: Amount,
  destination: { kind: string; ref: string },
): Promise<DestinationDecision> {
  const mode = await latestModeRow(q, userId);
  if (!mode || !mode.enabled) return { allowed: true, via: 'mode_off' };
  if (destination.kind !== 'crypto') return { allowed: true, via: 'not_crypto' };
  const norm = normalizeAddress(destination.ref);
  if (norm) {
    const [entry] = await q<Array<{ id: string }>>`
      SELECT id FROM pay.allowlist_entries
       WHERE user_id = ${userId} AND asset_id = ${assetId} AND address_norm = ${norm} AND state = 'active'`;
    if (entry) return { allowed: true, via: 'entry', entryId: entry.id };
  }
  const oneTime = await latestOneTimeRow(q, userId);
  if (oneTime && oneTime.enabled && oneTime.asset_id === assetId && amount <= parseAmount(oneTime.max_amount)) {
    return { allowed: true, via: 'one_time' };
  }
  return { allowed: false };
}

export class AllowlistService {
  private readonly now: () => Date;
  constructor(private readonly deps: AllowlistServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  // ── owner settings ────────────────────────────────────────────────────────

  async setQuorum(actor: string, input: SetQuorumInput): Promise<QuorumView> {
    const [row] = await this.deps.sql<Array<{ team_account_id: string; required_approvals: number; set_by: string; set_at: Date }>>`
      INSERT INTO pay.allowlist_quorum_events (user_id, team_account_id, required_approvals, set_by)
      VALUES (${input.userId}, ${input.teamAccountId}, ${input.requiredApprovals}, ${actor})
      RETURNING team_account_id, required_approvals, set_by, set_at`;
    return quorumView(input.userId, row!);
  }

  async quorum(userId: string): Promise<QuorumView | null> {
    const row = await this.latestQuorum(this.deps.sql, userId);
    return row ? quorumView(userId, row) : null;
  }

  // ── the switch and the policy ─────────────────────────────────────────────

  async mode(userId: string): Promise<ModeView> {
    const row = await latestModeRow(this.deps.sql, userId);
    return { userId, enabled: row?.enabled ?? false, setAt: row ? row.set_at.toISOString() : null };
  }

  async policy(userId: string): Promise<PolicyView> {
    const row = await latestOneTimeRow(this.deps.sql, userId);
    return policyView(userId, row);
  }

  /**
   * ON applies at once and needs a quorum already set (a user whose list nobody can change must not lock themselves into the
   * mode). OFF is a governed change.
   */
  async setMode(userId: string, input: SetModeInput): Promise<SetModeResult> {
    if (input.enabled) {
      if (!(await this.latestQuorum(this.deps.sql, userId))) {
        throw new AllowlistError('allowlist.quorum_unset', 'no approver quorum is set for this account; the list could never be changed');
      }
      await transaction(this.deps.sql, async (tx) => {
        await this.lockUser(tx, userId);
        const current = await latestModeRow(tx, userId);
        if (current?.enabled) return;
        await tx`INSERT INTO pay.allowlist_mode_events (user_id, enabled, set_by) VALUES (${userId}, true, ${userId})`;
        await this.event(tx, userId, null, null, 'mode_on', userId, {});
      });
      return { mode: await this.mode(userId), change: null };
    }
    const existing = await this.byRef(this.deps.sql, userId, input.clientRef);
    if (!existing) {
      const current = await latestModeRow(this.deps.sql, userId);
      if (!current?.enabled) throw new AllowlistError('allowlist.mode_already_off', 'allowlist-only mode is already off');
    }
    const change = await this.submit(userId, input.clientRef, 'mode_off', null, {});
    return { mode: await this.mode(userId), change };
  }

  async proposePolicy(userId: string, input: ProposePolicyInput): Promise<ChangeView> {
    const subject = { enabled: input.enabled, assetId: input.assetId, maxAmount: formatAmount(parseAmount(input.maxAmount)) };
    if (!(await this.byRef(this.deps.sql, userId, input.clientRef))) {
      const current = await latestOneTimeRow(this.deps.sql, userId);
      if (
        current &&
        current.enabled === subject.enabled &&
        current.asset_id === subject.assetId &&
        parseAmount(current.max_amount) === parseAmount(subject.maxAmount)
      ) {
        throw new AllowlistError('allowlist.policy_unchanged', 'the one-time send policy already reads this way');
      }
    }
    return this.submit(userId, input.clientRef, 'onetime_policy', null, subject);
  }

  // ── entries: add and delete are requests ──────────────────────────────────

  async proposeAdd(userId: string, input: ProposeAddInput): Promise<ChangeView> {
    const norm = normalizeAddress(input.address);
    if (!norm) throw new AllowlistError('allowlist.address_invalid', 'that is not a withdrawal address the list can hold');
    const subject = { group: input.group, assetId: input.assetId, address: input.address.trim(), label: input.label.trim() };
    return this.submit(userId, input.clientRef, 'add', null, subject);
  }

  async proposeDelete(userId: string, input: ProposeDeleteInput): Promise<ChangeView> {
    const [entry] = await this.deps.sql<EntryRow[]>`
      SELECT ${this.deps.sql.unsafe(ENTRY_COLUMNS)} FROM pay.allowlist_entries WHERE id = ${input.entryId} AND user_id = ${userId}`;
    if (!entry || entry.state === 'removed') throw new AllowlistError('allowlist.entry_not_found', 'no such list entry');
    return this.submit(userId, input.clientRef, 'delete', entry.id, {
      group: entry.group_kind,
      assetId: entry.asset_id,
      address: entry.address,
      label: entry.label,
    });
  }

  // ── decide ────────────────────────────────────────────────────────────────

  async approve(approverId: string, changeId: string, requestHash: string): Promise<ChangeView> {
    const change = await this.load(changeId);
    await this.assertMayDecide(approverId, change, requestHash);
    await transaction(this.deps.sql, async (tx) => {
      const row = await this.lock(tx, changeId);
      if (row.status === 'approved') return;
      if (row.status !== 'waiting') {
        throw new AllowlistError('allowlist.not_waiting', `this change is ${row.status}`, { status: row.status });
      }
      const added = await tx`
        INSERT INTO pay.allowlist_decisions (change_id, approver_id, decision, request_hash, decided_at)
        VALUES (${changeId}, ${approverId}, 'approve', ${requestHash}, ${this.now()}) ON CONFLICT DO NOTHING RETURNING change_id`;
      if (added.length > 0) await this.event(tx, row.user_id, changeId, row.entry_id, 'approved', approverId, {});
      const [count] = await tx<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pay.allowlist_decisions WHERE change_id = ${changeId} AND decision = 'approve'`;
      if (count!.n < row.required_approvals) return;
      await this.lockUser(tx, row.user_id);
      const failure = await this.apply(tx, row);
      const now = this.now();
      await tx`
        UPDATE pay.allowlist_changes
           SET status = ${failure ? 'failed' : 'approved'}, failure_code = ${failure}, decided_at = ${now}, updated_at = ${now}
         WHERE id = ${changeId}`;
      await this.event(
        tx,
        row.user_id,
        changeId,
        row.entry_id,
        failure ? 'failed' : 'applied',
        approverId,
        failure ? { code: failure } : {},
      );
    });
    return this.view(approverId, (await this.byId(this.deps.sql, changeId))!);
  }

  /** Any eligible approver may refuse, and one refusal ends the change. */
  async reject(approverId: string, changeId: string, requestHash: string): Promise<ChangeView> {
    const change = await this.load(changeId);
    await this.assertMayDecide(approverId, change, requestHash);
    await transaction(this.deps.sql, async (tx) => {
      const row = await this.lock(tx, changeId);
      if (row.status === 'rejected') return;
      if (row.status !== 'waiting') {
        throw new AllowlistError('allowlist.not_waiting', `this change is ${row.status}`, { status: row.status });
      }
      const now = this.now();
      await tx`
        INSERT INTO pay.allowlist_decisions (change_id, approver_id, decision, request_hash, decided_at)
        VALUES (${changeId}, ${approverId}, 'reject', ${requestHash}, ${now}) ON CONFLICT DO NOTHING`;
      await tx`UPDATE pay.allowlist_changes SET status = 'rejected', decided_at = ${now}, updated_at = ${now} WHERE id = ${changeId}`;
      await this.event(tx, row.user_id, changeId, row.entry_id, 'rejected', approverId, {});
    });
    return this.view(approverId, (await this.byId(this.deps.sql, changeId))!);
  }

  /** The requester withdraws their own change while it waits. */
  async cancel(userId: string, changeId: string): Promise<ChangeView> {
    const change = await this.load(changeId);
    if (change.user_id !== userId) throw notFound();
    await transaction(this.deps.sql, async (tx) => {
      const row = await this.lock(tx, changeId);
      if (row.status === 'cancelled') return;
      if (row.status !== 'waiting') {
        throw new AllowlistError('allowlist.not_waiting', `this change is ${row.status}`, { status: row.status });
      }
      const now = this.now();
      await tx`UPDATE pay.allowlist_changes SET status = 'cancelled', decided_at = ${now}, updated_at = ${now} WHERE id = ${changeId}`;
      await this.event(tx, userId, changeId, row.entry_id, 'cancelled', userId, {});
    });
    return this.view(userId, (await this.byId(this.deps.sql, changeId))!);
  }

  // ── operator ──────────────────────────────────────────────────────────────

  /** An operator suspends an entry: it refuses like an unlisted address until resumed. */
  async suspend(actor: string, entryId: string, reason: string): Promise<EntryView> {
    return this.setEntryState(actor, entryId, 'suspended', reason);
  }

  async resume(actor: string, entryId: string): Promise<EntryView> {
    return this.setEntryState(actor, entryId, 'active', null);
  }

  // ── reads ─────────────────────────────────────────────────────────────────

  async get(viewerId: string, changeId: string): Promise<ChangeView> {
    const change = await this.byId(this.deps.sql, changeId);
    if (!change) throw notFound();
    if (change.user_id !== viewerId) {
      const answer = await this.deps.eligibility?.check({ accountId: change.team_account_id, userId: viewerId });
      if (answer?.state !== 'eligible') throw notFound();
    }
    return this.view(viewerId, change);
  }

  async listEntries(userId: string, input: ListInput, includeRemoved = false): Promise<EntryView[]> {
    const limit = this.limit(input.limit);
    const rows = await this.deps.sql<EntryRow[]>`
      SELECT ${this.deps.sql.unsafe(ENTRY_COLUMNS)} FROM pay.allowlist_entries
       WHERE user_id = ${userId} AND (${includeRemoved} OR state <> 'removed')
         AND (${input.after ?? null}::uuid IS NULL
              OR (created_at, id) < (SELECT created_at, id FROM pay.allowlist_entries WHERE id = ${input.after ?? null}::uuid AND user_id = ${userId}))
       ORDER BY created_at DESC, id DESC LIMIT ${limit}`;
    return rows.map(entryView);
  }

  async listChanges(userId: string, input: ListInput): Promise<ChangeView[]> {
    const limit = this.limit(input.limit);
    const rows = await this.deps.sql<ChangeRow[]>`
      SELECT ${this.deps.sql.unsafe(CHANGE_COLUMNS)} FROM pay.allowlist_changes
       WHERE user_id = ${userId}
         AND (${input.after ?? null}::uuid IS NULL
              OR (created_at, id) < (SELECT created_at, id FROM pay.allowlist_changes WHERE id = ${input.after ?? null}::uuid AND user_id = ${userId}))
       ORDER BY created_at DESC, id DESC LIMIT ${limit}`;
    return Promise.all(rows.map((r) => this.view(userId, r)));
  }

  /** Changes waiting on a team, for an eligible approver of that team. Their own requests are not listed. */
  async listForTeam(viewerId: string, input: ListForTeamInput): Promise<ChangeView[]> {
    const limit = this.limit(input.limit);
    await this.assertEligible(viewerId, input.teamAccountId);
    const rows = await this.deps.sql<ChangeRow[]>`
      SELECT ${this.deps.sql.unsafe(CHANGE_COLUMNS)} FROM pay.allowlist_changes
       WHERE team_account_id = ${input.teamAccountId} AND user_id <> ${viewerId}
         AND (${input.status ?? null}::text IS NULL OR status = ${input.status ?? null})
         AND (${input.after ?? null}::uuid IS NULL
              OR (created_at, id) < (SELECT created_at, id FROM pay.allowlist_changes WHERE id = ${input.after ?? null}::uuid AND team_account_id = ${input.teamAccountId}))
       ORDER BY created_at DESC, id DESC LIMIT ${limit}`;
    return Promise.all(rows.map((r) => this.view(viewerId, r)));
  }

  /**
   * The direct withdrawal door asks this first, so the caller gets the typed refusal before a claim. The guard in the claim
   * asks the same question under the lock; this one is the friendly error and the guard is what holds under a race.
   */
  async assertDirectAllowed(input: {
    userId: string;
    assetId: string;
    amount: Amount;
    clientRef: string;
    destination?: { kind: string; ref: string };
  }): Promise<void> {
    if (!input.destination) return;
    const [existing] = await this.deps.sql<Array<{ status: string }>>`
      SELECT status FROM pay.withdrawals WHERE user_id = ${input.userId} AND client_ref = ${input.clientRef}`;
    if (existing && existing.status !== 'failed') return; // already admitted: a resume, not a fresh ask
    const decision = await decideDestination(this.deps.sql, input.userId, input.assetId, input.amount, input.destination);
    if (!decision.allowed) {
      throw new AllowlistError('pay.destination_not_allowlisted', 'allowlist-only mode is on and this address is not on the list');
    }
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private async submit(
    userId: string,
    clientRef: string,
    op: ChangeOp,
    entryId: string | null,
    subject: Record<string, unknown>,
  ): Promise<ChangeView> {
    const hash = requestHashOf(userId, op, entryId, subject);
    const existing = await this.byRef(this.deps.sql, userId, clientRef);
    if (existing) {
      if (existing.request_hash !== hash) {
        throw new AllowlistError('allowlist.conflict', `client reference "${clientRef}" already names a different change`, {
          changeId: existing.id,
        });
      }
      return this.view(userId, existing);
    }
    const quorum = await this.latestQuorum(this.deps.sql, userId);
    if (!quorum) throw new AllowlistError('allowlist.quorum_unset', 'no approver quorum is set for this account');
    const inserted = await transaction(this.deps.sql, async (tx) => {
      await this.lockUser(tx, userId);
      await this.assertApplicable(tx, userId, op, entryId, subject);
      const now = this.now();
      const rows = await tx<ChangeRow[]>`
        INSERT INTO pay.allowlist_changes
          (user_id, client_ref, op, entry_id, payload, request_hash, team_account_id, required_approvals, created_at, updated_at)
        VALUES (${userId}, ${clientRef}, ${op}, ${entryId}, ${tx.json(subject as never)}, ${hash}, ${quorum.team_account_id},
                ${quorum.required_approvals}, ${now}, ${now})
        ON CONFLICT (user_id, client_ref) DO NOTHING
        RETURNING ${tx.unsafe(CHANGE_COLUMNS)}`;
      if (rows[0]) await this.event(tx, userId, rows[0].id, entryId, 'proposed', userId, { op });
      return rows[0] ?? null;
    });
    const row = inserted ?? (await this.byRef(this.deps.sql, userId, clientRef));
    if (!row) throw new AllowlistError('allowlist.not_found', 'the change could not be read back');
    if (row.request_hash !== hash) {
      throw new AllowlistError('allowlist.conflict', `client reference "${clientRef}" already names a different change`, {
        changeId: row.id,
      });
    }
    return this.view(userId, row);
  }

  /** Refuse at submit what could never apply, so a change is not left waiting for nothing. Reads under the user lock. */
  private async assertApplicable(
    tx: Sql,
    userId: string,
    op: ChangeOp,
    entryId: string | null,
    subject: Record<string, unknown>,
  ): Promise<void> {
    if (op === 'add') {
      const norm = normalizeAddress(String(subject.address))!;
      const [taken] = await tx<Array<{ id: string }>>`
        SELECT id FROM pay.allowlist_entries
         WHERE user_id = ${userId} AND asset_id = ${String(subject.assetId)} AND address_norm = ${norm} AND state <> 'removed'`;
      if (taken) throw new AllowlistError('allowlist.address_listed', 'that address is already on the list for this asset');
      const [label] = await tx<Array<{ id: string }>>`
        SELECT id FROM pay.allowlist_entries WHERE user_id = ${userId} AND lower(label) = lower(${String(subject.label)}) AND state <> 'removed'`;
      if (label) throw new AllowlistError('allowlist.label_taken', 'another entry already has that label');
    } else if (op === 'delete') {
      const [entry] = await tx<Array<{ state: string }>>`
        SELECT state FROM pay.allowlist_entries WHERE id = ${entryId} AND user_id = ${userId}`;
      if (!entry || entry.state === 'removed') throw new AllowlistError('allowlist.entry_not_found', 'no such list entry');
    }
  }

  /** Apply an approved change inside the transaction that counted its last approval. Returns a failure code, or null. */
  private async apply(tx: Sql, row: ChangeRow): Promise<string | null> {
    const now = this.now();
    if (row.op === 'add') {
      const s = row.payload as { group: string; assetId: string; address: string; label: string };
      const norm = normalizeAddress(s.address)!;
      const [taken] = await tx<Array<{ id: string }>>`
        SELECT id FROM pay.allowlist_entries WHERE user_id = ${row.user_id} AND asset_id = ${s.assetId} AND address_norm = ${norm} AND state <> 'removed'`;
      if (taken) return 'allowlist.address_listed';
      const [label] = await tx<Array<{ id: string }>>`
        SELECT id FROM pay.allowlist_entries WHERE user_id = ${row.user_id} AND lower(label) = lower(${s.label}) AND state <> 'removed'`;
      if (label) return 'allowlist.label_taken';
      const [entry] = await tx<Array<{ id: string }>>`
        INSERT INTO pay.allowlist_entries (user_id, group_kind, asset_id, address, address_norm, label, created_by, change_id, created_at, updated_at)
        VALUES (${row.user_id}, ${s.group}, ${s.assetId}, ${s.address}, ${norm}, ${s.label}, ${row.user_id}, ${row.id}, ${now}, ${now})
        RETURNING id`;
      await tx`UPDATE pay.allowlist_changes SET entry_id = ${entry!.id} WHERE id = ${row.id}`;
      return null;
    }
    if (row.op === 'delete') {
      const moved = await tx`
        UPDATE pay.allowlist_entries SET state = 'removed', removed_at = ${now}, updated_at = ${now}
         WHERE id = ${row.entry_id} AND user_id = ${row.user_id} AND state <> 'removed' RETURNING id`;
      return moved.length > 0 ? null : 'allowlist.entry_not_found';
    }
    if (row.op === 'mode_off') {
      await tx`INSERT INTO pay.allowlist_mode_events (user_id, enabled, set_by, change_id) VALUES (${row.user_id}, false, ${row.user_id}, ${row.id})`;
      return null;
    }
    const p = row.payload as { enabled: boolean; assetId: string; maxAmount: string };
    await tx`
      INSERT INTO pay.allowlist_onetime_policy_events (user_id, enabled, asset_id, max_amount, set_by, change_id)
      VALUES (${row.user_id}, ${p.enabled}, ${p.assetId}, ${p.maxAmount}::numeric, ${row.user_id}, ${row.id})`;
    return null;
  }

  private async setEntryState(actor: string, entryId: string, to: 'active' | 'suspended', reason: string | null): Promise<EntryView> {
    return transaction(this.deps.sql, async (tx) => {
      const [entry] = await tx<EntryRow[]>`SELECT ${tx.unsafe(ENTRY_COLUMNS)} FROM pay.allowlist_entries WHERE id = ${entryId}`;
      if (!entry) throw new AllowlistError('allowlist.entry_not_found', 'no such list entry');
      await this.lockUser(tx, entry.user_id);
      const [row] = await tx<EntryRow[]>`
        UPDATE pay.allowlist_entries
           SET state = ${to}, suspended_reason = ${reason}, updated_at = ${this.now()}
         WHERE id = ${entryId} AND state <> 'removed' RETURNING ${tx.unsafe(ENTRY_COLUMNS)}`;
      if (!row) throw new AllowlistError('allowlist.entry_not_removable', 'a removed entry cannot change state');
      if (entry.state !== to)
        await this.event(tx, entry.user_id, null, entryId, to === 'suspended' ? 'suspended' : 'resumed', actor, { reason });
      return entryView(row);
    });
  }

  private async assertMayDecide(approverId: string, change: ChangeRow, requestHash: string): Promise<void> {
    if (approverId === change.user_id) {
      throw new AllowlistError('allowlist.requester_cannot_approve', 'the person who asked for a change cannot decide it');
    }
    if (requestHash !== change.request_hash) {
      throw new AllowlistError('allowlist.hash_mismatch', 'the change is not the one that was read; read it again');
    }
    await this.assertEligible(approverId, change.team_account_id);
  }

  private async assertEligible(userId: string, teamAccountId: string): Promise<void> {
    if (!this.deps.eligibility) {
      throw new AllowlistError('allowlist.eligibility_unwired', 'approver eligibility is not connected to the bank service');
    }
    const answer = await this.deps.eligibility.check({ accountId: teamAccountId, userId });
    if (answer.state === 'unavailable') {
      throw new AllowlistError('allowlist.eligibility_unavailable', 'the team could not be checked; nothing was counted');
    }
    if (answer.state !== 'eligible') {
      throw new AllowlistError('allowlist.approver_not_eligible', 'this person may not approve for the team', { state: answer.state });
    }
  }

  private limit(limit: number | undefined): number {
    if (limit === undefined) throw new AllowlistError('allowlist.list_limit_unset', 'pass a page size; there is no default');
    return limit;
  }

  private async latestQuorum(q: Sql, userId: string) {
    const [row] = await q<Array<{ team_account_id: string; required_approvals: number; set_by: string; set_at: Date }>>`
      SELECT team_account_id, required_approvals, set_by, set_at
        FROM pay.allowlist_quorum_events WHERE user_id = ${userId} ORDER BY seq DESC LIMIT 1`;
    return row ?? null;
  }

  private async lockUser(tx: Sql, userId: string): Promise<void> {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${allowlistLockKey(userId)}))`;
  }

  private async load(changeId: string): Promise<ChangeRow> {
    const row = await this.byId(this.deps.sql, changeId);
    if (!row) throw notFound();
    return row;
  }

  private async byId(q: Sql, id: string): Promise<ChangeRow | null> {
    const [row] = await q<ChangeRow[]>`SELECT ${q.unsafe(CHANGE_COLUMNS)} FROM pay.allowlist_changes WHERE id = ${id}`;
    return row ?? null;
  }

  private async byRef(q: Sql, userId: string, clientRef: string): Promise<ChangeRow | null> {
    const [row] = await q<ChangeRow[]>`
      SELECT ${q.unsafe(CHANGE_COLUMNS)} FROM pay.allowlist_changes WHERE user_id = ${userId} AND client_ref = ${clientRef}`;
    return row ?? null;
  }

  private async lock(tx: Sql, id: string): Promise<ChangeRow> {
    const [row] = await tx<ChangeRow[]>`SELECT ${tx.unsafe(CHANGE_COLUMNS)} FROM pay.allowlist_changes WHERE id = ${id} FOR UPDATE`;
    if (!row) throw notFound();
    return row;
  }

  private async event(
    q: Sql,
    userId: string,
    changeId: string | null,
    entryId: string | null,
    kind: string,
    actor: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    await q`
      INSERT INTO pay.allowlist_events (user_id, change_id, entry_id, kind, actor_id, detail)
      VALUES (${userId}, ${changeId}, ${entryId}, ${kind}, ${actor}, ${q.json(detail as never)})`;
  }

  private async view(viewerId: string, r: ChangeRow): Promise<ChangeView> {
    const [counts] = await this.deps.sql<Array<{ n: number; mine: boolean }>>`
      SELECT count(*) FILTER (WHERE decision = 'approve')::int AS n,
             COALESCE(bool_or(approver_id = ${viewerId} AND decision = 'approve'), false) AS mine
        FROM pay.allowlist_decisions WHERE change_id = ${r.id}`;
    return {
      id: r.id,
      userId: r.user_id,
      op: r.op,
      entryId: r.entry_id,
      subject: r.payload,
      requestHash: r.request_hash,
      teamAccountId: r.team_account_id,
      requiredApprovals: r.required_approvals,
      approvalCount: counts?.n ?? 0,
      approvedByMe: counts?.mine ?? false,
      status: r.status,
      failureCode: r.failure_code,
      createdAt: r.created_at.toISOString(),
      decidedAt: r.decided_at ? r.decided_at.toISOString() : null,
    };
  }
}

const notFound = () => new AllowlistError('allowlist.not_found', 'no such change');

function entryView(r: EntryRow): EntryView {
  return {
    id: r.id,
    userId: r.user_id,
    group: r.group_kind,
    assetId: r.asset_id,
    address: r.address,
    label: r.label,
    state: r.state,
    createdBy: r.created_by,
    suspendedReason: r.suspended_reason,
    createdAt: r.created_at.toISOString(),
    lastUsedAt: r.last_used_at ? r.last_used_at.toISOString() : null,
  };
}

function quorumView(userId: string, r: { team_account_id: string; required_approvals: number; set_by: string; set_at: Date }): QuorumView {
  return {
    userId,
    teamAccountId: r.team_account_id,
    requiredApprovals: r.required_approvals,
    setBy: r.set_by,
    setAt: r.set_at.toISOString(),
  };
}

function policyView(userId: string, r: OneTimeRow | null): PolicyView {
  if (!r) return { userId, enabled: false, assetId: null, maxAmount: null, setAt: null };
  return {
    userId,
    enabled: r.enabled,
    assetId: r.asset_id,
    maxAmount: formatAmount(parseAmount(r.max_amount)),
    setAt: r.set_at.toISOString(),
  };
}
