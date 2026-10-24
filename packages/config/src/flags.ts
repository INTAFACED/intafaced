import type { ModuleId } from './modules.js';

/**
 * Feature flags — §11: "Everything ships dark behind flags; the drop sequence
 * is configuration, not deployment risk."
 *
 * A flag turns on when the current LAUNCH_DROP has reached the flag's drop,
 * unless an explicit override says otherwise. Overrides come from (in order of
 * precedence): explicit `overrides` argument > env `INTAFACED_FLAG_<NAME>=on|off`.
 *
 * Kill-switches (§14 DoD "Admin controls") are the same mechanism pointed the
 * other way: `module.<id>.enabled` defaults on, and admin sets it off.
 */

export const DROPS = ['0', 'I', 'II', 'III', 'IV', 'V'] as const;
export type Drop = (typeof DROPS)[number];

/**
 * Exported, because comparing two drops is something callers legitimately need
 * and the obvious workaround is a trap: `'0' | 'I' | 'II' | 'III' | 'IV' | 'V'`
 * happens to sort correctly lexicographically, right up until someone adds
 * drop 'VI' — which sorts before 'V'.
 */
export const DROP_ORDER: Readonly<Record<Drop, number>> = { '0': 0, I: 1, II: 2, III: 3, IV: 4, V: 5 };

/** Negative when `a` comes first. Use this rather than comparing the strings. */
export function compareDrops(a: Drop, b: Drop): number {
  return DROP_ORDER[a] - DROP_ORDER[b];
}

/**
 * The §11 launch-sequence names.
 *
 * They live here rather than only in the build doc so the admin console and the
 * doctrine cannot drift — an operator staring at "III" needs to know that is
 * Soft launch.
 */
export const DROP_NAMES: Readonly<Record<Drop, string>> = {
  '0': 'Tease',
  I: 'Blueprint',
  II: 'Lobby preview',
  III: 'Soft launch',
  IV: 'Public drop',
  V: 'Seasons',
};

/**
 * WHAT ACTUALLY REFUSES WHEN THIS FLAG IS OFF.
 *
 * ── Why this field exists ───────────────────────────────────────────────────
 *
 * `isEnabled()` answers a question about the REGISTRY. For most of this file's
 * life the admin console read that answer and rendered it as a question about
 * the PLATFORM — "protocol.amm: Dark" — and those are not the same question.
 * Most services still do not import `isEnabled` / `resolveAll` / `FLAG_REGISTRY`.
 * The exception is waitlist capture on svc-identity: `WaitlistService` calls
 * `assertEnabled` so off / wrong drop / kill is a named refuse, not a silent open.
 *
 * That is the mirror image of the bug `svc-edge/src/routes.ts` was written to
 * prevent. There, a service was reachable that the route table did not know
 * about. Here, an operator believes a capability is off and it is answering.
 * Both are the map disagreeing with the territory; this one points at the
 * operator, which is the worse direction.
 *
 * The seven flags below that DO bite are bitten by a **separate boolean**: a
 * per-service environment variable, read once at boot, with its own default of
 * `true`, that mirrors the flag by name and nothing else. `TRADE_SPOT_ENABLED`
 * does not consult `LAUNCH_DROP`, this registry, or the flag's `drop`. So even
 * for those, "the drop clock says off" and "the capability refuses" are two
 * independent facts that happen to share a spelling.
 *
 * Stating enforcement here, as required data, makes both impossible to hide:
 * the type will not let a new flag be declared without answering "what refuses
 * when this is off?", and `flag-enforcement.test.ts` re-derives the answer from
 * the services' own `env.ts` files rather than trusting the sentence.
 */
