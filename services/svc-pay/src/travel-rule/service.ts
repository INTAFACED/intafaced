import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { MessageCipher } from './cipher.js';
import { TravelRuleError } from './errors.js';
import type {
  AssessInput,
  AssessmentView,
  CustomerStatus,
  DisplayStatus,
  Entity,
  ListInput,
  MarkInput,
  MessageInput,
  MessageResult,
  OpenInput,
  RuleView,
  SetRuleInput,
  SetWaitLimitsInput,
  TransferDetail,
  TransferStatus,
  TransferView,
  TravelRuleField,
  WaitLimitsView,
} from './schemas.js';

/**
 * The outbound travel rule (W-compliance-notices-04). One transfer record per withdrawal, whose status is its latest
 * transition (ENGINE T-1). Nothing here moves money.
 *
 * The owner decides everything that is a figure or a list: which (region, entity, asset) the rule applies to, the
 * amount threshold, the fields to collect, and how long a pending or repair wait may last. With no rule for a key the
 * assessment refuses `wallet.travel_rule_undecided`; with no wait limit a required transfer cannot be opened; with no
 * key the message path refuses `travel_rule.cipher_unwired`. A rule that says "not required" is the only way a transfer
 * is `not_required` (shown as "Bypassed"): it is decided when the transfer is opened, from the rule and its version,
 * and no operator can move a transfer there afterwards.
 *
 * A transfer reaches `accepted` or `completed` only from a counterparty reply or the system. A wait that runs out
 * becomes `blocking_time_expired`, which still blocks: a timer never approves. The counterparty network is not
 * connected (`vendor.travelrule`): a send with no provider records `provider_unavailable` and refuses.
 *
 * The rail send must call `assertMayBroadcast` before it signs; wiring that into the withdrawal door is W-withdraw-16.
 */
export interface ProviderReply {
  readonly status: 'accepted' | 'pending' | 'rejected' | 'review' | 'repair';
  readonly reason?: string;
}

/** The counterparty network. None is connected here, so a send answers `vendor.travelrule`. */
export interface TravelRuleProvider {
  send(input: { transferId: string; message: Record<string, unknown> }): Promise<ProviderReply>;
}

export interface TravelRuleServiceDeps {
  readonly sql: Sql;
  readonly cipher?: MessageCipher | null;
  readonly provider?: TravelRuleProvider | null;
  /** Injected for tests; production uses the wall clock. */
  readonly now?: () => Date;
}

const LEGAL: Record<TransferStatus, readonly TransferStatus[]> = {
  started: ['pending', 'review', 'repair', 'accepted', 'rejected', 'provider_unavailable', 'canceled', 'failed'],
  repair: ['started', 'pending', 'rejected', 'blocking_time_expired', 'canceled', 'failed'],
  provider_unavailable: ['started', 'canceled', 'failed'],
  pending: ['accepted', 'rejected', 'review', 'repair', 'blocking_time_expired', 'canceled', 'failed'],
  review: ['accepted', 'rejected', 'repair', 'pending', 'blocking_time_expired', 'canceled', 'failed'],
  blocking_time_expired: ['accepted', 'rejected', 'pending', 'review', 'repair', 'canceled', 'failed'],
  accepted: ['completed', 'canceled', 'failed'],
  completed: [],
  rejected: [],
  not_required: [],
  canceled: [],
  failed: [],
};
/** What an operator may do: stop a transfer or ask for more information. Never approve, bypass or complete one. */
const OPERATOR_MAY: readonly TransferStatus[] = ['canceled', 'rejected', 'repair', 'started'];
/** What a counterparty reply may set. */
const COUNTERPARTY_MAY: readonly TransferStatus[] = ['accepted', 'pending', 'rejected', 'review', 'repair'];
const WAITING: readonly TransferStatus[] = ['pending', 'review', 'repair'];
const OK_TO_BROADCAST: readonly TransferStatus[] = ['accepted', 'completed', 'not_required'];

const DISPLAY: Record<TransferStatus, DisplayStatus> = {
  started: 'Pending',
  pending: 'Pending',
  review: 'Pending',
  repair: 'Pending',
  accepted: 'Pending',
  provider_unavailable: 'Pending',
  completed: 'Completed',
  rejected: 'Rejected',
  failed: 'Failed',
  blocking_time_expired: 'Blocking time expired',
  canceled: 'Canceled',
  not_required: 'Bypassed',
};

