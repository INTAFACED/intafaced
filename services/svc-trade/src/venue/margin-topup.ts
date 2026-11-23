import type { z } from 'zod';
import { keccak256, toHex, type TypedDataDefinition } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { add, compare, formatAmount, parseAmount, SCALE, ZERO, type Amount } from '@intafaced/ledger-client/money';
import { AuthError, type Principal } from '@intafaced/auth';
import type { marginTopUpViewSchema } from '@intafaced/contracts/trade-margin-topup-procedures';
import {
  isTestVenue,
  VenueRefusalError,
  type UpdateIsolatedMarginIntent,
  type UserVenueAccount,
  type UserVenuePosition,
  type VenueSubmitOutcome,
} from '@intafaced/venue-contracts';
import type { AccountFreezeRead } from '../quant/live-run/ports.js';
import type { MarginTopUpStore, TopUp, TopUpPosition, TopUpRule } from './margin-topup-store.js';
import { engineActor } from './protections.js';
import { UserVenueDoorError, type UserVenueDoor } from './user-venue-door.js';

/**
 * AUTO TOP-UP OF AN ISOLATED POSITION'S MARGIN ON THE PERSON'S OWN VENUE ACCOUNT (J-derivatives-06 #4; D-margin-04).
 *
 * Money (J-derivatives-06 "Money"): INTAFACED holds and moves nothing, and the ledger posts nothing. The position and its
 * margin are the venue's. A top-up is one venue margin change (`update_isolated_margin`, add) that moves the person's own
 * free collateral into their own position's margin, for the amount the person set, signed by the margin top-up agent key
 * INTAFACED derives for them on that account, which their wallet approves on the venue (the agent permission: it can
 * never withdraw or approve anything). It is sent once each time the position's margin level falls to the level the
 * person set: the level is the position's margin with its unrealised result as a percent of the venue's maintenance
 * margin, read from the venue's own figures, and a rule that added is armed again only once the level was seen above its
 * level again. Two caps hold it, both counted before the key signs: the rule's own (what it added since it was turned
 * on) and the permission's own (what the key added in all on the account, set by the person before their wallet approves
 * the key). A fall that would pass either adds nothing and says which.
 *
 * Crash points (whose funds are stranded? none, ever): the funds only ever sit on the person's own venue account. A fall
 * is claimed in one transaction (both counts, the rule marked sending, the top-up row with its key
 * `margin:<owner>:<symbol>:add:auto.<n>`) before anything is signed; the door stores the prepared change and then its
 * signature before it is sent. A worker that stops anywhere after the claim leaves the rule sending: the next pass reads
 * the door's stored action under the same key and sends those same bytes, which the venue applies once. A definite
 * refusal gives the amount back to both counts; with no definite answer the rule stays sending and nothing new starts.
 */

export const MARGIN_TOPUP_AGENT_NAME = 'margin-top-up';
/** The margin top-up agent permission's business key on one venue account. */
export const marginTopUpAgentKey = (owner: string, agentAddress: string) =>
  `margin-topup-agent:${owner.toLowerCase()}:${agentAddress.toLowerCase()}`;
/** The business key of a position's n-th top-up: the app's own margin changes use the same `margin:` family with a draft id. */
export const topUpChangeKey = (owner: string, symbol: string, n: number) =>
  `margin:${owner.toLowerCase()}:${symbol.toLowerCase().replace(/[^a-z0-9.-]/g, '-')}:add:auto.${n}`;

const DECIMAL_RE = /^[0-9]+(\.[0-9]+)?$/;
const HUNDRED = 100n;
const CENT = SCALE / 100n;
const TOPUPS_SHOWN = 50;

export type MarginTopUpErrorCode =
  | 'trade.margin_topup_unavailable'
  | 'trade.margin_topup_agent_key_unset'
  | 'trade.margin_topup_field_invalid'
  | 'trade.margin_topup_amount_above_cap'
  | 'trade.margin_topup_no_position'
  | 'trade.margin_topup_level_unmeasured'
  | 'trade.margin_topup_level_reached'
  | 'trade.margin_topup_permission_missing';

export class MarginTopUpError extends Error {
  constructor(
    message: string,
    readonly code: MarginTopUpErrorCode,
  ) {
    super(message);
    this.name = 'MarginTopUpError';
  }
}

