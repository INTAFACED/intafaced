import { listWithdrawNetworks, type WithdrawAsset, type WithdrawNetworkSource } from './withdraw-networks.js';
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import {
  InsufficientFundsError,
  LedgerError,
  formatAmount,
  parseAmount,
  recipes,
  userAvailable,
  withdrawalHoldAccount,
  type Amount,
  type LedgerClient,
} from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import { assertOfframpsListLimit, assertOnrampsListLimit } from '../owner-list-limit.js';
import { BANK_OFFRAMP_COOLING_HOURS_ENV, assertOfframpDestCoolingElapsed, requireOfframpCoolingHours } from '../offramp-cooling.js';
import { assertHoldsOpen, assertSecurityLockOpen, unconfiguredSecurityLock, type SecurityLockPort } from '../security-lock.js';
import { withSessionAdvisoryLock } from '../session-lock.js';
import { withMoneySpan } from '../tracing.js';
import { emptyPayFiatRampPort, resolvePayFiatRailId, assertEmptyRailsCannotLookLive, type PayFiatRampPort } from './pay-fiat-adapter.js';
import type { OfframpFeeSource, OnrampMethod, OnrampPaymentPort, OnrampQuoteSource } from './customer-ports.js';
import type { OnrampStandIn } from './onramp-sim.js';
import {
  checkDestination,
  createOnramp,
  onrampQuoteOf,
  customerOnrampsByIds,
  destinationReadiness,
  listDestinations,
  quoteOfframp,
  quoteOnramp,
  removeDestination,
  renameDestination,
  saveDestination,
  viewWithOwnership,
  type CustomerOnrampView,
  type CustomerRampDeps,
  type DestinationCheck,
  type DestinationReadiness,
  type DestinationView,
  type OfframpQuoteView,
  type OnrampQuoteView,
} from './customer-ramps.js';
import {
  BANK_WALLET_PROOF_VALIDITY_ENV,
  BANK_WALLET_PROOF_WINDOW_ENV,
  sqlWalletProofs,
  startWalletProof,
  verifyWalletProof,
  type StartedProof,
  type WalletProofDeps,
  type WalletProofStore,
} from './wallet-ownership.js';
import { assertCryptoRamp, assertFiatSocketWhenNone, refuseFiatRamp, type RampProgramme, NO_RAMP_PROGRAMME } from './rails.js';
import {
  BANK_ADDRESS_APPROVAL_LINK_ENV,
  approveByLink,
  approveOnDevice,
  requestApprovalMail,
  sqlApprovalLinks,
  unconfiguredApprovalMail,
  type AddressApprovalDeps,
  type ApprovalLinkStore,
  type ApprovalMailPort,
} from './address-approval.js';
import { unconfiguredTrustedDevices, type TrustedDevicePort } from './trusted-devices.js';
import { sendableDestination } from './send-destination.js';
import {
  assertNotSanctioned,
  BANK_DESTINATION_SANCTIONS_ENV,
  destinationSanctions,
  sanctionsRefusal,
  type DestinationSanctionsPort,
} from './sanctions-list.js';
import type { BankSendDestination, BankSendDestinationInput } from '@intafaced/contracts';
import { DestinationFraudList, fraudAddressKey, refuseFraudListed, type DestinationFraudListPort } from './fraud-list.js';
import {
  BANK_ADDRESS_BOOK_CAP_ENV,
  destKindForRamp,
  UserWithdrawDestinationStore,
  type SaveDestinationInput,
  type SavedOn,
  type UserWithdrawDestinations,
  type WithdrawDestination,
} from '../withdraw-destination.js';

/**
 * RAMPS (§8.1 / D-S-09) — the CRYPTO LEDGER half: on-ramp credit, off-ramp settle.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THIS SERVICE ADDS NO NEW RECIPE
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * An on-ramp is a DEPOSIT. An off-ramp is a WITHDRAWAL. Both recipes already
 * exist in `packages/ledger-client`:
 *
 *   on-ramp credited     `deposit`           rail boundary → user available
 *   off-ramp hold        `withdrawHold`      available → hold per offramp id
 *   off-ramp settle      `withdrawSettle`    hold → rail boundary
 *
 * A `bankRamp` recipe would have been those with a different string — a second
 * way to spell one movement. Cards made the same choice for the same reason.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * IF THE PROCESS DIES EXACTLY HERE
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ── creditOnramp(): claim, THEN deposit ──────────────────────────────────────
 *
 *   after the claim, before the post
 *     Value is still outside the book. The pending row is the resumable marker.
 *     Re-drive with the same railRef finishes the credit. The claim keeps the
 *     rail stored on the first row, and the deposit stays on that rail.
 *
 *   after the post, before status=settled
 *     User has funds; row is one status behind. Reporting lag, not stranded money.
 *
 * ── offramp(): claim, hold, THEN settle ──────────────────────────────────────
 *
 *   after hold, before settle
 *     Funds sit in `withdrawalHoldAccount(user, asset, offrampId)` — the user's.
 *     Re-drive settles (or an operator reverse path can return them). Nothing is
 *     on a chain yet: this service does not broadcast.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT IS NOT HERE
 * ═════════════════════════════════════════════════════════════════════════════
 *
 *   · FIAT. kind `fiat` refuses `bank.fiat_ramp_socket` before any row and
 *     before any ledger post. These tables are the crypto ledger half.
 *     Do not invent a PSP, a BIN, or an APY.
 *   · CHAIN BROADCAST / CONFIRMATION. Live crypto send and inbound watcher are
 *     svc-pay. Settle here means value left OUR book to `bank-crypto-ledger`.
 *   · EARN APY, CARD BIN, or any commercial rate invention.
 *   · A LIVE MODE that sets `simulated: false`. Class X is a human decision.
 */

