import { formatAmount, type Amount } from '@intafaced/ledger-client';

/**
 * The chain, as `crypto-native` needs it.
 *
 * Doctrine §0.4 applies to our own infrastructure too: the adapter talks to
 * this interface, not to a node, an RPC provider or an indexer. In production
 * this is implemented against the chain watcher; in dev and in every test it is
 * `MemoryChain` below. The adapter cannot tell the difference, which is what
 * makes the adapter's own logic testable to the branch.
 *
 * Amounts are `Amount` — scaled bigint — on both sides. Chains speak in their
 * own smallest units; converting to and from those is the implementation's job,
 * at its own edge, and a `number` never appears in either direction.
 */

export interface ConfirmedTransfer {
  readonly txHash: string;
  /** The payer's address. This is where a refund has to go back to. */
  readonly from: string;
  readonly assetId: string;
  readonly amount: Amount;
  /** Blocks deep. The adapter's confirmation threshold is what makes it final. */
  readonly confirmations: number;
}

type CreditInput = { address: string; assetId: string; amount: Amount; from?: string; confirmations?: number; txHash?: string };

export interface ChainSendRequest {
  readonly to: string;
  readonly assetId: string;
  readonly amount: Amount;
  /**
   * Business key for the outbound transfer.
   *
   * The chain layer must return the ORIGINAL broadcast for a repeated key
   * rather than broadcasting again. Retrying an outbound payment because a
   * response timed out is the single most expensive mistake available on this
   * path: the first transfer already left, and it is not coming back.
   */
  readonly idempotencyKey: string;
}

/**
 * What is actually behind this port. THREE states, not two, and the third is
 * the one that matters.
 *
 *   live    — a real chain. A returned `txHash` names a transaction anybody can
 *             look up, and it is irreversible.
 *   sandbox — a simulator (`MemoryChain`). Every answer is internally
 *             consistent and none of it is on a chain.
 *   absent  — NOTHING is configured. Distinct from `sandbox` because a sandbox
 *             succeeds and an absent chain must refuse: the failure mode a
 *             simulator has in production is that it SUCCEEDS, hands back a
 *             fabricated `txHash`, and the user is told their withdrawal was
 *             sent. `UnconfiguredChain` exists so that state is loud instead.
 *
 * This is a property of the implementation, not configuration. A port that had
 * to be told what it was would be a second copy of the fact, and the copy is
 * what goes stale.
 */
export type ChainPosture = 'live' | 'sandbox' | 'absent';

export interface CryptoChainPort {
  readonly posture: ChainPosture;
  /** One line an operator can read in a boot log. `/ready` uses `payChainReadyHonesty`. */
  readonly description: string;
  /** Deterministic per (payment, asset) — the same payment always gets the same address. */
  acceptanceAddress(paymentId: string, assetId: string): Promise<string>;
  /**
   * The inbound transfer to an acceptance address, if one has landed.
   *
   * Takes only the address, and the transfer says what asset arrived. The
   * caller must NOT be able to ask "did the asset I expected arrive here" —
   * that phrasing cannot see a payer who sent the wrong token to the right
   * address, which is a thing payers do, and those funds would then sit at an
   * address nothing points at.
   */
  inboundTransfer(address: string): Promise<ConfirmedTransfer | null>;
  /**
   * Every inbound transfer to an acceptance address, oldest first, in whatever
   * asset and at whatever depth. A payer can pay one payment in several
   * transfers (J-merchant-04 step 5); the rail adds up what is final.
   */
  inboundTransfers(address: string): Promise<readonly ConfirmedTransfer[]>;
  send(request: ChainSendRequest): Promise<{ txHash: string }>;
  /**
   * The outbound transfer already journalled for this business key.
   * `not_sent` is a positive answer that this port never broadcast it.
   * `unknown` means a broadcast may have left and this port cannot prove either way.
   */
  lookupSend(idempotencyKey: string): Promise<ChainSendLookup>;
  /**
   * One cheap liveness check. MemoryChain resolves. A live chain reads its
   * chain id and must not scan blocks. UnconfiguredChain throws.
   */
  ping(): Promise<void>;
}

