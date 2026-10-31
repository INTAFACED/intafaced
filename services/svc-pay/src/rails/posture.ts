import { MemoryBroadcastStore, type BroadcastStore } from './broadcast-store.js';
import { parseAmount, type Amount } from '@intafaced/ledger-client';
import { MemoryChain, UnconfiguredChain, type CryptoChainPort, type MemoryChainPace } from './chain-port.js';
import { parseEvmAssets } from './evm-assets.js';
import { EvmLiveChain } from './evm-chain.js';
import { SignerUnsetError, TestnetSigner, type EvmSigner } from './evm-signer.js';
import { DepositSourceUnsetError, TestnetDepositAddresses, type DepositAddressSource } from './deposit-source.js';
import { VALUE_LEAVING_CAPABILITIES, isUsable, type RailAdapter, type RailCapability } from './rail-adapter.js';
import type { RailRegistry } from './registry.js';

/**
 * RAIL POSTURE — is this deployment allowed to move real money through a rail
 * that is not real?
 *
 * WHY THIS FILE EXISTS. svc-pay shipped with `MemoryChain` wired into
 * `index.ts` unconditionally and `card-sandbox` registered beside it. Both
 * declare `payout`. `withdrawal.create` takes `railId` from the caller and
 * resolves it through `rails.require(railId, 'payout')`, so on any deployment —
 * including a production one — a user could withdraw through a rail whose
 * counterparty is a `Map`. The path would have debited their real ledger
 * balance, written a made-up provider reference into `withdrawals.rail_ref`,
 * posted `withdrawSettle`, and answered `status: 'sent'`.
 *
 * THAT IS THE WORST AVAILABLE BUG IN THIS SERVICE, and it is worse than it
 * sounds, because it is invisible from the inside. Every invariant holds: the
 * journal balances, the boundary account carries the obligation, the double
 * entry is perfect. The only thing missing is the money, and the only thing that
 * would ever notice is a reconciliation against real custody — which is a job
 * that runs later, if at all, and by then the user has been told for days that
 * their withdrawal was sent.
 *
 * THE ANSWER IS MODELLED ON `assertScreeningConfigured` (packages/config), and
 * on purpose: a property the platform claims is asserted at startup, the process
 * refuses to run rather than quietly mislead users about it, and `dev`/`test`
 * are deliberately frictionless because nobody should need a sponsor bank to run
 * a unit test.
 *
 * TWO GATES, NOT ONE:
 *
 *   1. BOOT (`assertRailPosture`) — an enforced environment with a sandbox rail
 *      registered refuses to start. Loud, early, and impossible to miss.
 *   2. RUNTIME (`assertRailMayMoveValue`) — the payout/refund call sites check
 *      again. Boot configuration drifts, adapters get added by later code, and a
 *      guard that only runs once is a guard that only used to run.
 */

/**
 * APP_ENVs where a sandbox rail moving value is a refusal.
 *
 * `staging` is included for the same reason screening includes it: it is a
 * production-like posture reachable by real people, and it is where a dishonest
 * default gets normalised before it reaches prod.
 */
export const RAIL_POSTURE_ENFORCED_ENVS = ['staging', 'prod'] as const;

export type ValueMovementPolicy = 'live-only' | 'allow-sandbox';

export interface RailPosture {
  readonly appEnv: string;
  readonly policy: ValueMovementPolicy;
  /** True when an operator deliberately overrode the refusal. */
  readonly sandboxOverride: boolean;

  /**
   * The policy for the PUBLIC HOSTED CHECKOUT — and the one thing
   * `PAY_ALLOW_SANDBOX_RAILS` does NOT relax.
   *
   * That override exists so an operator can run a pilot, a demo or a load test
   * in a production-like environment, and its documented meaning is: no USER OF
   * THIS DEPLOYMENT is being told anything true about their money. Everyone it
   * covers is inside the exercise — an operator, a tester, an investor being
   * shown a screen.
   *
   * A HOSTED CHECKOUT IS REACHABLE BY STRANGERS. The payer is not in the pilot;
   * they followed a link, they are not logged in, and they have not agreed to
   * anything. "Nobody here is being told the truth" cannot be consented to on
   * their behalf by an environment variable — so the public path follows the
   * ENVIRONMENT, not the override, and in `staging`/`prod` it is `live-only`
   * whatever the flag says.
   */
  readonly publicCheckoutPolicy: ValueMovementPolicy;
}

