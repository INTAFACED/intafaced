import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { keccak256, toHex, type TypedDataDefinition } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { add, compare, formatAmount, isNegative, parseAmount, sub, ZERO, type Amount } from '@intafaced/ledger-client/money';
import type { Principal } from '@intafaced/auth';
import { autoTopUpViewSchema } from '@intafaced/contracts/trade-auto-top-up-procedures';
import {
  encodeVenueWire,
  isTestVenue,
  VenueRefusalError,
  type UserVenue,
  type UserVenueAccount,
  type UserVenuePosition,
  type VenueSubmitOutcome,
} from '@intafaced/venue-contracts';
import type { AccountFreezeRead } from '../quant/live-run/ports.js';
import type { AutoTopUpAdd, AutoTopUpPermission, AutoTopUpSetting, AutoTopUpStore } from './auto-top-up-store.js';
import { engineActor } from './protections.js';
import type { UserVenueDoor } from './user-venue-door.js';

/**
 * AUTO TOP-UP OF AN ISOLATED POSITION'S MARGIN ON THE PERSON'S OWN VENUE ACCOUNT (J-derivatives-06 #4; D-margin-04).
 *
 * Money (J-derivatives-06 "Money"): INTAFACED holds and moves nothing, and the ledger posts nothing. The venue holds the
 * position and its margin. The person's wallet approves, on the venue, an agent key INTAFACED derives for their auto
 * top-up (the agent permission: it may sign margin changes and orders, never a withdrawal), and sets the permission's own
 * cap, the most all its top-ups may add together. For each isolated position they set the margin level that starts a
 * top-up, the amount each adds and a cap. Our engine reads the position's margin with its unrealised result, as the venue
 * reports them: each time it falls to the level from above (a crossing), it adds the set amount once, one
 * `update_isolated_margin` the agent key signs, under `margin:<owner>:<symbol>:auto:<sequence>`. A crossing whose amount
 * would pass the position's cap, or the permission's own cap, sends nothing and says which cap stopped it.
 *
 * Crash points (whose funds are stranded? none, ever): the top-up row is written `sending`, under its sequence and key,
 * in the same transaction that consumes the crossing, before anything is prepared or signed. A worker that stops at any
 * later point leaves that row `sending`, and the next pass sends the same key again: the door returns the same prepared
 * bytes, a definite answer already stored is never sent again, and the venue applies one signed change once. The margin
 * only ever moves between the person's own free balance and their own position on their own venue account.
 */

const AUTO_TOP_UP_AGENT_NAME = 'auto-top-up';
/** The auto top-up agent permission's business key on one venue account. */
const autoTopUpAgentKey = (owner: string, agentAddress: string) => `auto-top-up-agent:${owner.toLowerCase()}:${agentAddress.toLowerCase()}`;
/** The business key of one top-up: the account, the market and the top-up's sequence, never a random id. */
export const autoTopUpChangeKey = (owner: string, symbol: string, sequence: number) =>
  `margin:${owner.toLowerCase()}:${symbol.toLowerCase()}:auto:${sequence}`;

const DECIMAL_RE = /^[0-9]+(\.[0-9]+)?$/;

export type AutoTopUpErrorCode =
  | 'trade.auto_top_up_unavailable'
  | 'trade.auto_top_up_request_invalid'
  | 'trade.auto_top_up_field_invalid'
  | 'trade.auto_top_up_no_position'
  | 'trade.auto_top_up_agent_key_unset'
  | 'trade.auto_top_up_not_asked';

export class AutoTopUpError extends Error {
  constructor(
    message: string,
    readonly code: AutoTopUpErrorCode,
    readonly field: string | null = null,
  ) {
    super(message);
    this.name = 'AutoTopUpError';
  }
}

export type AutoTopUpView = z.input<typeof autoTopUpViewSchema>;
type AutoTopUpNext = NonNullable<AutoTopUpView['next']>;
const NEXT_TYPED_DATA = autoTopUpViewSchema.shape.next.unwrap().shape.typedData;