export type ChainSendLookup =
  | { readonly state: 'sent'; readonly txHash: string; readonly amount: Amount | null; readonly assetId: string | null }
  | { readonly state: 'not_sent' }
  | { readonly state: 'unknown' };

/**
 * In-memory chain — the reference implementation of the port.
 *
 * The same role `MemoryLedger` plays for the ledger: not a toy, but an
 * executable specification of what the adapter is entitled to assume. Confirm
 * depth, idempotent broadcast, and "a transfer that has not landed is null" are
 * all modelled here, so an adapter that behaves correctly against this one
 * behaves correctly against a chain.
 */
/**
 * Dev and test only (J-wallet-05 #8): how the in-memory chain paces a send, so a real send can be watched on its page.
 * `sendDelayMs` waits after the send is recorded (broadcast) and before it answers, as a real node waits for its
 * confirmations. `refuseAmount` refuses, before anything is recorded, every send of exactly that amount, as a node refuses a
 * transaction it will not take. Both are TEST settings: `defaultChainFor` reads them only where the chain is this one.
 */
export interface MemoryChainPace {
  readonly sendDelayMs?: number;
  readonly refuseAmount?: Amount;
}

/**
 * The chain refused the send before anything left: nothing was broadcast, so nothing can arrive. `crypto-native` turns
 * it into a `rail.refused` failure and the hold is reversed in the same call.
 */
export class ChainSendRefusedError extends Error {
  readonly code = 'chain.send_refused';

  constructor(reason: string) {
    super(`The chain refused the send before broadcast: ${reason}`);
    this.name = 'ChainSendRefusedError';
  }
}

export class MemoryChain implements CryptoChainPort {
  constructor(private readonly pace: MemoryChainPace = {}) {}

  /**
   * SANDBOX, stated on the object rather than known by convention.
   *
   * This class is the §13 socket's placeholder, and it is genuinely useful — but
   * a `txHash` it returns is `0xout00000001`, which is not a transaction. The
   * only thing that keeps that from reaching a user as "your withdrawal was
   * sent" is this field and the posture check that reads it.
   */
  readonly posture = 'sandbox' as const;
  readonly description = 'in-memory reference chain (MemoryChain) — no transaction reaches any chain';

  private readonly transfers = new Map<string, ConfirmedTransfer[]>();
  private readonly sent = new Map<string, { txHash: string }>();
  private readonly outbound: Array<ChainSendRequest & { txHash: string }> = [];
  private nonce = 0;
  private broadcastError: Error | null = null;
  private callError: Error | null = null;

  async acceptanceAddress(paymentId: string, assetId: string): Promise<string> {
    this.takeCallError();
    return `addr_${assetId.toLowerCase()}_${paymentId}`;
  }

  async inboundTransfer(address: string): Promise<ConfirmedTransfer | null> {
    this.takeCallError();
    return this.transfers.get(address)?.[0] ?? null;
  }

  async inboundTransfers(address: string): Promise<readonly ConfirmedTransfer[]> {
    this.takeCallError();
    return [...(this.transfers.get(address) ?? [])];
  }

  async lookupSend(idempotencyKey: string): Promise<ChainSendLookup> {
    const hit = this.outbound.find((row) => row.idempotencyKey === idempotencyKey);
    if (!hit) return { state: 'not_sent' };
    return { state: 'sent', txHash: hit.txHash, amount: hit.amount, assetId: hit.assetId };
  }

  /** In-process. There is no RPC to fail. */
  async ping(): Promise<void> {
    this.takeCallError();
  }

