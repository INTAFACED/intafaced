import { assertWithdrawNetwork, type WithdrawNetworkSource } from './withdraw-networks.js';
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import { coolingOffEndsAt, readOfframpCoolingHours } from '../offramp-cooling.js';
import {
  assertBookEntry,
  evmChecksumMatches,
  isBankDestinationRef,
  isEvmAddressRef,
  lookalikeOf,
  type SaveDestinationInput,
  type UserWithdrawDestinations,
  type WithdrawDestination,
} from '../withdraw-destination.js';
import { resolvePayFiatRailId, type PayFiatRampPort } from './pay-fiat-adapter.js';
import { assertFiatSocketWhenNone, refuseFiatRamp, type RampProgramme } from './rails.js';
import type { OfframpFeeSource, OnrampMethod, OnrampPaymentInstruction, OnrampPaymentPort, OnrampQuoteSource } from './customer-ports.js';
import type { OnrampStandIn } from './onramp-sim.js';
import { ownershipOf, type Ownership, type WalletProofStore } from './wallet-ownership.js';
import { assertSecurityLockOpen, type SecurityLockPort } from '../security-lock.js';
import { openApprovalLinks, type ApprovalLinkStore } from './address-approval.js';
import type { DestinationFraudListPort } from './fraud-list.js';

/**
 * Customer-callable quote and destination procedures.
 *
 * Numbers are the port's decimals, canonicalised, or the call refuses.
 * Nothing here posts a ledger transaction. A fiat off-ramp still refuses
 * `bank.fiat_ramp_socket` before a quote or a row.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface CustomerRampDeps {
  sql: Sql;
  programme: RampProgramme;
  payFiat: PayFiatRampPort;
  quotes: OnrampQuoteSource | null;
  /** The TEST rate stand-in of the local stack (`ramp-sim`), for the asks it lists. Null everywhere else. */
  standIn?: OnrampStandIn | null;
  payments: OnrampPaymentPort | null;
  fees: OfframpFeeSource | null;
  destinations: UserWithdrawDestinations;
  networks: WithdrawNetworkSource | null;
  coolingRaw: () => string | undefined;
  /** Signed-message proofs that the customer controls a saved wallet (W-withdraw-17). */
  proofs: WalletProofStore;
  /** The owner's security lock, read from identity per request (W-withdraw-09). */
  securityLock: SecurityLockPort;
  /** Emailed approval links for new addresses (W-withdraw-09), so the book can say a link is out and until when. */
  approvalLinks: ApprovalLinkStore;
  /** The owner's destination fraud list (W-withdraw-03): a listed address is never saved, and a saved one reads blocked. */
  fraudList: DestinationFraudListPort;
}

interface QuoteRow {
  id: string;
  user_id: string;
  asset_id: string;
  amount: string;
  method: OnrampMethod;
  country: string;
  pay_amount: string;
  fee: string;
  rate: string;
  pay_currency: string;
  expires_at: Date;
  simulated: boolean;
  delivery_estimate: string | null;
  created_at: Date;
}

interface CustomerOnrampRow {
  id: string;
  user_id: string;
  quote_id: string;
  method: OnrampMethod;
  asset_id: string;
  amount: string;
  pay_amount: string;
  fee: string;
  rate: string;
  pay_currency: string;
  status: 'pending_payment';
  simulated: boolean;
  partner_rail: string;
  hosted_url: string | null;
  bank_reference: string | null;
  bank_account_name: string | null;
  bank_account_ref: string | null;
  created_at: Date;
}

export interface OnrampQuoteView {
  quoteId: string;
  assetId: string;
  amount: string;
  method: OnrampMethod;
  country: string;
  payAmount: string;
  fee: string;
  rate: string;
  payCurrency: string;
  expiresAt: string;
  /** The source's own delivery estimate, or null when it gave none. */
  deliveryEstimate: string | null;
  simulated: true;
}

