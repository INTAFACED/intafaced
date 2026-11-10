import {
  serviceCallSigner,
  SUPPORT_WITHDRAWAL_FREEZE_PATH,
  SUPPORT_WITHDRAWAL_FREEZE_RECORDS_PATH,
  supportWithdrawalFreezeRecordsResultSchema,
  supportWithdrawalFreezeResultSchema,
  type ServiceAuthMode,
  type ServiceSigner,
  type SupportTicket,
  type SupportWithdrawalFreezeInput,
  type SupportWithdrawalFreezeRecordsInput,
  type SupportWithdrawalFreezeRecordsResult,
  type SupportWithdrawalFreezeResult,
} from '@intafaced/contracts';
import { SupportError } from './support-service.js';
import { identitySecretSet } from './identity-grounding-honesty.js';

/**
 * A WITHDRAWAL FREEZE ASKED FROM A REQUEST (J-support-public-20 #7, RC-support-public-07).
 *
 * The desk asks, from a customer's request, that the customer's withdrawals be frozen. svc-identity records it (the
 * account's security lock, set by support, and its own audit row); this service keeps no copy and never says a freeze
 * happened that svc-identity did not answer. The customer comes off the request, never from the agent's input, and the
 * agent is the signed principal.
 *
 * Freezing only takes power away: nothing here moves, posts or reads money, and no hold is touched. There is no door
 * that lifts the freeze, and a request's status change (resolve, close, reopen) never reaches svc-identity. A closed
 * request takes no freeze (`support.ticket_closed`); an identity that gives no answer, or isn't wired, refuses
 * `support.withdrawal_freeze_unavailable` and nothing is claimed.
 */

export const WITHDRAWAL_FREEZE_UNAVAILABLE = 'support.withdrawal_freeze_unavailable' as const;

/** svc-identity's answer, or null when it gave none. */
export interface IdentityWithdrawalFreeze {
  freeze(input: SupportWithdrawalFreezeInput): Promise<SupportWithdrawalFreezeResult | null>;
  /** The audit rows svc-identity recorded for one request, or null when it gave no answer. */
  records(input: SupportWithdrawalFreezeRecordsInput): Promise<SupportWithdrawalFreezeRecordsResult | null>;
}

type TicketReader = {
  getTicket(input: { userId: string; ticketId: string; asOperator?: boolean }): Promise<SupportTicket>;
};

export class WithdrawalFreezes {
  constructor(
    private readonly support: TicketReader,
    private readonly identity: IdentityWithdrawalFreeze | null,
  ) {}

  async request(operatorId: string, input: { ticketId: string; reason: string }): Promise<SupportWithdrawalFreezeResult> {
    const ticket = await this.support.getTicket({ userId: operatorId, ticketId: input.ticketId, asOperator: true });
    if (ticket.status === 'closed') throw new SupportError('a closed request takes no freeze', 'support.ticket_closed');
    if (!this.identity) throw unavailable();
    const answer = await this.identity.freeze({ userId: ticket.userId, ticketId: ticket.id, operatorId, reason: input.reason });
    // Only an answer about this customer, with the lock holding, is a recorded freeze.
    if (!answer || answer.lock.userId !== ticket.userId || !answer.lock.locked) throw unavailable();
    return answer;
  }

  /**
   * What svc-identity recorded for this request, read back from it: the desk sees the freeze's own audit rows, never a
   * copy kept here. Any request the desk can open, closed ones too; no answer refuses and nothing is claimed.
   */
  async records(operatorId: string, input: { ticketId: string }): Promise<SupportWithdrawalFreezeRecordsResult> {
    const ticket = await this.support.getTicket({ userId: operatorId, ticketId: input.ticketId, asOperator: true });
    if (!this.identity) throw unavailable();
    const answer = await this.identity.records({ userId: ticket.userId, ticketId: ticket.id });
    // Only rows of this request are its record.
    if (!answer || answer.records.some((row) => row.ticketId !== ticket.id)) throw unavailable();
    return answer;
  }
}

function unavailable(): SupportError {
  return new SupportError('the identity service gave no answer, so no freeze is recorded', WITHDRAWAL_FREEZE_UNAVAILABLE, 'svc-identity');
}

/** svc-identity's freeze door, signed as svc-support with the body bound. Any answer but a verified result is null. */
export function createIdentityWithdrawalFreezeClient(
  baseUrl: string,
  internalSecret: string,
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode },
): IdentityWithdrawalFreeze | null {
  if (!baseUrl || !identitySecretSet(internalSecret)) return null;
  const target = new URL(`${baseUrl.replace(/\/$/, '')}${SUPPORT_WITHDRAWAL_FREEZE_PATH}`);
  const recordsTarget = new URL(`${baseUrl.replace(/\/$/, '')}${SUPPORT_WITHDRAWAL_FREEZE_RECORDS_PATH}`);
  const sign = serviceCallSigner({ service: 'svc-support', audience: 'svc-identity', legacySecret: internalSecret, s2s });
  return {
    async freeze(input) {
      const body = JSON.stringify(input);
      try {
        const res = await fetch(target, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            ...sign(body, { method: 'POST', url: target, contentType: 'application/json' }),
          },
          body,
          signal: AbortSignal.timeout(5_000),
        });
        if (!res.ok) return null;
        const parsed = supportWithdrawalFreezeResultSchema.safeParse(await res.json());
        return parsed.success ? parsed.data : null;
      } catch {
        return null;
      }
    },
    async records(input) {
      const body = JSON.stringify(input);
      try {
        const res = await fetch(recordsTarget, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            ...sign(body, { method: 'POST', url: recordsTarget, contentType: 'application/json' }),
          },
          body,
          signal: AbortSignal.timeout(5_000),
        });
        if (!res.ok) return null;
        const parsed = supportWithdrawalFreezeRecordsResultSchema.safeParse(await res.json());
        return parsed.success ? parsed.data : null;
      } catch {
        return null;
      }
    },
  };
}