export type RampKind = 'crypto' | 'fiat';
export type RampEventStatus = 'pending' | 'settled' | 'rejected';

export interface OnrampRecord {
  id: string;
  userId: string;
  assetId: string;
  amount: Amount;
  kind: RampKind;
  rail: string;
  railRef: string;
  simulated: boolean;
  creditedBy: string;
  status: RampEventStatus;
  ledgerTxId: string | null;
  rejectionCode: string | null;
  createdAt: Date;
  settledAt: Date | null;
}

export interface OfframpRecord {
  id: string;
  userId: string;
  assetId: string;
  amount: Amount;
  kind: RampKind;
  rail: string;
  destinationRef: string;
  clientRef: string;
  simulated: boolean;
  status: RampEventStatus;
  holdLedgerTxId: string | null;
  settleLedgerTxId: string | null;
  releaseLedgerTxId: string | null;
  rejectionCode: string | null;
  createdAt: Date;
  settledAt: Date | null;
}

interface OnrampRow {
  id: string;
  user_id: string;
  asset_id: string;
  amount: string;
  kind: RampKind;
  rail: string;
  rail_ref: string;
  simulated: boolean;
  credited_by: string;
  status: RampEventStatus;
  ledger_tx_id: string | null;
  rejection_code: string | null;
  created_at: Date;
  settled_at: Date | null;
}

interface OfframpRow {
  id: string;
  user_id: string;
  asset_id: string;
  amount: string;
  kind: RampKind;
  rail: string;
  destination_ref: string;
  client_ref: string;
  simulated: boolean;
  status: RampEventStatus;
  hold_ledger_tx_id: string | null;
  settle_ledger_tx_id: string | null;
  release_ledger_tx_id: string | null;
  rejection_code: string | null;
  created_at: Date;
  settled_at: Date | null;
}

export interface RampServiceOptions {
  /**
   * Which ramp programme this deployment has. Not defaulted to crypto-ledger —
   * silence is `none`, and every money path then refuses `bank.no_ramp_rail`.
   */
  programme?: RampProgramme;
  /**
   * Pay-adapter plane for fiat legs (D26-P1-B4). Default empty → honest refuse.
   * Never invent a partner here; inject from the edge when pay registers a live
   * fiat RailAdapter.
   */
  payFiat?: PayFiatRampPort;
  /**
   * Persisted user withdraw dest. Default is the SQL store. Tests may inject
   * `assertOnlyWithdrawDestinations` so persist asserts and require refuses.
   */
  destinations?: UserWithdrawDestinations;
  /**
   * Owner-set cooling hours (`BANK_OFFRAMP_COOLING_HOURS`). Omit to read the
   * env at offramp time. Blank / unset refuses `bank.offramp_cooling_unset`.
   * A real integer then dest-elapsed (`updated_at`) before claim/hold.
   * Never defaulted to 24. Zero is no wait.
   */
  offrampCoolingHours?: string;
  /**
   * Owner-set address-book size (`BANK_ADDRESS_BOOK_CAP`). Omit to read the env at save time.
   * Blank / unset refuses `bank.address_book_cap_unset`. Never defaulted.
   */
  addressBookCap?: string;
  /**
   * Rate/fee source for `ramps.onrampQuote`. Unset refuses `bank.onramp_rate_unset`.
   * The service does not invent a pay amount, fee, or rate.
   */
  onrampQuotes?: OnrampQuoteSource | null;
  /** The local stack's TEST rate stand-in (`BANK_ONRAMP_RATES=ramp-sim`), for the asks it lists. Unset everywhere else. */
  onrampStandIn?: OnrampStandIn | null;
  /**
   * Partner that opens a hosted payment or bank-transfer instruction.
   * Unset refuses `bank.fiat_ramp_socket` and inserts no row.
   */
  onrampPayments?: OnrampPaymentPort | null;
  /**
   * Fee schedule for `ramps.offrampQuote` on the crypto ledger half.
   * Unset refuses `bank.offramp_fee_unset`. A zero fee is not assumed.
   */
  offrampFees?: OfframpFeeSource | null;
  /**
   * svc-ledger's asset and network registry: which asset may be withdrawn on which network. Unset refuses saving an
   * address with `bank.asset_registry_unavailable`; no network is accepted on its looks.
   */
  withdrawNetworks?: WithdrawNetworkSource | null;
  /** Signed-message wallet proofs (W-withdraw-17). Omit for the Postgres store on `sql`. */
  walletProofs?: WalletProofStore;
  /**
   * Owner-set minutes a wallet proof offer stays open (`BANK_WALLET_PROOF_WINDOW_MINUTES`) and days a verified proof
   * holds (`BANK_WALLET_PROOF_VALID_DAYS`). Omit to read the env at call time. Blank refuses; never defaulted.
   */
  walletProofWindowMinutes?: string;
  walletProofValidDays?: string;
  /**
   * The owner's security lock, read from svc-identity per request (W-withdraw-09). While it holds, adding or removing a
   * withdrawal address and sending to one refuse `bank.security_locked`. Omitted, every one of those refuses
   * `bank.security_lock_unset`: a bank that cannot read the lock does not act as if there were none.
   */
  securityLock?: SecurityLockPort;
  /**
   * New-address approval (W-withdraw-09): the links store (omit for the Postgres store on `sql`), identity's mail door
   * (omitted, a link request refuses `bank.address_approval_mail_unavailable`), and the owner's link lifetime
   * (`BANK_ADDRESS_APPROVAL_LINK_MINUTES`; omit to read the env at call time, blank refuses).
   */
  approvalLinks?: ApprovalLinkStore;
  approvalMail?: ApprovalMailPort;
  addressApprovalLinkMinutes?: string;
  /** Identity's trusted devices, for approval from another device (omitted, every such approval refuses unavailable). */
  trustedDevices?: TrustedDevicePort;
  /** The destination fraud list (W-withdraw-03). Defaults to the bank's own table. */
  fraudList?: DestinationFraudListPort;
  /** The owner's destination sanctions list; read from `BANK_DESTINATION_SANCTIONS` when not given. */
  sanctions?: DestinationSanctionsPort;
}