export interface RailPostureStatus {
  readonly policy: ValueMovementPolicy;
  readonly live: readonly string[];
  readonly sandbox: readonly string[];
  /**
   * Rails registered with NOTHING behind them.
   *
   * Its own list, because these used to be counted as `sandbox` and that was the
   * wrong place. A rail that refuses every call is neither a hazard to gate nor a
   * capability to count. An operator needs "this rail will lie to you" and "this
   * rail will not answer you" as separate lines: the first is a posture decision,
   * the second is usually a contract nobody has signed yet.
   */
  readonly absent: readonly string[];
  /** One line an operator can read in a log, on `/ready`, or on a dashboard. */
  readonly summary: string;
}

/**
 * Which rails are real, said out loud.
 *
 * Exists because "how many rails are registered" and "how many rails can
 * actually send money" are different questions, and the answer to both used to
 * be an indistinguishable two.
 */
export function railPostureStatus(rails: RailRegistry, policy: ValueMovementPolicy = 'allow-sandbox'): RailPostureStatus {
  const live = rails
    .list()
    .filter((a) => a.mode === 'live')
    .map((a) => a.id);
  const sandbox = rails
    .list()
    .filter((a) => a.mode === 'sandbox')
    .map((a) => a.id);
  const absent = rails
    .list()
    .filter((a) => a.mode === 'absent')
    .map((a) => a.id);

  const base =
    sandbox.length === 0
      ? `rails: ${live.length} live [${live.join(', ')}], 0 sandbox`
      : `rails: ${live.length} live [${live.join(', ') || '—'}], ${sandbox.length} SANDBOX [${sandbox.join(', ')}] — ` +
        (policy === 'live-only'
          ? 'sandbox rails are refused for payout and refund'
          : 'SANDBOX RAILS MAY MOVE VALUE. A payout here returns a fabricated reference and nothing leaves.');

  // APPENDED, never woven in. A deployment with no absent rails reads exactly as
  // it always did — a clean posture still needs no extra words, and the operator
  // who has learned to recognise the old line does not have to relearn it.
  const summary =
    absent.length === 0
      ? base
      : `${base}; ${absent.length} ABSENT [${absent.join(', ')}] — nothing is configured behind these; every call refuses`;

  return { policy, live, sandbox, absent, summary };
}

export class SandboxRailError extends Error {
  constructor(
    readonly appEnv: string,
    readonly sandboxRails: readonly string[],
  ) {
    super(
      `SANDBOX RAILS ARE REGISTERED AND APP_ENV=${appEnv}. Refusing to start.\n\n` +
        `Sandbox rails: ${sandboxRails.join(', ')}\n\n` +
        `Each of these declares \`payout\`, and each has a SIMULATED counterparty. A withdrawal or a ` +
        `merchant payout routed to one of them debits a real ledger balance, returns a provider ` +
        `reference this codebase invented, and reports success. The user is told their money moved. ` +
        `Nothing moved.\n\n` +
        `The books will balance perfectly while this is happening — double entry is satisfied by a ` +
        `fabricated settlement exactly as well as by a real one. The only figure that can tell them ` +
        `apart is the rail boundary account reconciled against actual custody, and by the time that ` +
        `job disagrees, the platform has been lying to users for however long it has been up.\n\n` +
        `THE FIX IS A LIVE RAIL, NOT A FLAG. Write an adapter with a real counterparty, pass the ` +
        `conformance kit (services/svc-pay/src/rails/conformance.ts), and register it. What the owner ` +
        `must obtain for each kind:\n` +
        `  · crypto-native — a chain node/RPC endpoint, custody of outbound signing keys, and a ` +
        `signing service that will not broadcast one business key twice. See ChainNotConfiguredError.\n` +
        `  · card acquiring — a sponsor bank / acquiring BIN. §13 lists this as a socket precisely ` +
        `because it is a commercial relationship, not code. §6.1's endgame is principal membership.\n` +
        `  · bank payout rails — a payment-institution licence or a sponsored BIN-adjacent ` +
        `arrangement, plus the provider's production credentials.\n\n` +
        `IF YOU ARE RUNNING A DELIBERATE SANDBOX in a production-like environment — a pilot, a demo ` +
        `to an investor, a load test — set PAY_ALLOW_SANDBOX_RAILS=true. It is logged at boot on ` +
        `every start, and it is an explicit statement that no user of this deployment is being told ` +
        `anything true about their money leaving.\n\n` +
        `dev and test are deliberately unaffected: the sandbox rails ARE the test fixture there.`,
    );
    this.name = 'SandboxRailError';
  }
}

/**
 * Called at boot, before the listener opens.
 *
 * Returns the posture so the caller can log it — in dev, where this does not
 * throw, the log line IS the control's visibility. Same contract as
 * `assertScreeningConfigured`.
 */