export type FlagEnforcement =
  /**
   * Nothing reads this flag. The capability serves regardless of its state.
   *
   * This is a **launch plan entry**, not a control. A console must not present
   * it as one — see `apps/admin/src/lib/flag-state.ts`.
   */
  | { readonly kind: 'none' }
  /**
   * A named service genuinely refuses — but from its own boot-time env var, not
   * from this registry. Flipping this flag anywhere changes nothing; changing
   * `envVar` and restarting `service` is the whole mechanism.
   */
  | { readonly kind: 'service-env'; readonly service: string; readonly envVar: string }
  /**
   * Enforced AND reachable while the platform is running, through an operator
   * endpoint. `ledger.posting` is the only one: `LEDGER_POSTING_ENABLED` at boot
   * plus a durable `posting_freeze` row an operator can set through
   * `/admin/ledger/*` without a deploy.
   */
  | { readonly kind: 'operator-api'; readonly service: string; readonly envVar: string; readonly surface: string }
  /**
   * Enforced on the request path via `assertEnabled(key)` in `service`.
   * Follows this registry + `LAUNCH_DROP` + `INTAFACED_FLAG_*` + module kill.
   * `envVar` is the pin name the resolver already honours (not a boot-time
   * default-on mirror). `surface` is the HTTP path that refuses.
   */
  | { readonly kind: 'request-path'; readonly service: string; readonly envVar: string; readonly surface: string };

/** Nothing enforces this flag. Its state is a plan, not a control. */
export const NOT_ENFORCED: FlagEnforcement = { kind: 'none' };

/** A boot-time env var on one service is the real switch. Needs a restart. */
function serviceEnv(service: string, envVar: string): FlagEnforcement {
  return { kind: 'service-env', service, envVar };
}

/** Boot-time env var AND a live operator endpoint. */
function operatorApi(service: string, envVar: string, surface: string): FlagEnforcement {
  return { kind: 'operator-api', service, envVar, surface };
}

/** Request-path `assertEnabled` gate — follows the drop clock. */
function requestPath(service: string, envVar: string, surface: string): FlagEnforcement {
  return { kind: 'request-path', service, envVar, surface };
}

export interface FlagDef {
  readonly key: string;
  readonly module: ModuleId;
  /** Earliest drop at which this flag defaults to on. `null` = never by default. */
  readonly drop: Drop | null;
  readonly description: string;
  /**
   * Required. A flag that does not say what refuses when it is off is a flag
   * that will be rendered as a control it is not.
   */
  readonly enforcement: FlagEnforcement;
}

function def(key: string, module: ModuleId, drop: Drop | null, description: string, enforcement: FlagEnforcement): FlagDef {
  return { key, module, drop, description, enforcement };
}

/**
 * §11 LAUNCH-SEQUENCE MAPPING — the table, as code.
 *
 * Read the `enforcement` column as the answer to "if I turn this off, what
 * stops?". `NOT_ENFORCED` means: nothing. That is not a TODO list — several of
 * these describe capabilities that do not exist yet, and a plan entry for
 * unbuilt work is honest. What was dishonest was rendering all of them
 * identically to the ones that bite.
 */
