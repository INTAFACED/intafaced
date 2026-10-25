import { createHash } from 'node:crypto';
import { isExplicitDevOrTestEnv } from '@intafaced/config';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import {
  railFailure,
  railHealthStaleReason,
  railRefusalIfBlocking,
  RAIL_HEALTH_MAX_STALENESS_MS,
  RAIL_MARKED_DOWN,
  RAIL_SANDBOX_ONLY,
  type PaymentIntent,
  type RailAdapter,
  type RailCapability,
  type RailEvent,
  type RailHealth,
  type RailProbeResult,
  type RailResult,
  type RailWebhookRequest,
} from './rail-adapter.js';
import { signPayload, verifySignature } from './webhook-signature.js';
import { PAYER_NAME_MAX } from '../payer-name/match.js';

/**
 * bank-transfer-sandbox: a TEST bank that takes pushed bank transfers for the hosted checkout (J-merchant-04 step 6).
 *
 * The payer sends a transfer from their own bank quoting the payment's reference; the bank tells us, by a signed webhook,
 * what arrived and the name on the account it came from. Everything on this side of the interface is real (the
 * reference, the amounts, the signed deliveries, the core's name check before capture). Only the bank is simulated: its
 * books are the `accounts` map below, and an inbound transfer reaches them through `receive`, which the service calls
 * with a delivery `verifyWebhook` accepted, before the core applies it (as the in-memory chain is fed in
 * `sandbox-chain-feed.ts`). So a payment can be completed on a dev or test stack, and nowhere else.
 *
 * SANDBOX, permanently, and not configurable: a live bank rail is a different adapter that passes the same kit. It is
 * registered only where `shouldRegisterBankTransferSandbox` says so, and a public checkout takes it only where the
 * posture lets sandbox rails take strangers' money (dev and test).
 *
 * It declares no `refund` and no `payout`: sending money back to a payer's bank is not simulated, so the core refuses
 * both by name rather than reporting a return that never happened.
 */

export interface BankTransferSandboxOptions {
  /** Webhook signing secret. In dev this is config; in prod this adapter does not exist. */
  readonly secret: string;
  readonly now?: () => Date;
  /** Deliveries older than this are treated as replays. Owner-published, never invented. */
  readonly toleranceSeconds: number;
}

interface InboundTransfer {
  readonly id: string;
  readonly amount: Amount;
  readonly assetId: string;
  readonly payerName: string | null;
}

interface BankAccount {
  readonly ref: string;
  readonly paymentId: string;
  readonly assetId: string;
  /** What `authorize` took: the whole of what had arrived once it covered the payment, and whose accounts it came from. */
  authorized: Amount | null;
  payerNames: readonly (string | null)[];
  captured: boolean;
}

export const BANK_TRANSFER_SANDBOX_SECRET_ENV = 'PAY_BANK_TRANSFER_SANDBOX_WEBHOOK_SECRET';

/**
 * The TEST bank, when this deployment has one: only with its webhook secret set, and only under an explicit APP_ENV of
 * dev or test. Its secret set anywhere else refuses boot, so a TEST bank can never take a stranger's payment.
 */
export function bankTransferSandboxFromEnv(
  env: Record<string, string | undefined>,
  toleranceSeconds: number,
): BankTransferSandboxAdapter | null {
  const secret = env[BANK_TRANSFER_SANDBOX_SECRET_ENV]?.trim() ?? '';
  if (!secret) return null;
  if (!isExplicitDevOrTestEnv(env)) {
    throw new Error(`${BANK_TRANSFER_SANDBOX_SECRET_ENV} is set, and the TEST bank runs only under APP_ENV dev or test. Unset it here.`);
  }
  if (secret.length < 32) throw new Error(`${BANK_TRANSFER_SANDBOX_SECRET_ENV} must be at least 32 characters`);
  return new BankTransferSandboxAdapter({ secret, toleranceSeconds });
}

/** The reference a payer quotes: `BT` and 12 characters derived from our payment id, so re-asking gives the same one. */
export function bankTransferReference(paymentId: string): string {
  const digest = createHash('sha256').update(`bank-transfer:${paymentId}`).digest('hex').slice(0, 12).toUpperCase();
  return `BT${digest}`;
}

export const BANK_TRANSFER_REFERENCE = /^BT[0-9A-F]{12}$/;

export class BankTransferSandboxAdapter implements RailAdapter {
  readonly id = 'bank-transfer-sandbox';
  readonly capabilities: readonly RailCapability[] = ['authorize', 'capture', 'webhook'];
  readonly mode = 'sandbox' as const;
  readonly checksPayerName = true;

  /** The TEST bank's books: one account per reference, and the transfers it received for each. */
  private readonly accounts = new Map<string, BankAccount>();
  private readonly transfers = new Map<string, InboundTransfer[]>();
  private readonly now: () => Date;
  private lastContact: Date;
  private forcedFailure: { code: string; reason: string } | null = null;
  private up = true;