export function assertRailPosture(rails: RailRegistry, env: Record<string, string | undefined> = process.env): RailPosture {
  const appEnv = env.APP_ENV ?? 'dev';
  const enforced = (RAIL_POSTURE_ENFORCED_ENVS as readonly string[]).includes(appEnv);
  const sandboxOverride = env.PAY_ALLOW_SANDBOX_RAILS === 'true';

  /**
   * `sandbox` ONLY — an ABSENT rail does not fail boot, and that is a fix rather
   * than a relaxation.
   *
   * This filter is unchanged in text and changed in effect, because `RailMode`
   * used to collapse `absent` into `sandbox`. The consequence was perverse:
   * `defaultChainFor` hands `staging`/`prod` an `UnconfiguredChain` when nothing
   * is set — the DESIGNED and SAFE production default — and that chain made
   * `crypto-native` report `sandbox`, which landed here, which refused to boot.
   * The documented escape was `PAY_ALLOW_SANDBOX_RAILS=true`, whose whole meaning
   * is "sandbox rails may move value here". The gate was pushing operators toward
   * setting, in production, the exact override it exists to warn about.
   *
   * An absent rail cannot fabricate anything. `UnconfiguredChain` throws on every
   * call including the reads, `crypto-native` reports it unhealthy so routing and
   * the console never offer it, and `assertRailMayMoveValue` refuses it by name
   * under every policy. There is no hazard here to fail boot over — only a rail
   * that has not been bought yet, which is `railStatus.absent` on `/ready` and in
   * the boot log.
   */
  const sandboxRails = rails
    .list()
    .filter((a) => a.mode === 'sandbox')
    .map((a) => a.id);

  if (enforced && !sandboxOverride && sandboxRails.length > 0) {
    throw new SandboxRailError(appEnv, sandboxRails);
  }

  return {
    appEnv,
    // An override relaxes the BOOT refusal, not the honesty of the log line.
    // The runtime policy follows the boot decision so the two cannot disagree.
    policy: enforced && !sandboxOverride ? 'live-only' : 'allow-sandbox',
    sandboxOverride: enforced && sandboxOverride,
    // NOT `&& !sandboxOverride`. See the field's own comment: the override is a
    // statement an operator can make about the people inside their own
    // deployment, and a hosted checkout is reachable by people who are not.
    publicCheckoutPolicy: enforced ? 'live-only' : 'allow-sandbox',
  };
}

/**
 * THIS RAIL IS NOT LIVE, AND HERE IS WHICH KIND OF NOT-LIVE IT IS.
 *
 * ── WHY THE CLASS KEEPS ITS NAME AND GAINS A `reason` ───────────────────────
 *
 * `pay.rail_not_live` was always the accurate code; `SandboxRailRefusal` was the
 * accurate NAME only while `sandbox` was the only way to be not-live. Now that
 * `RailMode` carries `absent` distinctly, there are two, and they need different
 * words in front of an operator:
 *
 *   sandbox — the rail WILL answer, and its answer is fabricated. The fix is a
 *             live adapter, or a deliberate `PAY_ALLOW_SANDBOX_RAILS`.
 *   absent  — the rail will NOT answer at all. There is no flag; the fix is
 *             usually a contract somebody has to sign.
 *
 * Sending an operator to look for a flag when the real answer is a sponsor bank
 * costs them a day, which is the whole reason the two are now told apart.
 *
 * The class is not split because `router.ts` maps `instanceof SandboxRailRefusal`
 * to SERVICE_UNAVAILABLE, and that mapping is correct for both: the request was
 * well-formed and the platform cannot serve it. Splitting the type to say
 * something the code already says would break that mapping for the new case and
 * reach a client as INTERNAL_SERVER_ERROR, which reads as "retry" — the one thing
 * that can never fix either of these.
 */
export type RailNotLiveReason = 'sandbox' | 'absent';

export class SandboxRailRefusal extends Error {
  readonly code = 'pay.rail_not_live';

  constructor(
    readonly railId: string,
    readonly capability: RailCapability,
    readonly reason: RailNotLiveReason = 'sandbox',
  ) {
    super(
      reason === 'absent'
        ? `Rail "${railId}" has NOTHING CONFIGURED BEHIND IT and this deployment refuses ${capability} on it. ` +
            `This is not a sandbox: a sandbox would answer, and answer falsely. This rail will not answer at ` +
            `all — every call to it refuses — so the refusal is raised HERE, before anything is written, ` +
            `rather than after a hold has been placed for a reason that was knowable beforehand. No value ` +
            `has been moved and no hold has been placed.\n\n` +
            `THERE IS NO FLAG FOR THIS. PAY_ALLOW_SANDBOX_RAILS permits a SIMULATION, and there is no ` +
            `simulation here to permit. What is missing is the thing behind the rail — a chain node and ` +
            `signing custody for crypto, a sponsor bank and an acquiring BIN for cards — and §13 lists ` +
            `those as sockets precisely because they are commercial relationships rather than code.`
        : `Rail "${railId}" is a SANDBOX and this deployment refuses ${capability} on a sandbox rail. ` +
            `A ${capability} here would return a provider reference nothing outside this process has ever ` +
            `seen, and the caller would be told value moved when none did. No value has been moved and no ` +
            `hold has been placed.`,
    );
    this.name = reason === 'absent' ? 'AbsentRailRefusal' : 'SandboxRailRefusal';
  }
}