export interface MarginTopUpsDeps {
  readonly door: UserVenueDoor;
  readonly store: MarginTopUpStore;
  /** `TRADE_AGENT_KEY_SEED`: the owner's secret the margin top-up key derives from. Blank refuses every top-up. */
  readonly keySeed: string;
  /** The person's own freeze (J-wallet-13), read before each top-up. Null, or a read that fails, sends nothing. */
  readonly freeze: AccountFreezeRead | null;
  readonly now: () => Date;
}

export type MarginTopUpView = z.output<typeof marginTopUpViewSchema>;

function positive(raw: string | null | undefined, field: string): Amount {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text === '') throw new MarginTopUpError(`Enter ${field}. Nothing was saved.`, 'trade.margin_topup_field_invalid');
  if (!DECIMAL_RE.test(text) || text.replace(/^[0-9]+\.?/, '').length > 18)
    throw new MarginTopUpError(`${field} must be a plain number above zero. Nothing was saved.`, 'trade.margin_topup_field_invalid');
  const amount = parseAmount(text);
  if (compare(amount, ZERO) <= 0)
    throw new MarginTopUpError(`${field} must be above zero. Nothing was saved.`, 'trade.margin_topup_field_invalid');
  return amount;
}

/** The position's equity as the venue's figures give it: its margin with its unrealised result. */
const equityOf = (p: UserVenuePosition): Amount => add(p.margin, p.unrealisedPnl);

/**
 * The margin level in percent, cut to two places and never rounded up: equity over the venue's maintenance margin. Null
 * where the venue publishes no maintenance margin (or none above zero): never a guess. Zero at or below zero equity.
 */
export function marginLevelOf(p: UserVenuePosition): Amount | null {
  const maintenance = p.maintenanceMargin?.known ? p.maintenanceMargin.value : null;
  if (maintenance === null || compare(maintenance, ZERO) <= 0) return null;
  const equity = equityOf(p);
  if (compare(equity, ZERO) <= 0) return ZERO;
  const level = (equity * HUNDRED * SCALE) / maintenance;
  return level - (level % CENT);
}

/** True when the position's margin level is at or below `level` percent, judged on the venue's exact figures (no rounding). */
export function atOrBelow(p: UserVenuePosition, level: Amount): boolean | null {
  const maintenance = p.maintenanceMargin?.known ? p.maintenanceMargin.value : null;
  if (maintenance === null || compare(maintenance, ZERO) <= 0) return null;
  return equityOf(p) * HUNDRED * SCALE <= level * maintenance;
}

export class VenueMarginTopUps {
  constructor(private readonly deps: MarginTopUpsDeps) {}

  /** The venue agent key INTAFACED holds for one person's margin top-ups on one venue account. Derived, never stored. */
  agentKey(userId: string, owner: string): PrivateKeyAccount {
    if (this.deps.keySeed.trim() === '') {
      throw new MarginTopUpError(
        'No key seed is set for the margin top-up agent key (owner value blank), so no auto top-up runs',
        'trade.margin_topup_agent_key_unset',
      );
    }
    return privateKeyToAccount(
      keccak256(toHex(`intafaced margin top-up key\u0000${this.deps.keySeed}\u0000${userId}\u0000${owner.toLowerCase()}`)),
    );
  }

  private async account(ownerRaw: string) {
    let account: UserVenueAccount;
    try {
      account = await this.deps.door.account(typeof ownerRaw === 'string' ? ownerRaw : '');
    } catch (err) {
      if (err instanceof UserVenueDoorError && err.status === 400)
        throw new MarginTopUpError('owner must be the wallet address of your venue account', 'trade.margin_topup_field_invalid');
      throw err;
    }
    if (account.subAccount !== null)
      throw new MarginTopUpError('auto top-up runs on your main venue account', 'trade.margin_topup_field_invalid');
    return { venue: await this.deps.door.venue(), account };
  }

  private symbolOf(raw: string): string {
    const symbol = typeof raw === 'string' ? raw.trim() : '';
    if (symbol === '') throw new MarginTopUpError('symbol is required', 'trade.margin_topup_field_invalid');
    return symbol;
  }