export const FLAG_REGISTRY: readonly FlagDef[] = [
  // Drop 0 · Tease
  def(
    'waitlist.enabled',
    'core-ops',
    '0',
    'Waitlist capture + referral queue',
    requestPath('svc-identity', 'INTAFACED_FLAG_WAITLIST_ENABLED', 'requireWaitlist().enroll'),
  ),
  def(
    'referral.queue',
    'core-ops',
    '0',
    'Referral position mechanics',
    requestPath('svc-identity', 'INTAFACED_FLAG_REFERRAL_QUEUE', 'requireWaitlist().position'),
  ),
  def('mining.testnet', 'mining-pool', '0', 'PoW pool in testnet mode', NOT_ENFORCED),

  // Drop I · Blueprint
  def('blueprint.onboarding', 'blueprint', 'I', 'Identity Blueprint onboarding session', NOT_ENFORCED),
  def('blueprint.cardShare', 'blueprint', 'I', 'Blueprint card render + share', NOT_ENFORCED),
  def('launch.foundingBadges', 'launch', 'I', 'Founding badge NFT mint', NOT_ENFORCED),
  def('token.paperPublished', 'token', 'I', 'Token paper public', NOT_ENFORCED),

  // Drop II · Lobby preview
  // `svc-academy` has no flag check on any procedure: `academy-service.ts`
  // creates rooms and seats users at every drop. The console said "Awaiting
  // drop II" over a lobby that was open.
  def('academy.inviteLobbies', 'academy', 'II', 'Invite-only preview lobbies', NOT_ENFORCED),
  def('mining.mainnet', 'mining-pool', 'II', 'PoW pool on mainnet', NOT_ENFORCED),
  def('bank.cardWaitlist', 'bank', 'II', 'Card waitlist capture', NOT_ENFORCED),

  // Drop III · Soft launch
  def('identity.rankedWaves', 'identity', 'III', 'Ranked onboarding waves', NOT_ENFORCED),
  def('launch.memeFactory', 'launch', 'III', 'Meme factory one-click launches', NOT_ENFORCED),
  // The starkest one. At the default `LAUNCH_DROP=0` this resolves OFF, so the
  // console reported that the public API gateway was not accepting traffic —
  // while `svc-edge` proxied every request in the platform. `svc-edge/src`
  // imports `assertScreeningConfigured` and `MODULE_IDS` from this package and
  // no flag resolver at all; the gateway has never consulted this flag.
  def('edge.gateway', 'edge', 'I', 'Public API gateway accepts traffic', NOT_ENFORCED),
  // `DEX_INTERNAL_BOOK_ENABLED` gates the internal book VENUE, which is a
  // different thing from smart order routing. Not claimed as this flag's
  // enforcement, because a near-miss mirror is how the drift started.
  def('dex.routing', 'dex', 'V', 'Protocol Plane DEX — smart order routing', NOT_ENFORCED),
  def('trade.spot', 'trade', 'III', 'Spot order book live', serviceEnv('svc-trade', 'TRADE_SPOT_ENABLED')),
  // Same drop as `trade.spot`: a live book with no way to watch it is not a
  // launched market. OFF stops the fan-out and closes every open socket, and
  // the terminal renders the book as unavailable rather than as stale numbers.
  def('ws.gateway', 'ws', 'III', 'Public market-data websocket fan-out (depth)', serviceEnv('svc-ws', 'WS_GATEWAY_ENABLED')),

  // Drop IV · Public drop
  def('platform.open', 'identity', 'IV', 'Fully open registration', NOT_ENFORCED),
  // `EMISSIONS_ENABLED` on svc-token gates minting, which is neither TGE nor
  // staking, and has no flag of its own. Enforcement without a registry entry
  // is the same drift pointed the other way — noted, not laundered into a claim.
  def('token.tge', 'token', 'IV', 'TGE + listing', NOT_ENFORCED),
  def('token.staking', 'token', 'IV', 'Staking live', NOT_ENFORCED),
  def('academy.tournament', 'academy', 'IV', 'Tournament engine', serviceEnv('svc-academy', 'ACADEMY_TOURNAMENT_ENABLED')),

  // Drop V · Seasons
  def('identity.seasonEngine', 'identity', 'V', 'Seasonal XP + ladders', NOT_ENFORCED),
  def('launch.limitedDrops', 'launch', 'V', 'Limited drops', NOT_ENFORCED),

  // Core — always on, switchable only by an operator in an emergency.
  // `ledger.posting` is the most consequential switch in the platform: §4.2
  // requires that a reconciliation mismatch freezes writes rather than letting
  // a book we cannot verify keep accepting them. It is also the ONE flag in
  // this file whose capability an operator can stop while the platform runs —
  // the freeze is a durable row, not a process variable.
  def(
    'ledger.posting',
    'ledger',
    '0',
    'Ledger accepts posts — OFF freezes all value movement platform-wide',
    operatorApi('svc-ledger', 'LEDGER_POSTING_ENABLED', '/admin/ledger/freeze'),
  ),
  def('ledger.reconciliation', 'ledger', '0', 'Hourly snapshot + replay reconciliation job', NOT_ENFORCED),
  def('matching.engine', 'matching', null, 'Order matching engine accepts orders', serviceEnv('svc-matching', 'MATCHING_ENGINE_ENABLED')),

  // Not on the drop clock — gated by build phase / licensing (§13 sockets)
  // `trade.futures` HAS A REAL SWITCH NOW, and this row is how the console stops
  // lying about it. It was `NOT_ENFORCED` for an honest reason — nothing read it,
  // and `assertTradable` refused every futures order unconditionally, so the
  // capability was not off by decision, it was absent. `TRADE_FUTURES_ENABLED`
  // makes it a decision: off refuses orders with `trade.futures_disabled`, on
  // takes them. Same mechanism and same caveat as `trade.spot` — a boot-time
  // variable that ignores this registry and the drop clock, so flipping the flag
  // here still changes nothing without a restart.
  def('trade.futures', 'trade', null, 'Perp futures markets', serviceEnv('svc-trade', 'TRADE_FUTURES_ENABLED')),
  def('trade.options', 'trade', null, 'Options markets (v1: full-collateral)', NOT_ENFORCED),
  def('trade.copyTrading', 'trade', null, 'Copy trading + profit share', NOT_ENFORCED),
  def('trade.otc', 'trade', null, 'OTC RFQ desk (staked gate)', NOT_ENFORCED),
  def('pay.payfac', 'pay', null, 'PayFac sub-merchant trees', NOT_ENFORCED),
  def('pay.laneA', 'pay', null, 'Permissionless crypto rails (§24 Lane A)', NOT_ENFORCED),
  def('p2p.sovereignEscrow', 'p2p', null, 'Contract escrow (Protocol Plane)', NOT_ENFORCED),
  // Boot-time module kills on svc-bank — OFF refuses open/issue (and card auth).
  // Job-level stops (accrual, risk sweep) stay separate env vars; these flags are
  // the product module switches the admin console used to paint as controls while
  // nothing read them (NOT_ENFORCED honesty residual, wave 13 L03).
  def('bank.loans', 'bank', null, 'Collateralised loans', serviceEnv('svc-bank', 'BANK_LOANS_ENABLED')),
  def('bank.cards', 'bank', null, 'Card issuance (ledger half)', serviceEnv('svc-bank', 'BANK_CARDS_ENABLED')),
  def('bank.sovereignCard', 'bank', null, 'Self-custody funded card (§18)', NOT_ENFORCED),
  def('protocol.smartAccounts', 'protocol', null, 'Passkey smart accounts (§17.4)', serviceEnv('svc-protocol', 'PROTOCOL_RELAY_ENABLED')),
  // `protocol.amm`: `router.ts` mounts `amm.quoteExactIn`, `amm.quoteFromPool`,
  // `amm.poolReserves` and the build-call procedures with no flag check. The
  // only refusal on that path is a zero `PROTOCOL_AMM_FACTORY_ADDRESS`, which
  // is a missing deployment, not an operator decision.
  def('protocol.amm', 'protocol', null, 'AMM pools', NOT_ENFORCED),
  def('protocol.lending', 'protocol', null, 'On-chain lending markets', NOT_ENFORCED),
  def('chain.mainnet', 'chain', null, 'INTACHAIN mainnet', NOT_ENFORCED),
  def('bridge.enabled', 'bridge', null, 'Fiat ↔ Protocol plane bridge', NOT_ENFORCED),
  def('launch.rwa', 'launch', null, 'RWA issuance (licence-gated, §13)', NOT_ENFORCED),
  def('agents.premiumTiers', 'agents', null, 'Metered premium agent tiers', NOT_ENFORCED),

  // Every module needs at least one flag, because §14's DoD requires a
  // kill-switch and the gate checks for exactly that. `market` and `indexer`
  // had none — meaning both services would have shipped with a Definition of
  // Done that could never pass. Found by the admin console, which surfaced
  // "modules with no kill-switch" as a panel.
  //
  // Worth naming what that gate does and does not prove: it checks that a
  // module id appears in this registry. It has never checked that anything
  // reads the flag — which is why `market.listings` can satisfy §14.6 while
  // switching it off does nothing at all.
  def('market.listings', 'market', null, 'Vendor marketplace open for listings and purchases', NOT_ENFORCED),
  def('market.vendorApplications', 'market', null, 'Accepting new vendor applications', NOT_ENFORCED),
  def('indexer.ingest', 'indexer', null, 'Chain → Postgres read-model ingestion', serviceEnv('svc-indexer', 'INDEXER_INGEST_ENABLED')),
  // In-app fan-out kill-switch. OFF = consumers ack without writing inbox rows.
  // Push / email / SMS are §13 sockets and are not gated by this flag.
  def('notify.fanout', 'notify', 'III', 'In-app notification fan-out from bus events', serviceEnv('svc-notify', 'NOTIFY_FANOUT_ENABLED')),
  // Support desk Stage-1. NOT_ENFORCED: edge kill-switch is the live control;
  // flag is rollout plan only (same honesty pattern as other surfaces).
  def('support.desk', 'support', 'V', 'Support tickets + KB desk', NOT_ENFORCED),
  // House tenant mechanism. Live control is edge kill of module `execution` plus
  // tRPC `execution.tenant.kill` (in-process). Flag is rollout plan only.
  def('execution.houseTenant', 'execution', 'II', 'Sealed house-desk tenancy mechanism (external venues only)', NOT_ENFORCED),
  // Lot export. Live control is edge kill of module `tax`. Flag is rollout plan only.
  def('tax.export', 'tax', 'V', 'Per-jurisdiction lot export packs (FIFO/LIFO/HIFO, caller-selected)', NOT_ENFORCED),
  // Sandbox isolate. Live halt is the edge kill of module `quant`; flag is rollout plan.
  def('quant.sandbox', 'quant', 'V', 'Sandboxed strategy runtime (TypeScript and Python)', NOT_ENFORCED),
  // Campaign catalogue and participations. Live halt is the edge kill of module `campaigns`; flag is rollout plan.
  def('campaigns.catalogue', 'campaigns', null, 'Campaign catalogue, participations and the operator desk', NOT_ENFORCED),
];