export class RampService {
  private readonly programme: RampProgramme;
  private readonly payFiat: PayFiatRampPort;
  private readonly destinations: UserWithdrawDestinations;
  private readonly offrampCoolingHours: string | undefined;
  private readonly onrampQuotes: OnrampQuoteSource | null;
  private readonly onrampStandIn: OnrampStandIn | null;
  private readonly onrampPayments: OnrampPaymentPort | null;
  private readonly offrampFees: OfframpFeeSource | null;
  private readonly withdrawNetworkSource: WithdrawNetworkSource | null;
  private readonly walletProofs: WalletProofStore;
  private readonly walletProofWindowMinutes: string | undefined;
  private readonly walletProofValidDays: string | undefined;
  private readonly securityLock: SecurityLockPort;
  private readonly approvalLinks: ApprovalLinkStore;
  private readonly approvalMail: ApprovalMailPort;
  private readonly addressApprovalLinkMinutes: string | undefined;
  private readonly trustedDevices: TrustedDevicePort;
  /** The owner's destination fraud list: read by the address book, written by compliance's desk door. */
  readonly fraudList: DestinationFraudListPort;
  readonly sanctions: DestinationSanctionsPort;

  constructor(
    private readonly sql: Sql,
    private readonly ledger: LedgerClient,
    options: RampServiceOptions = {},
  ) {
    this.programme = options.programme ?? NO_RAMP_PROGRAMME;
    this.payFiat = options.payFiat ?? emptyPayFiatRampPort;
    this.destinations =
      options.destinations ??
      new UserWithdrawDestinationStore(sql, {
        addressBookCap: () => (options.addressBookCap !== undefined ? options.addressBookCap : process.env[BANK_ADDRESS_BOOK_CAP_ENV]),
      });
    this.offrampCoolingHours = options.offrampCoolingHours;
    this.onrampQuotes = options.onrampQuotes ?? null;
    this.onrampStandIn = options.onrampStandIn ?? null;
    this.onrampPayments = options.onrampPayments ?? null;
    this.offrampFees = options.offrampFees ?? null;
    this.withdrawNetworkSource = options.withdrawNetworks ?? null;
    this.walletProofs = options.walletProofs ?? sqlWalletProofs(sql);
    this.walletProofWindowMinutes = options.walletProofWindowMinutes;
    this.walletProofValidDays = options.walletProofValidDays;
    this.securityLock = options.securityLock ?? unconfiguredSecurityLock();
    this.approvalLinks = options.approvalLinks ?? sqlApprovalLinks(sql);
    this.approvalMail = options.approvalMail ?? unconfiguredApprovalMail();
    this.addressApprovalLinkMinutes = options.addressApprovalLinkMinutes;
    this.trustedDevices = options.trustedDevices ?? unconfiguredTrustedDevices();
    this.fraudList = options.fraudList ?? new DestinationFraudList(sql);
    this.sanctions = options.sanctions ?? destinationSanctions(() => process.env[BANK_DESTINATION_SANCTIONS_ENV]);
  }

  private approvalDeps(): AddressApprovalDeps {
    return {
      destinations: this.destinations,
      links: this.approvalLinks,
      mail: this.approvalMail,
      devices: this.trustedDevices,
      securityLock: this.securityLock,
      linkMinutesRaw: () =>
        this.addressApprovalLinkMinutes !== undefined ? this.addressApprovalLinkMinutes : process.env[BANK_ADDRESS_APPROVAL_LINK_ENV],
    };
  }

  private walletProofDeps(): WalletProofDeps {
    return {
      destinations: this.destinations,
      proofs: this.walletProofs,
      windowRaw: () =>
        this.walletProofWindowMinutes !== undefined ? this.walletProofWindowMinutes : process.env[BANK_WALLET_PROOF_WINDOW_ENV],
      validityRaw: () =>
        this.walletProofValidDays !== undefined ? this.walletProofValidDays : process.env[BANK_WALLET_PROOF_VALIDITY_ENV],
    };
  }

  private customerDeps(): CustomerRampDeps {
    return {
      sql: this.sql,
      programme: this.programme,
      payFiat: this.payFiat,
      quotes: this.onrampQuotes,
      standIn: this.onrampStandIn,
      payments: this.onrampPayments,
      fees: this.offrampFees,
      destinations: this.destinations,
      networks: this.withdrawNetworkSource,
      coolingRaw: () => this.ownerOfframpCoolingHoursRaw(),
      proofs: this.walletProofs,
      securityLock: this.securityLock,
      approvalLinks: this.approvalLinks,
      fraudList: this.fraudList,
      sanctions: this.sanctions,
    };
  }

  /** What this deployment's ramp programme is — including that it is not one. */
  programmeInfo(): RampProgramme {
    return this.programme;
  }

