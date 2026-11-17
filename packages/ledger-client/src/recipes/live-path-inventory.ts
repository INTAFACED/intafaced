/**
 * D26-P2-11 — Ledger recipe matrix closed for live paths.
 *
 * Done bar: every money path → named recipe or explicit §13.
 *
 * The registry (`export const recipes`) is the product surface. Every registry
 * key is either a §13 socket listed in RECIPE_SOCKETS (the recipe exists so the
 * path can be honest later; nothing posts it today) or live: a production
 * service posts it. Live is not written down here; it is every registry key
 * that is not a socket, and live-path-inventory.test.ts proves each one has a
 * production caller outside the recipe-gate catalog, and that no socket gains
 * one unannounced. So a new recipe that a service posts needs no row here; one
 * that nothing posts yet gets a socket row with its reason.
 */

import { recipes, type RecipeName } from './index.js';

/** A recipe nothing in production posts yet, and why. */
export interface RecipeSocket {
  readonly kind: 'socket';
  /** Always §13 — deliberate not-in-v1 / parked wire. */
  readonly socket: '§13';
  readonly reason: string;
}

/** How a registry recipe is accounted for against live money paths. */
export type RecipeDisposition = { readonly kind: 'live' } | RecipeSocket;

/**
 * The §13 sockets. Socket reasons cite the ADR / park that keeps them unwired —
 * not a ticket to invent a caller. Wiring one deletes its row here.
 */
export const RECIPE_SOCKETS = {
  marketMakerSeedFund: {
    kind: 'socket',
    socket: '§13',
    reason:
      '§13 — recipe funds the house MM pot from a named rail; trade.mm-bot seed jobs consume a pre-funded pot and do not post this. Ops/treasury seed door is not a service writer on tip (package + test seed only).',
  },
  tradeFillFeeCorrection: {
    kind: 'socket',
    socket: '§13',
    reason:
      '§13 — TRD-0171 posts a fee correction as a new balanced entry under trade.fill.fee.correction. It leaves the original trade.fill row. No production writer posts this yet; the recipe-gate catalog samples it and does not ledger.post.',
  },
  feeShareBudgetFund: {
    kind: 'socket',
    socket: '§13',
    reason:
      "§13 — sets collected builder-fee revenue aside for one venue's fee shares, keyed on the venue's claim. No production writer and no grant: fee shares wait for the owner's share rate (docs/adr/2026-11-10-launch-money-model.md, rule 1). The recipe-gate catalog samples it and does not ledger.post.",
  },
  feeShareOwe: {
    kind: 'socket',
    socket: '§13',
    reason:
      "§13 — a share of our fee on one fill owed to a lead trader or affiliate, from the venue's fee-share budget, keyed on the fill's earn key and the recipient. Refused with ledger.fee_share_rate_unset while the owner's share rate is unset, so no production writer and no grant (docs/adr/2026-11-10-launch-money-model.md, rule 1). The recipe-gate catalog samples it and does not ledger.post.",
  },
  feeSharePayOut: {
    kind: 'socket',
    socket: '§13',
    reason:
      "§13 — a fee share we owe paid from one of our own-funds places to the recipient's own wallet, keyed on the chain transaction. No production writer and no grant until fee shares can be owed (docs/adr/2026-11-10-launch-money-model.md, rule 1). The recipe-gate catalog samples it and does not ledger.post.",
  },
  partnerFeeSettle: {
    kind: 'socket',
    socket: '§13',
    reason:
      "§13 — our fees settled by a partner into our treasury wallet or our reserve at that partner, keyed on the partner's settlement line, refused above what it owes. No production writer and no grant until partner fees can be earned (docs/adr/2026-11-10-launch-money-model.md, rule 1). The recipe-gate catalog samples it and does not ledger.post.",
  },
  feeGiveBackOwe: {
    kind: 'socket',
    socket: '§13',
    reason:
      "§13 — a fee a customer paid on a fill, given back as goodwill: our builder-fee revenue down and what we owe them up, keyed fee-refund:<the fill's earn key>. Refused without two different approvers or above the fee paid on that fill. No production writer and no grant (docs/adr/2026-11-10-launch-money-model.md, rule 1). The recipe-gate catalog samples it and does not ledger.post.",
  },
  feeGiveBackPayOut: {
    kind: 'socket',
    socket: '§13',
    reason:
      "§13 — a fee give-back paid from one of our own-funds places to the customer's own wallet, keyed on the chain transaction, refused above what we owe them and above what the place holds. No production writer and no grant (docs/adr/2026-11-10-launch-money-model.md, rule 1). The recipe-gate catalog samples it and does not ledger.post.",
  },
  orderHoldAmend: {
    kind: 'socket',
    socket: '§13',
    reason:
      '§13 — qty-up extra hold on the orderHold pot. svc-trade native amend only reduces remaining quantity and refuses trade.amend_qty_up, so qty-up-amend.ts no longer posts this. The recipe-gate catalog samples it and does not ledger.post. No production writer on tip.',
  },
  bankTransferReversal: {
    kind: 'socket',
    socket: '§13',
    reason:
      '§13 — consented reversal of a posted internal send (bank-transfers BK-xfer-09): recipient available back to the original sender, only with the recipient consent. svc-bank has no production writer until BK-xfer-09 lands and no grant is added yet; the recipe-gate catalog samples it and does not ledger.post.',
  },
  marketListingFee: {
    kind: 'socket',
    socket: '§13',
    reason:
      '§13 — D26-P1-M2 vendor listing fee recipe; amount required (no invent rates). Deliberately unwired from svc-market: VendorService moves no value; commerce listing writer is M1 residual.',
  },
  marketPremiumPlacement: {
    kind: 'socket',
    socket: '§13',
    reason:
      '§13 — D26-P1-M2 premium placement fee recipe; amount required (no invent rates). Ranking/featured order stays owner residual; no svc-market writer posts this on tip.',
  },
  buybackOrderHold: {
    kind: 'socket',
    socket: '§13',
    reason:
      '§13 J-dex-protocol-17 buyback IOC order hold from the rewards engine; svc-trade wires it in the next PR (recipes land first, one package per PR).',
  },
  buybackOrderHoldRelease: {
    kind: 'socket',
    socket: '§13',
    reason:
      '§13 J-dex-protocol-17 unfilled remainder of a buyback IOC order back to the rewards engine; svc-trade wires it in the next PR.',
  },
  buybackTakerFill: {
    kind: 'socket',
    socket: '§13',
    reason:
      '§13 J-dex-protocol-17 buyback IOC fill against a customer ask, bought base into the rewards engine; svc-trade wires it in the next PR.',
  },
  subAccountTransfer: {
    kind: 'socket',
    socket: '§13',
    reason:
      '§13 — a transfer between two sub-accounts of one person. svc-identity only asserts the transfer door (assertTransferDoor in router.ts) and moves no value; no production service posts this and svc-ledger grants it to no caller (caller-allowlist.ts). The recipe-gate catalog samples it and does not ledger.post.',
  },
} as const satisfies Partial<Record<RecipeName, RecipeSocket>>;