export interface AutoTopUpDeps {
  readonly door: UserVenueDoor;
  readonly store: AutoTopUpStore;
  /** `TRADE_AGENT_KEY_SEED`: the owner's secret the auto top-up key derives from. Blank refuses every auto top-up. */
  readonly keySeed: string;
  /** The person's own account freeze (J-wallet-13), read before each top-up is sent. Null, or a read that fails, sends nothing. */
  readonly freeze: AccountFreezeRead | null;
  readonly now: () => Date;
}

export interface AutoTopUpSetInput {
  readonly owner: string;
  readonly symbol: string;
  readonly triggerLevel?: string | null;
  readonly amountEach?: string | null;
  readonly cap?: string | null;
  readonly permissionCap?: string | null;
}

function amountField(raw: string | null | undefined, field: string): Amount {
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (!DECIMAL_RE.test(v)) throw new AutoTopUpError(`${field} must be an amount, like 10 or 2.5`, 'trade.auto_top_up_field_invalid', field);
  const amount = parseAmount(v);
  if (compare(amount, ZERO) <= 0) throw new AutoTopUpError(`${field} must be above zero`, 'trade.auto_top_up_field_invalid', field);
  return amount;
}

const floorZero = (x: Amount) => (isNegative(x) ? ZERO : x);
const isOpenIsolated = (p: UserVenuePosition, symbol: string) =>
  p.symbol === symbol && p.marginMode === 'isolated' && compare(p.size, ZERO) !== 0;

function isTypedData(value: unknown): value is TypedDataDefinition {
  if (typeof value !== 'object' || value === null) return false;
  return 'domain' in value && 'types' in value && 'primaryType' in value && 'message' in value;
}

const log = (msg: string, fields: Record<string, unknown>) =>
  process.stderr.write(`${JSON.stringify({ level: 'warn', msg, ...fields })}\n`);

export class VenueAutoTopUp {
  /** Settings this process is driving now, so two passes never act on one position at once in this process. */
  private readonly driving = new Set<string>();

  constructor(private readonly deps: AutoTopUpDeps) {}

  /** The venue agent key INTAFACED holds for one person's auto top-up on one venue account. Derived, never stored. */
  agentKey(userId: string, owner: string): PrivateKeyAccount {
    if (this.deps.keySeed.trim() === '') {
      throw new AutoTopUpError(
        'No key seed is set for the auto top-up agent key (owner value blank), so auto top-up does not run',
        'trade.auto_top_up_agent_key_unset',
      );
    }
    return privateKeyToAccount(
      keccak256(toHex(`intafaced auto top-up key\u0000${this.deps.keySeed}\u0000${userId}\u0000${owner.toLowerCase()}`)),
    );
  }

  private async read(owner: string, symbol: string) {
    const account = await this.deps.door.account(owner);
    const venue = await this.deps.door.venue();
    const markets = (await venue.markets(account)).value;
    const market = markets.find((m) => m.symbol === symbol);
    if (!market || market.kind !== 'perpetual') {
      throw new AutoTopUpError(`${symbol} is not a perpetual on ${venue.venue.displayName}`, 'trade.auto_top_up_request_invalid', 'Market');
    }
    const asset = market.marginAccount?.known ? market.marginAccount.value.collateralAsset : market.quoteAsset;
    return { account, venue, asset };
  }

  private async permitted(venue: UserVenue, account: UserVenueAccount, agentAddress: string): Promise<boolean> {
    const listed = (await venue.agents(account)).value.find((a) => a.address.toLowerCase() === agentAddress);
    return !!listed && (listed.validUntil === null || listed.validUntil.getTime() > this.deps.now().getTime());
  }

  async get(principal: Principal, owner: string, symbol: string): Promise<AutoTopUpView> {
    const { account, venue, asset } = await this.read(owner, symbol);
    return this.view(principal, { venue, account, asset }, symbol);
  }