  /** On-ramp and off-ramp attempts opened at or after `since`. Health reads this; it invents no probe. */
  async attemptsSince(since: Date): Promise<Array<{ rail: string; status: string; created_at: Date; settled_at: Date | null }>> {
    const onramps = await this.sql<Array<{ rail: string; status: string; created_at: Date; settled_at: Date | null }>>`
      SELECT rail, status::text AS status, created_at, settled_at
        FROM bank.ramp_onramps
       WHERE created_at >= ${since}
    `;
    const offramps = await this.sql<Array<{ rail: string; status: string; created_at: Date; settled_at: Date | null }>>`
      SELECT rail, status::text AS status, created_at, settled_at
        FROM bank.ramp_offramps
       WHERE created_at >= ${since}
    `;
    return [...onramps, ...offramps];
  }

  /**
   * Live cash movement stays refused. The programme remains simulated.
   * An amount on the call is not posted.
   */
  liveRamp(): never {
    throw new BankError('A live cash ramp is refused. The missing piece is an outside company, the cash rail.', 'bank.live_ramp_unset');
  }

  /** Persist a user withdraw dest (IBAN/IFSC/EVM) so a later offramp has a real ref. Refused while the security lock holds. */
  async setWithdrawDestination(input: { userId: string; kind: string; ref: string; label?: string }) {
    await assertSecurityLockOpen(this.securityLock, input.userId, 'changing a withdrawal address');
    // An address on the owner's fraud list is never stored as the withdrawal address (W-withdraw-03), on any network.
    if (await this.fraudList.isListed(null, input.ref)) refuseFraudListed();
    // The same for the sanctions list, and with no list set no address is screened, so none is stored.
    assertNotSanctioned(this.sanctions, null, input.ref);
    return this.destinations.persist(input);
  }

  /** Saved wallets and bank accounts. Cooling end is the owner window, or a named unset. */
  listDestinations(userId: string): Promise<DestinationView[]> {
    return listDestinations(this.customerDeps(), userId);
  }

  /** Assets an address may be saved for, with their networks, from svc-ledger's registry. */
  withdrawNetworks(): Promise<WithdrawAsset[]> {
    return listWithdrawNetworks(this.withdrawNetworkSource);
  }

  /** Whether an address would be taken as typed: its checksum, and any saved entry it shows like but is not. */
  checkDestination(input: { userId: string; ref: string; network?: string }): Promise<DestinationCheck> {
    return checkDestination(this.customerDeps(), input);
  }

  /**
   * Save an address-book entry (asset, network, address, optional memo or tag, unique label). An address that shows
   * like a saved one but is not needs `confirmLookalike`.
   */
  saveDestination(input: SaveDestinationInput & { confirmLookalike?: boolean }) {
    return saveDestination(this.customerDeps(), input);
  }

  /** Rename one saved destination. The cooling clock does not restart. */
  renameDestination(input: { userId: string; destinationId: string; label: string }) {
    return renameDestination(this.customerDeps(), input);
  }

  /** Offer a message to sign that proves the customer controls one of their saved wallets (W-withdraw-17). */
  startWalletProof(input: { userId: string; destinationId: string }): Promise<StartedProof> {
    return startWalletProof(this.walletProofDeps(), input);
  }

  /** Check the signature of an open proof offer: the saved address must have signed it. */
  verifyWalletProof(input: { userId: string; proofId: string; signature: string }) {
    return verifyWalletProof(this.walletProofDeps(), input);
  }

  /** Whether money may be sent to one saved address now, or what stands in the way first (W-withdraw-09). Read-only. */
  destinationReadiness(input: { userId: string; destinationId: string }): Promise<DestinationReadiness> {
    return destinationReadiness(this.customerDeps(), input);
  }

  /**
   * Whether money may be sent to one address of one asset on one network now (J-wallet-05 #6), asked by svc-pay before it
   * claims a withdrawal to a wallet outside the platform. Read-only.
   */
  sendableDestination(input: BankSendDestinationInput): Promise<BankSendDestination> {
    return sendableDestination(this.customerDeps(), input);
  }

  /** Mail a single-use link that approves one new address (W-withdraw-09). Says until when it works; never that it arrived. */
  requestAddressApproval(input: { userId: string; destinationId: string }): Promise<{ destinationId: string; expiresAt: string }> {
    return requestApprovalMail(this.approvalDeps(), input);
  }

  /** Approve the new address an emailed link names, for the customer it was sent to. */
  async approveAddressByLink(input: { userId: string; token: string }): Promise<DestinationView> {
    return viewWithOwnership(this.customerDeps(), input.userId, await approveByLink(this.approvalDeps(), input));
  }

  /** Approve a new address from a signed-in device that did not save it (the router asks for the fresh confirmation). */
  async approveAddressOnDevice(input: { userId: string; destinationId: string; approving: SavedOn }): Promise<DestinationView> {
    return viewWithOwnership(this.customerDeps(), input.userId, await approveOnDevice(this.approvalDeps(), input));
  }

  /** Remove one saved destination. `idempotencyKey` replays the same removal. */
  removeDestination(input: { userId: string; destinationId: string; idempotencyKey: string }) {
    return removeDestination(this.customerDeps(), input);
  }

  /** The TEST label of the stand-in that would price this ask, or null when a real source (or nothing) answers it. */
  onrampStandInFor(input: { assetId: string; method: OnrampMethod; country: string }): string | null {
    return this.onrampStandIn?.covers({ ...input, country: input.country.trim().toUpperCase() }) ? this.onrampStandIn.label : null;
  }