  constructor(private readonly options: BankTransferSandboxOptions) {
    this.now = options.now ?? (() => new Date());
    this.lastContact = this.now();
  }

  health(): RailHealth {
    const ageMs = this.now().getTime() - this.lastContact.getTime();
    if (ageMs > RAIL_HEALTH_MAX_STALENESS_MS) {
      return { healthy: false, latencyMs: 12, lastUpdate: this.lastContact, reason: railHealthStaleReason(ageMs) };
    }
    if (!this.up) return { healthy: false, latencyMs: 12, lastUpdate: this.lastContact, reason: RAIL_MARKED_DOWN };
    return { healthy: true, latencyMs: 12, lastUpdate: this.lastContact, reason: RAIL_SANDBOX_ONLY };
  }

  async probe(): Promise<RailProbeResult> {
    if (!this.up) return { ok: false, reason: RAIL_MARKED_DOWN };
    this.lastContact = this.now();
    return { ok: true };
  }

  // ── Test controls ──────────────────────────────────────────────────────────

  /** The next rail call fails, once. */
  failNext(code = 'bank.unavailable', reason = 'Simulated bank failure'): void {
    this.forcedFailure = { code, reason };
  }

  setHealthy(up: boolean): void {
    this.up = up;
  }

  reset(): void {
    this.accounts.clear();
    this.transfers.clear();
    this.forcedFailure = null;
    this.up = true;
    this.lastContact = this.now();
  }

  /**
   * The TEST bank books a transfer it reported. Only ever called with a delivery `verifyWebhook` accepted. The same
   * transfer id twice is one transfer. Returns whether it was new.
   */
  receive(event: RailEvent | null): boolean {
    if (!event || event.railId !== this.id || event.type !== 'captured') return false;
    if (event.amount === undefined || event.amount <= 0n || !event.assetId) return false;
    const list = this.transfers.get(event.railRef) ?? [];
    if (list.some((t) => t.id === event.eventId)) return false;
    list.push({ id: event.eventId, amount: event.amount, assetId: event.assetId, payerName: event.payerName ?? null });
    this.transfers.set(event.railRef, list);
    return true;
  }

  // ── The interface ──────────────────────────────────────────────────────────

  /**
   * Before anything has arrived: `pending`, with the reference the payer quotes. Once the transfers to that reference
   * in the payment's currency cover it: `authorized` for all of what arrived (a payer who sent more has still sent it).
   * Both name the sending account of every transfer counted, so the core checks the names of exactly that money.
   */
  async authorize(p: PaymentIntent): Promise<RailResult> {
    const ref = bankTransferReference(p.paymentId);
    const blocked = railRefusalIfBlocking(this, { amount: p.amount, assetId: p.assetId, railRef: ref, at: this.now() });
    if (blocked) return blocked;
    this.lastContact = this.now();
    const forced = this.takeForcedFailure(ref, p.amount, p.assetId);
    if (forced) return forced;
    if (p.amount <= 0n) {
      return railFailure({
        railRef: ref,
        amount: p.amount,
        assetId: p.assetId,
        failureCode: 'authorize.invalid_amount',
        failureReason: 'Authorization amount must be positive',
        at: this.now(),
      });
    }

    const account = this.accounts.get(ref) ?? {
      ref,
      paymentId: p.paymentId,
      assetId: p.assetId,
      authorized: null,
      payerNames: [],
      captured: false,
    };
    this.accounts.set(ref, account);
    if (account.authorized !== null) return this.result(account, 'authorized', account.authorized);

    const counted = this.transfersIn(ref, p.assetId);
    const received = counted.reduce((sum, t) => sum + t.amount, 0n);
    const payerNames = counted.map((t) => t.payerName);
    if (received < p.amount) {
      return {
        ok: true,
        railRef: ref,
        status: 'pending',
        amount: p.amount,
        assetId: p.assetId,
        at: this.now(),
        raw: { received: formatAmount(received), missing: formatAmount(p.amount - received) },
        payerNames,
      };
    }
    account.authorized = received;
    account.payerNames = payerNames;
    return this.result(account, 'authorized', received);
  }

  async capture(ref: string): Promise<RailResult> {
    const account = this.accounts.get(ref);
    const blocked = railRefusalIfBlocking(this, {
      amount: account?.authorized ?? 0n,
      assetId: account?.assetId ?? '',
      railRef: ref,
      at: this.now(),
    });
    if (blocked) return blocked;
    this.lastContact = this.now();
    if (!account || account.authorized === null) {
      return railFailure({
        railRef: ref,
        amount: 0n,
        assetId: account?.assetId ?? '',
        failureCode: account ? 'capture.not_authorized' : 'rail.unknown_reference',
        failureReason: account ? 'Nothing has been authorized on this reference' : `No transfer reference ${ref}`,
        at: this.now(),
      });
    }
    const forced = this.takeForcedFailure(ref, account.authorized, account.assetId);
    if (forced) return forced;
    // Idempotent: the transfer was taken once, and asking again answers the same.
    account.captured = true;
    return this.result(account, 'captured', account.authorized);
  }

