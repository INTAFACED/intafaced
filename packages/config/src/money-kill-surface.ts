/**
 * MONEY KILL SURFACE (D26-P2-10) — one operator family for every money door.
 *
 * Done bar: every money route is killable from the same surface family, proven.
 *
 * ── Same surface family (do not invent a second console) ────────────────────
 *
 *   · Module kills  → `POST /admin/kill-switches` on svc-edge (`admin:write`+MFA)
 *                     enforced by the edge `onRequest` kill-switch guard.
 *   · Book freeze   → `POST /admin/ledger/freeze` on svc-edge (`admin:treasury`+MFA)
 *                     durable `posting_freeze` on svc-ledger — the only platform-wide
 *                     value freeze (see `freeze-authority.ts`).
 *
 * Module kills stop NEW COMMITMENTS at the public door. They do not replace the
 * ledger freeze, and they must not invent a fake "freeze pay" / "freeze trade"
 * book switch — those refuse via `assertFreezeAuthority`.
 *
 * ── What this file is / is not ──────────────────────────────────────────────
 *
 * Catalogue + invariants only. No I/O. Behaviour is proved by
 * `services/svc-edge/src/money-routes.kill-switch.test.ts` and the money matrix
 * in `control-plane.e2e.test.ts` (flip via `/admin/kill-switches`).
 *
 * Operator incident steps stay in `docs/OPS-KILL-SWITCH-RUNBOOK.md` (P3-10).
 * This file is the mapping the gate enforces — not a second runbook.
 */

import { MODULES, MODULE_IDS, isModuleId, type ModuleId } from './modules.js';

/** How a money door is halted from the shared operator surface. */
export type MoneyKillControl =
  | {
      readonly kind: 'edge-module';
      /** Module id armed on `POST /admin/kill-switches`. */
      readonly module: ModuleId;
    }
  | {
      readonly kind: 'ledger-freeze';
      /** Operator path — never a module flag. */
      readonly surface: '/admin/ledger/freeze';
    }
  | {
      readonly kind: 'via-sibling';
      readonly module: ModuleId;
      /** Kill this instead — the sibling that owns the public door. */
      readonly haltVia: ModuleId;
      readonly note: string;
    }
  | {
      readonly kind: 'not-deployed';
      readonly module: ModuleId;
      readonly note: string;
    };

/**
 * One public money commitment the operator must be able to stop.
 *
 * Paths are edge-facing (`/api/...`). Internal S2S jobs keep their own env
 * kill-switches (defence in depth) and are not listed here — the public door
 * is what D26-P2-10 closes.
 */
export interface MoneyPublicDoor {
  readonly id: string;
  readonly module: ModuleId;
  readonly method: 'POST' | 'DELETE' | 'PUT' | 'PATCH';
  readonly path: string;
  /** One sentence an operator can act on at 3am. */
  readonly what: string;
  readonly control: MoneyKillControl;
}

/**
 * Residual families that #1683 left thin — must stay in `MONEY_PUBLIC_DOORS`.
 *
 * Prior land covered one sample door per live custodial module. D26-P2-10 deepen
 * closes the remaining commitment surfaces (convert/otc/algo/copy, pay settle +
 * withdraw, bank loans/spaces, p2p disputes, token unstake/buyback, agents
 * metering) so "every money route" is not a six-row sketch.
 */
export const MONEY_KILL_RESIDUAL_DOOR_IDS = [
  'trade.convert.execute',
  'trade.otc.accept',
  'trade.otc.settle',
  'trade.algo.createTwap',
  'trade.copy.follow',
  'trade.copy.planMirror',
  'trade.copy.settleFeeShare',
  'pay.payment.create',
  'pay.payment.authorize',
  'pay.payment.capture',
  'pay.settlement.run',
  'pay.settlement.payout',
  'pay.deposit.credit',
  'pay.withdrawal.create',
  'pay.public.payments.create',
  'pay.public.payments.capture',
  'bank.earn.withdraw',
  'bank.spaces.create',
  'bank.loans.open',
  'p2p.disputes.open',
  'token.unstake',
  'token.recordBuyback',
  'agents.session.open',
  'agents.run.complete',
] as const;

/**
 * Canonical money commitment doors — every live public write that must refuse
 * when its kill control is armed.
 *
 * Extending this list is how a new money route stays in the prove suite: add a
 * row here, then the edge unit + e2e matrices fail closed until they cover it.
 */
