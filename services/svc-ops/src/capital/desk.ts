import { createHash } from 'node:crypto';
import { add, compare, formatAmount, mul, parseAmount, sub, type Amount } from '@intafaced/ledger-client';
import {
  OPS_CAPITAL_ASSET,
  OPS_CAPITAL_CONTACT_MAX,
  OPS_CAPITAL_MINIMUM,
  OPS_CAPITAL_REASON_MAX,
  OPS_CAPITAL_REASON_MIN,
  OPS_CAPITAL_SCENARIO_INPUT_MISSING,
  OPS_CAPITAL_SOURCE_UNAVAILABLE,
  OPS_CAPITAL_STORAGE_UNCONFIGURED,
  OPS_CAPITAL_TARGET_SERVICE,
  OPS_CAPITAL_THRESHOLD_ACTION,
  OPS_CAPITAL_THRESHOLD_INVALID,
  OPS_CAPITAL_THRESHOLD_UNSET,
  OPS_CAPITAL_VENUE_NOT_CONNECTED,
  opsCapitalBreachKey,
  opsCapitalThresholdFields,
  opsCapitalThresholdTargetId,
  type LedgerOwnFunds,
  type OpsCapitalBuffer,
  type OpsCapitalOwnFunds,
  type OpsCapitalScenario,
  type OpsCapitalScenarioInput,
  type OpsCapitalSnapshot,
  type OpsCapitalThreshold,
  type OpsCapitalThresholdSetInput,
  type OpsCapitalThresholdSetOutput,
  type OpsCapitalVenues,
} from '@intafaced/contracts';
import { OpsError } from '../codes.js';
import { assertIdempotencyKey, consumeFounderApproval, type ApprovalConsumer } from '../operator-desks.js';
import type { CapitalSources, SourceRead } from './sources.js';
import { capitalFingerprint, type CapitalStore, type StoredThreshold } from './store.js';

const ALERT_LIST_LIMIT = 50;

/** How often svc-ops evaluates the monitor with nobody watching. An engineering cadence, not a policy figure. */
export const CAPITAL_EVALUATE_MS = 60_000;

/** The UTC day a breach is counted in: one alert per asset per day. */
export function breachDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** No venue adapter reports a builder account to svc-ops yet: said in words, never as an empty list of venues. */
export const VENUES_NOT_CONNECTED: OpsCapitalVenues = {
  status: 'not_connected',
  code: OPS_CAPITAL_VENUE_NOT_CONNECTED,
  message: 'No venue adapter reports INTAFACED’s builder account to this console yet, so no venue balance or published minimum is shown.',
};

/** The ledger's accounts summed per asset. A source that could not be read is "unknown", never zero. */
export function composeOwnFunds(read: SourceRead<LedgerOwnFunds>): OpsCapitalOwnFunds {
  if (!read.ok) return { status: 'unknown', code: read.code, message: read.message };
  const sums = new Map<string, { amount: Amount; accounts: number }>();
  for (const a of read.value.accounts) {
    const prior = sums.get(a.assetId) ?? { amount: 0n, accounts: 0 };
    sums.set(a.assetId, { amount: add(prior.amount, parseAmount(a.balance)), accounts: prior.accounts + 1 });
  }
  return {
    status: 'read',
    asOf: read.value.asOf,
    assets: [...sums.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([assetId, s]) => ({ assetId, amount: formatAmount(s.amount), accounts: s.accounts })),
    accounts: read.value.accounts,
  };
}

function thresholdView(stored: StoredThreshold | undefined): OpsCapitalThreshold {
  if (!stored || stored.minimum === null) return { status: 'unset', code: OPS_CAPITAL_THRESHOLD_UNSET };
  return {
    status: 'set',
    minimum: stored.minimum,
    contact: stored.contact,
    version: stored.version,
    reason: stored.reason,
    setAt: stored.setAt,
    setBy: stored.setBy,
    approvedBy: stored.approvedBy,
  };
}

/**
 * One row per asset that has own funds or a threshold. A blank threshold is `not_monitored` with its typed code, never
 * `ok`. With the ledger unread, a set threshold is `unknown`: neither ok nor a breach, and no alert is opened.
 */
export function composeBuffers(ownFunds: OpsCapitalOwnFunds, thresholds: ReadonlyMap<string, StoredThreshold>): OpsCapitalBuffer[] {
  const held = new Map(ownFunds.status === 'read' ? ownFunds.assets.map((a) => [a.assetId, a.amount]) : []);
  const assets = [...new Set([...held.keys(), ...[...thresholds.values()].filter((t) => t.minimum !== null).map((t) => t.assetId)])].sort();
  return assets.map((assetId) => {
    const threshold = thresholdView(thresholds.get(assetId));
    // The ledger answered: an asset it holds none of is zero, because it answered and booked none.
    const buffer = ownFunds.status === 'read' ? (held.get(assetId) ?? '0') : null;
    const state: OpsCapitalBuffer['state'] =
      threshold.status === 'unset'
        ? 'not_monitored'
        : buffer === null
          ? 'unknown'
          : compare(parseAmount(buffer), parseAmount(threshold.minimum)) < 0
            ? 'below_minimum'
            : 'ok';
    return { assetId, buffer, threshold, state };
  });
}