/**
 * THE RUNTIME GATE. Call it before the ledger moves, never after.
 *
 * Placed at the money sites rather than inside `RailRegistry.require` so the
 * refusal is visible in the code that is about to move value — and so the
 * registry stays what its own comment says it is: a map from id to adapter that
 * does not choose between rails.
 *
 * ORDERING IS THE WHOLE POINT. This must run before `withdrawHold`. Refusing
 * after the hold is posted leaves the user's funds immobilised for a reason that
 * was knowable before anything was touched.
 */
export function assertRailMayMoveValue(adapter: RailAdapter, capability: RailCapability, policy: ValueMovementPolicy): void {
  // AN ABSENT RAIL IS REFUSED UNDER EVERY POLICY, INCLUDING `allow-sandbox`, and
  // ahead of every other consideration.
  //
  // `allow-sandbox` is an operator's statement about a SIMULATION: "everything
  // here works, and none of it is real, and everyone it affects is inside the
  // exercise." That statement cannot be made about a rail with nothing behind it,
  // because there is no simulation to consent to — the call is going to refuse
  // whatever this function decides. Letting it through would mean the ledger
  // moves first and the rail refuses second, which is precisely the ordering the
  // comment above forbids: a hold posted for a reason that was knowable before
  // anything was touched.
  //
  // It also refuses by the RIGHT NAME. `SandboxRailRefusal` says "this rail
  // fabricates references", which is untrue of an absent rail and sends an
  // operator to look for a flag instead of a contract.
  if (adapter.mode === 'absent') throw new SandboxRailRefusal(adapter.id, capability, 'absent');

  if (policy !== 'live-only') return;
  if (!VALUE_LEAVING_CAPABILITIES.includes(capability)) return;
  if (adapter.mode === 'live') return;
  throw new SandboxRailRefusal(adapter.id, capability);
}

// ── THE PUBLIC INBOUND GATE ──────────────────────────────────────────────────

export type PublicCheckoutUnavailableReason = 'sandbox' | 'absent' | 'none-configured' | 'unhealthy' | 'psp-unset';

export type PublicCheckoutUnavailableCode =
  | 'pay.checkout_rail_not_live'
  /** Operator checkout rail list is empty — not "the rail is down". */
  | 'pay.checkout_rails_unset'
  /** Card/PSP acquiring is not configured (`socket.psp-partners`) — not a sandbox lie. */
  | 'pay.psp_unset';

export function publicCheckoutUnavailableCode(reason: PublicCheckoutUnavailableReason): PublicCheckoutUnavailableCode {
  if (reason === 'none-configured') return 'pay.checkout_rails_unset';
  if (reason === 'psp-unset') return 'pay.psp_unset';
  return 'pay.checkout_rail_not_live';
}

export class PublicCheckoutUnavailable extends Error {
  readonly code: PublicCheckoutUnavailableCode;

  constructor(
    readonly railId: string | null,
    /**
     * `absent` is its own reason for the same operator-facing purpose the third
     * `RailMode` serves: "we have a rail and it lies" and "we have no rail" send
     * a reader to two different places, and only one of them is fixable today.
     * `psp-unset` is the card-acquiring socket (`socket.psp-partners`) specifically.
     */
    readonly reason: PublicCheckoutUnavailableReason,
  ) {
    super(
      (railId === null
        ? `No rail can accept a public hosted-checkout payment on this deployment (${reason}). `
        : `Rail "${railId}" cannot accept a public hosted-checkout payment on this deployment (${reason}). `) +
        `No session was opened, no payment row exists, and no payer has been shown a checkout that ` +
        `could not complete.`,
    );
    this.name = 'PublicCheckoutUnavailable';
    this.code = publicCheckoutUnavailableCode(reason);
  }
}