export const MONEY_PUBLIC_DOORS: readonly MoneyPublicDoor[] = [
  {
    id: 'trade.trpc.create',
    module: 'trade',
    method: 'POST',
    path: '/api/trade/trpc/orders.create',
    what: 'place a spot/futures order over tRPC',
    control: { kind: 'edge-module', module: 'trade' },
  },
  {
    id: 'trade.ccxt.create',
    module: 'trade',
    method: 'POST',
    path: '/api/v1/orders',
    what: 'place an order over the public CCXT REST contract',
    control: { kind: 'edge-module', module: 'trade' },
  },
  {
    id: 'trade.ccxt.positions',
    module: 'trade',
    method: 'POST',
    path: '/api/v1/positions',
    what: 'open a futures position (new risk)',
    control: { kind: 'edge-module', module: 'trade' },
  },
  {
    id: 'trade.convert.execute',
    module: 'trade',
    method: 'POST',
    path: '/api/trade/trpc/convert.execute',
    what: 'execute a convert (instant swap commitment)',
    control: { kind: 'edge-module', module: 'trade' },
  },
  {
    id: 'trade.otc.accept',
    module: 'trade',
    method: 'POST',
    path: '/api/trade/trpc/otc.accept',
    what: 'accept an OTC quote (new risk)',
    control: { kind: 'edge-module', module: 'trade' },
  },
  {
    id: 'trade.otc.settle',
    module: 'trade',
    method: 'POST',
    path: '/api/trade/trpc/otc.settle',
    what: 'settle an OTC trade (moves value)',
    control: { kind: 'edge-module', module: 'trade' },
  },
  {
    id: 'trade.algo.createTwap',
    module: 'trade',
    method: 'POST',
    path: '/api/trade/trpc/algo.createTwap',
    what: 'schedule a TWAP algo (future places)',
    control: { kind: 'edge-module', module: 'trade' },
  },
  {
    id: 'trade.copy.follow',
    module: 'trade',
    method: 'POST',
    path: '/api/trade/trpc/copy.follow',
    what: 'follow a copy-trading leader (mirror risk)',
    control: { kind: 'edge-module', module: 'trade' },
  },
  {
    id: 'trade.copy.planMirror',
    module: 'trade',
    method: 'POST',
    path: '/api/trade/trpc/copy.planMirror',
    what: 'plan a copy mirror place',
    control: { kind: 'edge-module', module: 'trade' },
  },
  {
    id: 'trade.copy.settleFeeShare',
    module: 'trade',
    method: 'POST',
    path: '/api/trade/trpc/copy.settleFeeShare',
    what: 'settle copy fee-share (moves value)',
    control: { kind: 'edge-module', module: 'trade' },
  },
  {
    id: 'pay.checkout.open',
    module: 'pay',
    method: 'POST',
    path: '/api/pay/trpc/checkout.open',
    what: 'open a hosted checkout session (takes money)',
    control: { kind: 'edge-module', module: 'pay' },
  },
  {
    id: 'pay.merchant.create',
    module: 'pay',
    method: 'POST',
    path: '/api/pay/trpc/merchant.create',
    what: 'create a merchant that can accept payments',
    control: { kind: 'edge-module', module: 'pay' },
  },
  {
    id: 'pay.payment.create',
    module: 'pay',
    method: 'POST',
    path: '/api/pay/trpc/payment.create',
    what: 'create a merchant payment intent',
    control: { kind: 'edge-module', module: 'pay' },
  },
  {
    id: 'pay.payment.authorize',
    module: 'pay',
    method: 'POST',
    path: '/api/pay/trpc/payment.authorize',
    what: 'authorize a payment (holds funds)',
    control: { kind: 'edge-module', module: 'pay' },
  },
  {
    id: 'pay.payment.capture',
    module: 'pay',
    method: 'POST',
    path: '/api/pay/trpc/payment.capture',
    what: 'capture an authorized payment',
    control: { kind: 'edge-module', module: 'pay' },
  },
  {
    id: 'pay.settlement.run',
    module: 'pay',
    method: 'POST',
    path: '/api/pay/trpc/settlement.run',
    what: 'run a merchant settlement window',
    control: { kind: 'edge-module', module: 'pay' },
  },
  {
    id: 'pay.settlement.payout',
    module: 'pay',
    method: 'POST',
    path: '/api/pay/trpc/settlement.payout',
    what: 'payout a settlement off-platform',
    control: { kind: 'edge-module', module: 'pay' },
  },
  {
    id: 'pay.deposit.credit',
    module: 'pay',
    method: 'POST',
    path: '/api/pay/trpc/deposit.credit',
    what: 'credit a user deposit into the book',
    control: { kind: 'edge-module', module: 'pay' },
  },
  {
    id: 'pay.withdrawal.create',
    module: 'pay',
    method: 'POST',
    path: '/api/pay/trpc/withdrawal.create',
    what: 'withdraw user balance off-platform (edge prefix is pay)',
    control: { kind: 'edge-module', module: 'pay' },
  },
  {
    id: 'pay.public.payments.create',
    module: 'pay',
    method: 'POST',
    path: '/api/pay/v1/payments',
    what: 'create a payment over the public Pay REST contract',
    control: { kind: 'edge-module', module: 'pay' },
  },
  {
    id: 'pay.public.payments.capture',
    module: 'pay',
    method: 'POST',
    path: '/api/pay/v1/payments/pay_example/capture',
    what: 'capture a payment over the public Pay REST contract',
    control: { kind: 'edge-module', module: 'pay' },
  },
  {
    id: 'bank.earn.deposit',
    module: 'bank',
    method: 'POST',
    path: '/api/bank/trpc/earn.deposit',
    what: 'deposit into an earn pool (moves value)',
    control: { kind: 'edge-module', module: 'bank' },
  },
  {
    id: 'bank.earn.withdraw',
    module: 'bank',
    method: 'POST',
    path: '/api/bank/trpc/earn.withdraw',
    what: 'withdraw from an earn pool',
    control: { kind: 'edge-module', module: 'bank' },
  },
  {
    id: 'bank.transfers.schedule',
    module: 'bank',
    method: 'POST',
    path: '/api/bank/trpc/transfers.schedule',
    what: 'schedule a standing transfer',
    control: { kind: 'edge-module', module: 'bank' },
  },
  {
    id: 'bank.spaces.create',
    module: 'bank',
    method: 'POST',
    path: '/api/bank/trpc/spaces.create',
    what: 'create a bank space that can hold value',
    control: { kind: 'edge-module', module: 'bank' },
  },
  {
    id: 'bank.loans.open',
    module: 'bank',
    method: 'POST',
    path: '/api/bank/trpc/loans.open',
    what: 'open a collateralized loan (new debt)',
    control: { kind: 'edge-module', module: 'bank' },
  },
  {
    id: 'p2p.trades.take',
    module: 'p2p',
    method: 'POST',
    path: '/api/p2p/trpc/trades.take',
    what: 'take a P2P offer (escrowLock)',
    control: { kind: 'edge-module', module: 'p2p' },
  },
  {
    id: 'p2p.offers.create',
    module: 'p2p',
    method: 'POST',
    path: '/api/p2p/trpc/offers.create',
    what: 'create a P2P offer',
    control: { kind: 'edge-module', module: 'p2p' },
  },
  {
    id: 'p2p.disputes.open',
    module: 'p2p',
    method: 'POST',
    path: '/api/p2p/trpc/disputes.open',
    what: 'open a P2P dispute (escrow path)',
    control: { kind: 'edge-module', module: 'p2p' },
  },
  {
    id: 'token.stake',
    module: 'token',
    method: 'POST',
    path: '/api/token/trpc/stake',
    what: 'open a stake (custodial lock)',
    control: { kind: 'edge-module', module: 'token' },
  },
  {
    id: 'token.unstake',
    module: 'token',
    method: 'POST',
    path: '/api/token/trpc/unstake',
    what: 'unstake (releases custodial lock)',
    control: { kind: 'edge-module', module: 'token' },
  },
  {
    id: 'token.mintEpoch',
    module: 'token',
    method: 'POST',
    path: '/api/token/trpc/mintEpoch',
    what: 'mint the next emission epoch',
    control: { kind: 'edge-module', module: 'token' },
  },
  {
    id: 'token.recordBuyback',
    module: 'token',
    method: 'POST',
    path: '/api/token/trpc/recordBuyback',
    what: 'record a buyback burn (treasury money path)',
    control: { kind: 'edge-module', module: 'token' },
  },
  {
    id: 'mining.submitShare',
    module: 'mining-pool',
    method: 'POST',
    path: '/api/mining/submitShare',
    what: 'submit an observed share for ledger-backed PPLNS payout',
    control: { kind: 'edge-module', module: 'mining-pool' },
  },
  {
    id: 'market.purchase',
    module: 'market',
    method: 'POST',
    path: '/api/market/trpc/purchase',
    what: 'purchase a marketplace listing',
    control: { kind: 'edge-module', module: 'market' },
  },
  {
    id: 'market.createListing',
    module: 'market',
    method: 'POST',
    path: '/api/market/trpc/createListing',
    what: 'create a paid marketplace listing',
    control: { kind: 'edge-module', module: 'market' },
  },
  /**
   * Agents is non-custodial in MODULES, but metering bills via ledger recipes.
   * Killing `agents` at the edge stops new billed sessions/runs from the same
   * `/admin/kill-switches` surface — no second console.
   */
  {
    id: 'agents.session.open',
    module: 'agents',
    method: 'POST',
    path: '/api/agents/trpc/session.open',
    what: 'open a metered agent session (can bill)',
    control: { kind: 'edge-module', module: 'agents' },
  },
  {
    id: 'agents.run.complete',
    module: 'agents',
    method: 'POST',
    path: '/api/agents/trpc/run.complete',
    what: 'run a metered agent completion (bills usage)',
    control: { kind: 'edge-module', module: 'agents' },
  },
] as const;

