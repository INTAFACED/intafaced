import {
  BANK_CASH_LEG_CARRY,
  BANK_CASH_LEG_OFFERS,
  BANK_CASH_LEG_READ,
  type BankCashLeg,
  type BankCashLegOffers,
} from '@intafaced/contracts/bank-cash-leg-procedures';
import { trpcRecordReply, trpcRecordRequest } from '@intafaced/contracts/procedure-trpc';
import { parseAmount, type Amount } from '@intafaced/ledger-client/money';
import { z } from 'zod';

/**
 * svc-trade's reach to the partner's cash leg (J-cex-spot-11 #11): svc-bank's `convertCash.*` records, asked AS THE PERSON,
 * with the edge-signed principal of their own Convert request passed on byte for byte, so svc-bank's own scope and
 * verification gates decide and it answers only that person's cash. svc-trade keeps no copy of the person's cash or of the
 * leg: each read is the partner's, through svc-bank.
 *
 *   · `offers` answers what the partner converts now; no answer is "not offered here", never a guess.
 *   · `carry` answers the leg, or a refusal with svc-bank's code. No answer (a timeout, a 5xx, a reply out of shape) is
 *     `unknown`: the leg may have been made, and asking again under the same key makes it once.
 */

export interface CashLegOffer {
  readonly cash: string;
  readonly coin: string;
  readonly rate: Amount;
  readonly available: Amount | null;
  readonly label: string;
  readonly test: boolean;
}

export type CashLegAnswer =
  | { readonly state: 'carried'; readonly leg: BankCashLeg }
  | { readonly state: 'refused'; readonly code: string; readonly message: string }
  | { readonly state: 'unknown' };

export interface CashLegPort {
  offers(forwarded: Record<string, string>): Promise<{ offers: CashLegOffer[]; reason: string }>;
  carry(
    forwarded: Record<string, string>,
    ask: { legKey: string; cash: string; coin: string; spend: string; least: string; venue: { venueId: string; owner: string } },
  ): Promise<CashLegAnswer>;
  leg(forwarded: Record<string, string>, key: string): Promise<BankCashLeg | null | 'unread'>;
}

const FETCH_MS = 8_000;

/** No bank wired: nothing is offered. */
export const NO_CASH_LEG: CashLegPort = {
  offers: async () => ({ offers: [], reason: 'no partner offers a cash leg here' }),
  carry: async () => ({ state: 'refused', code: 'bank.cash_leg_not_offered', message: 'no partner offers a cash leg here' }),
  leg: async () => null,
};

async function send(url: string, init: RequestInit): Promise<{ status: number; body: unknown } | null> {
  try {
    const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(FETCH_MS) });
    const body: unknown = await response.json().catch(() => null);
    return { status: response.status, body };
  } catch {
    return null;
  }
}

/** The tRPC error body svc-bank sends: its message, and its own code in `data.cause.code` (a BankError) or `data.intafacedCode`. */
const trpcErrorBody = z.object({
  error: z.object({
    message: z.string().optional(),
    data: z.object({ intafacedCode: z.string().optional(), cause: z.object({ code: z.string().optional() }).optional() }).optional(),
  }),
});

/** svc-bank's own refusal code from a tRPC error body, or null when it names none. */
function refusalOf(body: unknown): { code: string; message: string } | null {
  const parsed = trpcErrorBody.safeParse(body);
  if (!parsed.success) return null;
  const { message = '', data } = parsed.data.error;
  const code = data?.cause?.code || data?.intafacedCode;
  return code ? { code, message } : null;
}

export function createCashLegClient(bankUrl: string): CashLegPort {
  const base = bankUrl.trim().replace(/\/+$/, '');
  if (!base) return NO_CASH_LEG;
  const headersOf = (forwarded: Record<string, string>) => ({ 'content-type': 'application/json', ...forwarded });
  return {
    async offers(forwarded) {
      if (Object.keys(forwarded).length === 0) return { offers: [], reason: 'the partner can be asked only during your own request' };
      const answer = await send(trpcRecordRequest(BANK_CASH_LEG_OFFERS, base, {}).url, { method: 'GET', headers: headersOf(forwarded) });
      const read: BankCashLegOffers | null = answer && answer.status === 200 ? trpcRecordReply(BANK_CASH_LEG_OFFERS, answer.body) : null;
      if (!read) return { offers: [], reason: 'the partner did not answer, so cash through a coin is not offered now' };
      return {
        offers: read.offers.map((o) => ({
          cash: o.cash,
          coin: o.coin,
          rate: parseAmount(o.rate),
          available: o.available === null ? null : parseAmount(o.available),
          label: o.label,
          test: o.test,
        })),
        reason: read.reason ?? '',
      };
    },
    async carry(forwarded, ask) {
      if (Object.keys(forwarded).length === 0)
        return { state: 'refused', code: 'bank.cash_leg_not_offered', message: 'the partner can be asked only during your own request' };
      const request = trpcRecordRequest(BANK_CASH_LEG_CARRY, base, ask);
      const answer = await send(request.url, { method: request.method, headers: headersOf(forwarded), body: request.body ?? null });
      if (!answer) return { state: 'unknown' };
      if (answer.status === 200) {
        const leg = trpcRecordReply(BANK_CASH_LEG_CARRY, answer.body);
        return leg ? { state: 'carried', leg } : { state: 'unknown' };
      }
      const refusal = answer.status < 500 || answer.status === 503 ? refusalOf(answer.body) : null;
      // A 503 sending leg is not a refusal: the cash is taken and the coin is paid on the next ask.
      if (!refusal || refusal.code === 'bank.cash_leg_sending') return { state: 'unknown' };
      return { state: 'refused', ...refusal };
    },
    async leg(forwarded, key) {
      if (Object.keys(forwarded).length === 0) return 'unread';
      const answer = await send(trpcRecordRequest(BANK_CASH_LEG_READ, base, { legKey: key }).url, {
        method: 'GET',
        headers: headersOf(forwarded),
      });
      const read = answer && answer.status === 200 ? trpcRecordReply(BANK_CASH_LEG_READ, answer.body) : null;
      return read ? read.leg : 'unread';
    },
  };
}
