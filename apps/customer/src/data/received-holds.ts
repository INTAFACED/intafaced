// hand-declared-ok: svc-bank's `holds.*` answers are declared in its router (services/svc-bank/src/holds/holds.router.ts).
/**
 * Payments from people not in the caller's contacts (PP-money-balance-05, J-pay-03 #5): the caller's rule (pay them in,
 * or hold them to accept), and the payments waiting for an answer. svc-bank `holds.rule`, `holds.setRule`,
 * `holds.waiting`, `holds.accept` and `holds.deny`.
 *
 * A release period the owner has not published is `holdDays: null`, and choosing "hold" then refuses
 * `bank.stranger_hold_period_unset`: the screen names it, never a made-up number of days.
 */
import { z } from 'zod';
import type { ApiClient } from '../shared/api';
import {
  BANK_HOLDS_RULE,
  BANK_HOLDS_SET_RULE,
  BANK_HOLDS_WAITING,
  BANK_HOLDS_ACCEPT,
  BANK_HOLDS_DENY,
} from '@intafaced/contracts/bank-holds-procedures';

const receiveRuleSchema = z.object({
  strangers: z.enum(['pay_in', 'hold']),
  holdDays: z.number().int().positive().nullable(),
});
export type ReceiveRule = z.infer<typeof receiveRuleSchema>;
export type StrangerRule = ReceiveRule['strangers'];

const receivedHoldSchema = z.object({
  transferId: z.string(),
  state: z.enum(['placing', 'held', 'releasing', 'released', 'returning', 'returned', 'lapsed']),
  reasonClass: z.literal('stranger'),
  amount: z.string(),
  assetId: z.string(),
  fromHandle: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: z.string(),
  releaseAt: z.string(),
  decidedAt: z.string().nullable(),
});
export type ReceivedHold = z.infer<typeof receivedHoldSchema>;

export const RECEIVED_HOLD_CODES = [
  'bank.stranger_hold_period_unset',
  'bank.received_hold_not_found',
  'bank.received_hold_not_ready',
  'bank.received_hold_decided',
] as const;
export type ReceivedHoldCode = (typeof RECEIVED_HOLD_CODES)[number];

export type Outcome<T> = { kind: 'ok'; data: T } | { kind: 'refused'; code: ReceivedHoldCode } | { kind: 'failed' };

const known = (code: string | undefined): code is ReceivedHoldCode => (RECEIVED_HOLD_CODES as readonly string[]).includes(code ?? '');

function outcome<T>(result: { ok: true; data: T } | { ok: false; code?: string }): Outcome<T> {
  if (result.ok) return { kind: 'ok', data: result.data };
  return known(result.code) ? { kind: 'refused', code: result.code } : { kind: 'failed' };
}

export const fetchReceiveRule = async (api: ApiClient, signal?: AbortSignal) =>
  outcome(await api.call(BANK_HOLDS_RULE, undefined, { signal }));

export const setReceiveRule = async (api: ApiClient, strangers: StrangerRule) =>
  outcome(await api.call(BANK_HOLDS_SET_RULE, { strangers }));

export const fetchWaitingPayments = async (api: ApiClient, signal?: AbortSignal) =>
  outcome(await api.call(BANK_HOLDS_WAITING, undefined, { signal }));

export const answerWaitingPayment = async (api: ApiClient, answer: 'accept' | 'deny', transferId: string) =>
  outcome(await (answer === 'accept' ? api.call(BANK_HOLDS_ACCEPT, { transferId }) : api.call(BANK_HOLDS_DENY, { transferId })));
