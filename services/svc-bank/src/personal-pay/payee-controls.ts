/**
 * Owner-published payee controls and proof-upload limits for a global send (BK-xfer-07).
 *
 * Both are the owner's values and have no default. `BANK_PAYEE_CONTROLS_JSON` is `{ "blockedAccounts": ["..."] }`: a
 * published empty list blocks nothing, a blank or unreadable value refuses every send that needs the check
 * (`bank.payee_controls_unset`). `BANK_PROOF_LIMITS_JSON` is `{ "allowedTypes": ["application/pdf"], "maxBytes": 1048576 }`:
 * blank or unreadable refuses an upload (`bank.proof_limits_unset`). The list itself is never returned to a customer.
 */
import { parseAmount } from '@intafaced/ledger-client';
import { z } from 'zod';

const controlsShape = z.object({ blockedAccounts: z.array(z.string().trim().min(1).max(64)) }).strict();
const limitsShape = z
  .object({
    allowedTypes: z
      .array(
        z
          .string()
          .trim()
          .regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i),
      )
      .min(1),
    maxBytes: z.number().int().min(1).max(25_000_000),
  })
  .strict();

export const normalizeAccount = (account: string): string => account.replace(/\s+/g, '').toUpperCase();

export interface PayeeControls {
  readonly blocked: ReadonlySet<string>;
}
export interface ProofLimits {
  readonly allowedTypes: string[];
  readonly maxBytes: number;
}

function parseJson(raw: string | undefined): unknown {
  if (!raw || !raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function parsePayeeControls(raw: string | undefined): PayeeControls | null {
  const parsed = controlsShape.safeParse(parseJson(raw));
  if (!parsed.success) return null;
  return { blocked: new Set(parsed.data.blockedAccounts.map(normalizeAccount)) };
}

export function parseProofLimits(raw: string | undefined): ProofLimits | null {
  const parsed = limitsShape.safeParse(parseJson(raw));
  if (!parsed.success) return null;
  return { allowedTypes: parsed.data.allowedTypes.map((type) => type.toLowerCase()), maxBytes: parsed.data.maxBytes };
}

const allowanceShape = z
  .object({
    exchangeAccounts: z.array(z.string().trim().min(1).max(64)),
    windowDays: z.number().int().min(1).max(365),
    limits: z.array(z.object({ asset: z.string().trim().min(2).max(16), maxAmount: z.string().regex(/^\d+(\.\d{1,18})?$/) })),
  })
  .strict();

export interface ExchangeAllowance {
  readonly accounts: ReadonlySet<string>;
  readonly windowDays: number;
  readonly limits: ReadonlyMap<string, string>;
}

/**
 * `BANK_EXCHANGE_ALLOWANCE_JSON`: `{ exchangeAccounts: [...], windowDays: n, limits: [{ asset, maxAmount }] }`. The owner names
 * which recipient accounts are crypto exchanges and how much one person may send to them per asset in a rolling window. No
 * default: blank or unreadable refuses every send (`bank.exchange_allowance_unset`); an exchange account with no limit for the
 * asset refuses the same way. A published empty account list means none is an exchange.
 */
export function parseExchangeAllowance(raw: string | undefined): ExchangeAllowance | null {
  const parsed = allowanceShape.safeParse(parseJson(raw));
  if (!parsed.success) return null;
  // A limit the ledger cannot read as money makes the whole setting unreadable, never a throw at send time.
  for (const limit of parsed.data.limits) {
    try {
      parseAmount(limit.maxAmount);
    } catch {
      return null;
    }
  }
  return {
    accounts: new Set(parsed.data.exchangeAccounts.map(normalizeAccount)),
    windowDays: parsed.data.windowDays,
    limits: new Map(parsed.data.limits.map((limit) => [limit.asset.toUpperCase(), limit.maxAmount])),
  };
}