/**
 * STRICTER THAN `assertRailMayMoveValue`, and it has to be.
 *
 * `VALUE_LEAVING_CAPABILITIES` deliberately excludes `authorize` and `capture`,
 * and the reasoning in `rail-adapter.ts` is sound as far as it goes: a sandbox
 * capture leaves the PLATFORM short, reconciliation against the rail boundary is
 * exactly the figure that catches it, and nobody has been told their own money
 * left.
 *
 * THAT REASONING ASSUMES THE PAYER IS THE MERCHANT'S OWN INTEGRATION — a
 * merchant server calling `payment.create` with a rail id it chose, on a
 * deployment whose posture it knows. Every part of that assumption fails on a
 * hosted checkout:
 *
 *   · The payer is an anonymous third party who agreed to nothing and is shown
 *     "paid" by a page carrying our name.
 *   · The merchant is credited clearing they can settle and then withdraw, so a
 *     fabricated inbound becomes a real outbound one hop later.
 *   · Nobody in the loop can see which rail was used, or what mode it was in.
 *
 * So on the public surface a sandbox rail is refused under the same `live-only`
 * policy that refuses a sandbox payout. One boot decision, two call sites, and
 * no second route around the P0.
 *
 * CALLED BEFORE THE SESSION ROW EXISTS, never after — a payer must not be shown
 * a checkout that cannot possibly complete, and refusing before anything is
 * written leaves nothing to reconcile.
 */
export function assertRailMayAcceptPublicPayment(adapter: RailAdapter, policy: ValueMovementPolicy): void {
  // Under EVERY policy, including dev's. A sandbox rail is a legitimate fixture
  // and dev genuinely wants a payer to be able to complete a checkout against
  // it; an absent rail cannot complete anything, so opening a session on it hands
  // a payer a page that is guaranteed to fail. `selectPublicCheckoutRail` already
  // skips it as unhealthy — this is the direct-call path, and a gate that is only
  // correct when reached one particular way is not a gate.
  if (adapter.mode === 'absent') throw new PublicCheckoutUnavailable(adapter.id, 'absent');

  if (policy !== 'live-only') return;
  if (adapter.mode === 'live') return;
  throw new PublicCheckoutUnavailable(adapter.id, 'sandbox');
}

/**
 * What a rail must be able to do before a public checkout may point at it.
 *
 * `webhook` is the load-bearing entry. A hosted checkout completes when the
 * RAIL says the money arrived, never when the browser says so — a rail that
 * cannot deliver a verified webhook has no way to tell us anything true, and a
 * session on it could only ever be completed by trusting the payer's own page.
 */
export const PUBLIC_CHECKOUT_CAPABILITIES: readonly RailCapability[] = ['authorize', 'capture', 'webhook'];

/**
 * Why a preference-list entry was skipped. Taxonomy only — no invented cost or
 * approval-rate numbers (DIRECTION §8 blanks refuse closed).
 */
export type RailSkipReason = 'not-registered' | 'missing-capability' | 'absent' | 'unhealthy' | 'sandbox';

export interface RailDecisionEntry {
  readonly railId: string;
  readonly outcome: 'chosen' | 'skipped';
  /** Present on skips; omitted on the chosen rail. */
  readonly reason?: RailSkipReason;
}

/**
 * Preference walk with a full decision record (SPEC §5 — log reason per decision).
 * No cost weights, no geo tables, no risk scores.
 */
export interface PublicCheckoutRailDecision {
  readonly adapter: RailAdapter;
  readonly considered: readonly RailDecisionEntry[];
}

/**
 * Which registered rail serves a public checkout, in configured order.
 *
 * NOT ROUTING ALONE. Smart routing — geo, method, risk — lives in
 * `services/svc-pay/src/routing/decide.ts` (`selectSmartCheckoutRail`) and
 * replaces this preference walk when those dimensions are required. What this
 * does is far dumber and deliberately so: walk an operator-configured preference
 * list and take the first entry that is registered, can run the whole inbound
 * lifecycle, is answering, and passes the gate above.
 *
 * THE PREFERENCE LIST IS CONFIGURATION, NEVER A REQUEST FIELD. That is the whole
 * reason this function exists rather than a `railAdapter` input: a hosted
 * checkout that can name a rail, or a payment link that resolves to one, is
 * exactly where the sandbox-withdrawal P0 would come back.
 *
 * Prefer `selectPublicCheckoutRailDetailed` when the caller must persist the
 * decision record (SPEC §5). This wrapper keeps existing call sites stable.
 */
export function selectPublicCheckoutRail(
  rails: RailRegistry,
  preference: readonly string[],
  policy: ValueMovementPolicy,
  now: Date = new Date(),
): RailAdapter {
  return selectPublicCheckoutRailDetailed(rails, preference, policy, now).adapter;
}

/**
 * Preference walk + decision log. Reasons are only the existing skip taxonomy
 * (not-registered / missing-capability / absent / unhealthy / sandbox).
 */
