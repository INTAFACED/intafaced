import type { Sql } from 'postgres';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { WithdrawalQuoteError } from './errors.js';
import { amountOutsideRules, readWithdrawalNetworkRules } from '../network-rules/service.js';
import type { AcceptInput, AdminQuoteView, FeeMode, ListInput, PolicyView, QuoteInput, QuoteView, SetPolicyInput } from './schemas.js';

/**
 * Withdrawal fee quotes (W-withdraw-04). A quote previews one withdrawal: the fee parts, whether the fee is on top of
 * the amount or deducted from it, the net amount and an expiry. It moves nothing and no balance lives here.
 *
 * Where each figure comes from. The network fee is the registry's fee for the network (`fee_estimate_source` and
 * `fee_estimate_amount`); a blank fee refuses `pay.fee_unset`. Only a `fixed` fee is read from the registry: a
 * `chain_estimate` or `venue_quote` source needs an estimator or venue this process does not have, so it refuses
 * `withdrawal_quote.fee_source_unwired` and never invents a figure. The fee mode and the quote lifetime are owner-set
 * and read from the latest policy row; with none, both are blank and a quote refuses `withdrawal_quote.policy_unset`.
 *
 * A stored quote never changes. A retry with the same `quoteRef` and terms returns the stored row; the same ref with
 * other terms is a conflict. `accept` marks a quote used by one client reference, once and before it expires, so the
 * terms a customer accepted are the terms the withdrawal keeps. `withdrawal.create` accepts the quote it names inside its
 * own claim (`send-out/door.ts` `acceptQuoteForSend`, the same one-acceptance rows) and posts its fee with the hold.
 *
 * The amount must fit the owner's rules for the asset on the network (W-withdraw-02, `network-rules/service.ts`): at least the
 * minimum, at most the maximum, a whole number of steps. A pair with no rules refuses `withdrawal_network_rules.unset`, so no
 * quote is ever stored for an amount the network's rules refuse.
 */
export interface WithdrawalQuoteServiceDeps {
  readonly sql: Sql;
  /** Injected for tests; production uses the wall clock. */
  readonly now?: () => Date;
}

interface QuoteRow {
  id: string;
  user_id: string;
  quote_ref: string;
  asset_id: string;
  network_id: string;
  amount: string;
  fee_mode: FeeMode;
  fee_components: Array<{ kind: 'network'; amount: string }>;
  fee_total: string;
  net_amount: string;
  total_debit: string;
  fee_source: string;
  quoted_at: Date;
  expires_at: Date;
  accepted_by: string | null;
}

interface PolicyRow {
  fee_mode: FeeMode | null;
  ttl_seconds: number | null;
  set_by: string | null;
  set_at: Date | null;
}

const SELECT_QUOTE = `
  SELECT q.id, q.user_id, q.quote_ref, q.asset_id, q.network_id, q.amount::text AS amount, q.fee_mode, q.fee_components,
         q.fee_total::text AS fee_total, q.net_amount::text AS net_amount, q.total_debit::text AS total_debit,
         q.fee_source, q.quoted_at, q.expires_at, a.client_ref AS accepted_by
    FROM pay.withdrawal_quotes q
    LEFT JOIN pay.withdrawal_quote_acceptances a ON a.quote_id = q.id`;

