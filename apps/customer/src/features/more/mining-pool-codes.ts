/** The pool's typed refusal codes the mining rooms answer in their own words, and the overview's published sections. */

export const OVERVIEW_UNSET = 'mining.overview_unset';
export const CONNECTION_UNSET = 'mining.connection_unset';
export const PROBE_REFUSALS: Readonly<Record<string, 'probeLimit' | 'probeLimitUnset' | 'probeTimeoutUnset' | 'probeTargetUnset'>> = {
  'mining.probe_limit_reached': 'probeLimit',
  'mining.probe_limit_unset': 'probeLimitUnset',
  'mining.probe_timeout_unset': 'probeTimeoutUnset',
  [CONNECTION_UNSET]: 'probeTargetUnset',
};

/** The overview's sections, in the order they are drawn, each with its field in the published overview. */
export const SECTIONS = [
  { key: 'coin', field: 'coin' },
  { key: 'hardware', field: 'hardware' },
  { key: 'revenueSplit', field: 'revenueSplit' },
  { key: 'notSupported', field: 'notSupported' },
] as const;