export interface CustomerOnrampView {
  onrampId: string;
  quoteId: string;
  userId: string;
  assetId: string;
  amount: string;
  method: OnrampMethod;
  payAmount: string;
  fee: string;
  rate: string;
  payCurrency: string;
  status: 'pending_payment';
  simulated: true;
  partnerRail: string;
  hostedUrl: string | null;
  bankInstructions: { reference: string; accountName: string; accountRef: string } | null;
  createdAt: string;
}

export interface OfframpQuoteView {
  assetId: string;
  amount: string;
  kind: 'crypto';
  destinationRef: string;
  fee: string;
  netAmount: string;
  expiresAt: string;
  simulated: true;
}

export interface DestinationView {
  destinationId: string;
  label: string | null;
  kind: 'crypto' | 'bank';
  ref: string;
  /** The address with its middle hidden, for lists and logs. `ref` stays for the customer's own picker. */
  refMasked: string;
  assetId: string | null;
  network: string | null;
  tag: string | null;
  origin: 'legacy' | 'customer';
  /** `pending`: a new address waiting for the customer's approval; its cooling-off starts when it is approved. */
  state: 'pending' | 'cooling' | 'active' | 'blocked' | 'archived';
  addedAt: string;
  /** Null while the entry waits for approval (its cooling-off has not started) or while no period is published. */
  coolingOffEndsAt: string | null;
  coolingBlocker: 'bank.offramp_cooling_unset' | null;
  /** When the customer confirmed this address is not the saved entry it looks like (W-withdraw-03); null otherwise. */
  lookalikeConfirmedAt: string | null;
  /** Whether the customer has proved they control this wallet by signing a message (W-withdraw-17), from the latest proof. */
  ownership: Ownership;
  /** When and how the customer approved this new address (W-withdraw-09); null until then and on older entries. */
  approvedAt: string | null;
  approvedBy: 'link' | 'device' | null;
  /** While it waits: until when the newest emailed approval link works, or null when none is out. */
  approvalLinkExpiresAt: string | null;
}

export async function quoteOnramp(
  deps: CustomerRampDeps,
  input: { userId: string; assetId: string; amount: string; method: OnrampMethod; country: string },
): Promise<OnrampQuoteView> {
  const amount = positive(input.amount, 'On-ramp amount');
  assertAsset(input.assetId);
  const country = input.country.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) {
    throw new BankError('On-ramp country must be two letters', 'bank.validation_failed');
  }
  // The TEST stand-in prices only what it lists, and only on a dev or test stack; every other ask needs a programme and a
  // live pay rail as before. It is a rate source and nothing more: opening the payment still needs a partner.
  const standIn = deps.standIn?.covers({ assetId: input.assetId, method: input.method, country }) ? deps.standIn : null;
  if (!standIn) {
    assertFiatSocketWhenNone(deps.programme);
    await resolvePayFiatRailId(deps.payFiat, 'onramp');
  }
  const source = standIn?.quotes ?? deps.quotes;
  if (!source) {
    throw new BankError(
      'On-ramp quote has no rate or fee source. socket.psp-partners is not a price. No pay amount, fee, or rate is invented.',
      'bank.onramp_rate_unset',
    );
  }
  const terms = await source.quote({
    assetId: input.assetId,
    amount: formatAmount(amount),
    method: input.method,
    country,
  });
  if (!terms) {
    throw new BankError(
      'The rate source returned no on-ramp quote. socket.psp-partners is not a price. No pay amount, fee, or rate is invented.',
      'bank.onramp_rate_unset',
    );
  }
  const payAmount = positive(terms.payAmount, 'On-ramp pay amount', 'bank.onramp_rate_unset');
  const fee = nonNegative(terms.fee, 'On-ramp fee', 'bank.onramp_rate_unset');
  const rate = positive(terms.rate, 'On-ramp rate', 'bank.onramp_rate_unset');
  const payCurrency = terms.payCurrency?.trim() ?? '';
  if (!/^[A-Z]{3,16}$/.test(payCurrency)) {
    throw new BankError('The rate source did not name a pay currency', 'bank.onramp_rate_unset');
  }
  if (!(terms.expiresAt instanceof Date) || Number.isNaN(terms.expiresAt.getTime()) || terms.expiresAt.getTime() <= Date.now()) {
    throw new BankError('The rate source did not publish a future expiry', 'bank.onramp_rate_unset');
  }
  const estimate = terms.deliveryEstimate?.trim() || null;
  if (estimate !== null && estimate.length > 140) {
    throw new BankError('The rate source published a delivery estimate longer than 140 characters', 'bank.onramp_rate_unset');
  }

  const rows = await deps.sql<QuoteRow[]>`
    INSERT INTO bank.ramp_onramp_quotes (
      user_id, asset_id, amount, method, country, pay_amount, fee, rate, pay_currency, expires_at, simulated, delivery_estimate
    ) VALUES (
      ${input.userId}, ${input.assetId}, ${formatAmount(amount)}::numeric, ${input.method}, ${country},
      ${formatAmount(payAmount)}::numeric, ${formatAmount(fee)}::numeric, ${formatAmount(rate)}::numeric,
      ${payCurrency}, ${terms.expiresAt}, true, ${estimate}
    )
    RETURNING *
  `;
  return toQuote(rows[0]!);
}