  async send(request: ChainSendRequest): Promise<{ txHash: string }> {
    // Idempotency is checked BEFORE the injected failure, because that is the
    // real ordering: a key that has already been broadcast returns the original
    // no matter what the node is doing now.
    const existing = this.sent.get(request.idempotencyKey);
    if (existing) return existing;

    this.takeCallError();

    if (this.broadcastError) {
      const err = this.broadcastError;
      this.broadcastError = null;
      throw err;
    }

    if (this.pace.refuseAmount !== undefined && request.amount === this.pace.refuseAmount) {
      throw new ChainSendRefusedError(`TEST: the in-memory chain refuses every send of ${formatAmount(request.amount)}`);
    }

    const txHash = `0xout${(++this.nonce).toString(16).padStart(8, '0')}`;
    this.sent.set(request.idempotencyKey, { txHash });
    this.outbound.push({ ...request, txHash });
    // Recorded first, so a status query during the wait finds it sent, as it would find a broadcast awaiting confirmations.
    if (this.pace.sendDelayMs) await new Promise((resolve) => setTimeout(resolve, this.pace.sendDelayMs));
    return { txHash };
  }

  // ── Test / dev controls ────────────────────────────────────────────────────

  /** Simulate a payer sending funds to an acceptance address: the only transfer there, replacing any before it. */
  credit(input: CreditInput): void {
    this.transfers.set(input.address, [this.transferOf(input)]);
  }

  /**
   * Simulate one more transfer to an address (a payer paying in parts). The same transaction hash again is the same
   * transfer seen again and replaces it; a new hash is added after the others.
   */
  creditAnother(input: CreditInput & { txHash: string }): void {
    const transfer = this.transferOf(input);
    const known = this.transfers.get(input.address) ?? [];
    const at = known.findIndex((t) => t.txHash === transfer.txHash);
    this.transfers.set(input.address, at === -1 ? [...known, transfer] : known.map((t, i) => (i === at ? transfer : t)));
  }

  /** Deepen (or shallow) the transfers at an address, or only the one with `txHash` — drives the confirmation branch. */
  setConfirmations(address: string, confirmations: number, txHash?: string): void {
    const existing = this.transfers.get(address);
    if (existing) {
      this.transfers.set(
        address,
        existing.map((t) => (txHash === undefined || t.txHash === txHash ? { ...t, confirmations } : t)),
      );
    }
  }

  private transferOf(input: CreditInput): ConfirmedTransfer {
    return {
      txHash: input.txHash ?? `0xin${(++this.nonce).toString(16).padStart(8, '0')}`,
      from: input.from ?? '0xpayer',
      assetId: input.assetId,
      amount: input.amount,
      confirmations: input.confirmations ?? 12,
    };
  }

  /** The next broadcast throws, once. Rail failure on the way OUT. */
  failNextBroadcast(error = new Error('chain rpc unavailable')): void {
    this.broadcastError = error;
  }

  /**
   * The next call of ANY kind throws, once — an RPC outage rather than a
   * rejected transaction. The adapter must turn this into a failed result, not
   * let it escape: a chain provider having a bad minute is not an exception in
   * a payments core, it is Tuesday.
   */
  failNextCall(error = new Error('chain rpc unavailable')): void {
    this.callError = error;
  }

  /** Everything this chain has been asked to send — the outbound audit. */
  outboundTransfers(): ReadonlyArray<ChainSendRequest & { txHash: string }> {
    return this.outbound;
  }

  totalSent(assetId: string): string {
    return formatAmount(this.outbound.filter((o) => o.assetId === assetId).reduce((acc, o) => acc + o.amount, 0n));
  }

  reset(): void {
    this.transfers.clear();
    this.sent.clear();
    this.outbound.length = 0;
    this.broadcastError = null;
    this.callError = null;
    this.nonce = 0;
  }

  private takeCallError(): void {
    if (!this.callError) return;
    const err = this.callError;
    this.callError = null;
    throw err;
  }
}

