/**
 * Rulebook refuse (PX-S03 / M00 M02 / PTX-M00-R04 PTX-M02-R03 PTX-M02-R06 PTX-M02-R08).
 * Emergency actions need authority+evidence. Corporate delist needs an owner policy.
 * Permissionless listings refuse. The engine does not invent evidence, a corporate
 * action, or a listing. Hitch: imported from index.ts so MatchingEngine is wrapped
 * without recutting engine.ts.
 */
import { MatchingEngine, type EmergencyCmd } from './engine.js';
import { operatorRefuse, readOperatorId } from './halt.js';
import type { MarketDelistResult, MarketExpireResult, MarketHaltResult, MarketId, VenueKillResult } from './types.js';

export const MISSING_EVIDENCE = 'missing_evidence' as const;
export const DELIST_POLICY_MISSING = 'delist_policy_missing' as const;
export const PERMISSIONLESS_LISTING = 'permissionless_listing' as const;

export const MISSING_EVIDENCE_MESSAGE = 'emergency action requires authority and evidence; the engine does not invent evidence';
export const DELIST_POLICY_MISSING_MESSAGE = 'delist requires an owner policy; the engine does not invent a corporate action';
export const PERMISSIONLESS_LISTING_MESSAGE = 'permissionless listings refuse; the engine does not invent a listing';

const FLAG = Symbol.for('intafaced.matching.rulebook-refuse');

export type { EmergencyCmd };

export type DelistCmd = {
  readonly operatorId?: string | null;
  readonly policyId?: string | null;
  readonly policyVersion?: string | null;
};

export type ListMarketCmd = {
  readonly marketId?: string | null;
  readonly permissionless?: boolean | null;
  readonly listingPolicy?: string | null;
  readonly listingAuthority?: string | null;
};

export type RulebookRefuse = {
  readonly code: typeof MISSING_EVIDENCE | typeof DELIST_POLICY_MISSING | typeof PERMISSIONLESS_LISTING;
  readonly message: string;
};

export type MarketListResult = {
  readonly accepted: boolean;
  readonly marketId: string | null;
  readonly listed: false;
  readonly rejected?: RulebookRefuse;
};

function readNonBlank(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null) return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function evidenceRefCounts(ref: unknown): boolean {
  return typeof ref === 'string' && readNonBlank(ref) !== null;
}

export function hasEvidence(cmd: EmergencyCmd): boolean {
  if (readNonBlank(cmd.evidence) !== null) return true;
  const refs = cmd.evidenceRefs;
  if (!Array.isArray(refs)) return false;
  for (const ref of refs) {
    if (evidenceRefCounts(ref)) return true;
  }
  return false;
}

export function evidenceRefuse(cmd: EmergencyCmd): { readonly code: typeof MISSING_EVIDENCE; readonly message: string } | null {
  if (hasEvidence(cmd)) return null;
  return { code: MISSING_EVIDENCE, message: MISSING_EVIDENCE_MESSAGE };
}

export function hasDelistPolicy(cmd: DelistCmd): boolean {
  return readNonBlank(cmd.policyId) !== null || readNonBlank(cmd.policyVersion) !== null;
}

export function delistPolicyRefuse(cmd: DelistCmd): { readonly code: typeof DELIST_POLICY_MISSING; readonly message: string } | null {
  if (hasDelistPolicy(cmd)) return null;
  return { code: DELIST_POLICY_MISSING, message: DELIST_POLICY_MISSING_MESSAGE };
}

export function listingRefuse(cmd: ListMarketCmd): { readonly code: typeof PERMISSIONLESS_LISTING; readonly message: string } | null {
  if (cmd.permissionless === true) {
    return { code: PERMISSIONLESS_LISTING, message: PERMISSIONLESS_LISTING_MESSAGE };
  }
  if (readNonBlank(cmd.listingPolicy) === null || readNonBlank(cmd.listingAuthority) === null) {
    return { code: PERMISSIONLESS_LISTING, message: PERMISSIONLESS_LISTING_MESSAGE };
  }
  return null;
}

type EmergencyGate =
  | {
      readonly operatorId: string | null;
      readonly rejected: { readonly code: string; readonly message: string };
    }
  | { readonly operatorId: string; readonly rejected: null };

function emergencyGate(cmd: EmergencyCmd): EmergencyGate {
  const operatorId = readOperatorId(cmd);
  const missing = operatorRefuse(operatorId);
  if (missing) return { operatorId: null, rejected: missing };
  const evidence = evidenceRefuse(cmd);
  if (evidence) return { operatorId, rejected: evidence };
  return { operatorId: operatorId as string, rejected: null };
}

