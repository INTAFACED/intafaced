/**
 * Risk & Compliance — screening-support drafts (§8.2).
 *
 * A draft is a proposal for a human. It is never a compliance decision
 * (tier grant, SAR filing, account clearance). The sanctions list ships empty
 * (`packages/config` screening.ts); JURISDICTION_MATRIX ships with zero
 * `blocked: true` entries. Drafting against that content as if it were a
 * clearance is the failure this module exists to make impossible.
 *
 * Class X: this file does not invent sanctions content or fill matrix blocks.
 */

import {
  envScreeningList,
  SHIPPED_BUSINESS_BLOCKS,
  type BusinessBlock,
  type ScreeningDeclaration,
  type ScreeningList,
} from '@intafaced/config';
import type { CopyKey } from '../copy.js';

export const RISK_COMPLIANCE_REFUSE_COPY = 'agents.error.capability_unavailable' as const satisfies CopyKey;

export type ScreeningDraftRefuseReason = 'screening_unset' | 'screening_empty' | 'inputs_missing' | 'decision_forbidden';

export type ScreeningListHit = {
  readonly region: string;
  readonly reason: string;
  readonly source: string;
  readonly authority: 'screening';
};

export type ScreeningDraftRefuse = {
  readonly status: 'refuse';
  readonly reason: ScreeningDraftRefuseReason;
  readonly kind: 'not_a_decision';
  readonly isDecision: false;
  readonly userMessageKey: typeof RISK_COMPLIANCE_REFUSE_COPY;
  readonly screeningDeclaration: ScreeningDeclaration;
  readonly screeningConfigured: boolean;
  readonly screeningSource: string;
  readonly inventedBlockedList: false;
};

export type ScreeningDraftProposal = {
  readonly status: 'draft';
  readonly kind: 'proposal';
  readonly isDecision: false;
  readonly subjectId: string;
  readonly region: string;
  readonly screeningDeclaration: ScreeningDeclaration;
  readonly screeningConfigured: boolean;
  readonly screeningSource: string;
  readonly listHitCount: number;
  readonly businessHitCount: number;
  /** Echoes counsel-supplied list rows that match `region`. Never synthesized. */
  readonly listHits: readonly ScreeningListHit[];
  readonly inventedBlockedList: false;
};

export type ScreeningSupportResult = ScreeningDraftRefuse | ScreeningDraftProposal;

export type ScreeningDraftInput = {
  readonly subjectId?: string;
  readonly region?: string;
  /** Asking the agent to decide (approve / clear / file) is always refused. */
  readonly asDecision?: boolean;
  /** identity.kyc-review `reviewed_by` is operator-only. */
  readonly writeReviewedBy?: boolean;
  /** Test seam. Production door uses `envScreeningList()`. */
  readonly screening?: ScreeningList;
  /** Test seam. Production door uses shipped matrix blocks (today the US alone, OWNER 237). */
  readonly businessBlocks?: readonly BusinessBlock[];
};

function refuse(reason: ScreeningDraftRefuseReason, screening: ScreeningList): ScreeningDraftRefuse {
  return {
    status: 'refuse',
    reason,
    kind: 'not_a_decision',
    isDecision: false,
    userMessageKey: RISK_COMPLIANCE_REFUSE_COPY,
    screeningDeclaration: screening.declaration,
    screeningConfigured: screening.configured,
    screeningSource: screening.source,
    inventedBlockedList: false,
  };
}

/**
 * Draft screening support, or refuse when the list / inputs cannot support one.
 *
 * Empty / unset screening is unknown — not a cleared account.
 * A populated list still yields a proposal, never a decision.
 */
export function draftScreeningSupport(input: ScreeningDraftInput = {}): ScreeningSupportResult {
  const screening = input.screening ?? envScreeningList();
  const business = input.businessBlocks ?? SHIPPED_BUSINESS_BLOCKS;

  if (input.asDecision === true || input.writeReviewedBy === true) {
    return refuse('decision_forbidden', screening);
  }

  const subjectId = input.subjectId?.trim() ?? '';
  const region = input.region?.trim().toUpperCase() ?? '';
  if (subjectId === '' || region === '') {
    return refuse('inputs_missing', screening);
  }

  if (screening.declaration === 'unset' || screening.configured === false) {
    return refuse('screening_unset', screening);
  }

  if (screening.declaration === 'reviewed-empty' || screening.regions.length === 0) {
    return refuse('screening_empty', screening);
  }

  const listHits: ScreeningListHit[] = screening.regions
    .filter((row) => row.region === region)
    .map((row) => ({
      region: row.region,
      reason: row.reason,
      source: row.source,
      authority: 'screening' as const,
    }));

  const businessHitCount = business.filter((row) => row.region === region).length;

  return {
    status: 'draft',
    kind: 'proposal',
    isDecision: false,
    subjectId,
    region,
    screeningDeclaration: screening.declaration,
    screeningConfigured: screening.configured,
    screeningSource: screening.source,
    listHitCount: listHits.length,
    businessHitCount,
    listHits,
    inventedBlockedList: false,
  };
}

/** True when a result is being sold as a clearance / grant / block decision. */
export function draftPresentedAsDecision(result: ScreeningSupportResult | Record<string, unknown>): boolean {
  const status = result.status;
  const kind = 'kind' in result ? result.kind : undefined;
  const isDecision = 'isDecision' in result ? result.isDecision : undefined;
  if (status === 'ok' || status === 'cleared' || status === 'approved' || status === 'blocked') return true;
  if (status === 'draft' && kind !== 'proposal') return true;
  if (isDecision === true) return true;
  if ('cleared' in result && result.cleared === true) return true;
  if ('approved' in result && result.approved === true) return true;
  return false;
}

/**
 * Empty / unconfigured screening rendered as a green tick.
 * `reviewed-empty` is a recorded counsel decision — still not an agent clearance.
 */
export function looksLikeClearedAccount(result: ScreeningSupportResult | Record<string, unknown>): boolean {
  if (draftPresentedAsDecision(result)) return true;
  const configured = 'screeningConfigured' in result ? result.screeningConfigured : undefined;
  const declaration = 'screeningDeclaration' in result ? result.screeningDeclaration : undefined;
  if (configured === false && 'allowed' in result && result.allowed === true) return true;
  if (declaration === 'unset' && 'blocked' in result && result.blocked === false) return true;
  if (statusOkAsClear(result)) return true;
  return false;
}

function statusOkAsClear(result: ScreeningSupportResult | Record<string, unknown>): boolean {
  return result.status === 'ok';
}

/** Invented `blocked: true` list (the thing this door must not return). */
export function inventedBlockedTrueList(result: ScreeningSupportResult | Record<string, unknown>): boolean {
  if ('inventedBlockedList' in result && result.inventedBlockedList === true) return true;
  if (!('blocked' in result)) return false;
  const blocked = result.blocked;
  if (blocked === true) return true;
  if (!Array.isArray(blocked)) return false;
  return blocked.some((row) => row && typeof row === 'object' && 'blocked' in row && (row as { blocked: unknown }).blocked === true);
}

export function assertProposalOnly(result: ScreeningSupportResult): void {
  if (draftPresentedAsDecision(result)) {
    throw new Error('risk-compliance draft presented as a compliance decision');
  }
  if (looksLikeClearedAccount(result)) {
    throw new Error('empty screening config must not look like a cleared account');
  }
  if (inventedBlockedTrueList(result)) {
    throw new Error('risk-compliance must not invent a blocked:true list');
  }
}