  /**
   * Turn auto top-up on for the position, or change its terms. The first time on the venue account the permission's own
   * cap is set too, and the view carries the permission for the wallet to sign. Nothing is sent to the venue here.
   */
  async set(principal: Principal, input: AutoTopUpSetInput): Promise<AutoTopUpView> {
    const { account, venue, asset } = await this.read(input.owner, input.symbol);
    const triggerLevel = amountField(input.triggerLevel, 'Margin level');
    const amountEach = amountField(input.amountEach, 'Amount each top-up');
    const cap = amountField(input.cap, 'Cap');
    if (compare(cap, amountEach) < 0) {
      throw new AutoTopUpError(
        `The cap (${formatAmount(cap)} ${asset}) must be at least the amount each top-up adds (${formatAmount(amountEach)} ${asset})`,
        'trade.auto_top_up_field_invalid',
        'Cap',
      );
    }
    const position = (await venue.positions(account)).value.find((p) => isOpenIsolated(p, input.symbol));
    if (!position) {
      throw new AutoTopUpError(
        `You have no isolated position on ${input.symbol} on ${venue.venue.displayName}, so there is no margin to top up`,
        'trade.auto_top_up_no_position',
      );
    }
    const agent = this.agentKey(principal.userId, account.owner).address.toLowerCase();
    const at = this.deps.now();
    let permission = await this.deps.store.permission(principal.userId, account.venueId, account.owner);
    const askedCap = typeof input.permissionCap === 'string' && input.permissionCap.trim() !== '' ? input.permissionCap : null;
    if (!permission) {
      const permissionCap = amountField(askedCap, 'Agent permission cap');
      permission = await this.deps.store.createPermissionOnce({
        userId: principal.userId,
        venueId: account.venueId,
        owner: account.owner,
        agentAddress: agent,
        asset,
        cap: permissionCap,
        createdAt: at,
      });
    } else if (askedCap !== null && compare(amountField(askedCap, 'Agent permission cap'), permission.cap) !== 0) {
      throw new AutoTopUpError(
        `The agent permission's cap is set once, when your wallet approves it: it is ${formatAmount(permission.cap)} ${permission.asset}`,
        'trade.auto_top_up_field_invalid',
        'Agent permission cap',
      );
    }
    await this.deps.store.save({
      id: randomUUID(),
      userId: principal.userId,
      venueId: account.venueId,
      owner: account.owner,
      symbol: input.symbol,
      triggerLevel,
      amountEach,
      cap,
      at,
    });
    return this.view(principal, { venue, account, asset }, input.symbol);
  }

  /** The wallet's signature of the auto top-up permission, sent once under its key. */
  async submitPermission(
    principal: Principal,
    input: { owner: string; symbol: string; actionKey: string; signature: { digest: string; signature: string; signedBy: string } },
  ): Promise<AutoTopUpView> {
    const { account, venue, asset } = await this.read(input.owner, input.symbol);
    const permission = await this.deps.store.permission(principal.userId, account.venueId, account.owner);
    if (!permission || input.actionKey !== autoTopUpAgentKey(account.owner, permission.agentAddress)) {
      throw new AutoTopUpError(
        `${JSON.stringify(input.actionKey)} is not this account's auto top-up permission`,
        'trade.auto_top_up_not_asked',
      );
    }
    const answer = await this.deps.door.submit(principal, input.actionKey, input.signature);
    if (answer.outcome.definite && !answer.outcome.accepted) {
      throw new AutoTopUpError(`The venue refused the agent permission: ${answer.outcome.refusal.detail}`, 'trade.auto_top_up_not_asked');
    }
    return this.view(principal, { venue, account, asset }, input.symbol);
  }

  async off(principal: Principal, owner: string, symbol: string): Promise<AutoTopUpView> {
    const { account, venue, asset } = await this.read(owner, symbol);
    const setting = await this.deps.store.setting({ userId: principal.userId, venueId: account.venueId, owner: account.owner, symbol });
    if (setting?.enabled) await this.deps.store.turnOff(setting.id, this.deps.now());
    return this.view(principal, { venue, account, asset }, symbol);
  }

  // ── the engine ─────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * One pass: every setting that is on, once. A top-up left `sending` by a worker that stopped is sent again under its
   * own key first. Then the position's margin with its result is read from the venue: above the level arms the setting;
   * at or below it, an armed setting's crossing is claimed against both caps and its one top-up sent.
   */
  async tick(): Promise<{ readonly sent: number }> {
    let sent = 0;
    for (const s of await this.deps.store.enabled()) {
      if (this.driving.has(s.id)) continue;
      this.driving.add(s.id);
      try {
        sent += await this.pass(s);
      } catch (err) {
        log('trade.auto_top_up.pass_failed', { setting: s.id, message: err instanceof Error ? err.message : String(err) });
      } finally {
        this.driving.delete(s.id);
      }
    }
    return { sent };
  }

