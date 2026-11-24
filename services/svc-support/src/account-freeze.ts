import type { ServiceAuthMode, ServiceSigner, SupportTicket } from '@intafaced/contracts';
import { callHttpRecord } from '@intafaced/contracts/procedure-http';
import { serviceCallSigner } from '@intafaced/contracts/service-auth-http';
import {
  IDENTITY_SUPPORT_ACCOUNT_FREEZE,
  IDENTITY_SUPPORT_ACCOUNT_FREEZE_RECORDS,
  SUPPORT_ACCOUNT_FREEZE_UNAVAILABLE,
  type SupportAccountFreezeInput,
  type SupportAccountFreezeRecords,
  type SupportAccountFreezeResult,
} from '@intafaced/contracts/support-account-freeze';
import { SupportError } from './support-service.js';
import { identitySecretSet } from './identity-grounding-honesty.js';

/**
 * AN ACCOUNT FREEZE ASKED FROM A REQUEST (J-support-public-20 #7, RC-support-public-07).
 *
 * The desk asks, from a customer's request, that the customer's account be frozen. svc-identity records it (the
 * account's trading restriction and its own audit row) and announces it, so agent permissions are revoked; this service
 * keeps no copy and never says a freeze happened that svc-identity did not answer. The customer comes off the request,
 * never from the agent's input, and the agent is the signed principal.
 *
 * There is no door here that lifts it, and a request's status change (resolve, close, reopen) never reaches
 * svc-identity. A closed request takes no freeze (`support.ticket_closed`); an identity that gives no answer, or isn't
 * wired, refuses `support.account_freeze_unavailable` and nothing is claimed.
 */

/** svc-identity's answer, or null when it gave none. */
export interface IdentityAccountFreeze {
  freeze(input: SupportAccountFreezeInput): Promise<SupportAccountFreezeResult | null>;
  records(input: { userId: string; ticketId: string }): Promise<SupportAccountFreezeRecords | null>;
}

type TicketReader = {
  getTicket(input: { userId: string; ticketId: string; asOperator?: boolean }): Promise<SupportTicket>;
};

export class AccountFreezes {
  constructor(
    private readonly support: TicketReader,
    private readonly identity: IdentityAccountFreeze | null,
  ) {}

  async request(operatorId: string, input: { ticketId: string; reason: string }): Promise<SupportAccountFreezeResult> {
    const ticket = await this.support.getTicket({ userId: operatorId, ticketId: input.ticketId, asOperator: true });
    if (ticket.status === 'closed') throw new SupportError('a closed request takes no freeze', 'support.ticket_closed');
    if (!this.identity) throw unavailable();
    const answer = await this.identity.freeze({ userId: ticket.userId, ticketId: ticket.id, operatorId, reason: input.reason });
    // Only an answer about this customer is a recorded freeze.
    if (!answer || answer.userId.toLowerCase() !== ticket.userId.toLowerCase()) throw unavailable();
    return answer;
  }

  /** What svc-identity recorded for this request, read back from it. Any request the desk can open, closed ones too. */
  async records(operatorId: string, input: { ticketId: string }): Promise<SupportAccountFreezeRecords> {
    const ticket = await this.support.getTicket({ userId: operatorId, ticketId: input.ticketId, asOperator: true });
    if (!this.identity) throw unavailable();
    const answer = await this.identity.records({ userId: ticket.userId, ticketId: ticket.id });
    // Only rows of this request are its record.
    if (!answer || answer.records.some((row) => row.ticketId !== ticket.id)) throw unavailable();
    return answer;
  }
}

function unavailable(): SupportError {
  return new SupportError(
    'the identity service gave no answer, so no freeze is recorded',
    SUPPORT_ACCOUNT_FREEZE_UNAVAILABLE,
    'svc-identity',
  );
}

/** svc-identity's two doors, signed as svc-support with the body bound. Any answer but a verified result is null. */
export function createIdentityAccountFreezeClient(
  baseUrl: string,
  internalSecret: string,
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode },
): IdentityAccountFreeze | null {
  if (!baseUrl || !identitySecretSet(internalSecret)) return null;
  const sign = serviceCallSigner({ service: 'svc-support', audience: 'svc-identity', legacySecret: internalSecret, s2s });
  const errorOf = (path: string, status: number) => new Error(`${path} refused (${status})`);
  const fetcher: typeof fetch = (target, init) => fetch(target, { ...init, signal: AbortSignal.timeout(5_000) });
  return {
    async freeze(input) {
      try {
        return await callHttpRecord(IDENTITY_SUPPORT_ACCOUNT_FREEZE, { baseUrl, input, sign, errorOf, fetcher });
      } catch {
        return null;
      }
    },
    async records(input) {
      try {
        return await callHttpRecord(IDENTITY_SUPPORT_ACCOUNT_FREEZE_RECORDS, { baseUrl, input, sign, errorOf, fetcher });
      } catch {
        return null;
      }
    },
  };
}