  /** Pay amount, fee, and rate from the quote source. Refuses when the PSP or the source is blank. */
  onrampQuote(input: { userId: string; assetId: string; amount: string; method: OnrampMethod; country: string }): Promise<OnrampQuoteView> {
    return quoteOnramp(this.customerDeps(), input);
  }

  /**
   * Idempotent by `onrampId`. Stores the partner instruction and does not credit the ledger.
   * A blank partner refuses `bank.fiat_ramp_socket` before any row.
   */
  onrampCreate(input: { userId: string; onrampId: string; quoteId: string; method: OnrampMethod }): Promise<CustomerOnrampView> {
    return createOnramp(this.customerDeps(), input);
  }

  /** One of the customer's own on-ramp quotes as stored, expired or not. */
  onrampQuoteOf(userId: string, quoteId: string): Promise<OnrampQuoteView> {
    return onrampQuoteOf(this.customerDeps(), userId, quoteId);
  }

  /** The customer's own on-ramps among these ids, with the partner's instructions, in one read. */
  customerOnrampsByIds(userId: string, onrampIds: readonly string[]): Promise<Map<string, CustomerOnrampView>> {
    return customerOnrampsByIds(this.customerDeps(), userId, onrampIds);
  }

  /**
   * Crypto fee quote from the fee source. Kind fiat refuses `bank.fiat_ramp_socket`.
   * No fee source refuses `bank.offramp_fee_unset` rather than quoting zero.
   */
  offrampQuote(input: { assetId: string; amount: string; kind: 'crypto' | 'fiat'; destinationRef: string }): Promise<OfframpQuoteView> {
    return quoteOfframp(this.customerDeps(), input);
  }

  /**
   * Public settle probe: names rail ids, or refuses `bank.fiat_ramp_no_pay_adapter`.
   * Does not insert a ramp row and does not post. Empty rails cannot look live.
   * Mode `none` refuses `bank.fiat_ramp_socket` first — no default fiat rail.
   */
  async fiatSettle(): Promise<{ canSettle: true; onrampRailId: string; offrampRailId: string }> {
    assertFiatSocketWhenNone(this.programme);
    const rails = await Promise.resolve(this.payFiat.listFiatRails());
    assertEmptyRailsCannotLookLive(rails, { simulated: this.programme.simulated });
    const onrampRailId = await resolvePayFiatRailId(this.payFiat, 'onramp');
    const offrampRailId = await resolvePayFiatRailId(this.payFiat, 'offramp');
    // A resolved pay rail is not an outside cash company while the programme
    // is still simulated. Refuse before any caller treats this as a settle.
    if (this.programme.simulated) this.liveRamp();
    return { canSettle: true, onrampRailId, offrampRailId };
  }

  async onrampsOf(userId: string, limit?: number): Promise<OnrampRecord[]> {
    const page = assertOnrampsListLimit(limit);
    const rows = await this.sql<OnrampRow[]>`
      SELECT * FROM bank.ramp_onramps WHERE user_id = ${userId} ORDER BY created_at DESC
       LIMIT ${page}
    `;
    return rows.map(toOnramp);
  }

  async offrampsOf(userId: string, limit?: number): Promise<OfframpRecord[]> {
    const page = assertOfframpsListLimit(limit);
    const rows = await this.sql<OfframpRow[]>`
      SELECT * FROM bank.ramp_offramps WHERE user_id = ${userId} ORDER BY created_at DESC
       LIMIT ${page}
    `;
    return rows.map(toOfframp);
  }

  /**
   * Credit a user's available balance from the crypto ledger rail.
   *
   * OPERATOR-CREDENTIALED. A user who can credit their own balance does not
   * need a ramp. Router gates on `admin:treasury`.
   *
   * Kind fiat refuses `bank.fiat_ramp_socket` before any row or ledger post.
   * Unconfigured crypto programme refuses by name.
   */
  async creditOnramp(input: {
    userId: string;
    assetId: string;
    amount: Amount;
    kind: RampKind;
    railRef: string;
    creditedBy: string;
  }): Promise<OnrampRecord> {
    if (input.kind === 'fiat') refuseFiatRamp();
    if (input.amount <= 0n) {
      throw new BankError('On-ramp amount must be positive', 'bank.ramp_invalid_amount');
    }
    assertRampAssetId(input.assetId);
    const rail = assertCryptoRamp(this.programme);

    return withMoneySpan(
      'bank.ramp.onramp',
      { operation: 'onramp', amount: formatAmount(input.amount), userId: input.userId, assetId: input.assetId },
      async () => {
        const claimed = await this.claimOnramp({ ...input, rail });

        if (claimed.status === 'settled') return claimed;
        if (claimed.status === 'rejected') {
          throw new BankError(claimed.rejectionCode ?? 'On-ramp previously rejected', 'bank.ramp_conflict');
        }

        const posted = await this.ledger.post(
          recipes.deposit({
            userId: claimed.userId,
            assetId: claimed.assetId,
            amount: claimed.amount,
            rail: claimed.rail,
            railRef: claimed.railRef,
          }),
        );

        await this.sql`
          UPDATE bank.ramp_onramps
             SET status = 'settled',
                 ledger_tx_id = ${posted.id},
                 settled_at = now()
           WHERE id = ${claimed.id} AND status = 'pending'
        `;

        return { ...claimed, status: 'settled', ledgerTxId: posted.id, settledAt: new Date() };
      },
    );
  }

