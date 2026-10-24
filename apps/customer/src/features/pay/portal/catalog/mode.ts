import { useUrlParam } from '../hooks';

export type CatalogMode = 'live' | 'test';

/** Which catalogue a page works on, from `?mode=`: live unless it says test (J-merchant-03 step 6). */
export function useCatalogMode(): [CatalogMode, (mode: CatalogMode) => void] {
  const [value, set] = useUrlParam('mode', 'live');
  return [value === 'test' ? 'test' : 'live', set];
}

/** A catalogue page's address in one catalogue: the live one carries no `?mode`. */
export const inMode = (path: string, mode: CatalogMode) => (mode === 'test' ? `${path}?mode=test` : path);