export async function createOnramp(
  deps: CustomerRampDeps,
  input: { userId: string; onrampId: string; quoteId: string; method: OnrampMethod },
): Promise<CustomerOnrampView> {
  assertUuid(input.onrampId, 'onrampId');
  assertUuid(input.quoteId, 'quoteId');
  const quote = await loadQuote(deps, input.userId, input.quoteId);
  if (quote.method !== input.method) {
    throw new BankError('On-ramp method does not match the quote', 'bank.ramp_conflict');
  }
  // A replay of an instruction already opened returns it, even after its quote expired: the partner holds it.
  const existing = await deps.sql<CustomerOnrampRow[]>`
    SELECT * FROM bank.customer_onramps WHERE id = ${input.onrampId}::uuid
  `;
  if (existing[0]) return sameOnramp(existing[0], input.userId, quote.id);
  if (quote.expires_at.getTime() <= Date.now()) {
    throw new BankError('On-ramp quote has expired', 'bank.onramp_quote_expired');
  }

  if (!deps.payments) {
    throw new BankError(
      'Fiat on-ramp payment is socket.psp-partners — no partner is connected, so no hosted URL or bank instruction is invented. Nothing was charged.',
      'bank.fiat_ramp_socket',
    );
  }
  const instruction = await deps.payments.open({
    onrampId: input.onrampId,
    quoteId: quote.id,
    method: input.method,
    userId: input.userId,
    assetId: quote.asset_id,
    amount: formatAmount(parseAmount(quote.amount)),
  });
  if (!instruction) {
    throw new BankError(
      'Fiat on-ramp payment is socket.psp-partners — the partner returned no hosted URL or bank instruction. Nothing was charged.',
      'bank.fiat_ramp_socket',
    );
  }
  const stored = normaliseInstruction(input.method, instruction);

  const inserted = await transaction(deps.sql, async (tx) => {
    const again = await tx<QuoteRow[]>`
      SELECT * FROM bank.ramp_onramp_quotes
       WHERE id = ${quote.id}::uuid AND user_id = ${input.userId}
       FOR UPDATE
    `;
    if (!again[0] || again[0].expires_at.getTime() <= Date.now()) {
      throw new BankError('On-ramp quote has expired', 'bank.onramp_quote_expired');
    }
    const prior = await tx<CustomerOnrampRow[]>`
      SELECT * FROM bank.customer_onramps WHERE id = ${input.onrampId}::uuid FOR UPDATE
    `;
    if (prior[0]) return prior[0];
    const rows = await tx<CustomerOnrampRow[]>`
      INSERT INTO bank.customer_onramps (
        id, user_id, quote_id, method, asset_id, amount, pay_amount, fee, rate, pay_currency,
        status, simulated, partner_rail, hosted_url, bank_reference, bank_account_name, bank_account_ref
      ) VALUES (
        ${input.onrampId}::uuid, ${input.userId}, ${quote.id}::uuid, ${input.method},
        ${quote.asset_id}, ${quote.amount}::numeric, ${quote.pay_amount}::numeric, ${quote.fee}::numeric,
        ${quote.rate}::numeric, ${quote.pay_currency}, 'pending_payment', true, ${stored.partnerRail},
        ${stored.hostedUrl}, ${stored.bankReference}, ${stored.bankAccountName}, ${stored.bankAccountRef}
      )
      ON CONFLICT (id) DO NOTHING
      RETURNING *
    `;
    if (rows[0]) return rows[0];
    const raced = await tx<CustomerOnrampRow[]>`
      SELECT * FROM bank.customer_onramps WHERE id = ${input.onrampId}::uuid FOR UPDATE
    `;
    if (!raced[0]) throw new BankError('On-ramp was not stored', 'bank.ramp_conflict');
    return raced[0];
  });
  return sameOnramp(inserted, input.userId, quote.id);
}