  /**
   * Move value out of the user's available balance to the crypto ledger rail
   * boundary. Crypto pays the stored EVM dest through ledger-client; refuses
   * if none stored — before withdrawHold. Does NOT broadcast.
   * `simulated` stays true.
   */
  async offramp(input: {
    offrampId: string;
    userId: string;
    assetId: string;
    amount: Amount;
    kind: RampKind;
    destinationRef?: string;
    clientRef: string;
  }): Promise<OfframpRecord> {
    if (input.kind === 'fiat') refuseFiatRamp();
    if (input.amount <= 0n) {
      throw new BankError('Off-ramp amount must be positive', 'bank.ramp_invalid_amount');
    }
    assertRampAssetId(input.assetId);
    const rail = assertCryptoRamp(this.programme);
    // While the owner's security lock holds, no new send starts (W-withdraw-09): asked before the claim, so a locked
    // account writes no row and posts no hold. A send already claimed under this id before the lock was set is a replay
    // or a resume, not a new send: it carries on, so a settled one answers as before and a held one is not left held.
    // Only with the address it was claimed with: an offered address is stored before the claim's terms are checked, so a
    // replay naming another one would change the withdrawal address, and that waits for the lock like any change does.
    // Identity unreachable refuses every send, replays included: it cannot say whether the lock holds. The owner's
    // self-freeze (I-account-lifecycle-08) is stricter: it is their emergency stop, so nothing carries on while it is
    // open, a send claimed before it included (a held one stays held until they lift it): `bank.account_frozen_self`.
    const hold = await this.securityLock.read(input.userId);
    if (hold.selfFrozen) assertHoldsOpen(hold, 'a withdrawal');
    if (hold.locked) {
      const claimedTo = await this.offrampClaimedTo(input.offrampId, input.userId);
      const offered = input.destinationRef?.trim();
      if (claimedTo === null || (offered && offered !== claimedTo)) assertHoldsOpen(hold, 'a withdrawal');
    }
    const coolingHours = requireOfframpCoolingHours(this.ownerOfframpCoolingHoursRaw());
    // A new send never goes to, and never stores, an address on the owner's fraud list (W-withdraw-03): checked before the
    // offered address is stored and before the claim. Only a send already claimed under this id TO THAT SAME ADDRESS carries
    // on (a settled one answers as before, a held one is not left held), so a listing made after the claim strands nothing;
    // a reused id naming a listed address it was not claimed with is refused like a new send, before anything is stored
    // (the security lock's rule above).
    const sameAs = (a: string, b: string) => fraudAddressKey(a) === fraudAddressKey(b);
    const resumesWith = async (ref: string) => {
      const claimedTo = await this.offrampClaimedTo(input.offrampId, input.userId);
      return claimedTo !== null && sameAs(ref, claimedTo);
    };
    const offered = input.destinationRef?.trim();
    if (offered && (await this.fraudList.isListed(null, offered)) && !(await resumesWith(offered))) refuseFraudListed();
    // The sanctions list the same way: a listed address, or any while the list is unset, starts no new send and is not stored.
    const sanctionedOffer = offered ? sanctionsRefusal(this.sanctions, null, offered) : null;
    if (sanctionedOffer && offered && !(await resumesWith(offered))) throw sanctionedOffer;
    const dest = await this.resolveWithdrawDestination(input.userId, input.kind, input.destinationRef);
    if ((await this.fraudList.isListed(dest.network, dest.ref)) && !(await resumesWith(dest.ref))) refuseFraudListed();
    const sanctionedDest = sanctionsRefusal(this.sanctions, dest.network, dest.ref);
    if (sanctionedDest && !(await resumesWith(dest.ref))) throw sanctionedDest;
    assertOfframpDestCoolingElapsed(coolingHours, dest.updatedAt);

    return withMoneySpan(
      'bank.ramp.offramp',
      {
        operation: 'offramp',
        amount: formatAmount(input.amount),
        userId: input.userId,
        assetId: input.assetId,
        coolingHours: String(coolingHours),
      },
      () =>
        this.withOfframpLock(input.offrampId, async () => {
          const claimed = await this.claimOfframp({ ...input, rail, destinationRef: dest.ref });

          if (claimed.status === 'settled') return claimed;
          if (claimed.status === 'rejected') {
            throw new BankError(claimed.rejectionCode ?? 'Off-ramp previously rejected', 'bank.ramp_conflict');
          }

          // Resume path: hold already posted, settle still needed.
          let holdTxId = claimed.holdLedgerTxId;
          if (!holdTxId) {
            try {
              const held = await this.ledger.post(
                recipes.withdrawHold({
                  userId: claimed.userId,
                  assetId: claimed.assetId,
                  amount: claimed.amount,
                  rail: claimed.rail,
                  withdrawalId: claimed.id,
                }),
              );
              holdTxId = held.id;
            } catch (err) {
              if (err instanceof InsufficientFundsError) {
                await this.rejectOfframp(claimed.id, 'ledger.insufficient_funds');
                throw err;
              }
              if (err instanceof LedgerError) throw err;
              throw err;
            }

            const stamped = await this.sql<Array<{ id: string }>>`
              UPDATE bank.ramp_offramps
                 SET hold_ledger_tx_id = ${holdTxId}
               WHERE id = ${claimed.id} AND status = 'pending'
               RETURNING id
            `;
            if (stamped.length === 0) {
              throw new BankError('Off-ramp hold did not claim the pending row', 'bank.ramp_conflict');
            }
          }

          const settled = await this.ledger.post(
            recipes.withdrawSettle({
              userId: claimed.userId,
              assetId: claimed.assetId,
              amount: claimed.amount,
              rail: claimed.rail,
              withdrawalId: claimed.id,
            }),
          );

          const wrote = await this.sql<Array<{ id: string }>>`
            UPDATE bank.ramp_offramps
               SET status = 'settled',
                   hold_ledger_tx_id = ${holdTxId},
                   settle_ledger_tx_id = ${settled.id},
                   settled_at = now()
             WHERE id = ${claimed.id} AND status = 'pending'
             RETURNING id
          `;
          if (wrote.length === 0) {
            throw new BankError('Off-ramp settle did not claim the pending row', 'bank.ramp_conflict');
          }

          return {
            ...claimed,
            status: 'settled',
            holdLedgerTxId: holdTxId,
            settleLedgerTxId: settled.id,
            settledAt: new Date(),
          };
        }),
    );
  }