/** Modules the edge kill-switch must be able to arm for money doors. */
export function edgeKillableMoneyModules(): readonly ModuleId[] {
  const out = new Set<ModuleId>();
  for (const door of MONEY_PUBLIC_DOORS) {
    if (door.control.kind === 'edge-module') out.add(door.control.module);
  }
  return MODULE_IDS.filter((id) => out.has(id));
}

/**
 * Every custodial module must declare how money movement on it is halted.
 *
 * Deployed-with-door → edge-module. Ledger → freeze. Matching engine → kill
 * trade. Undeployed placeholders → not-deployed (honest residual, not pretend).
 */
export function moneyKillControlFor(module: ModuleId): MoneyKillControl {
  if (module === 'ledger') {
    return { kind: 'ledger-freeze', surface: '/admin/ledger/freeze' };
  }
  if (module === 'matching') {
    return {
      kind: 'via-sibling',
      module: 'matching',
      haltVia: 'trade',
      note: 'svc-matching has no browser door; halt trade to stop new risk at the edge',
    };
  }
  if (module === 'launch' || module === 'bridge') {
    return {
      kind: 'not-deployed',
      module,
      note: `${MODULES[module].service} has no live public door in this tree — residual, not pretend-killable`,
    };
  }
  if (edgeKillableMoneyModules().includes(module)) {
    return { kind: 'edge-module', module };
  }
  // Non-custodial modules are not money doors; callers should filter.
  return {
    kind: 'not-deployed',
    module,
    note: `${module} is not a custodial money door on the shared kill surface`,
  };
}

