/**
 * W1 CONTROL-ROOM ROWS FOR THE ISOLATION WORLD.
 *
 * Every number here is a TEST VALUE (control.testkit.ts), not a proposal for a real tier. The seed gives
 * each of the eight merchants a tier, a payout destination and ONE pending payout approval made by its
 * own owner (the maker), so an id-taking `merchantControl.*` procedure has a real row to aim at. It also
 * leaves the founder side a real, one-shot target for each founder procedure that takes an id.
 */
import { founderChangeHash } from '@intafaced/contracts/founder-change-hash';
import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import type { Principal } from '@intafaced/auth';
import { ChangeService } from '../../src/control/changes.js';
import { ControlService } from '../../src/control/service.js';
import { teamAccessPorts } from '../../src/control/access.js';
import { MerchantPayoutDestinationStore } from '../../src/merchant-payout-destination.js';
import { applyChange, FOUNDER_1, TEST_GLOBAL_RULE, TEST_TIER } from '../../src/control/control.testkit.js';

/** Approval needed from 50, two founders from 1000: the seeded settlements (net 97.5) need a checker and no founder. */
export const ISOLATION_TIER = {
  ...TEST_TIER,
  id: 'iso-tier',
  name: 'TEST VALUE isolation tier',
  founderThresholds: [{ assetCode: 'USDT', amount: '1000' }],
};
const SECOND_TIER = { ...ISOLATION_TIER, id: 'iso-tier-2', name: 'TEST VALUE isolation tier 2' };

export interface ControlSeedEntity {
  readonly tag: string;
  readonly userId: string;
  readonly merchantId: string;
  readonly settlementId: string;
}

export interface ControlSeed {
  /** tag -> the pending approval its owner (the maker) requested on `settlementId`. */
  readonly approvalIds: Readonly<Record<string, string>>;
  /** A pending approval that needs founders and already has its merchant-side checker: the founder positive control signs it. */
  readonly founderApprovalId: string;
  readonly founderApprovalHash: string;
  /** Pending requests opened by a DIFFERENT founder, for the founder positive controls of the two `confirm` procedures. */
  readonly pendingMerchantChangeId: string;
  readonly pendingConfigureId: string;
  /** The hash each pending request was stored under; a confirm must carry it. */
  readonly pendingMerchantChangeHash: string;
  readonly pendingConfigureHash: string;
  /** The merchant the pending merchant change names, and the one the founder positive control submits against. */
  readonly changeMerchantId: string;
  /** The profile version the founder `changes.submit` positive control expects. */
  readonly changeMerchantVersion: string;
  /** One pending limit ask, closed by the founder positive control. */
  readonly pendingLimitRequestId: string;
}

export async function seedControl(
  sql: Sql,
  entities: readonly ControlSeedEntity[],
  makePrincipal: (userId: string) => Principal,
  destination: { railId: string; kind: string; ref: string },
): Promise<ControlSeed> {
  const changes = new ChangeService(sql);
  const control = new ControlService(sql, teamAccessPorts(sql));
  const destinations = new MerchantPayoutDestinationStore(sql);

  await applyChange(changes, sql, { scope: 'tier', change: { kind: 'upsert_tier', tier: ISOLATION_TIER } });
  await applyChange(changes, sql, {
    scope: 'pricing',
    change: { kind: 'set_pricing_layer', layer: 'global', scopeId: null, rules: [TEST_GLOBAL_RULE] },
  });

  const approvalIds: Record<string, string> = {};
  for (const e of entities) {
    await applyChange(changes, sql, {
      scope: 'merchant',
      merchantId: e.merchantId,
      change: { kind: 'set_tier', tierId: ISOLATION_TIER.id, archetypeId: null },
    });
    await destinations.persist({ merchantId: e.merchantId, ...destination });
    const approval = await control.approvals.request(makePrincipal(e.userId), {
      merchantId: e.merchantId,
      settlementId: e.settlementId,
      railId: destination.railId,
    });
    approvalIds[e.tag] = approval.approvalId;
  }

  // The founder-side payout approval: needs founders, merchant-side checker already done (by someone who is nobody's maker).
  const target = entities[entities.length - 1]!;
  const rows = await sql<Array<{ id: string; payload_hash: string }>>`
    UPDATE pay.control_payout_approvals
       SET founder_required = true, checker_user_id = ${randomUUID()}, checker_reason = 'isolation seed', checker_decided_at = now()
     WHERE id = ${approvalIds[target.tag]!}
     RETURNING id, payload_hash`;

  // A merchant change another founder has already submitted, and a tier change likewise.
  const changeMerchant = entities[entities.length - 2]!;
  const versionRows = await sql<Array<{ version: string }>>`
    SELECT version FROM pay.control_merchant_profiles WHERE merchant_id = ${changeMerchant.merchantId}`;
  const changeMerchantVersion = versionRows[0]?.version ?? '0';
  const pendingMerchantChangeId = randomUUID();
  const merchantTarget = {
    scope: 'merchant',
    merchantId: changeMerchant.merchantId,
    change: { kind: 'set_tier', tierId: ISOLATION_TIER.id, archetypeId: 'standard' },
  } as const;
  const merchantSubmit = await changes.submit(FOUNDER_1, {
    requestId: pendingMerchantChangeId,
    target: merchantTarget,
    reason: 'isolation seed',
    expectedVersion: changeMerchantVersion,
  });
  if (merchantSubmit.outcome !== 'pending_second_approval') throw new Error(`seed merchant change ${merchantSubmit.outcome}`);
  const pendingConfigureId = randomUUID();
  const configureTarget = { scope: 'tier', change: { kind: 'upsert_tier', tier: SECOND_TIER } } as const;
  const configureSubmit = await changes.submit(FOUNDER_1, {
    requestId: pendingConfigureId,
    target: configureTarget,
    reason: 'isolation seed',
    expectedVersion: '0',
  });
  if (configureSubmit.outcome !== 'pending_second_approval') throw new Error(`seed tier change ${configureSubmit.outcome}`);

  const askMerchant = entities[0];
  if (!askMerchant) throw new Error('seed limit request needs a merchant');
  const pendingLimitRequestId = randomUUID();
  const asked = await control.requestLimitIncrease(makePrincipal(askMerchant.userId), {
    merchantId: askMerchant.merchantId,
    requestId: pendingLimitRequestId,
    caps: [{ kind: 'per_payment', assetCode: 'USDT', limit: '10' }],
    reason: 'isolation seed ask',
  });
  if (asked.outcome !== 'stored') throw new Error(`seed limit request ${asked.outcome}`);

  return {
    approvalIds,
    founderApprovalId: rows[0]!.id,
    founderApprovalHash: rows[0]!.payload_hash,
    pendingMerchantChangeId,
    pendingConfigureId,
    pendingMerchantChangeHash: founderChangeHash(merchantTarget, changeMerchantVersion),
    pendingConfigureHash: founderChangeHash(configureTarget, '0'),
    changeMerchantId: changeMerchant.merchantId,
    changeMerchantVersion,
    pendingLimitRequestId,
  };
}
