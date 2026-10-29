import type { Sql } from 'postgres';
import { bankSendDestinationInputSchema, type BankSendDestinationPort } from '@intafaced/contracts';
import { parseAmount, type Amount } from '@intafaced/ledger-client';
import { PayError, type PayErrorCode } from '../../payment-service.js';
import { WithdrawalQuoteError } from '../quotes/errors.js';
import { signerFor, type WithdrawSignerPosture } from './signer-posture.js';

/**
 * THE DOOR FOR A SEND OUT OF THE PLATFORM (J-wallet-05 #6 and #7, issue #6517).
 *
 * `withdrawal.create` to a wallet outside the platform (not the internal branch, W-withdraw-14) passes three checks, in this
 * order, before anything is claimed or held, and the claim then accepts the quote inside its own transaction:
 *
 *   1. A SIGNER (`assertSigner`). The send names its network, and that network has a custody signer (`signer-posture.ts`).
 *      No network, another rail, or no signer for the network refuses `pay.wallet_withdraw_unavailable`, the code the
 *      customer app words as "no custody signer is set up". Checked first, so nothing else is asked of a send that cannot go.
 *   2. A QUOTE NAMED (`assertSigner` too). A send with no `quoteRef` refuses `withdrawal_quote.required`: its fee would be a
 *      guess.
 *   3. A SAVED ADDRESS ON THAT NETWORK (`assertDestination`). svc-bank owns the address book, so svc-pay asks it over
 *      `ramps.destinations.sendable` (packages/contracts) and never reads its tables. Only `ready` passes: saved for that
 *      asset on that network, approved, past its cooling-off, and the security lock open. Each other answer refuses by name
 *      (`pay.withdrawal_destination_*`); no answer at all refuses `pay.withdrawal_destination_unavailable`.
 *   4. THE QUOTE, IN THE CLAIM (`acceptQuoteForSend`). In the claim's transaction, after the guards: the quote is this
 *      person's, for the same asset, network and amount, not used by another withdrawal and not expired; its fee mode is
 *      `on_top`. It is accepted under the withdrawal's client reference in the same transaction that writes the row, so a
 *      refusal anywhere in the claim accepts nothing, and the row keeps the network, the quote reference and the fee.
 *
 * The fee then rides the hold, the settle and every reverse of the withdrawal from the stored row (`user-money-service.ts`):
 * what leaves the balance is the quote's total debit, and svc-ledger's door refuses a settle or reverse whose fee is not the
 * one its posted hold carries.
 *
 * If it crashes here, whose funds are stranded? None: checks 1 to 3 run before the claim; check 4 commits with the claim
 * row or not at all, and nothing is posted until the claim has committed.
 */
export interface SendOutDoorDeps {
  readonly signer: WithdrawSignerPosture;
  /** svc-bank's address book, asked by address. */
  readonly destinations: BankSendDestinationPort;
}

export interface SendOutAsk {
  readonly userId: string;
  readonly assetId: string;
  readonly rail: string;
  readonly networkId?: string | null;
  readonly quoteRef?: string | null;
  readonly destination: { readonly kind: string; readonly ref: string };
}

const DESTINATION_REFUSALS: Record<string, { code: PayErrorCode; message: string }> = {
  not_saved: {
    code: 'pay.withdrawal_destination_not_saved',
    message: 'That address is not in your address book for this asset; nothing is sent to it',
  },
  other_network: {
    code: 'pay.withdrawal_destination_network_mismatch',
    message: 'That address is saved for another network; sending it on this one is refused',
  },
  approval_pending: {
    code: 'pay.withdrawal_destination_unapproved',
    message: 'That address has not been approved yet; approve it from the link we emailed',
  },
  cooling: { code: 'pay.withdrawal_destination_cooling', message: 'That address is still in its cooling-off period' },
  cooling_unset: {
    code: 'pay.withdrawal_destination_cooling_unset',
    message: 'No cooling-off period is published for new addresses, so none can be sent to yet',
  },
  locked: { code: 'pay.withdrawal_destination_locked', message: 'Your security lock is on; nothing can be sent while it holds' },
  blocked: { code: 'pay.withdrawal_destination_blocked', message: 'That saved address cannot be used' },
};

export class SendOutDoor {
  constructor(private readonly deps: SendOutDoorDeps) {}

  /** Checks 1 and 2: a signer for the send's network, and a quote named. Asks nothing outside this process. */
  assertSigner(ask: SendOutAsk): void {
    if (signerFor(this.deps.signer, ask.rail, ask.networkId) === null) {
      const networkId = ask.networkId ?? null;
      throw new PayError(
        networkId
          ? `No custody signer is set up for network "${networkId}", so this withdrawal was refused before anything was held`
          : 'A send out of the platform names its network, and no custody signer is set up for this one; nothing was held',
        'pay.wallet_withdraw_unavailable',
        { networkId, rail: ask.rail },
      );
    }
    if (!ask.quoteRef) {
      throw new WithdrawalQuoteError('withdrawal_quote.required', 'a send out of the platform needs the fee quote it was shown');
    }
  }

