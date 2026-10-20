/**
 * Last-resort ADL hitch after insurance cannot cover a bankrupt liquidation.
 *
 * The tick parks the position (no futuresRealizeLoss post, no socialized-loss
 * recipe). This gate then calls {@link runAdlLastResort} with the owner policy
 * or null. Unset / invalid policy → `trade.adl_unconfigured`; the reducer
 * never runs; maxReduceBps is never invented here.
 *
 * Split out of `liquidation-tick.ts` so the hitch stays a small import + two
 * call sites rather than a recut of the scan loop.
 */
import type { Amount } from '@intafaced/ledger-client';
import type { AdlRanking } from './adl-pairing.js';
import { memoryAdlDisclosureStore, type AdlDisclosureStore } from './adl-disclosure.js';
import {
  memoryAdlDisclosureEventStore,
  runAdlLastResort,
  type AdlBankruptPosition,
  type AdlCandidate,
  type AdlDisclosureEventStore,
  type AdlLastResortOutcome,
  type AdlOwnerPolicy,
  type AdlReducePort,
} from './adl-last-resort.js';

export interface LiquidationAdlDeps {
  /**
   * Owner ADL parameters. Null / omitted on the tick → refuse-closed.
   * There is no default maxReduceBps.
   */
  policy: AdlOwnerPolicy | null;
  /**
   * The owner's ranking formula, applied by the candidate loader. Null / omitted
   * → refuse-closed like an unset policy (docs/adr/2026-10-20-futures-matched-traders.md
   * section 6). `TEST_ADL_RANKING` is for the test rig only.
   */
  ranking?: AdlRanking | null;
  /**
   * Opposing-side candidates in owner-chosen order. This gate does not rank
   * (D5). Unused when policy is unset — refuse returns before they matter.
   */
  candidates?: readonly AdlCandidate[] | ((bankrupt: AdlBankruptPosition) => Promise<readonly AdlCandidate[]>);
  /**
   * Drive any planned ADL pair touching a position before anything else is
   * decided for it (`adl-pairing.ts`). True when one was driven.
   */
  replayPlanned?: (positionId: string) => Promise<boolean>;
  disclosureAcks?: AdlDisclosureStore;
  events?: AdlDisclosureEventStore;
  reducer?: AdlReducePort;
  newEventId?: () => string;
}

function refuseReducer(): AdlReducePort {
  return {
    async reduce() {
      throw new Error('ADL reducer must not run when owner policy is unset — no socialized-loss default');
    },
  };
}

/**
 * Drive last-resort ADL after insurance cannot cover.
 *
 * Always calls `runAdlLastResort` (even when `adl` is omitted) so the refuse
 * is the same unit that already pins unset policy. Default policy is null.
 */
export async function runLastResortAdlAfterInsuranceUnderfunded(input: {
  adl: LiquidationAdlDeps | undefined;
  bankrupt: AdlBankruptPosition;
  at: Date;
}): Promise<AdlLastResortOutcome> {
  const policy = input.adl?.ranking ? (input.adl.policy ?? null) : null;
  const candidates =
    policy == null || input.adl?.candidates == null
      ? []
      : typeof input.adl.candidates === 'function'
        ? await input.adl.candidates(input.bankrupt)
        : input.adl.candidates;

  return runAdlLastResort({
    policy,
    bankrupt: input.bankrupt,
    candidates,
    disclosureAcks: input.adl?.disclosureAcks ?? memoryAdlDisclosureStore(),
    events: input.adl?.events ?? memoryAdlDisclosureEventStore(),
    reducer: input.adl?.reducer ?? refuseReducer(),
    at: input.at,
    newEventId:
      input.adl?.newEventId ??
      (() => {
        throw new Error('ADL event id must not mint when owner policy is unset');
      }),
  });
}

export interface ParkedUnderfundedItem {
  positionId: string;
  outcome: 'skipped_insurance_underfunded';
  reason: string;
  summary: string;
}

/**
 * Park the bankrupt rung and surface the ADL outcome on the tick item.
 *
 * Outcome stays `skipped_insurance_underfunded` (position open, no post).
 * Reason is the ADL code — unset policy → `trade.adl_unconfigured`.
 */
export async function parkUnderfundedWithAdl(input: {
  adl: LiquidationAdlDeps | undefined;
  row: { positionId: string; userId: string; marketId: string; side: 'long' | 'short'; size?: Amount };
  fromInsurance: Amount;
  insuranceReason: string;
  at: Date;
}): Promise<ParkedUnderfundedItem> {
  const adl = await runLastResortAdlAfterInsuranceUnderfunded({
    adl: input.adl,
    bankrupt: {
      positionId: input.row.positionId,
      userId: input.row.userId,
      marketId: input.row.marketId,
      side: input.row.side,
      uncoveredShortfall: input.fromInsurance,
      ...(input.row.size !== undefined ? { size: input.row.size } : {}),
    },
    at: input.at,
  });
  return {
    positionId: input.row.positionId,
    outcome: 'skipped_insurance_underfunded',
    reason: adl.code,
    summary: `${input.insuranceReason}; last-resort ADL: ${adl.action === 'refused' ? adl.reason : adl.code}`,
  };
}