export interface CapitalDeskDeps {
  readonly store: CapitalStore | undefined;
  readonly sources: CapitalSources;
  readonly approvals: ApprovalConsumer | undefined;
  readonly venues?: () => Promise<OpsCapitalVenues>;
  readonly now: () => Date;
}

/**
 * The capital monitor (RC-ops-console-06). Reads only; the one write is a founder's threshold change under a second
 * founder's approval. No ledger-client recipe is called and no entry is assembled: nothing here moves money.
 */
export class CapitalDesk {
  constructor(private readonly deps: CapitalDeskDeps) {}

  private store(): CapitalStore {
    if (!this.deps.store) {
      throw new OpsError(
        OPS_CAPITAL_STORAGE_UNCONFIGURED,
        'No durable storage is configured for capital thresholds. Nothing was read or saved.',
      );
    }
    return this.deps.store;
  }

  /**
   * When the monitor evaluates: read every source, judge each asset against its threshold, and open one breach alert per
   * asset and UTC day for a buffer below a set minimum, escalated to the contact the threshold names.
   */
  async snapshot(): Promise<OpsCapitalSnapshot> {
    const store = this.store();
    const at = this.deps.now();
    const day = breachDay(at);
    const [funds, reserves, thresholds, venues] = await Promise.all([
      this.deps.sources.ownFunds(),
      this.deps.sources.partnerReserves(),
      store.thresholds(),
      this.deps.venues ? this.deps.venues() : Promise.resolve(VENUES_NOT_CONNECTED),
    ]);
    const ownFunds = composeOwnFunds(funds);
    const buffers = composeBuffers(ownFunds, thresholds);
    for (const b of buffers) {
      if (b.state !== 'below_minimum' || b.threshold.status !== 'set' || b.buffer === null) continue;
      await store.openBreach({
        key: opsCapitalBreachKey(b.assetId, day),
        assetId: b.assetId,
        period: day,
        buffer: b.buffer,
        minimum: b.threshold.minimum,
        escalatedTo: b.threshold.contact,
        openedAt: at.toISOString(),
        thresholdVersion: b.threshold.version,
      });
    }
    return {
      asOf: at.toISOString(),
      period: day,
      ownFunds,
      venues,
      reserves: reserves.ok
        ? { status: 'read', asOf: reserves.value.asOf, partners: reserves.value.partners }
        : { status: 'unknown', code: reserves.code, message: reserves.message },
      buffers,
      alerts: [...(await store.alerts(ALERT_LIST_LIMIT))],
    };
  }

  /** Set or clear one asset's minimum. Validated before the approval is spent; one approval is one version. */
  async setThreshold(requesterId: string, input: OpsCapitalThresholdSetInput): Promise<OpsCapitalThresholdSetOutput> {
    const store = this.store();
    const fields = parseThresholdChange(input);
    const key = assertIdempotencyKey(input.idempotencyKey);
    const fingerprint = capitalFingerprint({ ...fields, approvalId: input.approvalId.trim(), operationId: input.operationId.trim() });
    const prior = await store.find(key, fingerprint);
    if (prior)
      return { assetId: prior.assetId, minimum: prior.minimum ?? '', contact: prior.contact, version: prior.version, outcome: 'replayed' };
    const consumed = await consumeFounderApproval(this.deps.approvals, {
      approvalId: input.approvalId,
      operationId: input.operationId,
      actionType: OPS_CAPITAL_THRESHOLD_ACTION,
      targetService: OPS_CAPITAL_TARGET_SERVICE,
      targetId: opsCapitalThresholdTargetId(fields.assetId),
      // Both founders signed the minimum as it was typed; the stored figure is its normalised form.
      fields: opsCapitalThresholdFields(fields.assetId, fields.signedMinimum, fields.contact, fields.reason),
      requesterId,
      // A retry after a crash between the spend and the write finds the spend again instead of being refused.
      requestId: `capital-threshold:${createHash('sha256').update(key).digest('hex')}`,
    });
    const stored = await store.append({
      key,
      fingerprint,
      assetId: fields.assetId,
      minimum: fields.minimum === '' ? null : fields.minimum,
      contact: fields.contact,
      reason: fields.reason,
      approvalId: consumed.approvalId,
      setBy: consumed.requesterId,
      approvedBy: consumed.approverId ?? '',
      setAt: this.deps.now().toISOString(),
    });
    return {
      assetId: stored.assetId,
      minimum: stored.minimum ?? '',
      contact: stored.contact,
      version: stored.version,
      outcome: stored.minimum === null ? 'cleared' : 'set',
    };
  }

