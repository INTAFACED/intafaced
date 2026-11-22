import { createHash } from 'node:crypto';
import type { z } from 'zod';
import { keccak256, toHex, type TypedDataDefinition } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { add, compare, div, formatAmount, mul, parseAmount, sub, ZERO, type Amount } from '@intafaced/ledger-client/money';
import { AuthError, type Principal } from '@intafaced/auth';
import { JurisdictionError } from '@intafaced/contracts/trpc';
import { recurringRuleSchema } from '@intafaced/contracts/trade-recurring-procedures';
import {
  encodeVenueWire,
  isTestVenue,
  VenueRefusalError,
  type PlaceUserOrderIntent,
  type PreparedVenueAction,
  type UserVenueFill,
  type UserVenueMarket,
  type VenueSignature,
  type VenueSubmitOutcome,
} from '@intafaced/venue-contracts';
import { assertBotVerification, type BotVerificationPolicy } from '../algo/bots-verification.js';
import { NO_PAUSES, botOrdersHalted, newBotPausedReason, type PauseSnapshot } from '../copy/platform-pauses.js';
import type { AccountFreezeRead } from '../quant/live-run/ports.js';
import { assertPlaceEligible } from '../spot/place-eligibility.js';
import { engineActor } from '../venue/protections.js';
import { UserVenueDoorError, type UserVenueDoor } from '../venue/user-venue-door.js';
import { floorTo } from '../grid/plan.js';
import type {
  BasketRow,
  OrderStatus,
  RecurringFrequency,
  RecurringOrder,
  RecurringRule,
  RecurringSlot,
  RecurringStatus,
  RecurringStore,
} from './store.js';

/**
 * A RECURRING BUY OF A BASKET ON THE PERSON'S OWN VENUE ACCOUNT (J-copy-bots-otc-16; CB-bots-11, CB-bots-12, CB-bots-13).
 *
 * Money (J-copy-bots-otc-16 "Money"): INTAFACED holds and moves nothing. The person's coins stay on their own venue
 * account. Each slot buys each basket coin as one venue spot order on that account, an IOC limit at the venue's best ask
 * for the coin's share of the slot's amount (weights total 100), sent once under the slot's own key
 * (`recurring:<ruleId>:<slot>:<symbol>`, from which the venue's client order id derives) and signed by the recurring-buy
 * agent key INTAFACED derives for the person on that account, which their wallet approves there (the agent permission:
 * it can place and cancel orders and never withdraw). Before a slot is signed the rule's cap holds it: its amount must be
 * free on the account, as the venue reports it, and with a max investment set, what the slots spent with this one never
 * passes it. Ending the rule converts once: each coin it bought, as far as it is still free on the account, is sold as
 * one venue IOC at the best bid under `recurring:<ruleId>:convert:<symbol>`. Cost and value are read from the venue's
 * fills and book. The ledger posts nothing here: our builder fee rides only on the venue's sells and is posted once per
 * fill by the builder-fee poster (builder-fee-poster.ts), which reads the fills of every order our door stored.
 *
 * Crash points (whose funds are stranded? none, ever): a slot row is written before any of its orders, and each order row
 * before its key signs; the door stores the signed bytes before they are sent, and a re-run of the same slot reads the
 * venue's record by the same key first and re-sends only those bytes. The next slot time moves only from the one this
 * pass read, so one slot runs once. Everything rests or fills on the person's own account, which their wallet controls.
 */

const AGENT_NAME = 'recurring-buys';
/** The recurring-buy agent permission's business key on one venue account. */
export const recurringAgentKey = (owner: string, agentAddress: string) =>
  `recurring-agent:${owner.toLowerCase()}:${agentAddress.toLowerCase()}`;

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const REQUEST_KEY = /^[A-Za-z0-9:._-]{8,120}$/;
const DECIMAL_RE = /^[0-9]+(\.[0-9]+)?$/;
const WEIGHT_RE = /^[0-9]+(\.[0-9]{1,2})?$/;
const HUNDRED = parseAmount('100');
const CENT = parseAmount('0.01');
const LIVE: readonly RecurringStatus[] = ['active', 'suspended_insufficient_funds'];
const OPEN: ReadonlySet<string> = new Set(['pending', 'open', 'partially_filled']);
const PERIOD_MS: Record<RecurringFrequency, number> = { hourly: 3_600_000, daily: 86_400_000, weekly: 604_800_000 };
export const CARD_FUNDING_OFF = 'Card funding needs the card processor, which is switched off in this build. Nothing was saved.';

export type RecurringErrorCode =
  | 'trade.recurring_unavailable'
  | 'trade.recurring_field_invalid'
  | 'trade.recurring_weights_not_100'
  | 'trade.recurring_price_range_inverted'
  | 'trade.recurring_card_funding_off'
  | 'trade.recurring_market_not_found'
  | 'trade.recurring_wallet_required'
  | 'trade.recurring_builder_fee_unapproved'
  | 'trade.recurring_agent_key_unset'
  | 'trade.recurring_request_conflict'
  | 'trade.recurring_not_found'
  | 'trade.recurring_not_signing'
  | 'trade.recurring_ended'
  | 'trade.bots_paused_by_platform';

export class RecurringError extends Error {
  constructor(
    message: string,
    readonly code: RecurringErrorCode,
    readonly data?: Record<string, string>,
  ) {
    super(message);
    this.name = 'RecurringError';
  }
}