/**
 * Invariant: every custodial module has an honest kill control (edge, freeze,
 * sibling, or explicit not-deployed). Never silent.
 */
export function assertCustodialMoneyKillsComplete(): readonly string[] {
  const failures: string[] = [];
  for (const id of MODULE_IDS) {
    if (!MODULES[id].custodial) continue;
    const control = moneyKillControlFor(id);
    if (control.kind === 'edge-module' && control.module !== id) {
      failures.push(`${id}: edge-module control must name itself`);
    }
    if (control.kind === 'ledger-freeze' && id !== 'ledger') {
      failures.push(`${id}: only ledger may use ledger-freeze`);
    }
    if (
      control.kind === 'not-deployed' &&
      (id === 'trade' || id === 'pay' || id === 'bank' || id === 'p2p' || id === 'token' || id === 'market')
    ) {
      failures.push(`${id}: live money module must not be classified not-deployed`);
    }
  }
  return failures;
}

/**
 * Invariant: residual money families from the deepen pass stay catalogued.
 * A catalogue that drops convert/otc/algo/copy/withdraw/agents is not complete.
 */
export function assertMoneyKillResidualsPresent(): readonly string[] {
  const ids = new Set(MONEY_PUBLIC_DOORS.map((d) => d.id));
  const failures: string[] = [];
  for (const id of MONEY_KILL_RESIDUAL_DOOR_IDS) {
    if (!ids.has(id)) failures.push(`missing residual money door "${id}"`);
  }
  if (!edgeKillableMoneyModules().includes('agents')) {
    failures.push('agents must be edge-killable — metering bills from the shared kill surface');
  }
  return failures;
}