  /** Owner window from options, else live env — never a canned 24h. */
  private ownerOfframpCoolingHoursRaw(): string | undefined {
    return this.offrampCoolingHours !== undefined ? this.offrampCoolingHours : process.env[BANK_OFFRAMP_COOLING_HOURS_ENV];
  }

  /** Ledger read: available balance for the user/asset (no local mirror). */
  async availableOf(userId: string, assetId: string): Promise<Amount> {
    return (await this.ledger.balance(userAvailable(userId, assetId))).amount;
  }

  /**
   * Crypto withdraw always uses the stored EVM dest. Persist an offered dest
   * then require the store — refuse closed if none stored, before withdrawHold.
   * Kind fiat never reaches this method.
   */
  private async resolveWithdrawDestination(userId: string, kind: RampKind, offeredRef?: string): Promise<WithdrawDestination> {
    const destKind = destKindForRamp(kind);
    const offered = offeredRef?.trim();
    if (kind === 'crypto') {
      if (offered) {
        await this.destinations.persist({ userId, kind: destKind, ref: offered });
      }
      return this.destinations.require({ userId, kind: destKind });
    }
    if (offered) {
      return this.destinations.persist({ userId, kind: destKind, ref: offered });
    }
    return this.destinations.require({ userId, kind: destKind });
  }

  /** Hold account for an offramp — for tests and recovery visibility. */
  holdAccount(userId: string, assetId: string, offrampId: string) {
    return withdrawalHoldAccount(userId, assetId, offrampId);
  }

  private async claimOnramp(input: {
    userId: string;
    assetId: string;
    amount: Amount;
    kind: RampKind;
    rail: string;
    railRef: string;
    creditedBy: string;
  }): Promise<OnrampRecord> {
    if (input.kind === 'fiat') refuseFiatRamp();
    return transaction(this.sql, async (tx) => {
      const inserted = await tx<OnrampRow[]>`
        INSERT INTO bank.ramp_onramps (
          user_id, asset_id, amount, kind, rail, rail_ref, simulated, credited_by, status
        ) VALUES (
          ${input.userId}, ${input.assetId}, ${formatAmount(input.amount)}::numeric,
          ${input.kind}, ${input.rail}, ${input.railRef}, true, ${input.creditedBy}, 'pending'
        )
        ON CONFLICT (rail, rail_ref) DO NOTHING
        RETURNING *
      `;
      if (inserted[0]) return toOnramp(inserted[0]);

      const rows = await tx<OnrampRow[]>`
        SELECT * FROM bank.ramp_onramps
         WHERE rail = ${input.rail} AND rail_ref = ${input.railRef}
         FOR UPDATE
      `;
      return sameOnrampOrConflict(toOnramp(rows[0]!), input);
    });
  }

  /** The address this customer's off-ramp under this id was claimed with (whatever its state), or null when there is none. */
  private async offrampClaimedTo(offrampId: string, userId: string): Promise<string | null> {
    const rows = await this.sql<Array<{ destination_ref: string }>>`
      SELECT destination_ref FROM bank.ramp_offramps WHERE id = ${offrampId}::uuid AND user_id = ${userId}
    `;
    return rows[0]?.destination_ref ?? null;
  }