/** The person is told once when a slot found too little free quote and the rule was suspended (svc-notify's inbox). */
export interface RecurringNotices {
  suspended(input: { ruleId: string; userId: string; slot: number; asset: string; amount: Amount; free: Amount; at: Date }): Promise<void>;
}
const NO_RECURRING_NOTICES: RecurringNotices = { suspended: async () => {} };

export interface RecurringBuysDeps {
  readonly door: UserVenueDoor;
  readonly store: RecurringStore;
  readonly verification: () => BotVerificationPolicy;
  /** The seed every venue agent key here derives from (TRADE_AGENT_KEY_SEED); blank refuses every recurring buy. */
  readonly keySeed: string;
  readonly liveTier: (userId: string) => Promise<Principal['tier']>;
  /** The person's own freeze, read before each slot and before the sells that end a rule (null: no order is sent). */
  readonly freeze: AccountFreezeRead | null;
  readonly notices?: RecurringNotices;
  readonly platformPauses?: () => Promise<PauseSnapshot>;
  readonly now: () => Date;
}

export type RecurringView = z.output<typeof recurringRuleSchema>;
type RecurringNext = NonNullable<RecurringView['next']>;
const NEXT_TYPED_DATA = recurringRuleSchema.shape.next.unwrap().shape.typedData;

export interface RecurringCreateInput {
  readonly clientRequestId: string;
  readonly owner?: string | null;
  readonly funding: 'venue' | 'card';
  readonly basket: readonly {
    symbol: string;
    weightPct?: string | null;
    lowestPrice?: string | null;
    highestPrice?: string | null;
  }[];
  readonly amount?: string | null;
  readonly frequency: RecurringFrequency;
  readonly maxInvestment?: string | null;
}

