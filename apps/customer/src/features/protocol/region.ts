import { createContext, useContext } from 'react';

/** The edge's refusal for a request from a region on the screening list (`services/svc-edge/src/geo-block.ts`). */
export const REGION_BLOCKED_CODE = 'edge.geo_blocked';

/** True inside the Web3 shell while the edge refuses this visitor's region. Outside the shell, false. */
export const RegionContext = createContext(false);
export const useRegionBlocked = (): boolean => useContext(RegionContext);
