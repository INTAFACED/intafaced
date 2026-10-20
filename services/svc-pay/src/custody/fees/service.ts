import type { Sql } from 'postgres';
import { parseAmount } from '@intafaced/ledger-client';
import { CustodyFeesError } from './errors.js';
import {
  GAS_EXECUTION_BLOCKER,
  type FeeCheckView,
  type FeeEstimateView,
  type FeeLevel,
  type FeeSetInput,
  type FeeSettingView,
  type GasPolicyView,
  type GasSetInput,
  type RefuelRecordInput,
  type RefuelView,
} from './schemas.js';

/**
 * Network fees, managed nonce and gas policy (W-custody-ops-10). Settings only: the latest row per network is the
 * setting and a network with none is unconfigured. A fee cap is never defaulted, so a send that needs one refuses until
 * a founder sets it. The fee estimate comes from a port this process may not have; without it the estimate refuses and
 * never invents a figure. Nothing is sent or refuelled from here: that runs behind the crypto rail.
 */
export interface FeeEstimate {
  /** What the three tiers are measured in, as the estimator names it. */
  readonly unit: string;
  readonly low: string;
  readonly medium: string;
  readonly high: string;
  readonly asOf: string;
}

export interface FeeEstimator {
  estimate(networkId: string): Promise<FeeEstimate>;
}

export interface CustodyFeesServiceDeps {
  readonly sql: Sql;
  /** Omitted: the estimate refuses with `custody_fees.estimator_unwired`. */
  readonly estimator?: FeeEstimator;
}

interface FeeRow {
  network_id: string;
  fee_level: FeeLevel | null;
  fee_cap: string | null;
  fee_unit: string | null;
  managed_nonce: boolean | null;
  reason: string | null;
  set_by: string | null;
  set_at: Date | null;
}

interface GasRow {
  network_id: string;
  fee_payer: 'self' | 'station' | 'relay' | null;
  gas_threshold: string | null;
  gas_cap: string | null;
  max_gas_price: string | null;
  auto_top_up: boolean | null;
  reason: string | null;
  set_by: string | null;
  set_at: Date | null;
}

const feeView = (r: FeeRow): FeeSettingView => ({
  networkId: r.network_id,
  configured: r.set_at !== null,
  feeLevel: r.fee_level,
  feeCap: r.fee_cap,
  feeUnit: r.fee_unit,
  managedNonce: r.managed_nonce,
  reason: r.reason,
  setBy: r.set_by,
  setAt: r.set_at ? r.set_at.toISOString() : null,
});

const gasView = (r: GasRow): GasPolicyView => ({
  networkId: r.network_id,
  configured: r.set_at !== null,
  feePayer: r.fee_payer,
  gasThreshold: r.gas_threshold,
  gasCap: r.gas_cap,
  maxGasPrice: r.max_gas_price,
  autoTopUp: r.auto_top_up,
  reason: r.reason,
  setBy: r.set_by,
  setAt: r.set_at ? r.set_at.toISOString() : null,
  executionBlocker: GAS_EXECUTION_BLOCKER,
});

export class CustodyFeesService {
  constructor(private readonly deps: CustodyFeesServiceDeps) {}

  private async assertNetwork(q: Sql, networkId: string): Promise<void> {
    const [row] = await q`SELECT 1 FROM pay.network_registry WHERE network_id = ${networkId}`;
    if (!row) throw new CustodyFeesError('custody_fees.network_unknown', `network "${networkId}" is not in the registry`);
  }

  // ── fee settings ───────────────────────────────────────────────────────────

  /** Record the fee level, cap and nonce switch for a network. Appended; the latest row is the setting. */
  async setFees(actor: string, input: FeeSetInput): Promise<FeeSettingView> {
    await this.assertNetwork(this.deps.sql, input.networkId);
    await this.deps.sql`
      INSERT INTO pay.network_fee_settings_events (network_id, fee_level, fee_cap, fee_unit, managed_nonce, reason, set_by)
      VALUES (${input.networkId}, ${input.feeLevel}, ${input.feeCap}::numeric, ${input.feeUnit}, ${input.managedNonce}, ${input.reason}, ${actor})`;
    return this.getFees(input.networkId);
  }

