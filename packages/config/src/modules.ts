/**
 * The module registry — the canonical list of every surface in the OS.
 *
 * Doctrine §0.2: the eleven modules are surfaces; the Core is the house.
 * Everything that needs to name a module (flags, jurisdiction rules, ledger
 * `module` column, NATS subjects, kill-switches) names it from here.
 */

/** Doctrine §16.8 — two planes, one economy. */
export const PLANES = ['fiat', 'protocol'] as const;
export type Plane = (typeof PLANES)[number];

export const PHASES = ['0', '1', '2', '3', '3P', '4', '4P', '5', '5P'] as const;
export type Phase = (typeof PHASES)[number];

export interface ModuleDef {
  readonly id: ModuleId;
  readonly service: string;
  /** Which plane(s) this module operates on. */
  readonly planes: readonly Plane[];
  /** Phase that first ships it (§12 / §21). */
  readonly phase: Phase;
  /**
   * True when the platform can take custody of user assets inside this module.
   * Drives §22 (zero-KYC follows custody) and `custody-scan` (Doctrine 10).
   */
  readonly custodial: boolean;
}

export const MODULE_IDS = [
  // Phase 1 · THE CORE
  'identity',
  'ledger',
  'token',
  // Phase 2 · TRADE
  'matching',
  'trade',
  'execution',
  'ws',
  // Phase 3 · PAY + P2P
  'pay',
  'p2p',
  // Phase 4 · BLUEPRINT
  'blueprint',
  // Phase 5 · SURFACES
  'bank',
  'launch',
  'academy',
  'market',
  'mining-pool',
  'agents',
  'core-ops',
  'notify',
  'support',
  'tax',
  'quant',
  'campaigns',
  'edge',
  // Protocol Plane (v1.1 §17.5)
  'chain',
  'indexer',
  'bridge',
  'protocol',
  'dex',
] as const;

export type ModuleId = (typeof MODULE_IDS)[number];

export const MODULES: Readonly<Record<ModuleId, ModuleDef>> = {
  // Infrastructure, not a product. Non-custodial by definition: it holds no
  // balance and no service secret, and it enforces no jurisdiction of its own —
  // it forwards to modules that do. See services/svc-edge/README.md.
  // §17.5: "the DEX is not a module beside the exchange; it IS the Protocol
  // Plane's front door." custodial:false is what makes it permissionless —
  // checkAccess short-circuits before any tier is read, and custody-scan fails
  // the build if this service ever imports a ledger write recipe.
  dex: { id: 'dex', service: 'svc-dex', planes: ['protocol'], phase: '5', custodial: false },
  edge: { id: 'edge', service: 'svc-edge', planes: ['fiat', 'protocol'], phase: '1', custodial: false },
  identity: { id: 'identity', service: 'svc-identity', planes: ['fiat', 'protocol'], phase: '1', custodial: false },
  ledger: { id: 'ledger', service: 'svc-ledger', planes: ['fiat'], phase: '1', custodial: true },
  token: { id: 'token', service: 'svc-token', planes: ['fiat', 'protocol'], phase: '1', custodial: true },

  matching: { id: 'matching', service: 'svc-matching', planes: ['fiat'], phase: '2', custodial: false },
  trade: { id: 'trade', service: 'svc-trade', planes: ['fiat'], phase: '2', custodial: true },
  // House-desk tenancy mechanism only (D26-P0-01 Stage-1). Non-custodial: no
  // balances, no ledger recipes in this process. Internal-venue half blocked.
  execution: { id: 'execution', service: 'svc-execution', planes: ['fiat'], phase: '2', custodial: false },
  // Infrastructure, like `edge`. It re-broadcasts public market data and holds
  // nothing: no database, no bus, no INTERNAL_SERVICE_SECRET, no ledger client.
  // `custodial: false` is not an aspiration here — there is no code path in the
  // service that could take custody, because there is no credential in the
  // process that would let it call anything that moves value.
  ws: { id: 'ws', service: 'svc-ws', planes: ['fiat'], phase: '2', custodial: false },

  pay: { id: 'pay', service: 'svc-pay', planes: ['fiat'], phase: '3', custodial: true },
  p2p: { id: 'p2p', service: 'svc-p2p', planes: ['fiat', 'protocol'], phase: '3', custodial: true },

  blueprint: { id: 'blueprint', service: 'svc-blueprint', planes: ['fiat', 'protocol'], phase: '4', custodial: false },

  bank: { id: 'bank', service: 'svc-bank', planes: ['fiat'], phase: '5', custodial: true },
  launch: { id: 'launch', service: 'svc-launch', planes: ['fiat', 'protocol'], phase: '5', custodial: true },
  academy: { id: 'academy', service: 'svc-academy', planes: ['fiat', 'protocol'], phase: '5', custodial: false },
  market: { id: 'market', service: 'svc-market', planes: ['fiat'], phase: '5', custodial: true },
  'mining-pool': { id: 'mining-pool', service: 'svc-mining-pool', planes: ['fiat'], phase: '5', custodial: true },
  agents: { id: 'agents', service: 'svc-agents', planes: ['fiat', 'protocol'], phase: '5', custodial: false },
  'core-ops': { id: 'core-ops', service: 'svc-ops', planes: ['fiat'], phase: '5', custodial: false },
  // In-app inbox only. Non-custodial: holds no balance, posts no ledger txs.
  // Push / email / SMS are §13 sockets — not this service.
  notify: { id: 'notify', service: 'svc-notify', planes: ['fiat', 'protocol'], phase: '5', custodial: false },
  // Support desk (ops.support). Non-custodial tickets + KB; no ledger.
  support: { id: 'support', service: 'svc-support', planes: ['fiat'], phase: '5', custodial: false },
  // Lot export. Reads ledger + lake; holds no balance and posts no recipes.
  tax: { id: 'tax', service: 'svc-tax', planes: ['fiat'], phase: '5', custodial: false },
  // Strategy sandbox. Paper book only — no ledger, no second money book.
  quant: { id: 'quant', service: 'svc-quant', planes: ['fiat'], phase: '5', custodial: false },
  // Campaigns, tasks, vouchers and reward intents. Holds no balance: a budget is a
  // limit, and a reward pays through the ledger's reward recipe under this
  // service's own grant.
  campaigns: { id: 'campaigns', service: 'svc-campaigns', planes: ['fiat'], phase: '5', custodial: false },

  // Protocol Plane — never custodial. custody-scan asserts this stays true.
  chain: { id: 'chain', service: 'svc-chain', planes: ['protocol'], phase: '4P', custodial: false },
  indexer: { id: 'indexer', service: 'svc-indexer', planes: ['protocol'], phase: '3P', custodial: false },
  /** The bridge is the one seam: it debits the ledger and credits the chain. */
  bridge: { id: 'bridge', service: 'svc-bridge', planes: ['fiat', 'protocol'], phase: '4P', custodial: true },
  protocol: { id: 'protocol', service: 'svc-protocol', planes: ['protocol'], phase: '3P', custodial: false },
};

export function isModuleId(value: string): value is ModuleId {
  return (MODULE_IDS as readonly string[]).includes(value);
}

export function moduleDef(id: ModuleId): ModuleDef {
  return MODULES[id];
}

/** Services that must never import ledger-client write recipes (Doctrine 10). */
export function protocolPlaneOnlyModules(): ModuleDef[] {
  return Object.values(MODULES).filter((m) => m.planes.length === 1 && m.planes[0] === 'protocol');
}
