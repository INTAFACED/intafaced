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
      // Required, no default. LOCAL TEST values. Every journey on a shard comes from one address, so this is the whole
      // shard's budget, the polling pages it leaves open included: at 1200 a minute it ran out mid-run and the next
      // steps were refused edge.rate_limited, sign-in included (runs 581 and 586 on main: J-cex-spot-02 #6,
      // J-cex-spot-06 #5-6, J-derivatives-02 #6). Edge's own tests prove the limit; the journeys aren't about it.
      EDGE_RATE_LIMIT_MAX: '6000',
      EDGE_RATE_LIMIT_WINDOW_MS: '60000',
      EDGE_BODY_LIMIT_BYTES: '1048576',
      // Owner value, blank in git. LOCAL TEST: the same edge answers as the sandbox host at localhost and as the live
      // host at 127.0.0.1, so J-developer-02 can call one key at both and see env.mismatch at the live one.
      EDGE_SANDBOX_HOSTS: `localhost:${PORTS.edge}`,
      EDGE_KILL_STATE_PATH: path.join(P.data, 'edge-kill-state.json'),
    };
    for (const [k, service] of Object.entries(EDGE_UPSTREAMS)) env[k] = urlOf(service);
    for (const k of Object.keys(EDGE_ABSENT)) env[k] = UNUSED; // nothing listens; answers 502 by design
    // Screening: pass through ONLY what is already in the caller's environment.
    // Never set, default or invent a sanctions list.
    return env;
  },
});
