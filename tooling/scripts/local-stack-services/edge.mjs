import path from 'node:path';

export default ({
  c,
  secrets,
  urlOf,
  PORTS,
  P,
  UNUSED,
  CUSTOMER_ORIGIN,
  CUSTOMER_LOCALHOST_ORIGIN,
  INVITATION_ORIGIN,
  EDGE_UPSTREAMS,
  EDGE_ABSENT,
}) => ({
  name: 'edge',
  env: () => {
    const env = {
      ...c('svc-edge', PORTS.edge),
      IDENTITY_OWNERSHIP_SECRET: secrets.edgeAuthority,
      EDGE_ALLOWED_ORIGINS: `${CUSTOMER_ORIGIN},${CUSTOMER_LOCALHOST_ORIGIN},${INVITATION_ORIGIN}`,
      EDGE_RATE_LIMIT_ENABLED: 'true',
      // Required, no default. LOCAL TEST values (generous: the UI polls).
      EDGE_RATE_LIMIT_MAX: '1200',
      EDGE_RATE_LIMIT_WINDOW_MS: '60000',
      EDGE_BODY_LIMIT_BYTES: '1048576',
      EDGE_KILL_STATE_PATH: path.join(P.data, 'edge-kill-state.json'),
    };
    for (const [k, service] of Object.entries(EDGE_UPSTREAMS)) env[k] = urlOf(service);
    for (const k of Object.keys(EDGE_ABSENT)) env[k] = UNUSED; // nothing listens; answers 502 by design
    // Screening: pass through ONLY what is already in the caller's environment.
    // Never set, default or invent a sanctions list.
    return env;
  },
});