/** One of the customer's own on-ramp quotes, as stored, expired or not. Someone else's, or none, is `bank.onramp_quote_missing`. */
export async function onrampQuoteOf(deps: CustomerRampDeps, userId: string, quoteId: string): Promise<OnrampQuoteView> {
  assertUuid(quoteId, 'quoteId');
  return toQuote(await loadQuote(deps, userId, quoteId));
}

/** The customer's own on-ramps among these ids, by id, in one read. Someone else's are left out. */
export async function customerOnrampsByIds(
  deps: CustomerRampDeps,
  userId: string,
  onrampIds: readonly string[],
): Promise<Map<string, CustomerOnrampView>> {
  if (onrampIds.length === 0) return new Map();
  const rows = await deps.sql<CustomerOnrampRow[]>`
    SELECT * FROM bank.customer_onramps WHERE id = ANY(${deps.sql.array([...onrampIds])}::uuid[]) AND user_id = ${userId}
  `;
  return new Map(rows.map((row) => [row.id, toCustomerOnramp(row)]));
}

export async function quoteOfframp(
  deps: CustomerRampDeps,
  input: { assetId: string; amount: string; kind: 'crypto' | 'fiat'; destinationRef: string },
): Promise<OfframpQuoteView> {
  if (input.kind === 'fiat') refuseFiatRamp();
  const amount = positive(input.amount, 'Off-ramp amount');
  assertAsset(input.assetId);
  const destinationRef = input.destinationRef.trim();
  if (!isEvmAddressRef(destinationRef)) {
    throw new BankError('Crypto off-ramp quote destination must be an EVM address', 'bank.ramp_invalid_destination');
  }
  if (!deps.programme.cryptoRail) {
    throw new BankError(
      'No bank ramp programme is configured — set BANK_RAMP_MODE=crypto-ledger for the crypto ledger half, or leave none and do not call ramps',
      'bank.no_ramp_rail',
    );
  }
  if (!deps.fees) {
    throw new BankError(
      'No off-ramp fee schedule is published for the crypto ledger half. A zero fee is not assumed, and no net amount is returned.',
      'bank.offramp_fee_unset',
    );
  }
  const terms = await deps.fees.quote({
    assetId: input.assetId,
    amount: formatAmount(amount),
    kind: 'crypto',
    destinationRef,
  });
  if (!terms) {
    throw new BankError(
      'The fee source returned no off-ramp quote. A zero fee is not assumed, and no net amount is returned.',
      'bank.offramp_fee_unset',
    );
  }
  const fee = nonNegative(terms.fee, 'Off-ramp fee', 'bank.offramp_fee_unset');
  const net = positive(terms.netAmount, 'Off-ramp net amount', 'bank.offramp_fee_unset');
  if (fee + net !== amount) {
    throw new BankError(
      'The fee source published a fee and net that do not add up to the amount. The numbers are not adjusted.',
      'bank.offramp_fee_inconsistent',
    );
  }
  if (!(terms.expiresAt instanceof Date) || Number.isNaN(terms.expiresAt.getTime()) || terms.expiresAt.getTime() <= Date.now()) {
    throw new BankError('The fee source did not publish a future expiry', 'bank.offramp_fee_unset');
  }
  return {
    assetId: input.assetId,
    amount: formatAmount(amount),
    kind: 'crypto',
    destinationRef,
    fee: formatAmount(fee),
    netAmount: formatAmount(net),
    expiresAt: terms.expiresAt.toISOString(),
    simulated: true,
  };
}