export const FLAG_KEYS = FLAG_REGISTRY.map((f) => f.key);
export type FlagKey = (typeof FLAG_REGISTRY)[number]['key'];

const BY_KEY = new Map(FLAG_REGISTRY.map((f) => [f.key, f]));

// ── Enforcement: what a flag's state is worth ───────────────────────────────

/**
 * What refuses when `key` is off.
 *
 * FAILS CLOSED ON THE HONESTY AXIS. An unknown key resolves to `NOT_ENFORCED`
 * rather than throwing or assuming a gate, because every caller of this
 * function is deciding how much to promise a reader. `isEnabled` refuses to
 * over-promise that a capability is ON — an undeclared flag throws, a
 * `drop: null` flag is off at every drop. This refuses to over-promise that a
 * capability is OFF. Same principle in both directions: never claim more
 * safety than we have.
 */
export function enforcementOf(key: string): FlagEnforcement {
  return BY_KEY.get(key)?.enforcement ?? NOT_ENFORCED;
}

/**
 * Does anything actually stop when this flag is off?
 *
 * The question an operator is really asking when they look at a switch. `false`
 * means the row is a launch-plan entry: the capability serves at whatever the
 * registry says.
 */
export function isEnforced(key: string): boolean {
  return enforcementOf(key).kind !== 'none';
}