export class WithdrawalQuoteService {
  private readonly now: () => Date;
  constructor(private readonly deps: WithdrawalQuoteServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  private view(r: QuoteRow, at: Date): QuoteView {
    return {
      quoteRef: r.quote_ref,
      assetId: r.asset_id,
      networkId: r.network_id,
      amount: formatAmount(parseAmount(r.amount)),
      feeMode: r.fee_mode,
      fees: r.fee_components.map((c) => ({ kind: c.kind, amount: formatAmount(parseAmount(c.amount)) })),
      feeTotal: formatAmount(parseAmount(r.fee_total)),
      netAmount: formatAmount(parseAmount(r.net_amount)),
      totalDebit: formatAmount(parseAmount(r.total_debit)),
      feeSource: r.fee_source,
      quotedAt: r.quoted_at.toISOString(),
      expiresAt: r.expires_at.toISOString(),
      expired: at.getTime() >= r.expires_at.getTime(),
      acceptedBy: r.accepted_by,
    };
  }

  // ── owner policy ───────────────────────────────────────────────────────────

  async policy(): Promise<PolicyView> {
    const [row] = await this.deps.sql<PolicyRow[]>`
      SELECT fee_mode, ttl_seconds, set_by, set_at FROM pay.withdrawal_quote_policy_events ORDER BY seq DESC LIMIT 1`;
    return row
      ? { feeMode: row.fee_mode, ttlSeconds: row.ttl_seconds, setBy: row.set_by, setAt: row.set_at?.toISOString() ?? null }
      : { feeMode: null, ttlSeconds: null, setBy: null, setAt: null };
  }

  async setPolicy(actor: string, input: SetPolicyInput): Promise<PolicyView> {
    await this.deps.sql`
      INSERT INTO pay.withdrawal_quote_policy_events (fee_mode, ttl_seconds, set_by)
      VALUES (${input.feeMode}, ${input.ttlSeconds}, ${actor})`;
    return this.policy();
  }

  // ── quote ──────────────────────────────────────────────────────────────────

  async quote(userId: string, input: QuoteInput): Promise<QuoteView> {
    const at = this.now();
    const stored = await this.find(userId, input.quoteRef);
    if (stored) return this.sameTerms(stored, input, at);

    const policy = await this.policy();
    if (policy.feeMode === null || policy.ttlSeconds === null) {
      throw new WithdrawalQuoteError('withdrawal_quote.policy_unset', 'the owner has not set the fee mode and quote lifetime');
    }
    const amount = parseAmount(input.amount);
    if (amount <= 0n) throw new WithdrawalQuoteError('withdrawal_quote.amount_invalid', 'the amount must be above zero');

    const { fee, source, registryVersion } = await this.networkFee(input);
    const outside = amountOutsideRules(await readWithdrawalNetworkRules(this.deps.sql, input.assetId, input.networkId), amount);
    if (outside) {
      const why = { below_minimum: 'below the minimum', above_maximum: 'above the maximum', off_step: 'not a whole number of steps' };
      throw new WithdrawalQuoteError(
        `withdrawal_quote.${outside}`,
        `the amount is ${why[outside]} for ${input.assetId} on ${input.networkId}`,
      );
    }
    const net: Amount = policy.feeMode === 'deducted' ? amount - fee : amount;
    if (net <= 0n) {
      throw new WithdrawalQuoteError('withdrawal_quote.fee_exceeds_amount', 'the fee is not below the amount, so nothing would arrive');
    }
    const total: Amount = policy.feeMode === 'on_top' ? amount + fee : amount;
    const components = [{ kind: 'network', amount: formatAmount(fee) }];
    const expires = new Date(at.getTime() + policy.ttlSeconds * 1000);

    await this.deps.sql`
      INSERT INTO pay.withdrawal_quotes
        (user_id, quote_ref, asset_id, network_id, amount, fee_mode, fee_components, fee_total, net_amount, total_debit,
         fee_source, registry_version, quoted_at, expires_at)
      VALUES (${userId}, ${input.quoteRef}, ${input.assetId}, ${input.networkId}, ${formatAmount(amount)}::numeric,
              ${policy.feeMode}, ${this.deps.sql.json(components)}, ${formatAmount(fee)}::numeric,
              ${formatAmount(net)}::numeric, ${formatAmount(total)}::numeric, ${source}, ${registryVersion}, ${at}, ${expires})
      ON CONFLICT (user_id, quote_ref) DO NOTHING`;
    // A concurrent first call with the same ref may have won the insert: read what is stored and compare.
    const row = await this.find(userId, input.quoteRef);
    return this.sameTerms(row!, input, at);
  }

  private sameTerms(row: QuoteRow, input: QuoteInput, at: Date): QuoteView {
    const same =
      row.asset_id === input.assetId && row.network_id === input.networkId && parseAmount(row.amount) === parseAmount(input.amount);
    if (!same) {
      throw new WithdrawalQuoteError(
        'withdrawal_quote.quote_differs',
        `quote ${input.quoteRef} exists with other terms; use a new reference`,
      );
    }
    return this.view(row, at);
  }

  private async networkFee(input: QuoteInput): Promise<{ fee: Amount; source: string; registryVersion: number }> {
    const [net] = await this.deps.sql<
      Array<{
        enabled: boolean;
        asset_codes: unknown;
        fee_estimate_source: string | null;
        fee_estimate_amount: string | null;
        version: number;
      }>
    >`SELECT enabled, asset_codes, fee_estimate_source, fee_estimate_amount, version
        FROM pay.network_registry WHERE network_id = ${input.networkId}`;
    if (!net) throw new WithdrawalQuoteError('withdrawal_quote.network_unknown', `network "${input.networkId}" is not in the registry`);
    if (!net.enabled) throw new WithdrawalQuoteError('withdrawal_quote.network_disabled', `network "${input.networkId}" is switched off`);
    const codes = Array.isArray(net.asset_codes) ? net.asset_codes : [];
    if (!codes.includes(input.assetId)) {
      throw new WithdrawalQuoteError('withdrawal_quote.asset_not_on_network', `${input.assetId} is not on network "${input.networkId}"`);
    }
    if (net.fee_estimate_source === null) {
      throw new WithdrawalQuoteError('pay.fee_unset', `the withdrawal fee for network "${input.networkId}" is not set`);
    }
    if (net.fee_estimate_source !== 'fixed') {
      throw new WithdrawalQuoteError(
        'withdrawal_quote.fee_source_unwired',
        `network "${input.networkId}" takes its fee from ${net.fee_estimate_source}, which is not connected here`,
      );
    }
    // The registry check requires an amount with a fixed source; a missing one is still a blank fee.
    if (net.fee_estimate_amount === null) {
      throw new WithdrawalQuoteError('pay.fee_unset', `the withdrawal fee for network "${input.networkId}" is not set`);
    }
    return { fee: parseAmount(net.fee_estimate_amount), source: 'fixed', registryVersion: net.version };
  }

  private async find(userId: string, quoteRef: string): Promise<QuoteRow | undefined> {
    const [row] = await this.deps.sql.unsafe<QuoteRow[]>(`${SELECT_QUOTE} WHERE q.user_id = $1 AND q.quote_ref = $2`, [userId, quoteRef]);
    return row;
  }

  async get(userId: string, quoteRef: string): Promise<QuoteView> {
    const row = await this.find(userId, quoteRef);
    if (!row) throw new WithdrawalQuoteError('withdrawal_quote.not_found', `no quote ${quoteRef} for this account`);
    return this.view(row, this.now());
  }

  // ── accept ─────────────────────────────────────────────────────────────────

  /**
   * Mark a quote used by one client reference. The same reference again returns the accepted quote (a retry, even
   * after expiry). Another reference on the same quote, or this reference on another quote, is a conflict.
   */
  async accept(userId: string, input: AcceptInput): Promise<QuoteView> {
    const at = this.now();
    const row = await this.find(userId, input.quoteRef);
    if (!row) throw new WithdrawalQuoteError('withdrawal_quote.not_found', `no quote ${input.quoteRef} for this account`);
    if (row.accepted_by !== null) {
      if (row.accepted_by === input.clientRef) return this.view(row, at);
      throw new WithdrawalQuoteError('withdrawal_quote.already_used', `quote ${input.quoteRef} was accepted by another request`);
    }
    if (at.getTime() >= row.expires_at.getTime()) {
      throw new WithdrawalQuoteError('withdrawal_quote.expired', `quote ${input.quoteRef} has expired; ask for a new one`);
    }
    const [taken] = await this.deps.sql<Array<{ quote_id: string }>>`
      SELECT quote_id FROM pay.withdrawal_quote_acceptances WHERE user_id = ${userId} AND client_ref = ${input.clientRef}`;
    if (taken) {
      throw new WithdrawalQuoteError(
        'withdrawal_quote.client_ref_taken',
        `client reference ${input.clientRef} already accepted another quote`,
      );
    }
    const inserted = await this.deps.sql<Array<{ quote_id: string }>>`
      INSERT INTO pay.withdrawal_quote_acceptances (quote_id, user_id, client_ref, accepted_at)
      VALUES (${row.id}, ${userId}, ${input.clientRef}, ${at})
      ON CONFLICT DO NOTHING
      RETURNING quote_id`;
    // A concurrent accept won (same quote or same reference): decide from what is stored.
    if (inserted.length === 0) return this.accept(userId, input);
    return this.view({ ...row, accepted_by: input.clientRef }, at);
  }

  // ── founder-ops read ───────────────────────────────────────────────────────

  async list(input: ListInput): Promise<AdminQuoteView[]> {
    const at = this.now();
    const rows = await this.deps.sql.unsafe<QuoteRow[]>(
      `${SELECT_QUOTE}
        WHERE ($1::uuid IS NULL OR q.user_id = $1::uuid) AND ($2::text IS NULL OR q.asset_id = $2::text)
        ORDER BY q.quoted_at DESC, q.id DESC LIMIT $3`,
      [input.userId ?? null, input.assetId ?? null, input.limit],
    );
    return rows.map((r) => ({ ...this.view(r, at), userId: r.user_id }));
  }
}