  async getFees(networkId: string): Promise<FeeSettingView> {
    await this.assertNetwork(this.deps.sql, networkId);
    const [row] = await this.deps.sql<FeeRow[]>`
      SELECT n.network_id, e.fee_level, e.fee_cap::text AS fee_cap, e.fee_unit, e.managed_nonce, e.reason, e.set_by, e.set_at
        FROM pay.network_registry n
        LEFT JOIN LATERAL (SELECT * FROM pay.network_fee_settings_events WHERE network_id = n.network_id ORDER BY seq DESC LIMIT 1) e ON true
       WHERE n.network_id = ${networkId}`;
    return feeView(row!);
  }

  /** Every registered network with its current setting, or an unconfigured row. */
  async listFees(limit: number, after?: string): Promise<FeeSettingView[]> {
    const rows = await this.deps.sql<FeeRow[]>`
      SELECT n.network_id, e.fee_level, e.fee_cap::text AS fee_cap, e.fee_unit, e.managed_nonce, e.reason, e.set_by, e.set_at
        FROM pay.network_registry n
        LEFT JOIN LATERAL (SELECT * FROM pay.network_fee_settings_events WHERE network_id = n.network_id ORDER BY seq DESC LIMIT 1) e ON true
       WHERE (${after ?? null}::text IS NULL OR n.network_id > ${after ?? null}::text)
       ORDER BY n.network_id
       LIMIT ${limit}`;
    return rows.map(feeView);
  }

  async feeHistory(networkId: string, limit: number): Promise<FeeSettingView[]> {
    await this.assertNetwork(this.deps.sql, networkId);
    const rows = await this.deps.sql<FeeRow[]>`
      SELECT network_id, fee_level, fee_cap::text AS fee_cap, fee_unit, managed_nonce, reason, set_by, set_at
        FROM pay.network_fee_settings_events WHERE network_id = ${networkId} ORDER BY seq DESC LIMIT ${limit}`;
    return rows.map(feeView);
  }

  // ── estimate and the send check ────────────────────────────────────────────

  private async rawEstimate(networkId: string): Promise<FeeEstimate> {
    await this.assertNetwork(this.deps.sql, networkId);
    if (!this.deps.estimator) {
      throw new CustodyFeesError('custody_fees.estimator_unwired', 'no chain fee estimator is connected here (rail.crypto)');
    }
    try {
      return await this.deps.estimator.estimate(networkId);
    } catch {
      throw new CustodyFeesError('custody_fees.estimate_failed', 'the chain fee estimate could not be read; try again');
    }
  }

  private static within(fee: string, setting: FeeSettingView, unit: string): boolean | null {
    if (setting.feeCap === null || setting.feeUnit !== unit) return null;
    return parseAmount(fee) <= parseAmount(setting.feeCap);
  }

  /** The current fee tiers for a network, each marked inside or outside the cap. */
  async estimate(networkId: string): Promise<FeeEstimateView> {
    const est = await this.rawEstimate(networkId);
    const setting = await this.getFees(networkId);
    return {
      networkId,
      unit: est.unit,
      asOf: est.asOf,
      tiers: { low: est.low, medium: est.medium, high: est.high },
      withinCap: {
        low: CustodyFeesService.within(est.low, setting, est.unit),
        medium: CustodyFeesService.within(est.medium, setting, est.unit),
        high: CustodyFeesService.within(est.high, setting, est.unit),
      },
    };
  }

  /**
   * The check a send makes before it signs: the fee at the chosen level (the network's own level when none is named)
   * must be inside the cap. No cap, an estimate in another unit, or a fee above the cap all refuse; none is guessed.
   */
  async assertSendFee(networkId: string, level?: FeeLevel): Promise<FeeCheckView> {
    const setting = await this.getFees(networkId);
    if (!setting.configured || setting.feeCap === null || setting.feeLevel === null || setting.managedNonce === null) {
      throw new CustodyFeesError(
        'custody_fees.cap_unset',
        `no fee cap is set for network "${networkId}"; a founder must set one before a send`,
      );
    }
    const est = await this.rawEstimate(networkId);
    if (est.unit !== setting.feeUnit) {
      throw new CustodyFeesError('custody_fees.unit_mismatch', `the estimate is in ${est.unit} but the cap is in ${setting.feeUnit}`);
    }
    const chosen = level ?? setting.feeLevel;
    const fee = est[chosen];
    if (parseAmount(fee) > parseAmount(setting.feeCap)) {
      throw new CustodyFeesError('custody_fees.fee_above_cap', `the ${chosen} fee ${fee} ${est.unit} is above the cap ${setting.feeCap}`);
    }
    return { networkId, level: chosen, fee, cap: setting.feeCap, unit: est.unit, managedNonce: setting.managedNonce };
  }

