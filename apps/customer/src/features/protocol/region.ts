import { createContext, useContext } from 'react';

/** The edge's refusal for a request from a region on the screening list (`services/svc-edge/src/geo-block.ts`). */
export const REGION_BLOCKED_CODE = 'edge.geo_blocked';
/** svc-protocol's own jurisdiction guard for a region the business does not serve (`checkAccess`). */
export const REGION_NOT_SERVED_CODE = 'denied.region_blocked';

/** True for either refusal of this visitor's region: the edge's screening list, or a region the business does not serve. */
export const isRegionBlocked = (code: string | undefined | null): boolean =>
  code === REGION_BLOCKED_CODE || code === REGION_NOT_SERVED_CODE;

/** True inside the Web3 shell while the edge refuses this visitor's region. Outside the shell, false. */
export const RegionContext = createContext(false);
export const useRegionBlocked = (): boolean => useContext(RegionContext);
