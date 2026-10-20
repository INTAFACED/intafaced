import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { FeeEstimator } from '../fees/service.js';
import { CustodyUtxoError } from './errors.js';
import type {
  ConsolidateInput,
  ConsolidationView,
  DueView,
  TriggerSetInput,
  TriggerView,
  UtxoLabelInput,
  UtxoListInput,
  UtxoState,
  UtxoView,
} from './schemas.js';

/**
 * UTXO inventory and consolidation (W-custody-ops-13). The node is a port this process may not have: with none, every
 * read and write that needs it refuses `rail.crypto` and nothing is guessed. The inventory is a cache of what the node
 * last reported for a custody wallet; the chain and the ledger remain the books.
 *
 * A consolidation is an intent first. Under one lock per wallet it picks the confirmed, available outputs, reserves
 * them and writes the intent with its frozen input set, and only then asks the node to build and broadcast. The outcome
 * is a separate row. A crash or an unknown node answer leaves the intent with no outcome and the outputs reserved; the
 * same `intentRef` resumes it and the node is asked with the same reference (the adapter must be idempotent on it).
 * Only a definite refusal from the node records `failed` and frees the outputs.
 *
 * What makes a consolidation due is the owner's: a UTXO count, a low fee level, or both. With neither set it refuses
 * `utxo.triggers_unset`; the confirmation depth is the network registry's, and a blank one refuses too.
 */
export interface NodeUtxo {
  readonly txid: string;
  readonly vout: number;
  readonly amount: string;
  readonly confirmations: number;
}

/** A definite refusal from the node: nothing was broadcast. Any other error means the outcome is unknown. */
export class UtxoNodeRefusal extends Error {
  constructor(
    readonly failureCode: string,
    message: string,
  ) {
    super(message);
    this.name = 'UtxoNodeRefusal';
  }
}

export interface UtxoNode {
  list(input: { networkId: string; address: string }): Promise<NodeUtxo[]>;
  /** Build, sign and broadcast one transaction spending exactly `inputs` to `toAddress`. Idempotent on `intentRef`. */
  consolidate(input: {
    intentRef: string;
    networkId: string;
    inputs: ReadonlyArray<{ txid: string; vout: number; amount: string }>;
    toAddress: string;
  }): Promise<{ txid: string }>;
}

export interface CustodyUtxoServiceDeps {
  readonly sql: Sql;
  /** Omitted: every node read and write refuses `rail.crypto`. */
  readonly node?: UtxoNode;
  /** The fee estimator (W-custody-ops-10). Omitted: the low-fee trigger reads as unavailable, never as met. */
  readonly estimator?: FeeEstimator;
  /** Injected for tests; production uses the wall clock. */
  readonly now?: () => Date;
}

interface WalletRow {
  wallet_id: string;
  network_id: string;
  address: string | null;
  confirmations_required: number | null;
}

interface UtxoRow {
  id: string;
  wallet_id: string;
  txid: string;
  vout: number;
  amount: string;
  confirmations: number;
  state: UtxoState;
  label: string | null;
  first_seen_at: Date;
  last_seen_at: Date;
}

interface TriggerRow {
  network_id: string;
  min_utxo_count: number | null;
  fee_below: string | null;
  fee_unit: string | null;
  reason: string | null;
  set_by: string | null;
  set_at: Date | null;
}

interface IntentRow {
  id: string;
  intent_ref: string;
  wallet_id: string;
  inputs: Array<{ txid: string; vout: number; amount: string }>;
  input_count: number;
  total_amount: string;
  created_by: string;
  created_at: Date;
  outcome: 'broadcast' | 'failed' | null;
  txid: string | null;
  failure_code: string | null;
}

const utxoView = (r: UtxoRow): UtxoView => ({
  id: r.id,
  walletId: r.wallet_id,
  txid: r.txid,
  vout: r.vout,
  amount: formatAmount(parseAmount(r.amount)),
  confirmations: r.confirmations,
  state: r.state,
  label: r.label,
  firstSeenAt: r.first_seen_at.toISOString(),
  lastSeenAt: r.last_seen_at.toISOString(),
});

const triggerView = (r: TriggerRow): TriggerView => ({
  networkId: r.network_id,
  configured: r.set_at !== null,
  minUtxoCount: r.min_utxo_count,
  feeBelow: r.fee_below === null ? null : formatAmount(parseAmount(r.fee_below)),
  feeUnit: r.fee_unit,
  reason: r.reason,
  setBy: r.set_by,
  setAt: r.set_at ? r.set_at.toISOString() : null,
});

