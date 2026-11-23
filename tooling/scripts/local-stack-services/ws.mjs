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
      // The private and drop-copy doors check a customer's ownership with identity, the same way the edge does, with
      // svc-ws's own read key: identity refuses a ws read signed with the edge's (IDENTITY_WS_AUTHORITY_SECRET).
      IDENTITY_URL: urlOf('identity'),
      IDENTITY_OWNERSHIP_SECRET: secrets.wsAuthority,
      // The SBE consumer list's read key; svc-edge signs with the same one for the founder console (J-cex-spot-20 #3).
      WS_STATUS_READ_SECRET: secrets.wsStatusRead,
      EDGE_ALLOWED_ORIGINS: `${CUSTOMER_ORIGIN},${CUSTOMER_LOCALHOST_ORIGIN}`,
      // The labelled TEST stream limits (tooling/profiles/test-owner-values/ws.json): the multiplexed door mounts and
      // takes subscriptions (#8311), and the public depth socket opens with its depth, lag and listing limits
      // (J-cex-spot-14 #8). Every other WS_* owner value stays unset and refuses by its own *_unset code.
      ...profileEnvFor('ws', 'test'),
      // `LOCAL_STACK_WS_IP_BAN_SECONDS=off` on a start or restart leaves the owner's ban time blank, so the storm ban is
      // off and svc-ws says so on GET /policy (J-developer-09 #6).
      ...(process.env.LOCAL_STACK_WS_IP_BAN_SECONDS === 'off' ? { WS_PER_IP_BAN_SECONDS: '' } : {}),
    };
  },
});
