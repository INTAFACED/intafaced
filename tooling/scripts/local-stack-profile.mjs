/**
 * Which of the stack's processes a start runs. With `LOCAL_STACK_PROFILE` unset the stack runs everything, as every CI
 * shard and builder stack does. `LOCAL_STACK_PROFILE=launch-desk` runs only what the launch desk uses: the hosted beta
 * sets it (tooling/beta/beta-host.mjs), so a tester's path has fewer processes to fail and the shared box keeps the
 * memory. Every other service stays in the repo and in CI; on this stack it is off, its row in the health table reads
 * `off`, and edge answers its routes as not connected here (EDGE_UPSTREAMS_OFF), never as a network fault.
 *
 * The launch desk's list was read from what the beta's own rooms call (the edge log of the hosted beta, every route a
 * beta page asked for) and what those services call on the tester's path (each service's file in local-stack-services):
 * - sign-up, sign-in, verification and its TEST approval: identity, edge, customer, notify (codes and the inbox)
 * - Home and Money: bank (the TEST partner account), ops (Home's settings and the TEST valuation prices), pay and
 *   identity and bank (Home's work list), ledger (the invited tester's TEST grant posts there; rail-statements feeds
 *   its rail controls)
 * - the wallet and the futures desk: protocol (the person's wallet, its TEST provider test-wallet-provider), indexer
 *   (the wallet's history), trade (the venue door), ws (live prices), the TEST venue adapter on Hyperliquid's test network
 */
export const PROFILES = Object.freeze({
  'launch-desk': Object.freeze([
    'ledger',
    'identity',
    'trade',
    'pay',
    'bank',
    'ops',
    'notify',
    'protocol',
    'indexer',
    'ws',
    'edge',
    'rail-statements',
    'test-wallet-provider',
    'customer',
  ]),
});

/** The profile `env` names, or null for the whole stack. An unknown name throws, naming the ones there are. */
export function stackProfile(env = process.env) {
  const name = env.LOCAL_STACK_PROFILE;
  if (name === undefined || name === '' || name === 'all') return null;
  const on = PROFILES[name];
  if (!on) throw new Error(`LOCAL_STACK_PROFILE must be all or one of ${Object.keys(PROFILES).join(', ')}, not "${name}"`);
  return { name, on: new Set(on) };
}

/** Whether the profile leaves the process `name` off. Processes no profile names (nats, the chain, the venue) stay on. */
export function profileOff(name, env = process.env) {
  const profile = stackProfile(env);
  return profile !== null && !profile.on.has(name) && PROFILED.has(name);
}

/** The processes a profile may leave off: the stack's services and its sites. */
const PROFILED = new Set([
  'ledger',
  'identity',
  'matching',
  'trade',
  'pay',
  'bank',
  'token',
  'p2p',
  'academy',
  'support',
  'ops',
  'market',
  'notify',
  'agents',
  'blueprint',
  'quant',
  'execution',
  'tax',
  'mining-pool',
  'protocol',
  'indexer',
  'dex',
  'campaigns',
  'ws',
  'fix',
  'edge',
  'video-store',
  'rail-statements',
  'test-wallet-provider',
  'customer',
  'invitation',
  'apex',
  'admin',
  'team-tls',
]);

/** The edge upstream env vars whose service the profile leaves off: edge answers them as not connected here. */
export function edgeUpstreamsOff(upstreams, env = process.env) {
  return Object.entries(upstreams)
    .filter(([, service]) => profileOff(service, env))
    .map(([key]) => key);
}