export function selectPublicCheckoutRailDetailed(
  rails: RailRegistry,
  preference: readonly string[],
  policy: ValueMovementPolicy,
  now: Date = new Date(),
): PublicCheckoutRailDecision {
  let sawSandbox = false;
  let sawUnhealthy = false;
  let sawAbsent = false;
  const considered: RailDecisionEntry[] = [];

  for (const railId of preference) {
    if (!rails.has(railId)) {
      considered.push({ railId, outcome: 'skipped', reason: 'not-registered' });
      continue;
    }
    const adapter = rails.get(railId);
    if (!PUBLIC_CHECKOUT_CAPABILITIES.every((c) => adapter.capabilities.includes(c))) {
      considered.push({ railId, outcome: 'skipped', reason: 'missing-capability' });
      continue;
    }

    // BEFORE the health check, because an absent rail is unhealthy BY
    // CONSTRUCTION and reporting it as `unhealthy` would send an operator to
    // check a node's uptime when the node was never bought. Same distinction the
    // adapter already makes between `chain.unavailable` and `chain.not_configured`
    // — one is a bad minute, the other is a procurement task.
    if (adapter.mode === 'absent') {
      sawAbsent = true;
      considered.push({ railId, outcome: 'skipped', reason: 'absent' });
      continue;
    }

    if (!isUsable(adapter, now)) {
      sawUnhealthy = true;
      considered.push({ railId, outcome: 'skipped', reason: 'unhealthy' });
      continue;
    }
    try {
      assertRailMayAcceptPublicPayment(adapter, policy);
    } catch {
      sawSandbox = true;
      considered.push({ railId, outcome: 'skipped', reason: 'sandbox' });
      continue;
    }
    considered.push({ railId, outcome: 'chosen' });
    return { adapter, considered };
  }

  // The reason is for operators. The payer's page says "this merchant cannot
  // take payment right now" and nothing whatsoever about our rail estate.
  // Ordered most-actionable first. `sandbox` outranks `absent` because a
  // deployment with a sandbox rail configured has made a posture decision it can
  // revisit; `absent` outranks `unhealthy` because "nothing is configured" is not
  // something waiting five minutes will fix.
  const cardishPref = preference.length > 0 && preference.every((id) => /card|psp|acquirer/i.test(id));
  const collapsed: PublicCheckoutUnavailableReason = sawSandbox
    ? 'sandbox'
    : sawAbsent
      ? cardishPref
        ? 'psp-unset'
        : 'absent'
      : sawUnhealthy
        ? 'unhealthy'
        : 'none-configured';
  throw new PublicCheckoutUnavailable(null, collapsed);
}

/**
 * The chain to put behind `crypto-native`.
 *
 * THREE STATES, still — but the live one is no longer missing from the tree:
 *
 *   1. `PAY_CRYPTO_RPC_URL` (+ chain id, assets, signer, deposit source) set →
 *      `EvmLiveChain` with `posture: 'live'`. crypto-native becomes a live rail.
 *   2. Enforced env (`staging`/`prod`) with nothing set → `UnconfiguredChain`
 *      (refuses every call — never a quiet MemoryChain in production).
 *   3. `dev`/`test` with nothing set → `MemoryChain` (the suite fixture).
 *
 * A partial live config (RPC without keys, keys without RPC) REFUSES TO BUILD
 * a chain — better a loud boot failure than a rail that looks live and cannot
 * pay out.
 */
/**
 * @param broadcasts Durable journal for live EVM sends. Dev/test may omit it
 *   and get MemoryBroadcastStore (single-process). staging/prod live chain
 *   REFUSES to build without one — two replicas on MemoryBroadcastStore can
 *   double-send. Production boot injects PostgresBroadcastStore.
 */
export function defaultChainFor(
  env: Record<string, string | undefined> = process.env,
  broadcasts?: BroadcastStore,
  signer?: EvmSigner,
  deposits?: DepositAddressSource,
): CryptoChainPort {
  // Read first, so a TEST pace set beside a live chain, or in staging or prod, refuses to boot instead of being ignored.
  const pace = memoryChainPaceFromEnv(env);
  const live = tryLiveChainFromEnv(env, broadcasts, signer, deposits);
  if (live) {
    if (Object.keys(pace).length > 0)
      throw new Error(
        'PAY_TEST_CHAIN_SEND_DELAY_MS, PAY_TEST_CHAIN_REFUSE_AMOUNT and PAY_TEST_CHAIN_BLOCK_MS pace only the in-memory chain, not a live one',
      );
    return live;
  }

  const appEnv = env.APP_ENV ?? 'dev';
  const enforced = (RAIL_POSTURE_ENFORCED_ENVS as readonly string[]).includes(appEnv);
  return enforced ? new UnconfiguredChain() : new MemoryChain(pace);
}

/** The longest TEST wait a send may be given: long enough to watch, and under svc-edge's 15-second upstream timeout. */
export const MEMORY_CHAIN_MAX_SEND_DELAY_MS = 12_000;