  /** The open isolated position on `symbol`, as the venue reports it now, with the venue's time. */
  private async positionNow(account: UserVenueAccount, symbol: string) {
    const venue = await this.deps.door.venue();
    const read = await venue.positions(account);
    const position = read.value.find((p) => p.symbol === symbol && p.size !== ZERO && p.marginMode === 'isolated') ?? null;
    return { position, asOf: read.asOf };
  }

  private async approved(account: UserVenueAccount, agentAddress: string): Promise<boolean> {
    const venue = await this.deps.door.venue();
    const listed = (await venue.agents(account)).value.find((a) => a.address.toLowerCase() === agentAddress);
    return !!listed && (listed.validUntil === null || listed.validUntil.getTime() > this.deps.now().getTime());
  }

  async get(principal: Principal, input: { owner: string; symbol: string }): Promise<MarginTopUpView> {
    const { account } = await this.account(input.owner);
    return this.view(principal.userId, account, this.symbolOf(input.symbol));
  }

  /** The permission's own cap, stored before the wallet is asked to approve the key. */
  async setPermissionCap(principal: Principal, input: { owner: string; symbol: string; cap?: string | null }): Promise<MarginTopUpView> {
    const { account } = await this.account(input.owner);
    const symbol = this.symbolOf(input.symbol);
    const cap = positive(input.cap, 'the permission cap');
    const agentAddress = this.agentKey(principal.userId, account.owner).address.toLowerCase();
    const at = { userId: principal.userId, venueId: account.venueId, owner: account.owner };
    const stored = await this.deps.store.setPermissionCap(at, agentAddress, cap, this.deps.now());
    if (!stored) {
      const now = await this.deps.store.permission(at);
      throw new MarginTopUpError(
        `The permission cap cannot be below what was already added under it (${now ? formatAmount(now.added) : '0'}). Nothing was saved.`,
        'trade.margin_topup_field_invalid',
      );
    }
    return this.view(principal.userId, account, symbol);
  }

  /** Turn auto top-up on for the position, or change it. */
  async set(
    principal: Principal,
    input: { owner: string; symbol: string; level?: string | null; amount?: string | null; cap?: string | null },
  ): Promise<MarginTopUpView> {
    const { venue, account } = await this.account(input.owner);
    const symbol = this.symbolOf(input.symbol);
    const level = positive(input.level, 'the margin level that starts a top-up');
    const amount = positive(input.amount, 'the amount each top-up adds');
    const cap = positive(input.cap, 'the cap');
    if (compare(amount, cap) > 0) {
      throw new MarginTopUpError(
        `Each top-up adds ${formatAmount(amount)}, which is above the cap of ${formatAmount(cap)}, so none could ever be sent. Nothing was saved.`,
        'trade.margin_topup_amount_above_cap',
      );
    }
    const name = venue.venue.displayName;
    const { position } = await this.positionNow(account, symbol);
    if (!position) {
      throw new MarginTopUpError(
        `You have no open isolated position on ${symbol} at ${name}, so there is no margin to top up. Nothing was saved.`,
        'trade.margin_topup_no_position',
      );
    }
    const below = atOrBelow(position, level);
    if (below === null) {
      throw new MarginTopUpError(
        `${name} publishes no maintenance margin for this position, so its margin level cannot be read and no top-up could start. Nothing was saved.`,
        'trade.margin_topup_level_unmeasured',
      );
    }
    if (below) {
      throw new MarginTopUpError(
        `The margin level is ${formatAmount(marginLevelOf(position) ?? ZERO)}% now, already at or below ${formatAmount(level)}%: a top-up starts when it falls to your level, so set a level below it. Nothing was saved.`,
        'trade.margin_topup_level_reached',
      );
    }
    const where = { userId: principal.userId, venueId: account.venueId, owner: account.owner };
    const permission = await this.deps.store.permission(where);
    const agentAddress = this.agentKey(principal.userId, account.owner).address.toLowerCase();
    if (!permission || permission.agentAddress !== agentAddress || !(await this.approved(account, agentAddress))) {
      throw new MarginTopUpError(
        `Auto top-up needs your margin top-up permission on ${name}: set its cap and approve it in your wallet first. Nothing was saved.`,
        'trade.margin_topup_permission_missing',
      );
    }
    const stored = await this.deps.store.setRule({ ...where, symbol }, { level, amount, cap }, this.deps.now());
    if (!stored) {
      const now = await this.deps.store.rule({ ...where, symbol });
      throw new MarginTopUpError(
        `The cap cannot be below what auto top-up already added (${now ? formatAmount(now.added) : '0'}). Nothing was saved.`,
        'trade.margin_topup_field_invalid',
      );
    }
    return this.view(principal.userId, account, symbol);
  }