export interface RecipeMatrixRow {
  readonly name: RecipeName;
  readonly disposition: RecipeDisposition;
}

export interface RecipeMatrixInventory {
  /** Registry keys, sorted. */
  readonly recipes: readonly RecipeName[];
  /** One row per registry recipe. */
  readonly rows: readonly RecipeMatrixRow[];
  readonly live: readonly RecipeName[];
  readonly sockets: readonly RecipeName[];
  /** Socket rows naming no registry recipe — a broken promise (the matrix lied). */
  readonly brokenPromises: readonly string[];
}

/**
 * Build the closed live-path inventory from the registry + RECIPE_SOCKETS: every
 * registry key that is not a socket is live. Pure data — no filesystem; the test
 * proves each live recipe has a production caller.
 */
export function buildRecipeMatrixInventory(): RecipeMatrixInventory {
  const registry = (Object.keys(recipes) as RecipeName[]).slice().sort();
  const socketRows: Partial<Record<string, RecipeSocket>> = RECIPE_SOCKETS;
  const registrySet = new Set<string>(registry);
  const brokenPromises = Object.keys(socketRows)
    .filter((name) => !registrySet.has(name))
    .map((name) => `socket-without-registry:${name}`)
    .sort();

  const rows: RecipeMatrixRow[] = registry.map((name) => ({ name, disposition: socketRows[name] ?? { kind: 'live' } }));
  const live = rows.filter((r) => r.disposition.kind === 'live').map((r) => r.name);
  const sockets = rows.filter((r) => r.disposition.kind === 'socket').map((r) => r.name);

  return { recipes: registry, rows, live, sockets, brokenPromises };
}

export function liveRecipeKeys(inventory = buildRecipeMatrixInventory()): readonly string[] {
  return inventory.live.slice();
}

export function socketRecipeKeys(inventory = buildRecipeMatrixInventory()): readonly string[] {
  return inventory.sockets.slice();
}

export function countByKind(inventory = buildRecipeMatrixInventory()): { live: number; socket: number } {
  return { live: inventory.live.length, socket: inventory.sockets.length };
}