/**
 * Edge prefix as declared in `svc-edge` `UPSTREAMS`. Passed in so this package
 * never imports the edge (sibling X6 owns that tree).
 */
export interface MoneyEdgeUpstream {
  readonly prefix: string;
  readonly module: string;
}

/**
 * Modules whose public edge prefixes must have a catalogue kill mapping.
 *
 * Custodial modules move value. `agents` is non-custodial in MODULES but
 * metering bills via ledger recipes, so it sits on the same surface.
 */
export function moneyRouteKillModules(): readonly ModuleId[] {
  return MODULE_IDS.filter((id) => id === 'agents' || MODULES[id].custodial);
}

function pathUnderPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function longestMatchingPrefix(path: string, upstreams: readonly MoneyEdgeUpstream[]): MoneyEdgeUpstream | undefined {
  return [...upstreams].filter((u) => pathUnderPrefix(path, u.prefix)).sort((a, b) => b.prefix.length - a.prefix.length)[0];
}

/**
 * Fail closed: a new money edge prefix without a `MONEY_PUBLIC_DOORS` row is
 * an unmapped route — the operator cannot prove it is killable from the
 * shared surface. Empty upstream lists fail (vacuous green is how the last
 * hole survived).
 *
 * Callers pass the live `UPSTREAMS` table (CI gate parses `routes.ts`; unit
 * tests pass fixtures including a deliberate unmapped prefix).
 */
export function assertMoneyRoutesHaveKillMapping(upstreams: readonly MoneyEdgeUpstream[]): readonly string[] {
  const failures: string[] = [];
  if (upstreams.length === 0) {
    failures.push('no edge upstreams provided — money-route kill mapping would pass vacuously');
    return failures;
  }

  const moneyModules = new Set<string>(moneyRouteKillModules());

  for (const upstream of upstreams) {
    // Skip only a registered non-money module. An unregistered name fails closed below.
    const knownModule = isModuleId(upstream.module);
    if (knownModule && !moneyModules.has(upstream.module)) continue;
    const control = knownModule ? moneyKillControlFor(upstream.module) : undefined;
    if (!control) {
      failures.push(`money route prefix "${upstream.prefix}" names unknown module "${upstream.module}" — no kill mapping`);
      continue;
    }
    if (control.kind === 'ledger-freeze') {
      failures.push(
        `money route prefix "${upstream.prefix}" maps to ledger — the book is halted at /admin/ledger/freeze, not an /api prefix`,
      );
      continue;
    }
    if (control.kind === 'not-deployed') {
      failures.push(
        `money route prefix "${upstream.prefix}" (module ${upstream.module}) is live on the edge but kill control is not-deployed — add a MONEY_PUBLIC_DOORS row and an edge-module mapping`,
      );
      continue;
    }
    if (control.kind === 'via-sibling') {
      failures.push(
        `money route prefix "${upstream.prefix}" (module ${upstream.module}) is live on the edge; halt via ${control.haltVia} is for services with no browser door`,
      );
      continue;
    }
    const covering = MONEY_PUBLIC_DOORS.filter((d) => d.module === upstream.module && pathUnderPrefix(d.path, upstream.prefix));
    if (covering.length === 0) {
      failures.push(
        `money route prefix "${upstream.prefix}" (module ${upstream.module}) has no kill mapping in MONEY_PUBLIC_DOORS — a new money door that is not in the catalogue cannot be proved killable from /admin/kill-switches`,
      );
    }
  }

  for (const door of MONEY_PUBLIC_DOORS) {
    if (door.control.kind !== 'edge-module') {
      failures.push(`money door "${door.id}" must use edge-module kill mapping (shared /admin/kill-switches surface)`);
      continue;
    }
    if (door.control.module !== door.module) {
      failures.push(`money door "${door.id}" kill mapping module ${door.control.module} !== door module ${door.module}`);
    }
    const match = longestMatchingPrefix(door.path, upstreams);
    if (!match) {
      failures.push(`money door "${door.id}" path ${door.path} matches no edge prefix — unmapped (will never hit the kill guard)`);
    } else if (match.module !== door.module) {
      failures.push(
        `money door "${door.id}" path ${door.path} resolves to prefix ${match.prefix} module ${match.module}, catalogue says ${door.module}`,
      );
    }
  }

  return failures;
}
