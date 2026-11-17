/** The safety room's owner values. An area of svc-bank (`area-chain.ts`). */
export interface SafetyServices {
  /** The owner's notice for a blocked region (`BANK_BLOCKED_REGION_NOTICE`, BK-safe-01). No default: blank reads "not published". */
  readonly blockedRegionNotice?: string | undefined;
}

export interface SafetyServiceOptions {
  /** The owner's notice for a blocked region (`BANK_BLOCKED_REGION_NOTICE`, BK-safe-01). No default: blank reads "not published". */
  blockedRegionNotice?: string | undefined;
}

export function composeSafetyArea(_root: unknown, _made: object, options: SafetyServiceOptions): SafetyServices {
  return { blockedRegionNotice: options.blockedRegionNotice };
}