  private async pass(s: AutoTopUpSetting): Promise<number> {
    const pending = (await this.deps.store.adds(s.id)).filter((a) => a.state === 'sending');
    for (const a of pending) await this.send(a);
    // A replayed top-up moved the margin: the next pass reads it again before judging a new crossing.
    if (pending.length > 0) return 0;
    const permission = await this.deps.store.permission(s.userId, s.venueId, s.owner);
    if (!permission) return 0;
    const venue = await this.deps.door.venue();
    if (venue.venue.id !== s.venueId) return 0;
    const account: UserVenueAccount = { venueId: s.venueId, owner: s.owner, subAccount: null };
    const position = (await venue.positions(account)).value.find((p) => isOpenIsolated(p, s.symbol));
    if (!position) return 0;
    const margin = add(position.margin, position.unrealisedPnl);
    const at = this.deps.now();
    if (compare(margin, s.triggerLevel) > 0) {
      if (!s.armed) await this.deps.store.setArmed(s.id, true, at);
      return 0;
    }
    if (!s.armed) return 0;
    // The agent key signs nothing the venue does not list approved, and nothing for a frozen account: the crossing stays
    // unclaimed, and is judged again on the next pass.
    if (!(await this.permitted(venue, account, permission.agentAddress))) return 0;
    if (!this.deps.freeze) throw new Error('the account freeze cannot be read here, so our engine sends no top-up');
    if (await this.deps.freeze.frozen(s.userId)) return 0;
    const claimed = await this.deps.store.claim({
      settingId: s.id,
      marginAt: margin,
      changeKeyOf: (sequence) => autoTopUpChangeKey(s.owner, s.symbol, sequence),
      at,
    });
    if (claimed.kind !== 'claimed') return 0;
    await this.send(claimed.add);
    return 1;
  }

  /** One top-up: prepared (or the stored one read back), signed by the auto top-up key, and sent once. */
  private async send(row: AutoTopUpAdd): Promise<void> {
    const signer = this.agentKey(row.userId, row.owner);
    const address = signer.address.toLowerCase();
    if (address !== row.agentAddress) throw new Error(`top-up ${row.changeKey} was claimed for another agent key; nothing is signed`);
    if (!this.deps.freeze) throw new Error('the account freeze cannot be read here, so our engine sends no top-up');
    if (await this.deps.freeze.frozen(row.userId)) return; // left sending: sent once the freeze is lifted
    const actor = engineActor(row.userId, 'none');
    const settle = async (state: 'added' | 'refused', refusal: string | null) => {
      await this.deps.store.settle({ settingId: row.settingId, sequence: row.sequence, state, refusal, at: this.deps.now() });
    };
    let answer: Awaited<ReturnType<UserVenueDoor['prepare']>>;
    try {
      answer = await this.deps.door.prepare(actor, {
        owner: row.owner,
        signer: { role: 'agent', address },
        intent: { kind: 'update_isolated_margin', symbol: row.symbol, direction: 'add', amount: row.amount, changeKey: row.changeKey },
      });
    } catch (err) {
      if (err instanceof VenueRefusalError) return settle('refused', err.refusal.detail);
      throw err;
    }
    const p = answer.prepared;
    if (
      p.intent.kind !== 'update_isolated_margin' ||
      p.intent.direction !== 'add' ||
      compare(p.intent.amount, row.amount) !== 0 ||
      p.account.owner.toLowerCase() !== row.owner ||
      p.signer.role !== 'agent'
    ) {
      throw new Error(`top-up ${row.changeKey} came back prepared for something else; nothing is signed`);
    }
    if (answer.signed && answer.lastOutcome?.definite) {
      return settle(
        answer.lastOutcome.accepted ? 'added' : 'refused',
        answer.lastOutcome.accepted ? null : answer.lastOutcome.refusal.detail,
      );
    }
    if (!isTypedData(p.typedData)) throw new Error(`top-up ${row.changeKey} came back with no typed data to sign`);
    const signature = await signer.signTypedData(p.typedData);
    let outcome: VenueSubmitOutcome;
    try {
      outcome = (await this.deps.door.submit(actor, answer.actionKey, { digest: p.digest, signature, signedBy: address })).outcome;
    } catch (err) {
      if (err instanceof VenueRefusalError) return settle('refused', err.refusal.detail);
      throw err;
    }
    if (!outcome.definite) return; // left sending: read back under the same key on the next pass
    return settle(outcome.accepted ? 'added' : 'refused', outcome.accepted ? null : outcome.refusal.detail);
  }