/** First six and last four characters: enough to recognise an address, not to copy it from a screenshot. */
export function maskRef(ref: string): string {
  const compact = ref.replace(/\s+/g, '');
  return compact.length <= 12 ? `${compact.slice(0, 2)}…` : `${compact.slice(0, 6)}…${compact.slice(-4)}`;
}

function viewOf(row: WithdrawDestination, hours: number | null, ownership: Ownership, linkExpiresAt: string | null): DestinationView {
  const pending = row.state === 'pending';
  return {
    destinationId: row.destinationId,
    label: row.label,
    kind: row.kind,
    ref: row.ref,
    refMasked: maskRef(row.ref),
    assetId: row.assetId,
    network: row.network,
    tag: row.tag,
    origin: row.origin,
    state: row.state,
    addedAt: row.addedAt.toISOString(),
    coolingOffEndsAt: hours === null || pending ? null : coolingOffEndsAt(hours, row.updatedAt).toISOString(),
    coolingBlocker: hours === null ? ('bank.offramp_cooling_unset' as const) : null,
    lookalikeConfirmedAt: row.lookalikeConfirmedAt ? row.lookalikeConfirmedAt.toISOString() : null,
    ownership,
    approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
    approvedBy: row.approvedBy,
    approvalLinkExpiresAt: pending ? linkExpiresAt : null,
  };
}

/** One entry's view with its ownership read from the latest proof. */
export async function viewWithOwnership(deps: CustomerRampDeps, userId: string, row: WithdrawDestination): Promise<DestinationView> {
  // Only an entry still waiting has an open link to show.
  const [latest, links] = await Promise.all([
    deps.proofs.latest(userId),
    row.state === 'pending' ? openApprovalLinks({ links: deps.approvalLinks }, userId) : new Map<string, string>(),
  ]);
  return viewOf(
    row,
    readOfframpCoolingHours(deps.coolingRaw()),
    ownershipOf(latest.get(row.destinationId), new Date(), row.ref),
    links.get(row.destinationId) ?? null,
  );
}

export async function listDestinations(deps: CustomerRampDeps, userId: string): Promise<DestinationView[]> {
  const hours = readOfframpCoolingHours(deps.coolingRaw());
  const [rows, latest, links] = await Promise.all([
    deps.destinations.list(userId),
    deps.proofs.latest(userId),
    openApprovalLinks({ links: deps.approvalLinks }, userId),
  ]);
  const now = new Date();
  return rows.map((row) =>
    viewOf(row, hours, ownershipOf(latest.get(row.destinationId), now, row.ref), links.get(row.destinationId) ?? null),
  );
}

/** What the add form learns before it asks for a confirmation code: whether the bank would take this address as typed. */
export type DestinationCheck = {
  /** `checksum_mismatch`: mixed case that does not match its EIP-55 checksum. `invalid`: not an EVM address at all. */
  address: 'ok' | 'invalid' | 'checksum_mismatch';
  /** The saved entry this address shows like but is not (address poisoning), or null. */
  lookalike: { destinationId: string; label: string | null; refMasked: string } | null;
  /** On the owner's fraud list for `network` (or every network): `save` refuses it. Only asked when a network is given. */
  fraudListed: boolean;
};

/** Read-only: the same address rules `saveDestination` applies, answered as data so the form can warn before step-up. */
export async function checkDestination(
  deps: CustomerRampDeps,
  input: { userId: string; ref: string; network?: string },
): Promise<DestinationCheck> {
  // Asked first, so a locked account is told before the form asks for a confirmation code; `save` asks again.
  await assertSecurityLockOpen(deps.securityLock, input.userId, 'adding a withdrawal address');
  const ref = input.ref.trim();
  if (!isEvmAddressRef(ref)) return { address: 'invalid', lookalike: null, fraudListed: false };
  const [saved, fraudListed] = await Promise.all([
    deps.destinations.list(input.userId),
    input.network === undefined ? false : deps.fraudList.isListed(input.network, ref),
  ]);
  const near = lookalikeOf(ref, saved);
  return {
    address: evmChecksumMatches(ref) ? 'ok' : 'checksum_mismatch',
    lookalike: near ? { destinationId: near.destinationId, label: near.label, refMasked: maskRef(near.ref) } : null,
    fraudListed,
  };
}

