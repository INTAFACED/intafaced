import { loadProfile } from '../owner-settings.mjs';

/** The multiplexed door's limits, from the labelled TEST profile (ws.json), only when the stack is asked for the door. */
export const WS_MUX_TEST_KEYS = [
  'WS_MUX_IDLE_MS',
  'WS_MAX_CONNECTIONS',
  'WS_MUX_MAX_SEATS',
  'WS_MUX_MAX_SUBSCRIPTIONS',
  'WS_MUX_MAX_OPS_PER_SECOND',
  'WS_HIGH_WATER_BYTES',
  'WS_MAX_LAG_TICKS',
  'WS_MARKETS_LIST_LIMIT',
  'WS_DEPTH_LIMIT',
];

/**
 * `LOCAL_STACK_WS_MUX=on` on a start or restart of ws sets them, so a journey can open the multiplexed door (J-cex-spot-14
 * #8, the instruments stream) and restart ws without it afterwards. Anything else leaves them out, as before: every door
 * then refuses by its own *_unset code (J-developer-01 reads ws.mux_idle_unset).
 */
export function wsMuxTestValues(env = process.env) {
  if (env.LOCAL_STACK_WS_MUX !== 'on') return {};
  const { values } = loadProfile();
  return Object.fromEntries(
    WS_MUX_TEST_KEYS.map((key) => {
      const entry = values[key];
      if (!entry) throw new Error(`${key} is missing from tooling/profiles/test-owner-values/ws.json.`);
      return [key, entry.value];
    }),
  );
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
      EDGE_ALLOWED_ORIGINS: `${CUSTOMER_ORIGIN},${CUSTOMER_LOCALHOST_ORIGIN}`,
      // Every WS_* limit, ceiling and window (depth, connections, lag, the multiplexed door's idle time) is
      // owner-unpublished: left unset, so each door refuses by its own *_unset code, unless the stack is asked for the
      // multiplexed door (`LOCAL_STACK_WS_MUX=on`, labelled TEST values).
      ...wsMuxTestValues(),
    };
  },
});