function recurringRuleIdFor(userId: string, clientRequestId: string): string {
  if (!REQUEST_KEY.test(clientRequestId)) {
    throw new RecurringError('clientRequestId must be 8 to 120 letters, digits or : . _ -', 'trade.recurring_field_invalid', {
      field: 'clientRequestId',
    });
  }
  const hex = createHash('sha256').update(`bots.recurring\0${userId}\0${clientRequestId}`).digest('hex');
  const variant = ((parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export const slotOrderKey = (ruleId: string, slot: number, symbol: string) => `recurring:${ruleId}:${slot}:${symbol}`;
export const convertOrderKey = (ruleId: string, symbol: string) => `recurring:${ruleId}:convert:${symbol}`;

/** A typed decimal above zero, or a refusal naming the field; blank answers null. */
function optionalAmount(raw: string | null | undefined, field: string): Amount | null {
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (v === '') return null;
  if (!DECIMAL_RE.test(v) || compare(parseAmount(v), ZERO) <= 0) {
    throw new RecurringError(`${field} must be a number above zero`, 'trade.recurring_field_invalid', { field });
  }
  return parseAmount(v);
}

/** A typed decimal above zero; blank or not a number is a refusal naming the field. */
function requiredAmount(raw: string | null | undefined, field: string): Amount {
  const amount = optionalAmount(raw, field);
  if (amount === null) throw new RecurringError(`${field} is required`, 'trade.recurring_field_invalid', { field });
  return amount;
}

/** The venue's typed data, checked to be EIP-712 shaped before the key signs it. */
function isTypedData(value: unknown): value is TypedDataDefinition {
  if (typeof value !== 'object' || value === null) return false;
  return 'domain' in value && 'types' in value && 'primaryType' in value && 'message' in value;
}

/** The rule's fields checked in the order the form shows them; nothing is read from the venue yet. */
function checkRecurringFields(input: RecurringCreateInput) {
  if (input.funding === 'card') throw new RecurringError(CARD_FUNDING_OFF, 'trade.recurring_card_funding_off', { field: 'Funding' });
  const symbols = new Set<string>();
  const rows = input.basket.map((row, i) => {
    const n = i + 1;
    const symbol = row.symbol.trim();
    if (symbols.has(symbol)) {
      throw new RecurringError(`Coin ${n} is already in the basket`, 'trade.recurring_field_invalid', { field: `Coin ${n}` });
    }
    symbols.add(symbol);
    const w = typeof row.weightPct === 'string' ? row.weightPct.trim() : '';
    if (!WEIGHT_RE.test(w) || compare(parseAmount(w), ZERO) <= 0) {
      throw new RecurringError(`Weight ${n} must be a percentage above zero, two decimals at most`, 'trade.recurring_field_invalid', {
        field: `Weight ${n}`,
      });
    }
    const lowestPrice = optionalAmount(row.lowestPrice, `Lowest price ${n}`);
    const highestPrice = optionalAmount(row.highestPrice, `Highest price ${n}`);
    if (lowestPrice !== null && highestPrice !== null && compare(lowestPrice, highestPrice) >= 0) {
      throw new RecurringError(`Coin ${n}: the lowest price must be below the highest price`, 'trade.recurring_price_range_inverted', {
        field: `Lowest price ${n}`,
      });
    }
    return { symbol, weightPct: parseAmount(w), lowestPrice, highestPrice };
  });
  const total = rows.reduce((s, r) => add(s, r.weightPct), ZERO);
  if (compare(total, HUNDRED) !== 0) {
    throw new RecurringError(
      `The weights add up to ${formatAmount(total)}%. They must add up to 100%.`,
      'trade.recurring_weights_not_100',
      { total: formatAmount(total) },
    );
  }
  const amount = requiredAmount(input.amount, 'Amount each time');
  const maxInvestment = optionalAmount(input.maxInvestment, 'Most to invest');
  return { rows, amount, maxInvestment };
}

function requestHash(input: RecurringCreateInput, owner: string): string {
  const body = [
    'venue',
    owner,
    input.funding,
    input.frequency,
    input.amount ?? '',
    input.maxInvestment ?? '',
    ...input.basket.map((b) => [b.symbol, b.weightPct ?? '', b.lowestPrice ?? '', b.highestPrice ?? ''].join('\u0001')),
  ];
  return createHash('sha256').update(body.join('\0')).digest('hex');
}

const sumOf = (xs: readonly Amount[]) => xs.reduce((a, b) => add(a, b), ZERO);
const sameOwner = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export class RecurringBuys {
  /** Rules this process is driving now, so a save, a change, an end and the tick never act on one rule at once. */
  private readonly driving = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: RecurringBuysDeps) {}

  /** The recurring-buy agent key INTAFACED holds for one person on one venue account. Derived, never stored. */
  agentKey(userId: string, owner: string): PrivateKeyAccount {
    if (this.deps.keySeed.trim() === '') {
      throw new RecurringError(
        'No key seed is set for the recurring-buy agent key (owner value blank), so no recurring buy runs on the venue',
        'trade.recurring_agent_key_unset',
      );
    }
    return privateKeyToAccount(
      keccak256(toHex(`intafaced recurring buy key\u0000${this.deps.keySeed}\u0000${userId}\u0000${owner.toLowerCase()}`)),
    );
  }

  private pauses(): Promise<PauseSnapshot> {
    return this.deps.platformPauses ? this.deps.platformPauses() : Promise.resolve(NO_PAUSES);
  }

  private async locked<T>(ruleId: string, f: () => Promise<T>): Promise<T> {
    const before = this.driving.get(ruleId) ?? Promise.resolve();
    const run = before.then(f, f);
    const settled = run.catch(() => undefined);
    this.driving.set(ruleId, settled);
    try {
      return await run;
    } finally {
      if (this.driving.get(ruleId) === settled) this.driving.delete(ruleId);
    }
  }

  private async account(owner: string) {
    const venue = await this.deps.door.venue();
    return { venue, account: await this.deps.door.account(owner) };
  }

  private async spotMarkets(owner: string): Promise<readonly UserVenueMarket[]> {
    const { venue, account } = await this.account(owner);
    return (await venue.markets(account)).value.filter((m) => m.kind === 'spot' && (m.status === null || m.status === 'trading'));
  }

  private async best(symbol: string): Promise<{ bid: Amount | null; ask: Amount | null }> {
    const venue = await this.deps.door.venue();
    const book = (await venue.book(symbol, 1)).value;
    return { bid: book.bids[0]?.price ?? null, ask: book.asks[0]?.price ?? null };
  }

  private async free(owner: string, asset: string): Promise<Amount> {
    const { venue, account } = await this.account(owner);
    return (await venue.balances(account)).value.find((b) => b.asset === asset)?.free ?? ZERO;
  }

  async create(principal: Principal, input: RecurringCreateInput, region: string): Promise<RecurringView> {
    assertBotVerification(this.deps.verification(), principal.tier);
    const ruleId = recurringRuleIdFor(principal.userId, input.clientRequestId);
    const owner = typeof input.owner === 'string' ? input.owner.trim().toLowerCase() : '';
    const hash = requestHash(input, owner);
    const already = await this.deps.store.find(ruleId);
    if (already) {
      if (already.requestHash !== hash)
        throw new RecurringError('This request key already made a different recurring buy', 'trade.recurring_request_conflict');
      return this.locked(ruleId, async () => this.view(principal, await this.advance(principal, already)));
    }
    const { rows, amount, maxInvestment } = checkRecurringFields(input);
    if (!ADDRESS_RE.test(owner)) {
      throw new RecurringError(
        'Connect your wallet: the recurring buy trades on your own venue account',
        'trade.recurring_wallet_required',
        {
          field: 'Wallet',
        },
      );
    }
    const venue = await this.deps.door.venue();
    const markets = await this.spotMarkets(owner);
    const basket: BasketRow[] = [];
    let quoteAsset: string | null = null;
    for (const [i, row] of rows.entries()) {
      const market = markets.find((m) => m.symbol === row.symbol);
      if (!market) {
        throw new RecurringError(
          `Coin ${i + 1}: ${row.symbol} is not an open spot market on ${venue.venue.displayName}`,
          'trade.recurring_market_not_found',
          { field: `Coin ${i + 1}` },
        );
      }
      if (quoteAsset !== null && market.quoteAsset !== quoteAsset) {
        throw new RecurringError(`Coin ${i + 1}: every coin is bought with ${quoteAsset}`, 'trade.recurring_market_not_found', {
          field: `Coin ${i + 1}`,
        });
      }
      quoteAsset = market.quoteAsset;
      const pausedWhy = newBotPausedReason(await this.pauses(), 'dca', market.symbol);
      if (pausedWhy) throw new RecurringError(pausedWhy, 'trade.bots_paused_by_platform');
      basket.push({ ...row, baseAsset: market.baseAsset });
    }
    const head = basket[0];
    if (!head || quoteAsset === null)
      throw new RecurringError('Add a coin to the basket', 'trade.recurring_field_invalid', { field: 'Coin 1' });
    // Ending the rule sells what it bought, and every venue sell carries our builder fee: it must be approved first.
    await this.assertBuilderFeeApproved(owner, head.symbol);
    const agent = this.agentKey(principal.userId, owner);
    const at = this.deps.now();
    const rule: RecurringRule = {
      ruleId,
      userId: principal.userId,
      clientRequestId: input.clientRequestId,
      requestHash: hash,
      venueId: venue.venue.id,
      owner,
      agentAddress: agent.address.toLowerCase(),
      region,
      quoteAsset,
      basket,
      amount,
      frequency: input.frequency,
      maxInvestment,
      status: 'signing',
      statusReason: null,
      nextRunAt: null,
      createdAt: at,
      updatedAt: at,
    };
    const saved = await this.deps.store.insertOnce(rule);
    if (!saved.created && saved.rule.requestHash !== hash) {
      throw new RecurringError('This request key already made a different recurring buy', 'trade.recurring_request_conflict');
    }
    return this.locked(ruleId, async () => this.view(principal, await this.advance(principal, saved.rule)));
  }

  private async assertBuilderFeeApproved(owner: string, symbol: string): Promise<void> {
    const { venue, account } = await this.account(owner);
    const fee = await this.deps.door.builderFeeFor(symbol, 'sell', 'spot');
    const status = await this.deps.door.status();
    const builder = 'builder' in status ? status.builder : null;
    if (fee === null || !builder) {
      throw new RecurringError(
        'Our builder fee is not published, so ending the recurring buy could not sell what it bought',
        'trade.recurring_builder_fee_unapproved',
      );
    }
    if (!fee.carries) return;
    const approved = (await venue.builderFeeApproval(account, builder.address)).value;
    if (compare(approved, fee.feeBps) < 0) {
      throw new RecurringError(
        `Approve our builder fee on your ${venue.venue.displayName} account first: ending the recurring buy sells what it bought`,
        'trade.recurring_builder_fee_unapproved',
        { feeBps: formatAmount(fee.feeBps) },
      );
    }
  }

  private async permitted(rule: RecurringRule): Promise<boolean> {
    const { venue, account } = await this.account(rule.owner);
    const listed = (await venue.agents(account)).value.find((a) => a.address.toLowerCase() === rule.agentAddress);
    return !!listed && (listed.validUntil === null || listed.validUntil.getTime() > this.deps.now().getTime());
  }

  private async stored(ruleId: string): Promise<RecurringRule> {
    const rule = await this.deps.store.find(ruleId);
    if (!rule) throw new RecurringError(`recurring buy ${ruleId} not found`, 'trade.recurring_not_found');
    return rule;
  }

  /** A signing rule becomes active once the venue lists its agent permission; its first slot is due at once. */
  private async advance(principal: Principal, start: RecurringRule): Promise<RecurringRule> {
    let rule = start;
    if (rule.status === 'signing') {
      if (!(await this.permitted(rule))) return rule;
      const at = this.deps.now();
      if (await this.deps.store.setStatus({ ruleId: rule.ruleId, status: 'active', reason: null, at, from: ['signing'] })) {
        await this.deps.store.setNextRun({ ruleId: rule.ruleId, from: null, to: at, at });
      }
      rule = await this.stored(rule.ruleId);
    }
    if (LIVE.includes(rule.status)) await this.step(rule, principal.tier);
    return this.stored(rule.ruleId);
  }

  async submitPermission(
    principal: Principal,
    sent: { ruleId: string; actionKey: string; signature: VenueSignature },
  ): Promise<RecurringView> {
    const rule = await this.own(principal, sent.ruleId);
    if (sent.actionKey !== recurringAgentKey(rule.owner, rule.agentAddress)) {
      throw new RecurringError(
        `${JSON.stringify(sent.actionKey)} is not this recurring buy's agent permission`,
        'trade.recurring_not_found',
      );
    }
    if (rule.status !== 'signing' && !(await this.permitted(rule))) {
      throw new RecurringError(
        `The recurring buy is ${rule.status}; its agent permission is no longer asked for`,
        'trade.recurring_not_signing',
      );
    }
    if (this.deps.freeze && (await this.deps.freeze.frozen(rule.userId))) {
      throw new RecurringError('Your account is frozen, so no agent permission is sent', 'trade.recurring_not_signing');
    }
    const answer = await this.deps.door.submit(principal, sent.actionKey, sent.signature);
    if (answer.outcome.definite && !answer.outcome.accepted) {
      throw new RecurringError(`The venue refused the agent permission: ${answer.outcome.refusal.detail}`, 'trade.recurring_not_signing');
    }
    return this.locked(rule.ruleId, async () => this.view(principal, await this.advance(principal, await this.stored(rule.ruleId))));
  }

  private async own(principal: Principal, ruleIdRaw: string): Promise<RecurringRule> {
    const rule = await this.deps.store.find(String(ruleIdRaw ?? '').trim());
    if (!rule || rule.userId !== principal.userId) throw new RecurringError('Recurring buy not found', 'trade.recurring_not_found');
    return rule;
  }

  async get(principal: Principal, ruleId: string): Promise<RecurringView> {
    return this.view(principal, await this.own(principal, ruleId));
  }

  async list(principal: Principal): Promise<readonly RecurringView[]> {
    const out: RecurringView[] = [];
    for (const rule of await this.deps.store.listForUser(principal.userId)) out.push(await this.view(principal, rule, false));
    return out;
  }

  /** The next slots spend the new amount; a slot already written keeps its own. A blank maximum is Not set. */
  async update(principal: Principal, input: { ruleId: string; amount?: string | null; maxInvestment?: string | null }) {
    assertBotVerification(this.deps.verification(), principal.tier);
    const rule = await this.own(principal, input.ruleId);
    const amount = requiredAmount(input.amount, 'Amount each time');
    const maxInvestment = optionalAmount(input.maxInvestment, 'Most to invest');
    return this.locked(rule.ruleId, async () => {
      const now = await this.stored(rule.ruleId);
      if (now.status === 'terminated' || now.status === 'completed') {
        throw new RecurringError('This recurring buy has ended; nothing was changed', 'trade.recurring_ended');
      }
      await this.deps.store.setTerms(rule.ruleId, { amount, maxInvestment }, this.deps.now());
      return this.view(principal, await this.stored(rule.ruleId));
    });
  }

  /** No slot runs again; each coin bought is sold back to the quote once, as one venue order under its own key. */
  async terminate(principal: Principal, ruleId: string): Promise<RecurringView> {
    assertBotVerification(this.deps.verification(), principal.tier);
    const rule = await this.own(principal, ruleId);
    return this.locked(rule.ruleId, async () => {
      const at = this.deps.now();
      await this.deps.store.setStatus({
        ruleId: rule.ruleId,
        status: 'terminated',
        reason: 'user_end',
        at,
        from: ['signing', 'active', 'suspended_insufficient_funds', 'completed'],
      });
      const now = await this.stored(rule.ruleId);
      if (now.nextRunAt !== null) await this.deps.store.setNextRun({ ruleId: rule.ruleId, from: now.nextRunAt, to: null, at });
      await this.convert(now, principal.tier);
      return this.view(principal, await this.stored(rule.ruleId));
    });
  }

  /** Every live rule, once: read its open orders, resume a suspended one whose funds arrived, run a slot that is due. */
  async tickAll(): Promise<void> {
    for (const rule of await this.deps.store.live()) {
      try {
        const tier = await this.deps.liveTier(rule.userId);
        await this.locked(rule.ruleId, async () => {
          const now = await this.deps.store.find(rule.ruleId);
          if (now && LIVE.includes(now.status)) await this.step(now, tier);
        });
      } catch (err) {
        process.stderr.write(
          `${JSON.stringify({ level: 'warn', msg: 'trade.recurring.tick_failed', rule: rule.ruleId, message: err instanceof Error ? err.message : String(err) })}\n`,
        );
      }
    }
  }

  // ── one pass ────────────────────────────────────────────────────────────────────────────────────────────────────

  private async step(rule0: RecurringRule, tier: Principal['tier']): Promise<void> {
    const actor = engineActor(rule0.userId, tier);
    await this.readOrders(rule0, actor);
    let rule = rule0;
    const at = this.deps.now();
    // Funds arriving resume a suspended rule, once: the status moves only from suspended.
    if (rule.status === 'suspended_insufficient_funds') {
      if (compare(await this.free(rule.owner, rule.quoteAsset), rule.amount) < 0) return;
      await this.deps.store.setStatus({ ruleId: rule.ruleId, status: 'active', reason: null, at, from: ['suspended_insufficient_funds'] });
      rule = await this.stored(rule.ruleId);
    }
    const slots = await this.deps.store.slots(rule.ruleId);
    const pending = slots.find((s) => s.outcome === 'pending');
    if (pending) return this.runSlot(rule, actor, pending);
    if (rule.nextRunAt === null || rule.nextRunAt.getTime() > at.getTime()) return;
    // The slot is moved on first, only from the time this pass read, so one due slot is written once.
    const next = new Date(rule.nextRunAt.getTime() + PERIOD_MS[rule.frequency]);
    if (!(await this.deps.store.setNextRun({ ruleId: rule.ruleId, from: rule.nextRunAt, to: next, at }))) return;
    const slot = await this.deps.store.insertSlot({
      ruleId: rule.ruleId,
      slot: slots.length,
      amount: rule.amount,
      outcome: 'pending',
      at,
    });
    await this.runSlot(await this.stored(rule.ruleId), actor, slot);
  }

  private async runSlot(rule: RecurringRule, actor: Principal, slot: RecurringSlot): Promise<void> {
    const at = this.deps.now();
    const pauses = await this.pauses();
    if (!(await this.mayTrade(rule, actor.tier)) || rule.basket.some((b) => botOrdersHalted(pauses, b.symbol))) {
      await this.deps.store.setSlotOutcome(rule.ruleId, slot.slot, 'skipped_not_permitted');
      return;
    }
    const orders = await this.deps.store.orders(rule.ruleId);
    const mine = orders.filter((o) => o.slot === slot.slot);
    // The max investment: a slot that would take what the rule spent past it is not run, and the rule completes.
    if (rule.maxInvestment !== null && mine.length === 0) {
      const spent = sumOf(orders.filter((o) => o.kind === 'buy').map((o) => this.cost(rule, o)));
      if (compare(add(spent, slot.amount), rule.maxInvestment) > 0) {
        await this.deps.store.setSlotOutcome(rule.ruleId, slot.slot, 'skipped_not_permitted');
        await this.deps.store.setStatus({ ruleId: rule.ruleId, status: 'completed', reason: 'max_investment_reached', at, from: LIVE });
        await this.deps.store.setNextRun({ ruleId: rule.ruleId, from: rule.nextRunAt, to: null, at });
        return;
      }
    }
    // The rule's cap: the slot's whole amount must be free on the person's own account now, as the venue reports it.
    if (mine.length === 0) {
      const free = await this.free(rule.owner, rule.quoteAsset);
      if (compare(free, slot.amount) < 0) {
        await this.deps.store.setSlotOutcome(rule.ruleId, slot.slot, 'skipped_insufficient_funds');
        if (
          await this.deps.store.setStatus({
            ruleId: rule.ruleId,
            status: 'suspended_insufficient_funds',
            reason: 'insufficient_funds',
            at,
            from: ['active'],
          })
        ) {
          await (this.deps.notices ?? NO_RECURRING_NOTICES).suspended({
            ruleId: rule.ruleId,
            userId: rule.userId,
            slot: slot.slot,
            asset: rule.quoteAsset,
            amount: slot.amount,
            free,
            at,
          });
        }
        return;
      }
    }
    const markets = await this.spotMarkets(rule.owner);
    for (const row of rule.basket) {
      const key = slotOrderKey(rule.ruleId, slot.slot, row.symbol);
      if (mine.some((o) => o.orderKey === key && o.status !== 'open')) continue;
      const market = markets.find((m) => m.symbol === row.symbol);
      const share = div(mul(slot.amount, row.weightPct, 'floor'), HUNDRED, 'floor');
      const { ask } = await this.best(row.symbol);
      const inRange =
        ask !== null &&
        (row.lowestPrice === null || compare(ask, row.lowestPrice) >= 0) &&
        (row.highestPrice === null || compare(ask, row.highestPrice) <= 0);
      const qty = market && ask !== null ? floorTo(div(share, ask, 'floor'), market.lotSize) : ZERO;
      const status: OrderStatus = !inRange ? 'skipped_price_range' : compare(qty, ZERO) <= 0 ? 'refused' : 'open';
      const order = await this.deps.store.insertOrder({
        orderKey: key,
        ruleId: rule.ruleId,
        slot: slot.slot,
        kind: 'buy',
        symbol: row.symbol,
        price: ask ?? ZERO,
        qty,
        status,
        filled: ZERO,
        quote: ZERO,
        venueFee: ZERO,
        builderFee: ZERO,
        feeAsset: null,
        placedAt: at,
        closedAt: status === 'open' ? null : at,
      });
      if (order.status !== 'open') continue;
      const sent = await this.send(rule, actor, {
        kind: 'place_order',
        symbol: order.symbol,
        side: 'buy',
        type: 'limit',
        amount: order.qty,
        price: order.price,
        timeInForce: 'IOC',
        reduceOnly: false,
        clientOrderKey: order.orderKey,
        builderFee: null,
      });
      if (sent === 'refused') await this.deps.store.updateOrder({ ...order, status: 'refused', closedAt: this.deps.now() });
    }
    await this.readOrders(rule, actor);
    await this.deps.store.setSlotOutcome(rule.ruleId, slot.slot, 'bought');
  }

  /** What one buy cost in the quote: its fills' quote and any fee the venue charged in the quote. */
  private cost(rule: RecurringRule, o: RecurringOrder): Amount {
    return o.feeAsset === rule.quoteAsset ? add(o.quote, add(o.venueFee, o.builderFee)) : o.quote;
  }

  /** What one buy put on the account in the base: what filled, less any fee charged in the base. */
  private received(rule: RecurringRule, o: RecurringOrder): Amount {
    const row = rule.basket.find((b) => b.symbol === o.symbol);
    return row && o.feeAsset === row.baseAsset ? sub(o.filled, add(o.venueFee, o.builderFee)) : o.filled;
  }

  private async convert(rule: RecurringRule, tier: Principal['tier']): Promise<void> {
    const actor = engineActor(rule.userId, tier);
    await this.readOrders(rule, actor);
    const orders = await this.deps.store.orders(rule.ruleId);
    const markets = await this.spotMarkets(rule.owner);
    const at = this.deps.now();
    // The same gate every slot passes: no sell is sent for a frozen or ineligible person, or on a coin under a platform
    // bot halt. A sell not yet placed is recorded refused, so ending the rule sends nothing for it, now or later.
    const mayTrade = await this.mayTrade(rule, tier);
    const pauses = await this.pauses();
    for (const row of rule.basket) {
      const key = convertOrderKey(rule.ruleId, row.symbol);
      let order = orders.find((o) => o.orderKey === key);
      if (order && order.status !== 'open') continue;
      const blocked = !mayTrade || botOrdersHalted(pauses, row.symbol);
      // A sell already placed whose answer is not read yet is left for readOrders; it is never sent again while blocked.
      if (order && blocked) continue;
      if (!order) {
        const bought = sumOf(orders.filter((o) => o.kind === 'buy' && o.symbol === row.symbol).map((o) => this.received(rule, o)));
        const market = markets.find((m) => m.symbol === row.symbol);
        const free = await this.free(rule.owner, row.baseAsset);
        const held = compare(bought, free) <= 0 ? bought : free;
        const qty = market ? floorTo(held, market.lotSize) : ZERO;
        if (compare(qty, ZERO) <= 0) continue;
        const { bid } = await this.best(row.symbol);
        order = await this.deps.store.insertOrder({
          orderKey: key,
          ruleId: rule.ruleId,
          slot: null,
          kind: 'convert',
          symbol: row.symbol,
          price: bid ?? ZERO,
          qty,
          status: blocked || bid === null ? 'refused' : 'open',
          filled: ZERO,
          quote: ZERO,
          venueFee: ZERO,
          builderFee: ZERO,
          feeAsset: null,
          placedAt: at,
          closedAt: blocked || bid === null ? at : null,
        });
        if (order.status !== 'open') continue;
      }
      const sent = await this.send(rule, actor, {
        kind: 'place_order',
        symbol: order.symbol,
        side: 'sell',
        type: 'limit',
        amount: order.qty,
        price: order.price,
        timeInForce: 'IOC',
        reduceOnly: false,
        clientOrderKey: order.orderKey,
        builderFee: null,
      });
      if (sent === 'refused') await this.deps.store.updateOrder({ ...order, status: 'refused', closedAt: this.deps.now() });
    }
    await this.readOrders(rule, actor);
  }

  private async fillsOf(rule: RecurringRule, actor: Principal, orderKey: string): Promise<UserVenueFill[]> {
    const cloid = (await this.deps.door.stored(actor, orderKey))?.prepared.venueClientOrderId;
    if (!cloid) return [];
    const { venue, account } = await this.account(rule.owner);
    const fills = (await venue.fills(account, rule.createdAt)).value;
    return fills.filter((f) => f.venueClientOrderId?.toLowerCase() === cloid.toLowerCase());
  }

  /** Each open order as the venue reports it now; a closed one keeps its fills' quote and fees. */
  private async readOrders(rule: RecurringRule, actor: Principal): Promise<void> {
    for (const o of (await this.deps.store.orders(rule.ruleId)).filter((x) => x.status === 'open')) {
      let read;
      try {
        read = await this.deps.door.orderByKey(actor, o.orderKey);
      } catch (err) {
        if (err instanceof UserVenueDoorError && err.code === 'trade.venue_action_unknown') continue;
        throw err;
      }
      if (read.state === 'refused') {
        await this.deps.store.updateOrder({ ...o, status: 'refused', closedAt: this.deps.now() });
        continue;
      }
      if (read.state !== 'accepted' || !read.order) continue;
      const v = read.order;
      if (OPEN.has(v.status)) continue;
      const fills = await this.fillsOf(rule, actor, o.orderKey);
      const whole = v.status === 'filled';
      await this.deps.store.updateOrder({
        ...o,
        status: whole ? 'filled' : compare(v.filled, ZERO) > 0 ? 'partial' : 'cancelled',
        filled: v.filled,
        quote: sumOf(fills.map((f) => mul(f.price, f.amount, 'floor'))),
        venueFee: sumOf(fills.map((f) => f.venueFee)),
        builderFee: sumOf(fills.map((f) => f.builderFee)),
        feeAsset: fills[0]?.feeAsset ?? null,
        closedAt: this.deps.now(),
      });
    }
  }

  private async mayTrade(rule: RecurringRule, tier: Principal['tier']): Promise<boolean> {
    if (!this.deps.freeze || (await this.deps.freeze.frozen(rule.userId))) return false;
    try {
      assertPlaceEligible({ tier, region: rule.region });
      return true;
    } catch (err) {
      if (err instanceof AuthError || err instanceof JurisdictionError) return false;
      throw err;
    }
  }

  /** One order on the person's venue account signed by the recurring-buy key. `pending` when the venue has not answered. */
  private async send(rule: RecurringRule, actor: Principal, intent: PlaceUserOrderIntent): Promise<'done' | 'refused' | 'pending'> {
    const signer = this.agentKey(rule.userId, rule.owner);
    if (signer.address.toLowerCase() !== rule.agentAddress)
      throw new Error(`the recurring-buy key of rule ${rule.ruleId} does not derive to its address`);
    const key = intent.clientOrderKey;
    const stored = await this.deps.door.stored(actor, key);
    let answer: { actionKey: string; prepared: PreparedVenueAction; signed: boolean; lastOutcome: VenueSubmitOutcome | null };
    try {
      answer = stored
        ? { actionKey: stored.businessKey, prepared: stored.prepared, signed: stored.signature !== null, lastOutcome: stored.lastOutcome }
        : await this.deps.door.prepare(actor, {
            owner: rule.owner,
            signer: { role: 'agent', address: rule.agentAddress },
            intent,
            actionKey: key,
          });
    } catch (err) {
      if (err instanceof VenueRefusalError || err instanceof AuthError || err instanceof UserVenueDoorError) return 'refused';
      throw err;
    }
    // The invariant: every order names the person's own account and the recurring-buy key, nothing else.
    if (
      !sameOwner(answer.prepared.account.owner, rule.owner) ||
      answer.prepared.account.subAccount !== null ||
      answer.prepared.signer.role !== 'agent'
    ) {
      throw new Error(`order ${key} was prepared outside rule ${rule.ruleId}'s account; nothing is signed`);
    }
    if (answer.signed && answer.lastOutcome?.definite) return answer.lastOutcome.accepted ? 'done' : 'refused';
    if (!isTypedData(answer.prepared.typedData)) throw new Error(`order ${key} came back with no typed data to sign`);
    const signature = await signer.signTypedData(answer.prepared.typedData);
    let outcome: VenueSubmitOutcome;
    try {
      outcome = (
        await this.deps.door.submit(actor, answer.actionKey, { digest: answer.prepared.digest, signature, signedBy: rule.agentAddress })
      ).outcome;
    } catch (err) {
      if (err instanceof VenueRefusalError) return err.refusal.code === 'venue_down' ? 'pending' : 'refused';
      throw err;
    }
    if (!outcome.definite) return 'pending';
    return outcome.accepted ? 'done' : 'refused';
  }

  // ── the view ────────────────────────────────────────────────────────────────────────────────────────────────────

  private async view(principal: Principal, rule: RecurringRule, withNext = true): Promise<RecurringView> {
    const venue = await this.deps.door.venue();
    let next: RecurringNext | null = null;
    if (rule.status === 'signing' && withNext) {
      const answer = await this.deps.door.prepare(principal, {
        owner: rule.owner,
        signer: { role: 'owner', address: rule.owner },
        intent: { kind: 'approve_agent', agentAddress: rule.agentAddress, agentName: AGENT_NAME, validUntil: null },
        actionKey: recurringAgentKey(rule.owner, rule.agentAddress),
      });
      next = {
        actionKey: answer.actionKey,
        digest: answer.prepared.digest,
        typedData: NEXT_TYPED_DATA.parse(encodeVenueWire(answer.prepared.typedData)),
      };
    }
    const slots = await this.deps.store.slots(rule.ruleId);
    const orders = await this.deps.store.orders(rule.ruleId);
    const buys = orders.filter((o) => o.kind === 'buy');
    const conversions = orders.filter((o) => o.kind === 'convert');
    const cost = sumOf(buys.map((o) => this.cost(rule, o)));
    // The coins the rule holds: what its buys received, less what its conversions sold.
    let value: Amount | null = ZERO;
    for (const row of rule.basket) {
      const held = sub(
        sumOf(buys.filter((o) => o.symbol === row.symbol).map((o) => this.received(rule, o))),
        sumOf(conversions.filter((o) => o.symbol === row.symbol).map((o) => o.filled)),
      );
      if (compare(held, ZERO) <= 0 || value === null) continue;
      const { bid, ask } = await this.best(row.symbol);
      // The venue's mark: the mid of its best bid and ask. Without both there is no mark, and no value is guessed.
      value = bid !== null && ask !== null ? add(value, mul(held, div(add(bid, ask), parseAmount('2'), 'half-up'), 'floor')) : null;
    }
    if (conversions.length > 0 && value !== null)
      value = add(
        value,
        sumOf(conversions.map((o) => sub(o.quote, o.feeAsset === rule.quoteAsset ? add(o.venueFee, o.builderFee) : ZERO))),
      );
    // The profit percentage, to two decimals, only with a value to measure it by.
    const profitPct =
      value !== null && compare(cost, ZERO) > 0 ? formatAmount(floorTo(div(mul(sub(value, cost), HUNDRED), cost, 'half-up'), CENT)) : null;
    return {
      ruleId: rule.ruleId,
      clientRequestId: rule.clientRequestId,
      status: rule.status,
      statusReason: rule.statusReason,
      quoteAsset: rule.quoteAsset,
      amount: formatAmount(rule.amount),
      frequency: rule.frequency,
      maxInvestment: rule.maxInvestment === null ? null : formatAmount(rule.maxInvestment),
      funding: 'venue',
      basket: rule.basket.map((b) => ({
        symbol: b.symbol,
        baseAsset: b.baseAsset,
        weightPct: formatAmount(b.weightPct),
        lowestPrice: b.lowestPrice === null ? null : formatAmount(b.lowestPrice),
        highestPrice: b.highestPrice === null ? null : formatAmount(b.highestPrice),
      })),
      nextRunAt: rule.nextRunAt?.toISOString() ?? null,
      createdAt: rule.createdAt.toISOString(),
      slots: slots.map((s) => {
        const mine = buys.filter((o) => o.slot === s.slot);
        return {
          slot: s.slot,
          at: s.at.toISOString(),
          amount: formatAmount(s.amount),
          outcome: s.outcome,
          spent: formatAmount(sumOf(mine.map((o) => this.cost(rule, o)))),
          orders: mine.map((o) => ({
            orderKey: o.orderKey,
            symbol: o.symbol,
            status: o.status,
            qty: formatAmount(o.qty),
            filled: formatAmount(o.filled),
            spent: formatAmount(this.cost(rule, o)),
          })),
        };
      }),
      conversions: conversions.map((o) => ({
        orderKey: o.orderKey,
        symbol: o.symbol,
        status: o.status === 'skipped_price_range' ? 'refused' : o.status,
        qty: formatAmount(o.qty),
        filled: formatAmount(o.filled),
        received: formatAmount(o.quote),
      })),
      result: { cost: formatAmount(cost), value: value === null ? null : formatAmount(value), profitPct },
      venue: {
        id: rule.venueId,
        name: venue.venue.displayName,
        test: isTestVenue(venue.venue),
        owner: rule.owner,
        agentAddress: rule.agentAddress,
        agentName: AGENT_NAME,
      },
      next,
    };
  }
}