export async function saveDestination(
  deps: CustomerRampDeps,
  input: SaveDestinationInput & { confirmLookalike?: boolean },
): Promise<DestinationView> {
  // A new entry is saved `pending`, recording the saving session: it waits for the customer's approval (W-withdraw-09).
  // The network must be one the registry lists for the asset before the entry is stored; nothing is saved otherwise.
  // Checked on the entry as the store will keep it (asset upper-case, network lower-case), the form registry ids take.
  // The look-alike record is this function's alone: whatever a caller passed is dropped, and only `near` sets it.
  const { confirmLookalike, lookalikeOf: _caller, ...book } = input;
  const entry = assertBookEntry(book);
  await assertWithdrawNetwork(deps.networks, entry.assetId, entry.network);
  // Independent reads, asked together: the book, and whether the address is on the fraud list.
  const [saved, fraudListed] = await Promise.all([deps.destinations.list(book.userId), deps.fraudList.isListed(entry.network, entry.ref)]);
  // The same entry again is a replay of a save already made, answered as before. Anything new is not added while the
  // owner's security lock holds (W-withdraw-09), read from identity before anything is stored.
  const same = saved.find(
    (row) =>
      row.origin === 'customer' &&
      row.kind === 'crypto' &&
      row.assetId === entry.assetId &&
      row.network === entry.network &&
      row.ref.toLowerCase() === entry.ref.toLowerCase() &&
      (row.tag ?? '') === (entry.tag ?? ''),
  );
  // A listed address is refused before anything is stored, even as a replay of an entry saved before it was listed.
  if (fraudListed) {
    throw new BankError(
      'This address is on the fraud list, so it cannot be saved to your address book. Nothing was saved',
      'bank.destination_fraud_listed',
    );
  }
  if (same) return viewWithOwnership(deps, book.userId, same);
  await assertSecurityLockOpen(deps.securityLock, book.userId, 'adding a withdrawal address');
  // An address that shows like a saved one but is not is saved only when the customer has said they checked it.
  const near = lookalikeOf(entry.ref, saved);
  if (near && confirmLookalike !== true) {
    throw new BankError(
      `This address starts and ends like your saved address ${near.label ? `"${near.label}"` : maskRef(near.ref)} but is a different address. Check every character before you save it`,
      'bank.address_lookalike',
    );
  }
  // The confirmation is recorded on the new entry: which saved entry it was checked against, and when.
  return viewWithOwnership(deps, book.userId, await deps.destinations.save(near ? { ...book, lookalikeOf: near.destinationId } : book));
}

export async function renameDestination(
  deps: CustomerRampDeps,
  input: { userId: string; destinationId: string; label: string },
): Promise<DestinationView> {
  return viewWithOwnership(deps, input.userId, await deps.destinations.rename(input));
}

export function removeDestination(
  deps: CustomerRampDeps,
  input: { userId: string; destinationId: string; idempotencyKey: string },
): Promise<{ destinationId: string; removed: true }> {
  // Not stopped by the security lock: removing an address only takes a way out away, as locking itself does.
  return deps.destinations.remove(input);
}

/**
 * Whether money may be sent to one saved address now, and if not, what stands in the way, first reason first: the
 * owner's security lock (`locked`, with when it ends once an unlock is asked for), an entry the book holds as blocked or
 * archived (`blocked`), a new address the customer has not approved yet (`approval_pending`, with until when the newest
 * emailed link works, if one is out), no published cooling-off period (`cooling_unset`), or a cooling-off that has not
 * ended (`cooling`, with its end; null when the published period runs past any date). The lock, approval and cooling-off
 * rules the bank's send path applies (`offramp`); the answer is read-only and changes nothing.
 */