  private async claimOfframp(input: {
    offrampId: string;
    userId: string;
    assetId: string;
    amount: Amount;
    kind: RampKind;
    rail: string;
    destinationRef: string;
    clientRef: string;
  }): Promise<OfframpRecord> {
    if (input.kind === 'fiat') refuseFiatRamp();
    return transaction(this.sql, async (tx) => {
      /**
       * Two unique keys: primary `id` and `(user_id, client_ref)`.
       *
       * `ON CONFLICT (user_id, client_ref)` alone left same-id / different-
       * clientRef as a raw PG 23505 on the primary key. Resolve both keys by
       * name as `bank.ramp_conflict` — never surface constraint codes.
       */
      const byId = await tx<OfframpRow[]>`
        SELECT * FROM bank.ramp_offramps
         WHERE id = ${input.offrampId}::uuid
         FOR UPDATE
      `;
      if (byId[0]) {
        const existing = toOfframp(byId[0]);
        if (offrampFactsMismatch(existing, input)) {
          throw new BankError(`Off-ramp id ${input.offrampId} was already used with different terms`, 'bank.ramp_conflict');
        }
        return existing;
      }

      try {
        const inserted = await tx<OfframpRow[]>`
          INSERT INTO bank.ramp_offramps (
            id, user_id, asset_id, amount, kind, rail, destination_ref, client_ref, simulated, status
          ) VALUES (
            ${input.offrampId}::uuid, ${input.userId}, ${input.assetId}, ${formatAmount(input.amount)}::numeric,
            ${input.kind}, ${input.rail}, ${input.destinationRef}, ${input.clientRef}, true, 'pending'
          )
          ON CONFLICT (user_id, client_ref) DO NOTHING
          RETURNING *
        `;
        if (inserted[0]) return toOfframp(inserted[0]);
      } catch (err) {
        // Concurrent same-id insert (or any other unique on this row) — resolve, don't leak 23505.
        if (!isUniqueViolation(err)) throw err;
        const raced = await tx<OfframpRow[]>`
          SELECT * FROM bank.ramp_offramps
           WHERE id = ${input.offrampId}::uuid
              OR (user_id = ${input.userId} AND client_ref = ${input.clientRef})
           FOR UPDATE
        `;
        if (raced[0]) {
          const existing = toOfframp(raced[0]);
          if (offrampFactsMismatch(existing, input)) {
            throw new BankError(`Off-ramp claim collided on id ${input.offrampId} or client ref ${input.clientRef}`, 'bank.ramp_conflict');
          }
          return existing;
        }
        throw err;
      }

      const rows = await tx<OfframpRow[]>`
        SELECT * FROM bank.ramp_offramps
         WHERE user_id = ${input.userId} AND client_ref = ${input.clientRef}
         FOR UPDATE
      `;
      const existing = toOfframp(rows[0]!);
      if (offrampFactsMismatch(existing, input)) {
        throw new BankError(`Client ref ${input.clientRef} was already used for a different off-ramp`, 'bank.ramp_conflict');
      }
      return existing;
    });
  }

  /**
   * One offramp at a time, from the claim through withdrawHold and withdrawSettle.
   *
   * The claim's FOR UPDATE ends when that transaction commits, which is before
   * the posts. This session lock is still held while those posts run, so a
   * second caller cannot settle a row this caller rejects.
   *
   * `pg_advisory_lock` is session-scoped. The connection stays reserved so
   * unlock hits the session that took the lock. The key is unchanged, so a
   * replica on older code takes the same lock. See `session-lock.ts` for how the
   * reserved connections are kept from starving the pool the body runs on.
   */
  private async withOfframpLock<T>(offrampId: string, body: () => Promise<T>): Promise<T> {
    return withSessionAdvisoryLock(this.sql, 'bank.ramp.offramp', offrampId, body);
  }

  private async rejectOfframp(id: string, code: string): Promise<void> {
    await this.sql`
      UPDATE bank.ramp_offramps
         SET status = 'rejected', rejection_code = ${code}
       WHERE id = ${id} AND status = 'pending'
    `;
  }
}

function toOnramp(row: OnrampRow): OnrampRecord {
  return {
    id: row.id,
    userId: row.user_id,
    assetId: row.asset_id,
    amount: parseAmount(row.amount),
    kind: row.kind,
    rail: row.rail,
    railRef: row.rail_ref,
    simulated: row.simulated,
    creditedBy: row.credited_by,
    status: row.status,
    ledgerTxId: row.ledger_tx_id,
    rejectionCode: row.rejection_code,
    createdAt: row.created_at,
    settledAt: row.settled_at,
  };
}

function toOfframp(row: OfframpRow): OfframpRecord {
  return {
    id: row.id,
    userId: row.user_id,
    assetId: row.asset_id,
    amount: parseAmount(row.amount),
    kind: row.kind,
    rail: row.rail,
    destinationRef: row.destination_ref,
    clientRef: row.client_ref,
    simulated: row.simulated,
    status: row.status,
    holdLedgerTxId: row.hold_ledger_tx_id,
    settleLedgerTxId: row.settle_ledger_tx_id,
    releaseLedgerTxId: row.release_ledger_tx_id,
    rejectionCode: row.rejection_code,
    createdAt: row.created_at,
    settledAt: row.settled_at,
  };
}

/**
 * Asset id shape gate — not a commercial allowlist.
 *
 * Empty / whitespace would post a ledger deposit under a nonsense asset and
 * look "successful". A full allowlist of pairs is product law (Nitro); until
 * that exists we only refuse the shapes that cannot be a real asset id.
 */
function assertRampAssetId(assetId: string): void {
  const trimmed = assetId.trim();
  if (!trimmed || trimmed !== assetId) {
    throw new BankError(
      'Ramp asset id must be a non-empty crypto symbol with no leading or trailing whitespace',
      'bank.ramp_invalid_asset',
    );
  }
}

function sameOnrampOrConflict(existing: OnrampRecord, input: { userId: string; assetId: string; amount: Amount }): OnrampRecord {
  const mismatch = existing.userId !== input.userId || existing.assetId !== input.assetId || existing.amount !== input.amount;
  if (mismatch) {
    throw new BankError(
      `Rail reference ${existing.rail}:${existing.railRef} was already credited as a different on-ramp`,
      'bank.ramp_conflict',
    );
  }
  return existing;
}

/** Claimed row must match every client-supplied term, including both unique keys. */
function offrampFactsMismatch(
  existing: OfframpRecord,
  input: {
    offrampId: string;
    userId: string;
    assetId: string;
    amount: Amount;
    destinationRef: string;
    clientRef: string;
  },
): boolean {
  return (
    existing.id !== input.offrampId ||
    existing.userId !== input.userId ||
    existing.assetId !== input.assetId ||
    existing.amount !== input.amount ||
    existing.destinationRef !== input.destinationRef ||
    existing.clientRef !== input.clientRef
  );
}

/** postgres.js surfaces PG SQLSTATE on `err.code`. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}