export function installRulebookRefuse(ctor: typeof MatchingEngine = MatchingEngine): void {
  const proto = ctor.prototype as {
    halt: (marketId: MarketId, cmd: EmergencyCmd) => Promise<MarketHaltResult>;
    resume: (marketId: MarketId, cmd: EmergencyCmd) => Promise<MarketHaltResult>;
    haltAll: (cmd: EmergencyCmd) => Promise<VenueKillResult>;
    resumeAll: (cmd: EmergencyCmd) => Promise<VenueKillResult>;
    expire: (marketId: MarketId, cmd: EmergencyCmd) => Promise<MarketExpireResult>;
    delist: (marketId: MarketId, cmd: DelistCmd) => Promise<MarketDelistResult>;
    listMarket?: (cmd: ListMarketCmd) => Promise<MarketListResult>;
    isHalted: (marketId: MarketId) => boolean;
    isExpired: (marketId: MarketId) => boolean;
    isDelisted: (marketId: MarketId) => boolean;
    isVenueHalted: boolean;
    [FLAG]?: boolean;
  };
  if (proto[FLAG]) return;
  proto[FLAG] = true;

  const origHalt = proto.halt;
  const origResume = proto.resume;
  const origHaltAll = proto.haltAll;
  const origResumeAll = proto.resumeAll;
  const origExpire = proto.expire;
  const origDelist = proto.delist;
  const origList = proto.listMarket;

  proto.halt = async function (this: MatchingEngine, marketId: MarketId, cmd: EmergencyCmd) {
    const gate = emergencyGate(cmd);
    if (gate.rejected) {
      return {
        accepted: false,
        marketId,
        halted: this.isHalted(marketId),
        operatorId: gate.operatorId,
        rejected: gate.rejected,
      } as MarketHaltResult;
    }
    return origHalt.call(this, marketId, cmd);
  };

  proto.resume = async function (this: MatchingEngine, marketId: MarketId, cmd: EmergencyCmd) {
    const gate = emergencyGate(cmd);
    if (gate.rejected) {
      return {
        accepted: false,
        marketId,
        halted: this.isHalted(marketId),
        operatorId: gate.operatorId,
        rejected: gate.rejected,
      } as MarketHaltResult;
    }
    return origResume.call(this, marketId, cmd);
  };

  proto.haltAll = async function (this: MatchingEngine, cmd: EmergencyCmd) {
    const gate = emergencyGate(cmd);
    if (gate.rejected) {
      return {
        accepted: false,
        halted: this.isVenueHalted,
        operatorId: gate.operatorId,
        rejected: gate.rejected,
      } as VenueKillResult;
    }
    return origHaltAll.call(this, cmd);
  };

  proto.resumeAll = async function (this: MatchingEngine, cmd: EmergencyCmd) {
    const gate = emergencyGate(cmd);
    if (gate.rejected) {
      return {
        accepted: false,
        halted: this.isVenueHalted,
        operatorId: gate.operatorId,
        rejected: gate.rejected,
      } as VenueKillResult;
    }
    return origResumeAll.call(this, cmd);
  };

  proto.expire = async function (this: MatchingEngine, marketId: MarketId, cmd: EmergencyCmd) {
    const gate = emergencyGate(cmd);
    if (gate.rejected) {
      return {
        accepted: false,
        marketId,
        expired: this.isExpired(marketId),
        operatorId: gate.operatorId,
        rejected: gate.rejected,
      } as MarketExpireResult;
    }
    return origExpire.call(this, marketId, cmd);
  };

  proto.delist = async function (this: MatchingEngine, marketId: MarketId, cmd: DelistCmd) {
    const operatorId = readOperatorId(cmd);
    const missing = operatorRefuse(operatorId);
    if (missing) {
      return {
        accepted: false,
        marketId,
        delisted: this.isDelisted(marketId),
        operatorId: null,
        rejected: missing,
      };
    }
    const policy = delistPolicyRefuse(cmd);
    if (policy) {
      return {
        accepted: false,
        marketId,
        delisted: this.isDelisted(marketId),
        operatorId,
        rejected: { code: policy.code, message: policy.message },
      };
    }
    return origDelist.call(this, marketId, cmd);
  };

  proto.listMarket = async function (this: MatchingEngine, cmd: ListMarketCmd) {
    const marketId = readNonBlank(cmd?.marketId);
    const refused = listingRefuse(cmd ?? {});
    if (refused) {
      return {
        accepted: false,
        marketId,
        listed: false,
        rejected: refused,
      };
    }
    if (typeof origList === 'function') {
      return origList.call(this, cmd);
    }
    return { accepted: false, marketId, listed: false };
  };
}

try {
  installRulebookRefuse();
} catch {
  queueMicrotask(() => installRulebookRefuse());
}