  /** Check 3: svc-bank's address book says the address is saved on this network and may be sent to now. */
  async assertDestination(ask: SendOutAsk): Promise<void> {
    const question = { userId: ask.userId, assetId: ask.assetId, network: ask.networkId ?? '', ref: ask.destination.ref };
    // An asset, network or address the address book cannot hold is not in it: refused as not saved, never as "try again".
    const answer = bankSendDestinationInputSchema.safeParse(question).success
      ? await this.deps.destinations.check(question)
      : ({ state: 'not_saved', destinationId: null, coolingOffEndsAt: null } as const);
    if (answer.state === 'ready') return;
    if (answer.state === 'unavailable') {
      throw new PayError('The address book could not be read, so nothing was sent', 'pay.withdrawal_destination_unavailable');
    }
    const refusal = DESTINATION_REFUSALS[answer.state]!;
    throw new PayError(refusal.message, refusal.code, {
      networkId: ask.networkId ?? null,
      ...(answer.state === 'cooling' ? { coolingOffEndsAt: answer.coolingOffEndsAt } : {}),
    });
  }
}

export interface QuotedSendTerms {
  readonly userId: string;
  readonly clientRef: string;
  readonly assetId: string;
  readonly networkId: string;
  readonly amount: Amount;
  readonly quoteRef: string;
}

interface QuoteRow {
  id: string;
  asset_id: string;
  network_id: string;
  amount: string;
  fee_mode: string;
  fee_total: string;
  total_debit: string;
  expires_at: Date;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Check 4, run on the claim's own transaction (READ COMMITTED): the quote covers exactly this send and is accepted under its
 * client reference. Returns the fee the withdrawal carries.
 *
 * The quote row is locked first, alone. Its acceptance is then read by a statement of its own, so a claim that waited on the
 * lock sees an acceptance another claim committed meanwhile (a join in the locking statement would keep the old, empty
 * answer). The insert is `ON CONFLICT DO NOTHING`, and a conflict is decided from what is stored, never surfaced raw.
 */
export async function acceptQuoteForSend(tx: Sql, terms: QuotedSendTerms, at: Date): Promise<{ fee: Amount; totalDebit: Amount }> {
  const notFound = () => new WithdrawalQuoteError('withdrawal_quote.not_found', `no quote ${terms.quoteRef} for this account`);
  // Quotes are stored under the account's uuid; any other id has none.
  if (!GUID.test(terms.userId)) throw notFound();
  const [quote] = await tx<QuoteRow[]>`
    SELECT id, asset_id, network_id, amount::text AS amount, fee_mode, fee_total::text AS fee_total,
           total_debit::text AS total_debit, expires_at
      FROM pay.withdrawal_quotes
     WHERE user_id = ${terms.userId}::uuid AND quote_ref = ${terms.quoteRef}
       FOR UPDATE`;
  if (!quote) throw notFound();
  if (quote.asset_id !== terms.assetId || quote.network_id !== terms.networkId || parseAmount(quote.amount) !== terms.amount) {
    throw new WithdrawalQuoteError(
      'withdrawal_quote.terms_differ',
      `quote ${terms.quoteRef} is for other terms than this withdrawal; get the fee for this one`,
    );
  }
  if (quote.fee_mode !== 'on_top') {
    throw new WithdrawalQuoteError(
      'withdrawal_quote.fee_mode_unsupported',
      'this quote takes its fee out of the amount, which a send does not carry yet; nothing was held',
    );
  }
  const fee = parseAmount(quote.fee_total);
  const totalDebit = parseAmount(quote.total_debit);
  if (totalDebit !== terms.amount + fee) {
    throw new WithdrawalQuoteError('withdrawal_quote.terms_differ', `quote ${terms.quoteRef} does not add up; get the fee again`);
  }
  const decide = async (): Promise<'mine' | 'free'> => {
    const [accepted] = await tx<Array<{ client_ref: string }>>`
      SELECT client_ref FROM pay.withdrawal_quote_acceptances WHERE quote_id = ${quote.id}`;
    if (accepted) {
      if (accepted.client_ref === terms.clientRef) return 'mine';
      throw new WithdrawalQuoteError('withdrawal_quote.already_used', `quote ${terms.quoteRef} was used by another withdrawal`);
    }
    const [taken] = await tx<Array<{ quote_id: string }>>`
      SELECT quote_id FROM pay.withdrawal_quote_acceptances
       WHERE user_id = ${terms.userId}::uuid AND client_ref = ${terms.clientRef}`;
    if (taken) {
      throw new WithdrawalQuoteError(
        'withdrawal_quote.client_ref_taken',
        `client reference ${terms.clientRef} already accepted another quote`,
      );
    }
    return 'free';
  };
  if ((await decide()) === 'mine') return { fee, totalDebit };
  if (at.getTime() >= quote.expires_at.getTime()) {
    throw new WithdrawalQuoteError('withdrawal_quote.expired', `quote ${terms.quoteRef} has expired; get the fee again`);
  }
  const inserted = await tx<Array<{ quote_id: string }>>`
    INSERT INTO pay.withdrawal_quote_acceptances (quote_id, user_id, client_ref, accepted_at)
    VALUES (${quote.id}, ${terms.userId}, ${terms.clientRef}, ${at})
    ON CONFLICT DO NOTHING
    RETURNING quote_id`;
  // Another claim took the quote or this reference first: decide from what is stored now. Free again cannot happen.
  if (inserted.length === 0 && (await decide()) !== 'mine') {
    throw new WithdrawalQuoteError('withdrawal_quote.already_used', `quote ${terms.quoteRef} was used by another withdrawal`);
  }
  return { fee, totalDebit };
}