  async off(principal: Principal, input: { owner: string; symbol: string }): Promise<MarginTopUpView> {
    const { account } = await this.account(input.owner);
    const symbol = this.symbolOf(input.symbol);
    await this.deps.store.turnOff({ userId: principal.userId, venueId: account.venueId, owner: account.owner, symbol }, this.deps.now());
    return this.view(principal.userId, account, symbol);
  }

  private async view(userId: string, account: UserVenueAccount, symbol: string): Promise<MarginTopUpView> {
    const venue = await this.deps.door.venue();
    const where = { userId, venueId: account.venueId, owner: account.owner };
    const agentAddress = this.agentKey(userId, account.owner).address.toLowerCase();
    const [{ position, asOf }, markets, permission, rule, topUps, approved] = await Promise.all([
      this.positionNow(account, symbol),
      venue.markets(account),
      this.deps.store.permission(where),
      this.deps.store.rule({ ...where, symbol }),
      this.deps.store.topUps({ ...where, symbol }, TOPUPS_SHOWN),
      this.approved(account, agentAddress),
    ]);
    const market = markets.value.find((m) => m.symbol === symbol);
    if (!market || market.kind !== 'perpetual')
      throw new MarginTopUpError(`${symbol} is not a perpetual on ${venue.venue.displayName}`, 'trade.margin_topup_field_invalid');
    const level = position ? marginLevelOf(position) : null;
    return {
      venue: { id: venue.venue.id, name: venue.venue.displayName, test: isTestVenue(venue.venue) },
      owner: account.owner,
      symbol,
      asset: market.quoteAsset,
      position: position
        ? {
            margin: formatAmount(position.margin),
            unrealisedPnl: formatAmount(position.unrealisedPnl),
            maintenanceMargin: position.maintenanceMargin?.known ? formatAmount(position.maintenanceMargin.value) : null,
            marginLevel: level === null ? null : formatAmount(level),
            asOf: asOf.toISOString(),
          }
        : null,
      permission: {
        agentAddress,
        agentName: MARGIN_TOPUP_AGENT_NAME,
        actionKey: marginTopUpAgentKey(account.owner, agentAddress),
        approved,
        cap: permission ? formatAmount(permission.cap) : null,
        added: formatAmount(permission?.added ?? ZERO),
      },
      rule: rule
        ? {
            on: rule.on,
            level: formatAmount(rule.level),
            amount: formatAmount(rule.amount),
            cap: formatAmount(rule.cap),
            added: formatAmount(rule.added),
            armed: rule.armed,
            stopped: rule.stopped,
          }
        : null,
      topUps: topUps.map((t) => ({
        n: t.n,
        changeKey: t.changeKey,
        amount: formatAmount(t.amount),
        levelSeen: formatAmount(t.levelSeen),
        state: t.state,
        failure: t.failure,
        at: t.at.toISOString(),
      })),
    };
  }

  /**
   * One pass of our engine over every rule that is on. A rule sending a top-up sends the same one again (the same key,
   * the same bytes) until the venue answers definitely. Otherwise the position's margin level is read from the venue: seen
   * above the rule's level, the rule is armed; at or below it while armed, the fall is claimed once and its one top-up
   * sent. One rule's failure never stops the next.
   */
  async tick(): Promise<{ readonly sent: number }> {
    let sent = 0;
    for (const rule of await this.deps.store.live()) {
      try {
        if (rule.sending !== null) {
          const topUp = await this.deps.store.topUp(rule, rule.sending);
          if (topUp) await this.send(rule, topUp);
          continue;
        }
        const account: UserVenueAccount = { venueId: rule.venueId, owner: rule.owner, subAccount: null };
        const { position } = await this.positionNow(account, rule.symbol);
        if (!position) continue;
        const below = atOrBelow(position, rule.level);
        if (below === null) continue;
        if (!below) {
          if (!rule.armed) await this.deps.store.arm(rule, this.deps.now());
          continue;
        }
        if (!rule.armed) continue;
        const claim = await this.deps.store.claim(
          rule,
          marginLevelOf(position) ?? ZERO,
          (n) => topUpChangeKey(rule.owner, rule.symbol, n),
          this.deps.now(),
        );
        if (!claim || 'stopped' in claim) continue;
        sent += 1;
        await this.send(rule, claim.topUp);
      } catch (err) {
        process.stderr.write(
          `${JSON.stringify({ level: 'warn', msg: 'trade.margin_topup.pass_failed', owner: rule.owner, symbol: rule.symbol, message: err instanceof Error ? err.message : String(err) })}\n`,
        );
      }
    }
    return { sent };
  }