/** Flags that gate nothing. The set a console must not render as controls. */
export function unenforcedFlags(): FlagDef[] {
  return FLAG_REGISTRY.filter((f) => f.enforcement.kind === 'none');
}

/** Flags with a real refusal behind them, whether or not it is live-reachable. */
export function enforcedFlags(): FlagDef[] {
  return FLAG_REGISTRY.filter((f) => f.enforcement.kind !== 'none');
}

/**
 * One sentence an operator can act on, for the control itself.
 *
 * Deliberately written for the person about to click, not for a doc: it says
 * what will happen, and — for `service-env` — that clicking is not the
 * mechanism.
 */
export function enforcementNote(key: string): string {
  const e = enforcementOf(key);
  switch (e.kind) {
    case 'none':
      return 'Nothing enforces this flag. The capability serves regardless of this state — this row is a launch-plan entry, not a control.';
    case 'service-env':
      return `Enforced by ${e.envVar} on ${e.service}, read once at boot and defaulting to on. It does not follow LAUNCH_DROP or this registry — changing it needs a restart of ${e.service}.`;
    case 'operator-api':
      return `Enforced by ${e.envVar} on ${e.service} at boot, and reachable while running through ${e.surface}. This is the only flag whose capability an operator can stop without a deploy.`;
    case 'request-path':
      return `Enforced on the request path: ${e.service} ${e.surface} calls assertEnabled. Follows LAUNCH_DROP, ${e.envVar}, and the module kill-switch. Off is a named refuse, not a silent open.`;
  }
}