/**
 * NO CHAIN IS CONFIGURED, and every call says so.
 *
 * THIS CLASS EXISTS BECAUSE THE ALTERNATIVE IS THE WORST BUG IN THE SERVICE.
 * Wiring `MemoryChain` into a real deployment does not fail — it succeeds. A
 * user's withdrawal debits their real ledger balance, `MemoryChain.send`
 * returns `0xout00000003`, svc-pay writes that into `withdrawals.rail_ref`,
 * posts `withdrawSettle`, and answers `status: 'sent'`. The books balance. The
 * user is told their money is on its way. Nothing moved, and no reconciliation
 * against real custody has been run yet to say otherwise.
 *
 * So the production default when nothing is configured is not a simulator; it is
 * this, which refuses. A refusal is recoverable: `crypto-native` turns the throw
 * into a `chain.unavailable` failure result, `UserMoneyService` reverses the
 * hold in the same call, and the user has their money back with a failure code
 * that names the real reason.
 *
 * WHAT THE OWNER MUST OBTAIN is in the error message, because the person who
 * reads it is the person who has to act on it.
 */
export class ChainNotConfiguredError extends Error {
  readonly code = 'pay.chain_not_configured';

  constructor(operation: string) {
    super(
      `NO CHAIN IS CONFIGURED — refusing to ${operation}.\n\n` +
        `\`crypto-native\` is registered but has no chain behind it. §13 lists the chain watcher as ` +
        `the socket this rail plugs into, and until something implements \`CryptoChainPort\` against a ` +
        `real node, this rail cannot move value.\n\n` +
        `THIS IS A REFUSAL ON PURPOSE. The in-memory reference chain would have answered this call ` +
        `successfully and handed back a transaction hash that is not a transaction. A withdrawal ` +
        `settled against that reports \`sent\`, and the user has been told their money moved.\n\n` +
        `TO MAKE THIS RAIL REAL, the owner must obtain and supply:\n` +
        `  1. A chain node or RPC provider endpoint per supported chain, with archive access deep ` +
        `enough to serve the confirmation depth in PAY_MIN_CONFIRMATIONS.\n` +
        `  2. Custody of the signing keys for outbound transfers, and a signing service that will ` +
        `not broadcast the same business key twice (see ChainSendRequest.idempotencyKey — a repeated ` +
        `broadcast is money that is not coming back).\n` +
        `  3. Deterministic acceptance-address derivation per (payment, asset), so a retry never ` +
        `hands a payer a second address.\n` +
        `  4. A chain watcher that signs its deliveries with PAY_CRYPTO_WEBHOOK_SECRET.\n\n` +
        `None of that is an engineering decision this service can make for itself, which is why the ` +
        `honest state until then is a loud failure rather than a quiet simulation.`,
    );
    this.name = 'ChainNotConfiguredError';
  }
}

export class UnconfiguredChain implements CryptoChainPort {
  readonly posture = 'absent' as const;
  readonly description = 'NO CHAIN CONFIGURED — every call refuses; crypto-native cannot move value';

  async acceptanceAddress(): Promise<string> {
    // Deliberately refuses even the read. Handing a payer an address derived by
    // a chain we cannot watch is inviting them to send funds nothing is looking
    // for — the one outcome worse than declining the payment.
    throw new ChainNotConfiguredError('derive an acceptance address');
  }

  async inboundTransfers(): Promise<readonly ConfirmedTransfer[]> {
    // NOT empty, for the same reason as `inboundTransfer` below.
    throw new ChainNotConfiguredError('read inbound transfers');
  }

  async inboundTransfer(): Promise<ConfirmedTransfer | null> {
    // NOT `null`. Null means "the payer has not sent anything yet", which is a
    // fact about the payer; this is a fact about us, and collapsing the two
    // would leave `authorize` reporting `pending` forever on a rail that is
    // never going to answer.
    throw new ChainNotConfiguredError('read an inbound transfer');
  }

  async send(): Promise<{ txHash: string }> {
    // The one that matters. There is no fabricated hash on this path.
    throw new ChainNotConfiguredError('broadcast an outbound transfer');
  }

  async lookupSend(): Promise<ChainSendLookup> {
    // Not `not_sent`. That would let a reconciler reverse a payout whose
    // broadcast this process can no longer see because nothing is configured.
    throw new ChainNotConfiguredError('look up an outbound transfer');
  }

  async ping(): Promise<void> {
    throw new ChainNotConfiguredError('probe the chain');
  }
}