export type DestinationReadiness = {
  destinationId: string;
  state: 'ready' | 'locked' | 'blocked' | 'approval_pending' | 'cooling_unset' | 'cooling';
  coolingOffEndsAt: string | null;
  lockUnlocksAt: string | null;
  approvalLinkExpiresAt: string | null;
};

export async function destinationReadiness(
  deps: CustomerRampDeps,
  input: { userId: string; destinationId: string },
  now: Date = new Date(),
): Promise<DestinationReadiness> {
  const [rows, lock] = await Promise.all([deps.destinations.list(input.userId), deps.securityLock.read(input.userId)]);
  const row = rows.find((entry) => entry.destinationId === input.destinationId);
  if (!row) {
    throw new BankError(`User ${input.userId} has no saved address ${input.destinationId}`, 'bank.withdraw_destination_missing');
  }
  const base = { destinationId: row.destinationId, coolingOffEndsAt: null, lockUnlocksAt: null, approvalLinkExpiresAt: null };
  // The owner's self-freeze reads as `locked` with no end: a send is refused either way, and svc-pay's door refuses it.
  if (lock.selfFrozen) return { ...base, state: 'locked' };
  if (lock.locked) return { ...base, state: 'locked', lockUnlocksAt: lock.unlocksAt };
  if (row.state === 'blocked' || row.state === 'archived') return { ...base, state: 'blocked' };
  // Listed as fraud after it was saved: nothing may be sent to it. An entry with no network matches a listing on any network.
  if (await deps.fraudList.isListed(row.network, row.ref)) return { ...base, state: 'blocked' };
  if (row.state === 'pending') {
    const links = await openApprovalLinks({ links: deps.approvalLinks, now: () => now }, input.userId);
    return { ...base, state: 'approval_pending', approvalLinkExpiresAt: links.get(row.destinationId) ?? null };
  }
  const hours = readOfframpCoolingHours(deps.coolingRaw());
  if (hours === null) return { ...base, state: 'cooling_unset' };
  const ends = coolingOffEndsAt(hours, row.updatedAt);
  // A period too long for any date never ends; the send path refuses it as still cooling, and so does this.
  if (!Number.isFinite(ends.getTime())) return { ...base, state: 'cooling' };
  if (now.getTime() < ends.getTime()) return { ...base, state: 'cooling', coolingOffEndsAt: ends.toISOString() };
  return { ...base, state: 'ready', coolingOffEndsAt: ends.toISOString() };
}

async function loadQuote(deps: CustomerRampDeps, userId: string, quoteId: string): Promise<QuoteRow> {
  const rows = await deps.sql<QuoteRow[]>`
    SELECT * FROM bank.ramp_onramp_quotes
     WHERE id = ${quoteId}::uuid AND user_id = ${userId}
  `;
  const row = rows[0];
  if (!row) throw new BankError('On-ramp quote was not found', 'bank.onramp_quote_missing');
  return row;
}

function sameOnramp(row: CustomerOnrampRow, userId: string, quoteId: string): CustomerOnrampView {
  if (row.user_id !== userId || row.quote_id !== quoteId) {
    throw new BankError('On-ramp id was already used with different terms', 'bank.ramp_conflict');
  }
  return toCustomerOnramp(row);
}

