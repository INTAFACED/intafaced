import { profileEnvFor } from '../owner-settings.mjs';

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
      // The multiplexed door's labelled TEST values (tooling/profiles/test-owner-values/ws.json), so that door mounts and
      // takes subscriptions on this stack (#8311). Every other WS_* limit (depth, lag) stays unset and refuses by its
      // own *_unset code.
      ...profileEnvFor('ws', 'test'),
    };
  },
});