export interface FlagContext {
  readonly drop: Drop;
  /** Explicit on/off overrides — admin console, tests, per-env config. */
  readonly overrides?: Readonly<Record<string, boolean>>;
  /** Modules switched off by the operator kill-switch (§14). */
  readonly disabledModules?: readonly ModuleId[];
  readonly env?: Record<string, string | undefined>;
}

/** `waitlist.enabled` → `INTAFACED_FLAG_WAITLIST_ENABLED`. */
export function envVarNameFor(key: string): string {
  return `INTAFACED_FLAG_${key.replace(/[.-]/g, '_').toUpperCase()}`;
}

const ENV_ON = new Set(['1', 'true', 'on', 'yes']);
const ENV_OFF = new Set(['0', 'false', 'off', 'no']);

/**
 * Read one `INTAFACED_FLAG_*` value.
 *
 * `undefined` means no pin: the drop clock decides. Compose writes `${VAR:-}`
 * as an empty string when the host did not pin, so blank is the same as unset.
 * Reading blank as off pinned drop-0 waitlist closed on every stock deploy,
 * and the shell then called that refuse "never built".
 *
 * A token this function cannot read (`maybe`, `enabled`) is `false`. Fail
 * closed. Only the on-list opens a flag the clock would have left shut.
 */
export function parseFlagEnv(raw: string | undefined | null): boolean | undefined {
  if (raw === undefined || raw === null) return undefined;
  const token = raw.trim().toLowerCase();
  if (token === '') return undefined;
  if (ENV_ON.has(token)) return true;
  if (ENV_OFF.has(token)) return false;
  return false;
}

function envOverride(key: string, env: Record<string, string | undefined>): boolean | undefined {
  return parseFlagEnv(env[envVarNameFor(key)]);
}

export class UnknownFlagError extends Error {
  constructor(key: string) {
    super(`Unknown feature flag "${key}". Declare it in FLAG_REGISTRY (packages/config/src/flags.ts).`);
    this.name = 'UnknownFlagError';
  }
}

/**
 * Thrown by `assertEnabled` when a flag is off.
 *
 * This is the product refuse path for drop-gated surfaces (waitlist, referral
 * queue, and every other registry key). Services call it on the request path;
 * the registry alone answering `isEnabled === false` never stopped traffic.
 *
 * `code` is stable for callers to map to HTTP/tRPC:
 *   - `flag.<key>.drop_pending`  — drop clock has not reached the flag
 *   - `flag.<key>.disabled`      — override, env pin, kill-switch, or phase-gate
 */
export class FlagDisabledError extends Error {
  readonly code: string;
  readonly key: string;
  readonly source: FlagSource;
  readonly reason: string;

  constructor(key: string, explanation: FlagExplanation) {
    const code = explanation.source === 'drop-pending' ? `flag.${key}.drop_pending` : `flag.${key}.disabled`;
    super(`${key} is off (${explanation.source}): ${explanation.reason}`);
    this.name = 'FlagDisabledError';
    this.code = code;
    this.key = key;
    this.source = explanation.source;
    this.reason = explanation.reason;
  }
}

/**
 * Resolve one flag. Unknown keys throw — there are no ad-hoc flags, because an
 * undeclared flag is an undocumented launch dependency.
 */