function normaliseInstruction(
  method: OnrampMethod,
  instruction: OnrampPaymentInstruction,
): {
  partnerRail: string;
  hostedUrl: string | null;
  bankReference: string | null;
  bankAccountName: string | null;
  bankAccountRef: string | null;
} {
  const partnerRail = instruction.partnerRail?.trim() ?? '';
  if (!partnerRail || partnerRail.length > 64) {
    throw new BankError('The partner did not name its rail', 'bank.onramp_instruction_missing');
  }
  if (method === 'bank_transfer') {
    const bank = instruction.bank;
    const reference = bank?.reference?.trim() ?? '';
    const accountName = bank?.accountName?.trim() ?? '';
    const accountRef = bank?.accountRef?.trim() ?? '';
    if (!reference || reference.length > 140 || !accountName || accountName.length > 140 || !isBankDestinationRef(accountRef)) {
      throw new BankError(
        'The partner did not return bank-transfer instructions (reference, account name, IBAN or IFSC)',
        'bank.onramp_instruction_missing',
      );
    }
    if (instruction.hostedUrl) {
      throw new BankError('A bank transfer instruction must not also carry a hosted card URL', 'bank.onramp_instruction_missing');
    }
    return {
      partnerRail,
      hostedUrl: null,
      bankReference: reference,
      bankAccountName: accountName,
      bankAccountRef: accountRef.replace(/\s+/g, '').toUpperCase(),
    };
  }
  const hostedUrl = instruction.hostedUrl?.trim() ?? '';
  if (!hostedUrl.startsWith('https://') || hostedUrl.length > 2000 || /\s/.test(hostedUrl)) {
    throw new BankError('The partner did not return an https hosted payment URL', 'bank.onramp_instruction_missing');
  }
  return { partnerRail, hostedUrl, bankReference: null, bankAccountName: null, bankAccountRef: null };
}

function toQuote(row: QuoteRow): OnrampQuoteView {
  return {
    quoteId: row.id,
    assetId: row.asset_id,
    amount: formatAmount(parseAmount(row.amount)),
    method: row.method,
    country: row.country,
    payAmount: formatAmount(parseAmount(row.pay_amount)),
    fee: formatAmount(parseAmount(row.fee)),
    rate: formatAmount(parseAmount(row.rate)),
    payCurrency: row.pay_currency,
    expiresAt: row.expires_at.toISOString(),
    deliveryEstimate: row.delivery_estimate,
    simulated: true,
  };
}

function toCustomerOnramp(row: CustomerOnrampRow): CustomerOnrampView {
  const bank =
    row.bank_reference && row.bank_account_name && row.bank_account_ref
      ? { reference: row.bank_reference, accountName: row.bank_account_name, accountRef: row.bank_account_ref }
      : null;
  return {
    onrampId: row.id,
    quoteId: row.quote_id,
    userId: row.user_id,
    assetId: row.asset_id,
    amount: formatAmount(parseAmount(row.amount)),
    method: row.method,
    payAmount: formatAmount(parseAmount(row.pay_amount)),
    fee: formatAmount(parseAmount(row.fee)),
    rate: formatAmount(parseAmount(row.rate)),
    payCurrency: row.pay_currency,
    status: 'pending_payment',
    simulated: true,
    partnerRail: row.partner_rail,
    hostedUrl: row.hosted_url,
    bankInstructions: bank,
    createdAt: row.created_at.toISOString(),
  };
}

function positive(
  value: string,
  what: string,
  code: 'bank.ramp_invalid_amount' | 'bank.onramp_rate_unset' | 'bank.offramp_fee_unset' = 'bank.ramp_invalid_amount',
): Amount {
  const parsed = asAmount(value, what, code);
  if (parsed <= 0n) throw new BankError(`${what} must be positive`, code);
  return parsed;
}

function nonNegative(value: string, what: string, code: 'bank.onramp_rate_unset' | 'bank.offramp_fee_unset'): Amount {
  const parsed = asAmount(value, what, code);
  if (parsed < 0n) throw new BankError(`${what} must not be negative`, code);
  return parsed;
}

function asAmount(
  value: string,
  what: string,
  code: 'bank.ramp_invalid_amount' | 'bank.onramp_rate_unset' | 'bank.offramp_fee_unset',
): Amount {
  try {
    return parseAmount(value);
  } catch {
    throw new BankError(`${what} is not an exact decimal string`, code);
  }
}

function assertAsset(assetId: string): void {
  const trimmed = assetId.trim();
  if (!trimmed || trimmed !== assetId || trimmed.length > 16) {
    throw new BankError(
      'Ramp asset id must be a non-empty crypto symbol with no leading or trailing whitespace',
      'bank.ramp_invalid_asset',
    );
  }
}

function assertUuid(value: string, label: string): void {
  if (!UUID_RE.test(value)) throw new BankError(`${label} must be a uuid`, 'bank.validation_failed');
}