interface RuleRow {
  seq: string;
  region: string;
  entity: Entity;
  asset_id: string;
  applies: boolean;
  threshold: string | null;
  fields: TravelRuleField[];
  reason: string;
  set_by: string;
  set_at: Date;
}

interface TransferRow {
  id: string;
  withdrawal_id: string;
  user_id: string;
  asset_id: string;
  network_id: string;
  amount: string;
  region: string;
  entity: Entity;
  assessment: 'required' | 'not_required';
  rule_seq: string;
  required_fields: TravelRuleField[];
  opened_at: Date;
  status: TransferStatus;
  wait_deadline: Date | null;
}

const ruleView = (r: RuleRow): RuleView => ({
  version: Number(r.seq),
  region: r.region,
  entity: r.entity,
  assetId: r.asset_id,
  applies: r.applies,
  threshold: r.threshold,
  fields: r.fields,
  reason: r.reason,
  setBy: r.set_by,
  setAt: r.set_at.toISOString(),
});

const SELECT_TRANSFER = `
  SELECT t.id, t.withdrawal_id, t.user_id, t.asset_id, t.network_id, t.amount::text AS amount, t.region, t.entity,
         t.assessment, t.rule_seq::text AS rule_seq, t.required_fields, t.opened_at, l.to_status AS status, l.wait_deadline
    FROM pay.travel_rule_transfers t
    JOIN LATERAL (SELECT to_status, wait_deadline FROM pay.travel_rule_transitions WHERE transfer_id = t.id ORDER BY seq DESC LIMIT 1) l ON true`;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export class TravelRuleService {
  private readonly now: () => Date;
  constructor(private readonly deps: TravelRuleServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  private view(t: TransferRow): TransferView {
    return {
      id: t.id,
      withdrawalId: t.withdrawal_id,
      userId: t.user_id,
      assetId: t.asset_id,
      networkId: t.network_id,
      amount: formatAmount(parseAmount(t.amount)),
      region: t.region,
      entity: t.entity,
      assessment: t.assessment,
      ruleVersion: Number(t.rule_seq),
      requiredFields: t.required_fields,
      status: t.status,
      displayStatus: DISPLAY[t.status],
      waitDeadline: iso(t.wait_deadline),
      blocker: t.status === 'provider_unavailable' ? 'vendor.travelrule' : null,
      openedAt: t.opened_at.toISOString(),
    };
  }

  // ── owner rules ────────────────────────────────────────────────────────────

  async setRule(actor: string, input: SetRuleInput): Promise<RuleView> {
    const [row] = await this.deps.sql<RuleRow[]>`
      INSERT INTO pay.travel_rule_rule_events (region, entity, asset_id, applies, threshold, fields, reason, set_by)
      VALUES (${input.region}, ${input.entity}, ${input.assetId}, ${input.applies}, ${input.threshold ?? null}::numeric,
              ${this.deps.sql.json(input.fields)}, ${input.reason}, ${actor})
      RETURNING seq::text, region, entity, asset_id, applies, threshold::text, fields, reason, set_by, set_at`;
    return ruleView(row!);
  }

  /** The current rule per (region, entity, asset): the latest row for each. */
  async listRules(): Promise<RuleView[]> {
    const rows = await this.deps.sql<RuleRow[]>`
      SELECT DISTINCT ON (region, entity, asset_id) seq::text, region, entity, asset_id, applies, threshold::text, fields, reason, set_by, set_at
        FROM pay.travel_rule_rule_events ORDER BY region, entity, asset_id, seq DESC`;
    return rows.map(ruleView);
  }

  async waitLimits(): Promise<WaitLimitsView> {
    const [row] = await this.deps.sql<Array<{ pending_seconds: number; repair_seconds: number; set_by: string; set_at: Date }>>`
      SELECT pending_seconds, repair_seconds, set_by, set_at FROM pay.travel_rule_wait_limit_events ORDER BY seq DESC LIMIT 1`;
    return row
      ? { pendingSeconds: row.pending_seconds, repairSeconds: row.repair_seconds, setBy: row.set_by, setAt: row.set_at.toISOString() }
      : { pendingSeconds: null, repairSeconds: null, setBy: null, setAt: null };
  }

  async setWaitLimits(actor: string, input: SetWaitLimitsInput): Promise<WaitLimitsView> {
    await this.deps.sql`
      INSERT INTO pay.travel_rule_wait_limit_events (pending_seconds, repair_seconds, set_by)
      VALUES (${input.pendingSeconds}, ${input.repairSeconds}, ${actor})`;
    return this.waitLimits();
  }

  // ── assessment ─────────────────────────────────────────────────────────────

  private async ruleFor(q: Sql, region: string, entity: Entity, assetId: string): Promise<RuleRow> {
    const rows = await q<RuleRow[]>`
      SELECT DISTINCT ON (region) seq::text, region, entity, asset_id, applies, threshold::text, fields, reason, set_by, set_at
        FROM pay.travel_rule_rule_events
       WHERE entity = ${entity} AND asset_id = ${assetId} AND region IN (${region}, '*')
       ORDER BY region, seq DESC`;
    // The exact region wins over the fallback.
    const rule = rows.find((r) => r.region === region) ?? rows.find((r) => r.region === '*');
    if (!rule) {
      throw new TravelRuleError(
        'wallet.travel_rule_undecided',
        `the owner has not decided the travel rule for ${entity} in ${region} on ${assetId}`,
      );
    }
    return rule;
  }

  private evaluate(rule: RuleRow, amount: string, collected: readonly TravelRuleField[]): AssessmentView {
    const version = Number(rule.seq);
    if (!rule.applies || rule.threshold === null || parseAmount(amount) < parseAmount(rule.threshold)) {
      return { result: 'not_required', ruleVersion: version, fields: [], missing: [] };
    }
    const missing = rule.fields.filter((f) => !collected.includes(f));
    return { result: missing.length > 0 ? 'need_more_info' : 'required', ruleVersion: version, fields: rule.fields, missing };
  }

  async assess(input: AssessInput): Promise<AssessmentView> {
    const rule = await this.ruleFor(this.deps.sql, input.region, input.entity, input.assetId);
    return this.evaluate(rule, input.amount, input.collected ?? []);
  }

  // ── transfers ──────────────────────────────────────────────────────────────

  private async loadTransfer(q: Sql, where: 'id' | 'withdrawal', value: string, lock = false): Promise<TransferRow | undefined> {
    const col = where === 'id' ? 't.id' : 't.withdrawal_id';
    // Lock in its own statement: under READ COMMITTED the next statement then reads the latest transition afresh. Locking
    // inside the joined select would re-check only the transfer row and could return a stale status.
    if (lock) await q`SELECT id FROM pay.travel_rule_transfers WHERE id = ${value}::uuid FOR UPDATE`;
    const [row] = await q.unsafe<TransferRow[]>(`${SELECT_TRANSFER} WHERE ${col} = $1::uuid`, [value]);
    return row;
  }

  /** Open the record for one withdrawal. Idempotent on the withdrawal; the same withdrawal with other terms conflicts. */
  async open(actor: string, input: OpenInput): Promise<TransferView> {
    const existing = await this.loadTransfer(this.deps.sql, 'withdrawal', input.withdrawalId);
    if (existing) return this.view(this.sameTerms(existing, input));

    const [w] = await this.deps.sql<Array<{ asset_id: string; amount: string }>>`
      SELECT asset_id, amount::text AS amount FROM pay.withdrawals WHERE id = ${input.withdrawalId}::uuid AND user_id = ${input.userId}`;
    if (!w) throw new TravelRuleError('travel_rule.withdrawal_not_found', 'no such withdrawal for this account');

    const rule = await this.ruleFor(this.deps.sql, input.region, input.entity, w.asset_id);
    const assessed = this.evaluate(rule, w.amount, []);
    const required = assessed.result !== 'not_required';
    if (required) {
      const limits = await this.waitLimits();
      if (limits.pendingSeconds === null || limits.repairSeconds === null) {
        throw new TravelRuleError('travel_rule.wait_limit_unset', 'the owner has not set the travel-rule wait limits');
      }
    }
    const at = this.now();
    await transaction(this.deps.sql, async (tx) => {
      const inserted = await tx<Array<{ id: string }>>`
        INSERT INTO pay.travel_rule_transfers
          (withdrawal_id, user_id, asset_id, network_id, amount, region, entity, assessment, rule_seq, required_fields, opened_by, opened_at)
        VALUES (${input.withdrawalId}::uuid, ${input.userId}, ${w.asset_id}, ${input.networkId}, ${w.amount}::numeric, ${input.region},
                ${input.entity}, ${required ? 'required' : 'not_required'}, ${rule.seq}::bigint, ${tx.json(assessed.fields)}, ${actor}, ${at})
        ON CONFLICT (withdrawal_id) DO NOTHING
        RETURNING id`;
      const row = inserted[0];
      if (!row) return;
      await tx`
        INSERT INTO pay.travel_rule_transitions (transfer_id, from_status, to_status, source, actor, reason, at)
        VALUES (${row.id}::uuid, NULL, ${required ? 'started' : 'not_required'}, 'system', ${actor},
                ${required ? 'opened under the owner rule' : 'the owner rule does not require it'}, ${at})`;
    });
    const row = await this.loadTransfer(this.deps.sql, 'withdrawal', input.withdrawalId);
    return this.view(this.sameTerms(row!, input));
  }

  private sameTerms(t: TransferRow, input: OpenInput): TransferRow {
    if (t.user_id !== input.userId || t.network_id !== input.networkId || t.region !== input.region || t.entity !== input.entity) {
      throw new TravelRuleError('travel_rule.transfer_differs', 'a travel-rule record for this withdrawal exists with other terms');
    }
    return t;
  }

  /**
   * Move one transfer, inside a transaction that holds its row lock. Repeating the move that already stands returns the
   * stored record. A wait deadline is set when the transfer enters a waiting status.
   */
  private async move(
    tx: Sql,
    t: TransferRow,
    to: TransferStatus,
    source: 'system' | 'counterparty' | 'operator',
    actor: string,
    reason: string | null,
  ): Promise<TransferRow> {
    if (t.status === to) return t;
    if (!LEGAL[t.status].includes(to)) {
      throw new TravelRuleError('travel_rule.transition_refused', `a ${t.status} transfer cannot become ${to}`);
    }
    const at = this.now();
    let deadline: Date | null = null;
    if (WAITING.includes(to)) {
      const limits = await this.waitLimits();
      const seconds = to === 'repair' ? limits.repairSeconds : limits.pendingSeconds;
      if (seconds === null) throw new TravelRuleError('travel_rule.wait_limit_unset', 'the owner has not set the travel-rule wait limits');
      deadline = new Date(at.getTime() + seconds * 1000);
    }
    await tx`
      INSERT INTO pay.travel_rule_transitions (transfer_id, from_status, to_status, source, actor, reason, wait_deadline, at)
      VALUES (${t.id}::uuid, ${t.status}, ${to}, ${source}, ${actor}, ${reason}, ${deadline}, ${at})`;
    return { ...t, status: to, wait_deadline: deadline };
  }

  private async locked<T>(transferId: string, fn: (tx: Sql, t: TransferRow) => Promise<T>): Promise<T> {
    return transaction(
      this.deps.sql,
      async (tx) => {
        const t = await this.loadTransfer(tx, 'id', transferId, true);
        if (!t) throw new TravelRuleError('travel_rule.transfer_not_found', `no travel-rule record ${transferId}`);
        return fn(tx, t);
      },
      { isolation: 'read committed' },
    );
  }

  /** The counterparty's answer, or the adapter's. Only these can accept. */
  async recordReply(
    transferId: string,
    reply: { status: ProviderReply['status']; reason?: string },
    actor = 'counterparty',
  ): Promise<TransferView> {
    if (!COUNTERPARTY_MAY.includes(reply.status)) {
      throw new TravelRuleError('travel_rule.transition_refused', `a counterparty cannot answer ${reply.status}`);
    }
    return this.locked(transferId, async (tx, t) =>
      this.view(await this.move(tx, t, reply.status, 'counterparty', actor, reply.reason ?? null)),
    );
  }

  /** The system marks an accepted transfer completed once the on-chain send has finished. */
  async complete(transferId: string, actor: string): Promise<TransferView> {
    return this.locked(transferId, async (tx, t) =>
      this.view(await this.move(tx, t, 'completed', 'system', actor, 'the on-chain send finished')),
    );
  }

  /** An operator can stop a transfer or ask for more information. Approving, bypassing or completing one is refused. */
  async operatorMark(actor: string, input: MarkInput): Promise<TransferView> {
    if (!OPERATOR_MAY.includes(input.to)) {
      throw new TravelRuleError(
        'travel_rule.operator_cannot_bypass',
        `an operator cannot set a transfer to ${input.to}; only the counterparty or the owner rule can`,
      );
    }
    return this.locked(input.transferId, async (tx, t) => this.view(await this.move(tx, t, input.to, 'operator', actor, input.reason)));
  }

  /** Record `blocking_time_expired` for every waiting transfer whose deadline has passed. It never approves anything. */
  async expireDue(actor: string): Promise<string[]> {
    const at = this.now();
    const due = await this.deps.sql<Array<{ transfer_id: string }>>`
      SELECT transfer_id FROM (
        SELECT DISTINCT ON (transfer_id) transfer_id, to_status, wait_deadline
          FROM pay.travel_rule_transitions ORDER BY transfer_id, seq DESC
      ) l WHERE l.to_status = ANY(${[...WAITING]}) AND l.wait_deadline IS NOT NULL AND l.wait_deadline <= ${at}`;
    const expired: string[] = [];
    for (const { transfer_id } of due) {
      await this.locked(transfer_id, async (tx, t) => {
        // A reply may have landed since the scan: act only on a transfer that is still waiting past its deadline.
        if (!WAITING.includes(t.status) || t.wait_deadline === null || t.wait_deadline > at) return;
        await this.move(tx, t, 'blocking_time_expired', 'system', actor, 'the wait limit passed');
        expired.push(transfer_id);
      });
    }
    return expired;
  }

  // ── message ────────────────────────────────────────────────────────────────

  private presentFields(m: MessageInput, destinationRef: string | null): Set<TravelRuleField> {
    const have = new Set<TravelRuleField>();
    const add = (f: TravelRuleField, v: string | undefined | null) => {
      if (v !== undefined && v !== null && v.trim() !== '') have.add(f);
    };
    add('originator_name', m.originator.name);
    add('originator_address', m.originator.address);
    add('originator_date_of_birth', m.originator.dateOfBirth);
    add('originator_national_identifier', m.originator.nationalIdentifier);
    add('beneficiary_name', m.beneficiary.name);
    add('beneficiary_address', m.beneficiary.address);
    add('beneficiary_account', m.beneficiary.account ?? destinationRef);
    add('beneficiary_institution', m.beneficiary.institution);
    add('beneficiary_wallet_type', m.beneficiary.walletType);
    add('transfer_purpose', m.transfer.purpose);
    add('self_or_third_party', m.transfer.selfOrThirdParty);
    return have;
  }

  /**
   * Store an encrypted IVMS101-shaped message for a transfer, as a new version. Fields the rule requires and the message
   * lacks put the transfer in `repair`; a complete message takes it out of `repair`. The amount, asset, network and
   * address are taken from the stored transfer and withdrawal, not from the client.
   */
  async attachMessage(actor: string, input: MessageInput): Promise<MessageResult> {
    const cipher = this.deps.cipher;
    if (!cipher) throw new TravelRuleError('travel_rule.cipher_unwired', 'no message key is loaded, so nothing is stored');
    return this.locked(input.transferId, async (tx, t) => {
      if (t.assessment === 'not_required') {
        throw new TravelRuleError('travel_rule.transition_refused', 'the owner rule does not require a message for this transfer');
      }
      if (!['started', 'repair', 'provider_unavailable'].includes(t.status)) {
        throw new TravelRuleError('travel_rule.transition_refused', `a ${t.status} transfer takes no new message`);
      }
      const [w] = await tx<Array<{ destination: { kind?: string; ref?: string } }>>`
        SELECT destination FROM pay.withdrawals WHERE id = ${t.withdrawal_id}::uuid`;
      const destinationRef = w?.destination?.ref ?? null;
      const have = this.presentFields(input, destinationRef);
      const missing = t.required_fields.filter((f) => !have.has(f));
      const body = {
        originator: input.originator,
        beneficiary: { ...input.beneficiary, account: input.beneficiary.account ?? destinationRef ?? undefined },
        transfer: input.transfer,
        transaction: {
          transferId: t.id,
          amount: formatAmount(parseAmount(t.amount)),
          assetId: t.asset_id,
          networkId: t.network_id,
          address: destinationRef,
        },
      };
      const sealed = cipher.seal(Buffer.from(JSON.stringify(body), 'utf8'), t.id);
      await tx`
        INSERT INTO pay.travel_rule_messages (transfer_id, key_id, iv, auth_tag, ciphertext, missing_fields, created_by)
        VALUES (${t.id}::uuid, ${sealed.keyId}, ${sealed.iv}, ${sealed.authTag}, ${sealed.ciphertext}, ${tx.json(missing)}, ${actor})`;
      const [msg] = await tx<
        Array<{ n: string }>
      >`SELECT count(*)::text AS n FROM pay.travel_rule_messages WHERE transfer_id = ${t.id}::uuid`;
      let status = t.status;
      if (missing.length > 0 && t.status !== 'repair') {
        status = (await this.move(tx, t, 'repair', 'system', actor, `missing: ${missing.join(', ')}`)).status;
      } else if (missing.length === 0 && t.status === 'repair') {
        status = (await this.move(tx, t, 'started', 'system', actor, 'the message is complete')).status;
      }
      return { transferId: t.id, messageVersion: Number(msg?.n ?? 0), missing, status };
    });
  }

  /** The newest message, decrypted. For the counterparty adapter only: no router returns it. */
  async readMessage(transferId: string): Promise<Record<string, unknown>> {
    const cipher = this.deps.cipher;
    if (!cipher) throw new TravelRuleError('travel_rule.cipher_unwired', 'no message key is loaded');
    const [row] = await this.deps.sql<Array<{ key_id: string; iv: Buffer; auth_tag: Buffer; ciphertext: Buffer }>>`
      SELECT key_id, iv, auth_tag, ciphertext FROM pay.travel_rule_messages WHERE transfer_id = ${transferId}::uuid ORDER BY seq DESC LIMIT 1`;
    if (!row) throw new TravelRuleError('travel_rule.message_missing', 'no message is stored for this transfer');
    const plain = cipher.open({ keyId: row.key_id, iv: row.iv, authTag: row.auth_tag, ciphertext: row.ciphertext }, transferId);
    return JSON.parse(plain.toString('utf8')) as Record<string, unknown>;
  }

  // ── send ───────────────────────────────────────────────────────────────────

  /**
   * Send the newest complete message to the counterparty. With no provider connected the transfer becomes
   * `provider_unavailable` and the call refuses `vendor.travelrule`; nothing is approved.
   */
  async submit(actor: string, transferId: string): Promise<TransferView> {
    const state = await this.locked(transferId, async (tx, t) => {
      if (['pending', 'review', 'accepted', 'completed'].includes(t.status)) return { done: this.view(t) as TransferView | null, t };
      if (t.status === 'repair') {
        const [r] = await tx<Array<{ missing_fields: TravelRuleField[] }>>`
          SELECT missing_fields FROM pay.travel_rule_messages WHERE transfer_id = ${t.id}::uuid ORDER BY seq DESC LIMIT 1`;
        throw new TravelRuleError('travel_rule.fields_missing', `still missing: ${(r?.missing_fields ?? t.required_fields).join(', ')}`);
      }
      if (!['started', 'provider_unavailable'].includes(t.status)) {
        throw new TravelRuleError('travel_rule.transition_refused', `a ${t.status} transfer cannot be sent`);
      }
      const [m] = await tx<Array<{ missing_fields: TravelRuleField[] }>>`
        SELECT missing_fields FROM pay.travel_rule_messages WHERE transfer_id = ${t.id}::uuid ORDER BY seq DESC LIMIT 1`;
      if (!m) throw new TravelRuleError('travel_rule.message_missing', 'add the message before sending');
      if (m.missing_fields.length > 0) {
        throw new TravelRuleError('travel_rule.fields_missing', `still missing: ${m.missing_fields.join(', ')}`);
      }
      if (!this.deps.provider) {
        if (t.status !== 'provider_unavailable')
          await this.move(tx, t, 'provider_unavailable', 'system', actor, 'vendor.travelrule is not connected');
      } else if (t.status === 'provider_unavailable') {
        await this.move(tx, t, 'started', 'system', actor, 'a provider is connected again');
      }
      return { done: null, t };
    });
    if (state.done) return state.done;
    const provider = this.deps.provider;
    if (!provider)
      throw new TravelRuleError(
        'vendor.travelrule',
        'Sending a travel-rule message needs vendor.travelrule. It is switched off in this build.',
      );
    // The counterparty call runs outside any lock; a retry after a crash here sends the same transfer id again.
    const reply = await provider.send({ transferId, message: await this.readMessage(transferId) });
    return this.recordReply(transferId, reply, 'counterparty');
  }

  // ── reads ──────────────────────────────────────────────────────────────────

  async get(transferId: string): Promise<TransferDetail> {
    const t = await this.loadTransfer(this.deps.sql, 'id', transferId);
    if (!t) throw new TravelRuleError('travel_rule.transfer_not_found', `no travel-rule record ${transferId}`);
    return this.detail(t);
  }

  async listByWithdrawal(withdrawalId: string): Promise<TransferDetail[]> {
    const t = await this.loadTransfer(this.deps.sql, 'withdrawal', withdrawalId);
    return t ? [await this.detail(t)] : [];
  }

  private async detail(t: TransferRow): Promise<TransferDetail> {
    const transitions = await this.deps.sql<
      Array<{
        from_status: TransferStatus | null;
        to_status: TransferStatus;
        source: 'system' | 'counterparty' | 'operator';
        actor: string;
        reason: string | null;
        wait_deadline: Date | null;
        at: Date;
      }>
    >`SELECT from_status, to_status, source, actor, reason, wait_deadline, at FROM pay.travel_rule_transitions WHERE transfer_id = ${t.id}::uuid ORDER BY seq`;
    const [msg] = await this.deps.sql<Array<{ n: string; missing_fields: TravelRuleField[] | null }>>`
      SELECT (SELECT count(*) FROM pay.travel_rule_messages WHERE transfer_id = ${t.id}::uuid)::text AS n,
             (SELECT missing_fields FROM pay.travel_rule_messages WHERE transfer_id = ${t.id}::uuid ORDER BY seq DESC LIMIT 1) AS missing_fields`;
    return {
      ...this.view(t),
      transitions: transitions.map((r) => ({
        fromStatus: r.from_status,
        toStatus: r.to_status,
        source: r.source,
        actor: r.actor,
        reason: r.reason,
        waitDeadline: iso(r.wait_deadline),
        at: r.at.toISOString(),
      })),
      messageVersions: Number(msg?.n ?? 0),
      missingFields: msg?.missing_fields ?? [],
    };
  }

  async list(input: ListInput): Promise<TransferView[]> {
    const rows = await this.deps.sql.unsafe<TransferRow[]>(
      `${SELECT_TRANSFER}
        WHERE ($1::text IS NULL OR l.to_status = $1::text) AND ($2::uuid IS NULL OR t.withdrawal_id = $2::uuid)
        ORDER BY t.opened_at DESC, t.id DESC LIMIT $3`,
      [input.status ?? null, input.withdrawalId ?? null, input.limit],
    );
    return rows.map((r) => this.view(r));
  }

  /** The customer's own view. Another account's withdrawal reads as not found. */
  async statusForCustomer(userId: string, withdrawalId: string): Promise<CustomerStatus> {
    const t = await this.loadTransfer(this.deps.sql, 'withdrawal', withdrawalId);
    if (!t || t.user_id !== userId)
      throw new TravelRuleError('travel_rule.transfer_not_found', 'no travel-rule record for this withdrawal');
    let fields: TravelRuleField[] = [];
    if (t.status === 'started' || t.status === 'repair') {
      const [m] = await this.deps.sql<Array<{ missing_fields: TravelRuleField[] }>>`
        SELECT missing_fields FROM pay.travel_rule_messages WHERE transfer_id = ${t.id}::uuid ORDER BY seq DESC LIMIT 1`;
      fields = m ? m.missing_fields : t.required_fields;
    }
    return {
      withdrawalId,
      status: t.status,
      displayStatus: DISPLAY[t.status],
      fieldsToCollect: fields,
      waitDeadline: iso(t.wait_deadline),
      blocker: t.status === 'provider_unavailable' ? 'vendor.travelrule' : null,
    };
  }

  /**
   * The gate the rail send makes before it signs: a withdrawal may be broadcast only with a record that is accepted,
   * completed or decided not required by the owner rule. No record, or any other status, refuses.
   */
  async assertMayBroadcast(withdrawalId: string): Promise<void> {
    const t = await this.loadTransfer(this.deps.sql, 'withdrawal', withdrawalId);
    if (!t) throw new TravelRuleError('travel_rule.record_missing', 'there is no travel-rule record for this withdrawal');
    if (!OK_TO_BROADCAST.includes(t.status)) {
      throw new TravelRuleError('travel_rule.not_accepted', `the travel-rule status is ${t.status}; a send needs accepted`);
    }
  }
}