export function isEnabled(key: string, ctx: FlagContext): boolean {
  const flag = BY_KEY.get(key);
  if (!flag) throw new UnknownFlagError(key);

  // A module kill-switch beats everything. Operator safety is not overridable.
  if (ctx.disabledModules?.includes(flag.module)) return false;

  const explicit = ctx.overrides?.[key];
  if (explicit !== undefined) return explicit;

  const fromEnv = envOverride(key, ctx.env ?? {});
  if (fromEnv !== undefined) return fromEnv;

  if (flag.drop === null) return false;
  return DROP_ORDER[ctx.drop] >= DROP_ORDER[flag.drop];
}

/**
 * Waitlist capture + referral queue — the switch mountain (`infra.drop-flags`).
 *
 * Callers must `assertEnabled` these keys. When OFF they are refuse-closed
 * (`FlagDisabledError`) and `offReadiness` is `overridden` / `killed` (built
 * request-path control), never a silent open. Founding-badge mint is
 * `launch.nft` (chain), not this list.
 */
export const WAITLIST_REFERRAL_FLAGS = ['waitlist.enabled', 'referral.queue'] as const;

/**
 * Refuse when the flag is off — the product Done bar for drop phases.
 *
 * `isEnabled` is a read. This is a gate. Waitlist capture, referral queue
 * position, and every other drop-mapped surface call this (or an equivalent
 * service-env check) before doing work; wrong phase → throw, not silent serve.
 *
 * OFF is refuse-closed, not ready: a false `isEnabled` without a throw is a
 * missed gate. `WAITLIST_REFERRAL_FLAGS` pin that contract in tests.
 *
 * Returns void on success so call sites read as a precondition, not a branch.
 */
export function assertEnabled(key: string, ctx: FlagContext): void {
  const explanation = explain(key, ctx);
  if (explanation.enabled) return;
  throw new FlagDisabledError(key, explanation);
}

/** Snapshot of every flag — what apps/admin renders, and what CI asserts against. */
export function resolveAll(ctx: FlagContext): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const f of FLAG_REGISTRY) out[f.key] = isEnabled(f.key, ctx);
  return out;
}

/** Why a flag is in the state it is in. Ordered by the precedence in `isEnabled`. */
export type FlagSource =
  /** A module kill-switch is holding it off. Beats everything. */
  | 'kill-switch'
  /** An explicit override was passed in — admin console, test, per-env config. */
  | 'override'
  /** An INTAFACED_FLAG_* environment variable pinned it. */
  | 'env'
  /** The drop clock reached it. */
  | 'drop'
  /** Its drop has not arrived yet. */
  | 'drop-pending'
  /** `drop: null` — gated by build phase or licensing, never by the clock. */
  | 'phase-gated';

export interface FlagExplanation {
  readonly key: string;
  readonly enabled: boolean;
  readonly source: FlagSource;
  /** One sentence an operator can act on. */
  readonly reason: string;
  readonly module: ModuleId;
  readonly drop: Drop | null;
  /**
   * What refuses when this is off — carried alongside the state, because
   * `enabled: false` on its own is exactly the sentence that misled an
   * operator. `source` says why the REGISTRY holds this value; this says
   * whether the PLATFORM agrees.
   */
  readonly enforcement: FlagEnforcement;
}

/**
 * Why is this flag on or off?
 *
 * `isEnabled` answers *whether*; an operator staring at a board of booleans
 * needs *why*. Without provenance you cannot tell whether a flag is on because
 * the drop clock reached it, because an env var pins it, or off because a
 * module kill-switch is holding it — and an operator who cannot see that flips
 * the wrong switch.
 *
 * Deliberately mirrors `isEnabled`'s precedence exactly. If the two ever
 * disagree, `isEnabled` is authoritative and this is the bug — there is a test
 * asserting they agree across every flag and a spread of contexts.
 */
