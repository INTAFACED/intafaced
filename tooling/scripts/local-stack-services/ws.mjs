import { loadProfile } from '../owner-settings.mjs';

/**
 * The stream limits from the labelled LOCAL TEST values in tooling/profiles/test-owner-values/ws.json, so every door
 * opens on the test stack (J-developer-09). `LOCAL_STACK_WS_LIMITS=off` on a start or restart leaves them all blank, so
 * each door refuses by its own *_unset code again. Production stays blank until the owner publishes them.
 */
function streamLimits() {
  if (process.env.LOCAL_STACK_WS_LIMITS === 'off') return {};
  const limits = {};
  for (const [name, entry] of Object.entries(loadProfile().values)) if (entry.service === 'ws') limits[name] = entry.value;
  if (Object.keys(limits).length === 0) throw new Error('tooling/profiles/test-owner-values/ws.json holds no stream limit.');
  return limits;
}

export default ({ c, secrets, urlOf, PORTS, CUSTOMER_ORIGIN, CUSTOMER_LOCALHOST_ORIGIN }) => ({
  name: 'ws',
  env: () => {
    // svc-ws holds no service credential and no database (services/svc-ws/src/env.ts, FORBIDDEN_SERVICE_CREDENTIALS),
    // so the shared wiring's two service secrets are left out rather than handed to the public port.
    const shared = c('svc-ws', PORTS.ws);
    for (const key of ['INTERNAL_SERVICE_SECRET', 'EDGE_PRINCIPAL_SECRET', 'DATABASE_URL']) delete shared[key];
    return {
      ...shared,
      MATCHING_URL: urlOf('matching'),
      TRADE_URL: urlOf('trade'),
      // The private and drop-copy doors check a customer's ownership with identity, the same way the edge does.
      IDENTITY_URL: urlOf('identity'),
      IDENTITY_OWNERSHIP_SECRET: secrets.edgeAuthority,
      // The SBE consumer list's read key; svc-edge signs with the same one for the founder console (J-cex-spot-20 #3).
      WS_STATUS_READ_SECRET: secrets.wsStatusRead,
      EDGE_ALLOWED_ORIGINS: `${CUSTOMER_ORIGIN},${CUSTOMER_LOCALHOST_ORIGIN}`,
      ...streamLimits(),
    };
  },
});