/** The longest TEST block time: a send still confirms within minutes at any depth an owner sets. */
export const MEMORY_CHAIN_MAX_BLOCK_MS = 60_000;

/**
 * The in-memory chain's TEST pace (J-wallet-05 #8): `PAY_TEST_CHAIN_SEND_DELAY_MS` (whole milliseconds, at most
 * {@link MEMORY_CHAIN_MAX_SEND_DELAY_MS}), `PAY_TEST_CHAIN_REFUSE_AMOUNT` (an exact decimal) and `PAY_TEST_CHAIN_BLOCK_MS`
 * (one TEST block per that many whole milliseconds, 1 to {@link MEMORY_CHAIN_MAX_BLOCK_MS}). Unset is no pace. Set
 * anywhere but APP_ENV exactly `dev` or `test`, or set to a value that does not parse, refuses to boot: a TEST setting
 * never quietly shapes a real chain, and a mistyped one never quietly does nothing.
 */
export function memoryChainPaceFromEnv(env: Record<string, string | undefined>): MemoryChainPace {
  const delay = env.PAY_TEST_CHAIN_SEND_DELAY_MS?.trim();
  const refuse = env.PAY_TEST_CHAIN_REFUSE_AMOUNT?.trim();
  const block = env.PAY_TEST_CHAIN_BLOCK_MS?.trim();
  if (!delay && !refuse && !block) return {};
  if (env.APP_ENV !== 'dev' && env.APP_ENV !== 'test') {
    throw new Error(
      `PAY_TEST_CHAIN_SEND_DELAY_MS, PAY_TEST_CHAIN_REFUSE_AMOUNT and PAY_TEST_CHAIN_BLOCK_MS are TEST settings: APP_ENV must be dev or test, not "${env.APP_ENV ?? ''}"`,
    );
  }
  const pace: { sendDelayMs?: number; refuseAmount?: Amount; blockMs?: number } = {};
  if (delay) {
    if (!/^\d+$/.test(delay) || Number(delay) > MEMORY_CHAIN_MAX_SEND_DELAY_MS) {
      throw new Error(
        `PAY_TEST_CHAIN_SEND_DELAY_MS must be whole milliseconds from 0 to ${MEMORY_CHAIN_MAX_SEND_DELAY_MS}, not "${delay}"`,
      );
    }
    pace.sendDelayMs = Number(delay);
  }
  if (refuse) {
    let amount: Amount;
    try {
      amount = parseAmount(refuse);
    } catch {
      throw new Error(`PAY_TEST_CHAIN_REFUSE_AMOUNT must be an exact decimal amount, not "${refuse}"`);
    }
    if (amount <= 0n) throw new Error(`PAY_TEST_CHAIN_REFUSE_AMOUNT must be above zero, not "${refuse}"`);
    pace.refuseAmount = amount;
  }
  if (block) {
    if (!/^\d+$/.test(block) || Number(block) < 1 || Number(block) > MEMORY_CHAIN_MAX_BLOCK_MS) {
      throw new Error(`PAY_TEST_CHAIN_BLOCK_MS must be whole milliseconds from 1 to ${MEMORY_CHAIN_MAX_BLOCK_MS}, not "${block}"`);
    }
    pace.blockMs = Number(block);
  }
  return pace;
}

/**
 * Whether `card-sandbox` may be registered alongside crypto-native.
 *
 * In `staging`/`prod`, a registered sandbox rail fails boot unless
 * `PAY_ALLOW_SANDBOX_RAILS=true`. A deployment that has wired a live crypto
 * rail should not also register the sandbox acquirer by default — that would
 * force the override flag and re-open the fabricated-payout hole on the card
 * path. Dev/test keep the sandbox: it is the fixture.
 *
 * Override with `PAY_REGISTER_CARD_SANDBOX=true|false`.
 */
export function shouldRegisterCardSandbox(env: Record<string, string | undefined> = process.env): boolean {
  if (env.PAY_REGISTER_CARD_SANDBOX === 'true') return true;
  if (env.PAY_REGISTER_CARD_SANDBOX === 'false') return false;
  const appEnv = env.APP_ENV ?? 'dev';
  return !(RAIL_POSTURE_ENFORCED_ENVS as readonly string[]).includes(appEnv);
}

/**
 * The signer for the live rail when boot code did not inject one. Only the
 * testnet signer can be chosen by setting; a key is never read from settings.
 * A provider signer is injected by boot code once one is bought.
 */