  // ── the view ────────────────────────────────────────────────────────────────────────────────────────────────────

  private async view(
    principal: Principal,
    at: { venue: UserVenue; account: UserVenueAccount; asset: string },
    symbol: string,
  ): Promise<AutoTopUpView> {
    const { venue, account, asset } = at;
    const [positions, permission, setting] = await Promise.all([
      venue.positions(account),
      this.deps.store.permission(principal.userId, account.venueId, account.owner),
      this.deps.store.setting({ userId: principal.userId, venueId: account.venueId, owner: account.owner, symbol }),
    ]);
    const position = positions.value.find((p) => isOpenIsolated(p, symbol)) ?? null;
    const adds = setting ? await this.deps.store.adds(setting.id) : [];
    return {
      venue: { id: venue.venue.id, name: venue.venue.displayName, test: isTestVenue(venue.venue) },
      owner: account.owner,
      symbol,
      asset,
      position: position
        ? {
            margin: formatAmount(position.margin),
            unrealisedPnl: formatAmount(position.unrealisedPnl),
            marginWithResult: formatAmount(add(position.margin, position.unrealisedPnl)),
            asOf: positions.asOf.toISOString(),
          }
        : null,
      permission: permission ? await this.permissionView(venue, account, permission) : null,
      setting: setting ? this.settingView(setting, adds) : null,
      topUps: adds.map((a) => ({
        sequence: a.sequence,
        changeKey: a.changeKey,
        amount: formatAmount(a.amount),
        marginAt: formatAmount(a.marginAt),
        state: a.state,
        refusal: a.refusal,
        at: a.createdAt.toISOString(),
      })),
      next: permission ? await this.next(principal, { venue, account }, permission) : null,
    };
  }

  private async permissionView(venue: UserVenue, account: UserVenueAccount, permission: AutoTopUpPermission) {
    const used = await this.deps.store.used(permission);
    return {
      agentAddress: permission.agentAddress,
      agentName: AUTO_TOP_UP_AGENT_NAME,
      approved: await this.permitted(venue, account, permission.agentAddress),
      cap: formatAmount(permission.cap),
      used: formatAmount(used),
      room: formatAmount(floorZero(sub(permission.cap, used))),
    };
  }

  private settingView(setting: AutoTopUpSetting, adds: readonly AutoTopUpAdd[]) {
    const added = adds
      .filter((a) => a.run === setting.run && (a.state === 'sending' || a.state === 'added'))
      .reduce((s, a) => add(s, a.amount), ZERO);
    return {
      on: setting.enabled,
      triggerLevel: formatAmount(setting.triggerLevel),
      amountEach: formatAmount(setting.amountEach),
      cap: formatAmount(setting.cap),
      added: formatAmount(added),
      room: formatAmount(floorZero(sub(setting.cap, added))),
      armed: setting.armed,
      stopped: setting.stopped,
    };
  }

  /** The permission for the wallet to sign while the venue does not list it: the same stored approval each time. */
  private async next(
    principal: Principal,
    at: { venue: UserVenue; account: UserVenueAccount },
    permission: AutoTopUpPermission,
  ): Promise<AutoTopUpNext | null> {
    const { venue, account } = at;
    if (await this.permitted(venue, account, permission.agentAddress)) return null;
    const answer = await this.deps.door.prepare(principal, {
      owner: account.owner,
      signer: { role: 'owner', address: account.owner },
      intent: { kind: 'approve_agent', agentAddress: permission.agentAddress, agentName: AUTO_TOP_UP_AGENT_NAME, validUntil: null },
      actionKey: autoTopUpAgentKey(account.owner, permission.agentAddress),
    });
    return {
      actionKey: answer.actionKey,
      digest: answer.prepared.digest,
      typedData: NEXT_TYPED_DATA.parse(encodeVenueWire(answer.prepared.typedData)),
    };
  }
}
