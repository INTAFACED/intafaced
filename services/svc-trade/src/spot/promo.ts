/**
 * CARD R-promo — create-promo refuses without budget and end.
 *
 * PTX-M21-R06 / socket.promotion-law / socket.rebate-negative-fee-funding.
 * Do not invent rebate bps. Absent funding = no rebate. Preview only — no
 * ledger post, no live program.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatAmount, parseAmount, ZERO } from '@intafaced/ledger-client';
import { composeServiceBlock } from '@intafaced/config/compose';

export const CREATE_PROMO_PATH = '/api/v1/promotions' as const;

export const PROMO_BUDGET_ENV = 'TRADE_PROMO_BUDGET' as const;
export const PROMO_END_ENV = 'TRADE_PROMO_END' as const;

export const PROMO_BUDGET_UNSET = 'trade.promo_budget_unset' as const;
export const PROMO_END_UNSET = 'trade.promo_end_unset' as const;
export const PROMO_IEEE = 'trade.promo_ieee' as const;

export type PromoRefuseCode = typeof PROMO_BUDGET_UNSET | typeof PROMO_END_UNSET | typeof PROMO_IEEE;

export type CreatePromoOk = {
  readonly ok: true;
  readonly preview: true;
  readonly created: false;
  readonly posted: false;
  readonly funded: boolean;
  readonly budget: string;
  readonly end: string;
  readonly rebateBps: string | null;
};

export type CreatePromoRefuse = {
  readonly ok: false;
  readonly code: PromoRefuseCode;
  readonly reason: string;
  readonly created: false;
  readonly posted: false;
  readonly rebateBps: null;
};

export type CreatePromoResult = CreatePromoOk | CreatePromoRefuse;

export type CreatePromoInput = {
  readonly budget?: unknown;
  readonly end?: unknown;
  readonly rebateBps?: unknown;
  /** Must never be invoked — create-promo mill does not post. */
  readonly post?: (recipe: unknown) => Promise<unknown>;
};

const INTEGER_BPS = /^[0-9]{1,4}$/;

function present(raw: unknown): boolean {
  if (raw === undefined || raw === null) return false;
  if (typeof raw === 'string' && raw.trim() === '') return false;
  return true;
}

function ieeeOnWire(raw: unknown): boolean {
  return typeof raw === 'number';
}

function pickSocket(input: unknown, fromEnv: unknown): unknown {
  return present(input) ? input : fromEnv;
}

export function readOwnerPromoBudget(env: NodeJS.ProcessEnv = process.env): unknown {
  return env[PROMO_BUDGET_ENV];
}

export function readOwnerPromoEnd(env: NodeJS.ProcessEnv = process.env): unknown {
  return env[PROMO_END_ENV];
}

function ownerBudget(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  try {
    const amount = parseAmount(raw.trim());
    if (amount < ZERO) return null;
    return formatAmount(amount);
  } catch {
    return null;
  }
}

function ownerEnd(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (Number.isNaN(Date.parse(trimmed))) return null;
  return trimmed;
}

function ownerRebateBps(raw: unknown): string | null {
  if (!present(raw)) return null;
  if (typeof raw !== 'string' || !INTEGER_BPS.test(raw.trim())) return null;
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < 0 || n >= 10_000) return null;
  return String(n);
}

/**
 * Create-promotion admission. Blank budget or end refuses by name.
 * IEEE money/bps refused. Unpublished rebate stays null — never 10/20.
 * Zero/unfunded budget is present but grants no rebate.
 */
export function checkCreatePromo(input: CreatePromoInput = {}): CreatePromoResult {
  void input.post;

  const budgetRaw = pickSocket(input.budget, readOwnerPromoBudget());
  if (ieeeOnWire(budgetRaw) || ieeeOnWire(input.rebateBps)) {
    return {
      ok: false,
      code: PROMO_IEEE,
      reason: 'TRADE_PROMO_BUDGET and rebateBps must be decimal strings — IEEE number refused on the wire',
      created: false,
      posted: false,
      rebateBps: null,
    };
  }
  if (!present(budgetRaw)) {
    return {
      ok: false,
      code: PROMO_BUDGET_UNSET,
      reason: 'TRADE_PROMO_BUDGET is unset — refuse create-promo rather than invent a budget',
      created: false,
      posted: false,
      rebateBps: null,
    };
  }
  const budget = ownerBudget(budgetRaw);
  if (budget == null) {
    return {
      ok: false,
      code: PROMO_BUDGET_UNSET,
      reason: 'TRADE_PROMO_BUDGET is unset — refuse create-promo rather than invent a budget',
      created: false,
      posted: false,
      rebateBps: null,
    };
  }

  const endRaw = pickSocket(input.end, readOwnerPromoEnd());
  if (ieeeOnWire(endRaw)) {
    return {
      ok: false,
      code: PROMO_IEEE,
      reason: 'TRADE_PROMO_END must be an owner end string — IEEE number refused on the wire',
      created: false,
      posted: false,
      rebateBps: null,
    };
  }
  const end = ownerEnd(endRaw);
  if (end == null) {
    return {
      ok: false,
      code: PROMO_END_UNSET,
      reason: 'TRADE_PROMO_END is unset — refuse create-promo rather than invent an end',
      created: false,
      posted: false,
      rebateBps: null,
    };
  }

  const funded = parseAmount(budget) > ZERO;
  const rebateBps = funded ? ownerRebateBps(input.rebateBps) : null;

  return {
    ok: true,
    preview: true,
    created: false,
    posted: false,
    funded,
    budget,
    end,
    rebateBps,
  };
}

/** Create-promo door. Refuses or previews; never posts; never accrues rebate. */
export async function runCreatePromo(input: CreatePromoInput = {}): Promise<CreatePromoResult> {
  const check = checkCreatePromo(input);
  void input.post;
  return check;
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

export function tradeComposeBlock(): string {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  return composeServiceBlock(compose, 'svc-trade');
}

export function promoOwnerEnvComposeWired(): boolean {
  const block = tradeComposeBlock();
  return (
    /TRADE_PROMO_BUDGET:\s*\$\{TRADE_PROMO_BUDGET:-\}/.test(block) &&
    /TRADE_PROMO_END:\s*\$\{TRADE_PROMO_END:-\}/.test(block) &&
    !/TRADE_PROMO_BUDGET:\s*\$\{TRADE_PROMO_BUDGET:-[^}\s]+\}/.test(block) &&
    !/TRADE_PROMO_END:\s*\$\{TRADE_PROMO_END:-[^}\s]+\}/.test(block)
  );
}