  /** The one margin change of a claimed top-up, signed by the margin top-up key. Stored by the door before it is sent. */
  private async send(rule: TopUpRule, topUp: TopUp): Promise<void> {
    const where: TopUpPosition = rule;
    const settle = (state: 'added' | 'refused', failure: string | null) =>
      this.deps.store.settle(where, topUp.n, state, failure, this.deps.now());
    const actor = engineActor(rule.userId, 'none');
    const signer = this.agentKey(rule.userId, rule.owner);
    const agentAddress = signer.address.toLowerCase();
    const stored = await this.deps.door.stored(actor, topUp.changeKey);
    // The venue's definite answer to these bytes is the answer: nothing is sent again.
    if (stored?.signature && stored.lastOutcome?.definite) return this.settleOutcome(settle, stored.lastOutcome);
    if (!stored) {
      // Nothing was prepared yet, so nothing can have reached the venue: a frozen account gets no top-up, and says so.
      if (!this.deps.freeze) throw new Error('the account freeze cannot be read here, so our engine sends no top-up');
      if (await this.deps.freeze.frozen(rule.userId)) return settle('refused', 'your account is frozen, so our engine sent no top-up');
    }
    const intent: UpdateIsolatedMarginIntent = {
      kind: 'update_isolated_margin',
      symbol: rule.symbol,
      direction: 'add',
      amount: topUp.amount,
      changeKey: topUp.changeKey,
    };
    let prepared: { actionKey: string; prepared: { typedData: unknown; digest: string; account: UserVenueAccount; signer: { role: string } } };
    try {
      prepared = stored
        ? { actionKey: stored.businessKey, prepared: stored.prepared }
        : await this.deps.door.prepare(actor, { owner: rule.owner, signer: { role: 'agent', address: agentAddress }, intent });
    } catch (err) {
      // Refused before anything was signed (no position any more, the key no longer approved, the venue's own check).
      if (err instanceof VenueRefusalError) return settle('refused', err.refusal.detail);
      if (err instanceof UserVenueDoorError || err instanceof AuthError) return settle('refused', err.message);
      throw err;
    }
    // The invariant: a top-up names the person's own main account and the margin top-up key, nothing else.
    if (
      prepared.prepared.account.owner.toLowerCase() !== rule.owner ||
      prepared.prepared.account.subAccount !== null ||
      prepared.prepared.signer.role !== 'agent'
    ) {
      throw new Error(`top-up ${topUp.changeKey} was prepared outside its own venue account; nothing is signed`);
    }
    const signature = await signer.signTypedData(prepared.prepared.typedData as TypedDataDefinition);
    let outcome: VenueSubmitOutcome;
    try {
      outcome = (
        await this.deps.door.submit(actor, prepared.actionKey, { digest: prepared.prepared.digest, signature, signedBy: agentAddress })
      ).outcome;
    } catch (err) {
      // `venue_down` after the bytes were stored: no answer about them, so the rule stays sending and they go again.
      if (err instanceof VenueRefusalError && err.refusal.code !== 'venue_down') return settle('refused', err.refusal.detail);
      throw err;
    }
    return this.settleOutcome(settle, outcome);
  }

  private async settleOutcome(
    settle: (state: 'added' | 'refused', failure: string | null) => Promise<void>,
    outcome: VenueSubmitOutcome,
  ): Promise<void> {
    if (!outcome.definite) return; // the same bytes go again on the next pass
    if (outcome.accepted) return settle('added', null);
    return settle('refused', outcome.refusal.detail);
  }
}