  async refund(ref: string, amount: Amount): Promise<RailResult> {
    return railFailure({
      railRef: ref,
      amount,
      assetId: this.accounts.get(ref)?.assetId ?? '',
      failureCode: 'rail.operation_unsupported',
      failureReason: 'The TEST bank does not send money back to a payer',
      at: this.now(),
    });
  }

  async payout(): Promise<RailResult> {
    return railFailure({
      railRef: '',
      amount: 0n,
      assetId: '',
      failureCode: 'rail.operation_unsupported',
      failureReason: 'The TEST bank does not pay out',
      at: this.now(),
    });
  }

  verifyWebhook(req: RailWebhookRequest): RailEvent | null {
    const ok = verifySignature({
      body: req.body,
      signature: req.headers['x-bank-signature'],
      timestamp: req.headers['x-bank-timestamp'],
      secret: this.options.secret,
      toleranceSeconds: this.options.toleranceSeconds,
      now: this.now(),
    });
    if (!ok) return null;
    // Parsed only after the signature verifies.
    let body: unknown;
    try {
      body = JSON.parse(req.body);
    } catch {
      return null;
    }
    return toRailEvent(this.id, body);
  }

  /** Sign a delivery the way the TEST bank does: tests and the local stack's `bank-transfer` command. */
  signWebhook(payload: Record<string, unknown>, at: Date = this.now()): RailWebhookRequest {
    const body = JSON.stringify(payload);
    const timestamp = Math.floor(at.getTime() / 1000).toString();
    return { headers: { 'x-bank-signature': signPayload(this.options.secret, timestamp, body), 'x-bank-timestamp': timestamp }, body };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private transfersIn(ref: string, assetId: string): InboundTransfer[] {
    return (this.transfers.get(ref) ?? []).filter((t) => t.assetId === assetId);
  }

  private takeForcedFailure(railRef: string, amount: Amount, assetId: string): RailResult | null {
    if (this.forcedFailure === null) return null;
    const { code, reason } = this.forcedFailure;
    this.forcedFailure = null;
    return railFailure({ railRef, amount, assetId, failureCode: code, failureReason: reason, at: this.now() });
  }

  private result(account: BankAccount, status: 'authorized' | 'captured', amount: Amount): RailResult {
    return {
      ok: true,
      railRef: account.ref,
      status,
      amount,
      assetId: account.assetId,
      at: this.now(),
      raw: { paymentId: account.paymentId },
      payerNames: account.payerNames,
    };
  }
}

/**
 * Shape-check a verified body. Only `captured` (money arrived) and `failed` are delivered by this bank. A `captured`
 * one names the amount as a decimal string, its currency and, when the bank has it, the payer's name; one missing its
 * amount or currency is booked by nobody (`receive` skips it and the rail still answers pending).
 */
function toRailEvent(railId: string, body: unknown): RailEvent | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  const eventId = typeof b.id === 'string' && b.id.trim() ? b.id.trim() : null;
  const type = b.type === 'captured' || b.type === 'failed' ? b.type : null;
  // Matched to a payment by the core; one that matches none is refused there by name.
  const railRef = typeof b.ref === 'string' && /^[\x21-\x7e]{1,200}$/.test(b.ref) ? b.ref : null;
  if (!eventId || !type || !railRef) return null;

  let amount: Amount | undefined;
  if (typeof b.amount === 'string') {
    try {
      amount = parseAmount(b.amount);
    } catch {
      return null;
    }
  } else if (b.amount !== undefined) {
    // Money never arrives as a JSON number.
    return null;
  }
  if (b.assetId !== undefined && (typeof b.assetId !== 'string' || !/^[A-Z0-9]{2,12}$/.test(b.assetId))) return null;
  const assetId = typeof b.assetId === 'string' ? b.assetId : undefined;

  let payerName: string | undefined;
  if (b.payerName !== undefined && b.payerName !== null) {
    if (typeof b.payerName !== 'string') return null;
    // A control character is never part of a name, and Postgres text cannot hold NUL: read it as a space.
    const name = b.payerName.replace(/\p{Cc}+/gu, ' ').trim();
    if (name.length > PAYER_NAME_MAX) return null;
    if (name) payerName = name;
  }

  const occurredAt = typeof b.occurredAt === 'string' ? new Date(b.occurredAt) : new Date();
  if (Number.isNaN(occurredAt.getTime())) return null;

  return {
    railId,
    eventId,
    type,
    railRef,
    ...(amount !== undefined ? { amount } : {}),
    ...(assetId ? { assetId } : {}),
    occurredAt,
    ...(typeof b.failureCode === 'string' ? { failureCode: b.failureCode } : {}),
    ...(payerName ? { payerName } : {}),
  };
}