  // ── gas policy and refuels ─────────────────────────────────────────────────

  async setGasPolicy(actor: string, input: GasSetInput): Promise<GasPolicyView> {
    await this.assertNetwork(this.deps.sql, input.networkId);
    await this.deps.sql`
      INSERT INTO pay.gas_policy_events (network_id, fee_payer, gas_threshold, gas_cap, max_gas_price, auto_top_up, reason, set_by)
      VALUES (${input.networkId}, ${input.feePayer}, ${input.gasThreshold}::numeric, ${input.gasCap}::numeric,
              ${input.maxGasPrice}::numeric, ${input.autoTopUp}, ${input.reason}, ${actor})`;
    return this.getGasPolicy(input.networkId);
  }

  async getGasPolicy(networkId: string): Promise<GasPolicyView> {
    await this.assertNetwork(this.deps.sql, networkId);
    const [row] = await this.deps.sql<GasRow[]>`
      SELECT n.network_id, e.fee_payer, e.gas_threshold::text AS gas_threshold, e.gas_cap::text AS gas_cap,
             e.max_gas_price::text AS max_gas_price, e.auto_top_up, e.reason, e.set_by, e.set_at
        FROM pay.network_registry n
        LEFT JOIN LATERAL (SELECT * FROM pay.gas_policy_events WHERE network_id = n.network_id ORDER BY seq DESC LIMIT 1) e ON true
       WHERE n.network_id = ${networkId}`;
    return gasView(row!);
  }

  /** Write down a refuel that happened elsewhere. Idempotent on `refuelRef`; the same reference with other terms conflicts. */
  async recordRefuel(actor: string, input: RefuelRecordInput): Promise<RefuelView> {
    await this.assertNetwork(this.deps.sql, input.networkId);
    await this.deps.sql`
      INSERT INTO pay.gas_refuels (refuel_ref, network_id, amount, tx_ref, reason, recorded_by)
      VALUES (${input.refuelRef}, ${input.networkId}, ${input.amount}::numeric, ${input.txRef}, ${input.reason}, ${actor})
      ON CONFLICT (refuel_ref) DO NOTHING`;
    const [row] = await this.refuelRows(input.refuelRef);
    const same =
      row !== undefined &&
      row.networkId === input.networkId &&
      parseAmount(row.amount) === parseAmount(input.amount) &&
      row.txRef === input.txRef;
    if (!same) throw new CustodyFeesError('custody_fees.refuel_differs', 'that refuel reference already names a different refuel');
    return row;
  }

  async listRefuels(networkId: string | undefined, limit: number): Promise<RefuelView[]> {
    const rows = await this.deps.sql<
      Array<{
        refuel_ref: string;
        network_id: string;
        amount: string;
        tx_ref: string;
        reason: string;
        recorded_by: string;
        recorded_at: Date;
      }>
    >`
      SELECT refuel_ref, network_id, amount::text AS amount, tx_ref, reason, recorded_by, recorded_at
        FROM pay.gas_refuels
       WHERE (${networkId ?? null}::text IS NULL OR network_id = ${networkId ?? null}::text)
       ORDER BY seq DESC LIMIT ${limit}`;
    return rows.map(refuelOf);
  }

  private async refuelRows(refuelRef: string): Promise<RefuelView[]> {
    const rows = await this.deps.sql<
      Array<{
        refuel_ref: string;
        network_id: string;
        amount: string;
        tx_ref: string;
        reason: string;
        recorded_by: string;
        recorded_at: Date;
      }>
    >`
      SELECT refuel_ref, network_id, amount::text AS amount, tx_ref, reason, recorded_by, recorded_at
        FROM pay.gas_refuels WHERE refuel_ref = ${refuelRef}`;
    return rows.map(refuelOf);
  }
}

const refuelOf = (r: {
  refuel_ref: string;
  network_id: string;
  amount: string;
  tx_ref: string;
  reason: string;
  recorded_by: string;
  recorded_at: Date;
}): RefuelView => ({
  refuelRef: r.refuel_ref,
  networkId: r.network_id,
  amount: r.amount,
  txRef: r.tx_ref,
  reason: r.reason,
  recordedBy: r.recorded_by,
  recordedAt: r.recorded_at.toISOString(),
});