export function explain(key: string, ctx: FlagContext): FlagExplanation {
  const flag = BY_KEY.get(key);
  if (!flag) throw new UnknownFlagError(key);

  const base = { key, module: flag.module, drop: flag.drop, enforcement: flag.enforcement };

  if (ctx.disabledModules?.includes(flag.module)) {
    return { ...base, enabled: false, source: 'kill-switch', reason: `module "${flag.module}" is killed by the operator` };
  }

  const explicit = ctx.overrides?.[key];
  if (explicit !== undefined) {
    return { ...base, enabled: explicit, source: 'override', reason: `explicitly overridden ${explicit ? 'on' : 'off'}` };
  }

  const fromEnv = envOverride(key, ctx.env ?? {});
  if (fromEnv !== undefined) {
    return {
      ...base,
      enabled: fromEnv,
      source: 'env',
      reason: `pinned ${fromEnv ? 'on' : 'off'} by ${envVarNameFor(key)}`,
    };
  }

  if (flag.drop === null) {
    return { ...base, enabled: false, source: 'phase-gated', reason: 'gated by build phase, not by the drop clock (§13)' };
  }

  const reached = DROP_ORDER[ctx.drop] >= DROP_ORDER[flag.drop];
  return reached
    ? { ...base, enabled: true, source: 'drop', reason: `drop ${flag.drop} (${DROP_NAMES[flag.drop]}) has been reached` }
    : { ...base, enabled: false, source: 'drop-pending', reason: `waiting for drop ${flag.drop} (${DROP_NAMES[flag.drop]})` };
}

export function explainAll(ctx: FlagContext): FlagExplanation[] {
  return FLAG_REGISTRY.map((f) => explain(f.key, ctx));
}

/** Modules with no flag at all — nothing for an operator to switch off (§14). */
export function modulesWithoutKillSwitch(allModules: readonly ModuleId[]): ModuleId[] {
  const covered = new Set(FLAG_REGISTRY.map((f) => f.module));
  return allModules.filter((m) => !covered.has(m));
}

export function flagsForModule(module: ModuleId): FlagDef[] {
  return FLAG_REGISTRY.filter((f) => f.module === module);
}

export function flagDef(key: string): FlagDef | undefined {
  return BY_KEY.get(key);
}

/**
 * Does anything real refuse when this flag is off?
 *
 * Tracker Done bar for `infra.drop-flags` (coverage core.drop-flags): a flag
 * whose feature does not exist must read as OFF-and-unbuilt, not OFF-and-ready.
 * Enforced flags (service-env / operator-api / request-path) have a live refuse
 * path → built control. `NOT_ENFORCED` is a launch-plan row → unbuilt / plan-only.
 */
export function isCapabilityBuilt(key: string): boolean {
  return isEnforced(key);
}

/**
 * Why an OFF flag is off, at the altitude the tracker Done bar cares about.
 *
 * Returns `null` when the flag is on. When off:
 *   - `unbuilt`      — plan row, no live refuse path (not "ready to flip")
 *   - `drop-pending` — built control waiting on the drop clock
 *   - `overridden`   — explicit or env pin holding it off
 *   - `killed`       — module kill-switch
 *   - `phase-gated`  — drop:null, never opens by clock alone
 *
 * Waitlist / referral (`WAITLIST_REFERRAL_FLAGS`) are built request-path gates.
 * OFF via env or override is `overridden`, never `unbuilt`. `null` means ON.
 * Never treat OFF as ready, and never call a built gate unbuilt because it is off.
 */
export type OffReadiness = 'unbuilt' | 'drop-pending' | 'overridden' | 'killed' | 'phase-gated';

export function offReadiness(key: string, ctx: FlagContext): OffReadiness | null {
  const explanation = explain(key, ctx);
  if (explanation.enabled) return null;

  if (!isCapabilityBuilt(key)) return 'unbuilt';

  switch (explanation.source) {
    case 'drop-pending':
      return 'drop-pending';
    case 'kill-switch':
      return 'killed';
    case 'phase-gated':
      return 'phase-gated';
    case 'override':
    case 'env':
      return 'overridden';
    case 'drop':
      // enabled:false with source drop is unreachable (drop source is always on)
      return 'drop-pending';
  }
}