  /**
   * A counterparty default: the loss is the exposure times the loss share (rounded up at the 18th decimal, so a loss is
   * never understated), set against INTAFACED's own funds from a fresh ledger read. With the ledger unread, no scenario
   * runs: `ops.capital.source_unavailable`, never a result on stale or missing data.
   */
  async scenario(input: OpsCapitalScenarioInput): Promise<OpsCapitalScenario> {
    const store = this.store();
    const s = parseScenario(input);
    const funds = composeOwnFunds(await this.deps.sources.ownFunds());
    if (funds.status !== 'read') {
      throw new OpsError(OPS_CAPITAL_SOURCE_UNAVAILABLE, `No scenario was run: INTAFACED’s own funds could not be read (${funds.message})`);
    }
    const before = parseAmount(funds.assets.find((a) => a.assetId === s.assetId)?.amount ?? '0');
    const loss = mul(parseAmount(s.exposure), parseAmount(s.lossShare), 'ceil');
    const after = sub(before, loss);
    const threshold = thresholdView((await store.thresholds()).get(s.assetId));
    return {
      asOf: funds.asOf,
      kind: 'counterparty_default',
      counterparty: s.counterparty,
      assetId: s.assetId,
      exposure: formatAmount(parseAmount(s.exposure)),
      lossShare: formatAmount(parseAmount(s.lossShare)),
      loss: formatAmount(loss),
      ownFundsBefore: formatAmount(before),
      ownFundsAfter: formatAmount(after),
      threshold,
      stateAfter:
        threshold.status === 'unset' ? 'not_monitored' : compare(after, parseAmount(threshold.minimum)) < 0 ? 'below_minimum' : 'ok',
    };
  }
}

/** What a founder asked for, trimmed and checked. Every failure is its own typed refusal, before any approval is spent. */
export function parseThresholdChange(input: Pick<OpsCapitalThresholdSetInput, 'assetId' | 'minimum' | 'contact' | 'reason'>) {
  const assetId = input.assetId.trim();
  const minimum = input.minimum.trim();
  const contact = input.contact.trim();
  const reason = input.reason.trim();
  const invalid = (why: string) => new OpsError(OPS_CAPITAL_THRESHOLD_INVALID, `${why} Nothing was saved.`);
  if (!OPS_CAPITAL_ASSET.test(assetId)) throw invalid('The asset is an upper-case code such as USDT.');
  if (minimum !== '' && !OPS_CAPITAL_MINIMUM.test(minimum)) {
    throw invalid('The minimum is a decimal with no leading zeros, at most 20 whole digits and 18 decimals, or blank to clear it.');
  }
  if (minimum !== '' && (contact.length < 1 || contact.length > OPS_CAPITAL_CONTACT_MAX)) {
    throw invalid(`A minimum needs the contact a breach is escalated to (1 to ${OPS_CAPITAL_CONTACT_MAX} characters).`);
  }
  if (minimum === '' && contact !== '') throw invalid('Clearing a threshold names no contact.');
  if (reason.length < OPS_CAPITAL_REASON_MIN || reason.length > OPS_CAPITAL_REASON_MAX) {
    throw invalid(`The reason is ${OPS_CAPITAL_REASON_MIN} to ${OPS_CAPITAL_REASON_MAX} characters.`);
  }
  return { assetId, signedMinimum: minimum, minimum: minimum === '' ? '' : formatAmount(parseAmount(minimum)), contact, reason };
}

const DECIMAL = /^\d+(\.\d{1,18})?$/;

function parseScenario(input: OpsCapitalScenarioInput) {
  const counterparty = input.counterparty?.trim() ?? '';
  const assetId = input.assetId?.trim() ?? '';
  const exposure = input.exposure?.trim() ?? '';
  const lossShare = input.lossShare?.trim() ?? '';
  const missing = [
    counterparty.length < 1 || counterparty.length > 200 ? 'counterparty' : null,
    OPS_CAPITAL_ASSET.test(assetId) ? null : 'asset',
    DECIMAL.test(exposure) ? null : 'exposure',
    DECIMAL.test(lossShare) && compare(parseAmount(lossShare), parseAmount('1')) <= 0 ? null : 'loss share (0 to 1)',
  ].filter((m): m is string => m !== null);
  if (missing.length) {
    throw new OpsError(OPS_CAPITAL_SCENARIO_INPUT_MISSING, `No scenario was run: enter the ${missing.join(', ')}. Nothing is assumed.`);
  }
  return { counterparty, assetId, exposure, lossShare };
}