const SELECT_INTENT = `
  SELECT c.id, c.intent_ref, c.wallet_id, c.inputs, c.input_count, c.total_amount::text AS total_amount, c.created_by,
         c.created_at, o.outcome, o.txid, o.failure_code
    FROM pay.utxo_consolidations c
    LEFT JOIN pay.utxo_consolidation_outcomes o ON o.consolidation_id = c.id`;

function intentView(r: IntentRow): ConsolidationView {
  return {
    id: r.id,
    intentRef: r.intent_ref,
    walletId: r.wallet_id,
    inputCount: r.input_count,
    totalAmount: formatAmount(parseAmount(r.total_amount)),
    status: r.outcome ?? 'intent',
    txid: r.txid,
    failureCode: r.failure_code,
    createdBy: r.created_by,
    createdAt: r.created_at.toISOString(),
  };
}

export class CustodyUtxoService {
  private readonly now: () => Date;
  constructor(private readonly deps: CustodyUtxoServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  private node(): UtxoNode {
    if (!this.deps.node) {
      throw new CustodyUtxoError('rail.crypto', 'Listing and consolidating UTXOs needs rail.crypto. It is switched off in this build.');
    }
    return this.deps.node;
  }

  private async wallet(q: Sql, walletId: string): Promise<WalletRow & { address: string }> {
    const [w] = await q<WalletRow[]>`
      SELECT w.wallet_id, w.network_id, w.address, n.confirmations_required
        FROM pay.custody_wallets w JOIN pay.network_registry n ON n.network_id = w.network_id
       WHERE w.wallet_id = ${walletId}::uuid`;
    if (!w) throw new CustodyUtxoError('utxo.wallet_not_found', `no custody wallet ${walletId}`);
    if (w.address === null) throw new CustodyUtxoError('utxo.wallet_has_no_address', 'the wallet has no address yet');
    return w as WalletRow & { address: string };
  }

  // ── inventory ──────────────────────────────────────────────────────────────

  /** Refresh the inventory from the node. A recorded output the node no longer reports is spent. */
  private async refresh(w: WalletRow & { address: string }): Promise<void> {
    const seen = await this.node().list({ networkId: w.network_id, address: w.address });
    const at = this.now();
    await transaction(
      this.deps.sql,
      async (tx) => {
        for (const u of seen) {
          await tx`
            INSERT INTO pay.utxo_records (wallet_id, txid, vout, amount, confirmations, state, first_seen_at, last_seen_at)
            VALUES (${w.wallet_id}::uuid, ${u.txid}, ${u.vout}, ${formatAmount(parseAmount(u.amount))}::numeric, ${u.confirmations}, 'available', ${at}, ${at})
            ON CONFLICT (wallet_id, txid, vout) DO UPDATE SET confirmations = EXCLUDED.confirmations, last_seen_at = EXCLUDED.last_seen_at,
              state = CASE WHEN pay.utxo_records.state = 'spent' THEN 'available' ELSE pay.utxo_records.state END`;
        }
        await tx`
          UPDATE pay.utxo_records SET state = 'spent'
           WHERE wallet_id = ${w.wallet_id}::uuid AND state <> 'spent'
             AND (txid, vout) NOT IN (SELECT * FROM unnest(${seen.map((u) => u.txid)}::text[], ${seen.map((u) => u.vout)}::int[]))`;
      },
      { isolation: 'read committed' },
    );
  }

  async list(input: UtxoListInput): Promise<UtxoView[]> {
    const w = await this.wallet(this.deps.sql, input.walletId);
    await this.refresh(w);
    const rows = await this.deps.sql<UtxoRow[]>`
      SELECT id, wallet_id, txid, vout, amount::text AS amount, confirmations, state, label, first_seen_at, last_seen_at
        FROM pay.utxo_records
       WHERE wallet_id = ${input.walletId}::uuid AND (${input.state ?? null}::text IS NULL OR state = ${input.state ?? null}::text)
       ORDER BY txid, vout`;
    return rows.map(utxoView);
  }

  /** Set or clear a label. An output that is spent can no longer be labelled. */
  async label(actor: string, input: UtxoLabelInput): Promise<UtxoView> {
    return transaction(this.deps.sql, async (tx) => {
      const [row] = await tx<UtxoRow[]>`
        SELECT id, wallet_id, txid, vout, amount::text AS amount, confirmations, state, label, first_seen_at, last_seen_at
          FROM pay.utxo_records WHERE id = ${input.utxoId}::uuid FOR UPDATE`;
      if (!row) throw new CustodyUtxoError('utxo.not_found', `no UTXO ${input.utxoId}`);
      if (row.state === 'spent') throw new CustodyUtxoError('utxo.not_labellable', 'a spent output keeps the label it had');
      await tx`UPDATE pay.utxo_records SET label = ${input.label} WHERE id = ${input.utxoId}::uuid`;
      await tx`INSERT INTO pay.utxo_label_events (utxo_id, label, set_by) VALUES (${input.utxoId}::uuid, ${input.label}, ${actor})`;
      return utxoView({ ...row, label: input.label });
    });
  }

  // ── owner triggers ─────────────────────────────────────────────────────────

  private async assertNetwork(networkId: string): Promise<void> {
    const [n] = await this.deps.sql`SELECT 1 FROM pay.network_registry WHERE network_id = ${networkId}`;
    if (!n) throw new CustodyUtxoError('utxo.network_unknown', `network "${networkId}" is not in the registry`);
  }

  async triggers(networkId: string): Promise<TriggerView> {
    await this.assertNetwork(networkId);
    const [row] = await this.deps.sql<TriggerRow[]>`
      SELECT network_id, min_utxo_count, fee_below::text AS fee_below, fee_unit, reason, set_by, set_at
        FROM pay.utxo_trigger_events WHERE network_id = ${networkId} ORDER BY seq DESC LIMIT 1`;
    return triggerView(
      row ?? { network_id: networkId, min_utxo_count: null, fee_below: null, fee_unit: null, reason: null, set_by: null, set_at: null },
    );
  }

  async setTriggers(actor: string, input: TriggerSetInput): Promise<TriggerView> {
    await this.assertNetwork(input.networkId);
    await this.deps.sql`
      INSERT INTO pay.utxo_trigger_events (network_id, min_utxo_count, fee_below, fee_unit, reason, set_by)
      VALUES (${input.networkId}, ${input.minUtxoCount ?? null}, ${input.feeBelow ?? null}::numeric, ${input.feeUnit ?? null}, ${input.reason}, ${actor})`;
    return this.triggers(input.networkId);
  }

  /** Is a consolidation due for this wallet under the owner's triggers? Refreshes the inventory first. */
  async due(walletId: string): Promise<DueView> {
    const w = await this.wallet(this.deps.sql, walletId);
    const t = await this.triggers(w.network_id);
    if (!t.configured)
      throw new CustodyUtxoError('utxo.triggers_unset', `the owner has not set consolidation triggers for ${w.network_id}`);
    if (w.confirmations_required === null) {
      throw new CustodyUtxoError('utxo.confirmations_unset', `the network registry has no confirmation depth for ${w.network_id}`);
    }
    await this.refresh(w);
    const [c] = await this.deps.sql<Array<{ n: string }>>`
      SELECT count(*)::text AS n FROM pay.utxo_records
       WHERE wallet_id = ${walletId}::uuid AND state = 'available' AND confirmations >= ${w.confirmations_required}`;
    const utxoCount = Number(c?.n ?? 0);
    const reasons: DueView['reasons'] = [];
    let feeNote: string | null = null;
    if (t.minUtxoCount !== null && utxoCount >= t.minUtxoCount) reasons.push('utxo_count');
    if (t.feeBelow !== null && t.feeUnit !== null) {
      if (!this.deps.estimator) {
        feeNote = 'custody_fees.estimator_unwired';
      } else {
        try {
          const est = await this.deps.estimator.estimate(w.network_id);
          if (est.unit !== t.feeUnit) feeNote = `the estimate is in ${est.unit}, the trigger in ${t.feeUnit}`;
          else if (parseAmount(est.low) <= parseAmount(t.feeBelow)) reasons.push('low_fee');
        } catch {
          feeNote = 'custody_fees.estimate_failed';
        }
      }
    }
    return { due: reasons.length > 0, reasons, utxoCount, feeNote };
  }

  // ── consolidation ──────────────────────────────────────────────────────────

  private async findIntent(q: Sql, intentRef: string): Promise<IntentRow | undefined> {
    const [row] = await q.unsafe<IntentRow[]>(`${SELECT_INTENT} WHERE c.intent_ref = $1`, [intentRef]);
    return row;
  }

  /**
   * Consolidate a wallet's confirmed outputs into one. Idempotent on `intentRef`: the same reference returns the stored
   * outcome, or resumes an intent that has none. A reference used for another wallet conflicts.
   */
  async consolidate(actor: string, input: ConsolidateInput): Promise<ConsolidationView> {
    const w = await this.wallet(this.deps.sql, input.walletId);
    const node = this.node();

    const existing = await this.findIntent(this.deps.sql, input.intentRef);
    if (existing) return this.finish(node, w, this.sameWallet(existing, input.walletId));

    const t = await this.triggers(w.network_id);
    if (!t.configured)
      throw new CustodyUtxoError('utxo.triggers_unset', `the owner has not set consolidation triggers for ${w.network_id}`);
    const due = await this.due(input.walletId);
    if (!due.due) throw new CustodyUtxoError('utxo.not_due', 'no consolidation trigger is met');
    const depth = w.confirmations_required as number;

    const intent = await transaction(
      this.deps.sql,
      async (tx) => {
        // One consolidation at a time per wallet; a second caller waits here and then sees the first one's intent.
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'utxo:' + w.wallet_id}, 0))`;
        const again = await this.findIntent(tx, input.intentRef);
        if (again) return this.sameWallet(again, input.walletId);
        const picked = await tx<Array<{ txid: string; vout: number; amount: string }>>`
          UPDATE pay.utxo_records SET state = 'reserved'
           WHERE wallet_id = ${w.wallet_id}::uuid AND state = 'available' AND confirmations >= ${depth}
          RETURNING txid, vout, amount::text AS amount`;
        if (picked.length < 2) {
          throw new CustodyUtxoError('utxo.nothing_to_consolidate', 'fewer than two confirmed outputs are available');
        }
        picked.sort((a, b) => (a.txid === b.txid ? a.vout - b.vout : a.txid < b.txid ? -1 : 1));
        const total = picked.reduce((s, u) => s + parseAmount(u.amount), 0n);
        await tx`
          INSERT INTO pay.utxo_consolidations (intent_ref, wallet_id, inputs, input_count, total_amount, created_by)
          VALUES (${input.intentRef}, ${w.wallet_id}::uuid,
                  ${tx.json(picked.map((u) => ({ txid: u.txid, vout: u.vout, amount: formatAmount(parseAmount(u.amount)) })))},
                  ${picked.length}, ${formatAmount(total)}::numeric, ${actor})`;
        return (await this.findIntent(tx, input.intentRef))!;
      },
      { isolation: 'read committed' },
    );
    return this.finish(node, w, intent);
  }

  private sameWallet(r: IntentRow, walletId: string): IntentRow {
    if (r.wallet_id !== walletId) {
      throw new CustodyUtxoError('utxo.intent_differs', `reference ${r.intent_ref} was used for another wallet`);
    }
    return r;
  }

  /** Ask the node (unless an outcome is already stored) and record what it answered. */
  private async finish(node: UtxoNode, w: WalletRow & { address: string }, intent: IntentRow): Promise<ConsolidationView> {
    if (intent.outcome) return intentView(intent);
    try {
      const sent = await node.consolidate({
        intentRef: intent.intent_ref,
        networkId: w.network_id,
        inputs: intent.inputs,
        toAddress: w.address,
      });
      await this.deps.sql`
        INSERT INTO pay.utxo_consolidation_outcomes (consolidation_id, outcome, txid) VALUES (${intent.id}::uuid, 'broadcast', ${sent.txid})
        ON CONFLICT (consolidation_id) DO NOTHING`;
    } catch (error) {
      if (error instanceof UtxoNodeRefusal) {
        await transaction(this.deps.sql, async (tx) => {
          const done = await tx`
            INSERT INTO pay.utxo_consolidation_outcomes (consolidation_id, outcome, failure_code)
            VALUES (${intent.id}::uuid, 'failed', ${error.failureCode}) ON CONFLICT (consolidation_id) DO NOTHING RETURNING consolidation_id`;
          if (done.length === 0) return;
          for (const u of intent.inputs) {
            await tx`UPDATE pay.utxo_records SET state = 'available'
                      WHERE wallet_id = ${w.wallet_id}::uuid AND txid = ${u.txid} AND vout = ${u.vout} AND state = 'reserved'`;
          }
        });
      } else {
        throw new CustodyUtxoError(
          'utxo.outcome_unknown',
          `the node did not answer for ${intent.intent_ref}; the outputs stay reserved and the same reference resumes it`,
        );
      }
    }
    const row = await this.findIntent(this.deps.sql, intent.intent_ref);
    return intentView(row!);
  }

  async listConsolidations(walletId: string, limit: number): Promise<ConsolidationView[]> {
    const rows = await this.deps.sql.unsafe<IntentRow[]>(
      `${SELECT_INTENT} WHERE c.wallet_id = $1::uuid ORDER BY c.created_at DESC, c.id DESC LIMIT $2`,
      [walletId, limit],
    );
    return rows.map(intentView);
  }
}