function signerFromEnv(env: Record<string, string | undefined>, appEnv: string): EvmSigner {
  const choice = env.PAY_CRYPTO_SIGNER?.trim();
  if (!choice) {
    throw new SignerUnsetError('no signer is chosen. Set PAY_CRYPTO_SIGNER=testnet on a test chain, or inject a provider signer at boot.');
  }
  if (choice !== 'testnet') {
    throw new SignerUnsetError(`PAY_CRYPTO_SIGNER "${choice}" is not a signer this build ships. Only "testnet" is available.`);
  }
  if ((RAIL_POSTURE_ENFORCED_ENVS as readonly string[]).includes(appEnv)) {
    throw new SignerUnsetError(`the testnet signer is refused in ${appEnv}. Inject a provider signer at boot.`);
  }
  return TestnetSigner.ephemeral();
}

/**
 * The deposit address source for the live rail when boot code did not inject
 * one. Only the testnet source can be chosen by setting; a seed phrase is never
 * read from settings. A provider source is injected by boot code once one is bought.
 */
function depositSourceFromEnv(env: Record<string, string | undefined>, appEnv: string): DepositAddressSource {
  const choice = env.PAY_CRYPTO_DEPOSIT_SOURCE?.trim();
  if (!choice) {
    throw new DepositSourceUnsetError(
      'no deposit source is chosen. Set PAY_CRYPTO_DEPOSIT_SOURCE=testnet on a test chain, or inject a provider source at boot.',
    );
  }
  if (choice !== 'testnet') {
    throw new DepositSourceUnsetError(
      `PAY_CRYPTO_DEPOSIT_SOURCE "${choice}" is not a source this build ships. Only "testnet" is available.`,
    );
  }
  if ((RAIL_POSTURE_ENFORCED_ENVS as readonly string[]).includes(appEnv)) {
    throw new DepositSourceUnsetError(`the testnet deposit source is refused in ${appEnv}. Inject a provider source at boot.`);
  }
  return TestnetDepositAddresses.default();
}

export function tryLiveChainFromEnv(
  env: Record<string, string | undefined> = process.env,
  broadcasts?: BroadcastStore,
  injectedSigner?: EvmSigner,
  injectedDeposits?: DepositAddressSource,
): EvmLiveChain | null {
  const rpcUrl = env.PAY_CRYPTO_RPC_URL?.trim();
  if (!rpcUrl) return null;

  const missing: string[] = [];
  const chainIdRaw = env.PAY_CRYPTO_CHAIN_ID?.trim();
  const assetsRaw = env.PAY_CRYPTO_ASSETS?.trim();

  if (!chainIdRaw) missing.push('PAY_CRYPTO_CHAIN_ID');
  if (!assetsRaw) missing.push('PAY_CRYPTO_ASSETS');

  if (missing.length > 0) {
    throw new Error(
      `PAY_CRYPTO_RPC_URL is set, but live crypto rail config is incomplete. Missing: ${missing.join(', ')}. ` +
        `Either supply all of them, or unset PAY_CRYPTO_RPC_URL to keep the ${
          (RAIL_POSTURE_ENFORCED_ENVS as readonly string[]).includes(env.APP_ENV ?? 'dev')
            ? 'UnconfiguredChain refusal'
            : 'MemoryChain sandbox'
        }.`,
    );
  }

  const chainId = Number(chainIdRaw);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new Error(`PAY_CRYPTO_CHAIN_ID must be a positive integer (got "${chainIdRaw}")`);
  }

  const confirmationsRaw = env.PAY_MIN_CONFIRMATIONS?.trim();
  if (!confirmationsRaw) {
    throw new Error(
      'PAY_MIN_CONFIRMATIONS is unset. Blank refuses — never 6. Owner must set a positive integer (6 is allowed if explicit).',
    );
  }
  const minConfirmations = Number(confirmationsRaw);
  if (!Number.isInteger(minConfirmations) || minConfirmations < 1) {
    throw new Error(`PAY_MIN_CONFIRMATIONS must be an integer >= 1 (got "${confirmationsRaw}")`);
  }

  const appEnv = env.APP_ENV ?? 'dev';
  const enforced = (RAIL_POSTURE_ENFORCED_ENVS as readonly string[]).includes(appEnv);
  if (enforced && !broadcasts) {
    throw new Error(
      `Live crypto rail in ${appEnv} requires a durable BroadcastStore ` +
        `(PostgresBroadcastStore). MemoryBroadcastStore is single-process ` +
        `and two replicas can double-send the same payout.`,
    );
  }

  const signer = injectedSigner ?? signerFromEnv(env, appEnv);
  const deposits = injectedDeposits ?? depositSourceFromEnv(env, appEnv);

  return new EvmLiveChain({
    rpcUrl,
    chainId,
    deposits,
    signer,
    assets: parseEvmAssets(assetsRaw!),
    broadcasts: broadcasts ?? new MemoryBroadcastStore(),
    minConfirmations,
  });
}
