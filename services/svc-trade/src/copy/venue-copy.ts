import { compare, div, formatAmount, mul, parseAmount, type Amount } from '@intafaced/ledger-client/money';
import type { Principal } from '@intafaced/auth';
import type { Sql } from 'postgres';
import type { TypedDataDefinition } from 'viem';
import {
  isTestVenue,
  type PlaceUserOrderIntent,
  type PreparedVenueAction,
  type UserVenue,
  type UserVenueAccount,
  type UserVenueFill,
  type UserVenueOrder,
  type VenueRefusal,
  type VenueSignature,
} from '@intafaced/venue-contracts';
import { requireOperatorWrite } from '../admin/common.js';
import { agentAddressFor, agentKeyFor } from '../venue/agent-key.js';
import type { UserVenueDoor } from '../venue/user-venue-door.js';
import type { PlaceFollowerOrderInput } from './auto-mirror-place.js';
import type { CopyService } from './copy-service.js';
import { CopyError } from './errors.js';

/**
 * COPY TRADING ON THE FOLLOWER'S OWN VENUE ACCOUNT (J-copy-bots-otc-01 #7 #8; CB-copy-03, CB-copy-04, CB-copy-10; the
 * launch money model, docs/adr/2026-11-10-launch-money-model.md; OWNER 226).
 *
 * INTAFACED holds and moves nothing. A follow's cap (the most in total) is a limit, never money: no reserve is held, and
 * the venue is the record of what the follower holds, what is copied and what it cost. Starting a follow asks the
 * follower's wallet to sign the venue's agent permission for a key INTAFACED holds for this follow only (agent-key.ts,
 * derived from the follow id), on their own main venue account. That key can place and cancel orders there and never
 * withdraw or approve (the venue's rule, `assertSignerMaySign`, and the door's refusal of an agent-signed owner action).
 * The follow (trade.copy_follows) is written only once the venue's record lists that permission: a signature the wallet
 * rejects is never sent, so it leaves no follow. The same request key again is the same follow and the same permission.
 *
 * Before it signs anything, the start checks the cap against the free balance the venue reports for that account, and
 * refuses a cap above it, naming the venue's figure and its as-of time (`trade.copy_venue_balance_short`).
 *
 * The copy driver (copy-service.ts `runMirrorSweep`) is unchanged; on the venue its three reads and its one write are
 * the ports below:
 *   - the lead's fills are the venue's record of the lead's own venue account (`copy_venue_leads`, set by the operator
 *     who lists the lead), each named `venue:<venueId>:<owner>:<venue fill id>`;
 *   - the market's lot is the venue's;
 *   - a copy is the follower's own venue order, placed by the follow's agent key. Our policy (the per-order limit, the
 *     fixed amount and the follow's cap, claimed under the follow's lock in `claimMirrorFill`) refuses any copy past the
 *     cap before the key signs. The order is stored under `copy-mirror:<mirror client id>`, one key per follow and lead
 *     fill, before it is sent, and sent once; a retry reads the venue's record by that key and re-sends only the stored,
 *     signed bytes. Our builder fee rides on the order as the door prices it, and the builder-fee poster posts it once
 *     per fill from the venue's record (builder-fee-poster.ts), like every other order of ours.
 *
 * Crash points (whose funds are stranded?): none, ever. Before the wallet signs, nothing exists outside our store; a
 * signed permission is read back from the venue's own list of agents. A copy is stored signed before it is sent, and a
 * lost answer is read back by its key; it can only rest or fill on the follower's own account, under their own wallet.
 */

export const COPY_VENUE_MIRROR_PREFIX = 'copy-mirror:';
export const copyVenueApproveKey = (followId: string) => `copy:follow:${followId}:approve`;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
/** How far back a lead fill named by id is looked up when the driver's own read of it is not in memory. */
const LOOKUP_WINDOW_MS = 24 * 3600_000;

export type VenueFollowStatus = 'signing' | 'active' | 'abandoned';

export interface VenueFollowRecord {
  readonly followId: string;
  readonly userId: string;
  readonly clientRequestId: string;
  readonly leaderId: string;
  readonly venueId: string;
  readonly owner: string;
  readonly agentAddress: string;
  readonly asset: string;
  readonly cap: Amount;
  /** The person's Start copying request, as copy.follow takes it. */
  readonly request: VenueFollowRequest;
  readonly status: VenueFollowStatus;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly activeAt: Date | null;
}

export interface VenueLeadRecord {
  readonly leaderUserId: string;
  readonly venueId: string;
  readonly owner: string;
  readonly setBy: string;
  readonly setAt: Date;
}

export type VenueFollowRequest = Parameters<CopyService['startVenueFollow']>[1];

export interface VenueCopyStore {
  find(followId: string): Promise<VenueFollowRecord | null>;
  /** Stores the record unless one is there for its follow id; answers the stored one. */
  insertOnce(record: VenueFollowRecord): Promise<VenueFollowRecord>;
  activate(followId: string, at: Date): Promise<VenueFollowRecord>;
  abandon(followId: string): Promise<VenueFollowRecord>;
  lead(leaderUserId: string): Promise<VenueLeadRecord | null>;
  leadByOwner(venueId: string, owner: string): Promise<VenueLeadRecord | null>;
  setLead(record: VenueLeadRecord): Promise<VenueLeadRecord>;
}

export class InMemoryVenueCopyStore implements VenueCopyStore {
  private readonly follows = new Map<string, VenueFollowRecord>();
  private readonly leads = new Map<string, VenueLeadRecord>();

  async find(followId: string) {
    return this.follows.get(followId) ?? null;
  }

  async insertOnce(record: VenueFollowRecord) {
    const had = this.follows.get(record.followId);
    if (had) return had;
    if ([...this.follows.values()].some((f) => f.agentAddress === record.agentAddress)) {
      throw new Error(`agent ${record.agentAddress} is already another follow's`);
    }
    this.follows.set(record.followId, record);
    return record;
  }

  private move(followId: string, from: VenueFollowStatus, patch: Partial<VenueFollowRecord>) {
    const had = this.follows.get(followId);
    if (!had) throw new Error(`no venue follow ${followId}`);
    if (had.status !== from) return had;
    const next = { ...had, ...patch };
    this.follows.set(followId, next);
    return next;
  }

  async activate(followId: string, at: Date) {
    return this.move(followId, 'signing', { status: 'active', activeAt: at });
  }

  async abandon(followId: string) {
    return this.move(followId, 'signing', { status: 'abandoned' });
  }

  async lead(leaderUserId: string) {
    return this.leads.get(leaderUserId) ?? null;
  }

  async leadByOwner(venueId: string, owner: string) {
    return [...this.leads.values()].find((l) => l.venueId === venueId && l.owner === owner) ?? null;
  }

  async setLead(record: VenueLeadRecord) {
    this.leads.set(record.leaderUserId, record);
    return record;
  }
}

type FollowRow = {
  follow_id: string;
  user_id: string;
  client_request_id: string;
  leader_id: string;
  venue_id: string;
  owner: string;
  agent_address: string;
  asset: string;
  cap: string;
  request: VenueFollowRequest | string;
  status: VenueFollowStatus;
  expires_at: Date;
  created_at: Date;
  active_at: Date | null;
};

const followOf = (r: FollowRow): VenueFollowRecord => ({
  followId: r.follow_id,
  userId: r.user_id,
  clientRequestId: r.client_request_id,
  leaderId: r.leader_id,
  venueId: r.venue_id,
  owner: r.owner,
  agentAddress: r.agent_address,
  asset: r.asset,
  cap: parseAmount(r.cap),
  request: typeof r.request === 'string' ? (JSON.parse(r.request) as VenueFollowRequest) : r.request,
  status: r.status,
  expiresAt: new Date(r.expires_at),
  createdAt: new Date(r.created_at),
  activeAt: r.active_at ? new Date(r.active_at) : null,
});

type LeadRow = { leader_user_id: string; venue_id: string; owner: string; set_by: string; set_at: Date };
const leadOf = (r: LeadRow): VenueLeadRecord => ({
  leaderUserId: r.leader_user_id,
  venueId: r.venue_id,
  owner: r.owner,
  setBy: r.set_by,
  setAt: new Date(r.set_at),
});

export class SqlVenueCopyStore implements VenueCopyStore {
  constructor(private readonly sql: Sql) {}

  async find(followId: string) {
    const rows = await this.sql<FollowRow[]>`SELECT * FROM trade.copy_venue_follows WHERE follow_id = ${followId}`;
    return rows[0] ? followOf(rows[0]) : null;
  }

  async insertOnce(f: VenueFollowRecord) {
    await this.sql`
      INSERT INTO trade.copy_venue_follows
        (follow_id, user_id, client_request_id, leader_id, venue_id, owner, agent_address, asset, cap, request, status,
         expires_at, created_at)
      VALUES (${f.followId}, ${f.userId}, ${f.clientRequestId}, ${f.leaderId}, ${f.venueId}, ${f.owner}, ${f.agentAddress},
        ${f.asset}, ${formatAmount(f.cap)}, ${this.sql.json(f.request as never)}, ${f.status}, ${f.expiresAt}, ${f.createdAt})
      ON CONFLICT (follow_id) DO NOTHING`;
    const stored = await this.find(f.followId);
    if (!stored) throw new Error(`the venue follow ${f.followId} was not stored`);
    return stored;
  }

  private async move(followId: string, from: VenueFollowStatus, to: VenueFollowStatus, activeAt: Date | null) {
    await this.sql`
      UPDATE trade.copy_venue_follows SET status = ${to}, active_at = COALESCE(${activeAt}, active_at)
      WHERE follow_id = ${followId} AND status = ${from}`;
    const row = await this.find(followId);
    if (!row) throw new Error(`no venue follow ${followId}`);
    return row;
  }

  activate(followId: string, at: Date) {
    return this.move(followId, 'signing', 'active', at);
  }

  abandon(followId: string) {
    return this.move(followId, 'signing', 'abandoned', null);
  }

  async lead(leaderUserId: string) {
    const rows = await this.sql<LeadRow[]>`
      SELECT leader_user_id, venue_id, owner, set_by, set_at FROM trade.copy_venue_leads WHERE leader_user_id = ${leaderUserId}`;
    return rows[0] ? leadOf(rows[0]) : null;
  }

  async leadByOwner(venueId: string, owner: string) {
    const rows = await this.sql<LeadRow[]>`
      SELECT leader_user_id, venue_id, owner, set_by, set_at FROM trade.copy_venue_leads
       WHERE venue_id = ${venueId} AND owner = ${owner} ORDER BY set_at DESC LIMIT 1`;
    return rows[0] ? leadOf(rows[0]) : null;
  }

  async setLead(l: VenueLeadRecord) {
    await this.sql`
      INSERT INTO trade.copy_venue_leads (leader_user_id, venue_id, owner, set_by, set_at)
      VALUES (${l.leaderUserId}, ${l.venueId}, ${l.owner}, ${l.setBy}, ${l.setAt})
      ON CONFLICT (leader_user_id) DO UPDATE SET venue_id = EXCLUDED.venue_id, owner = EXCLUDED.owner,
        set_by = EXCLUDED.set_by, set_at = EXCLUDED.set_at`;
    return (await this.lead(l.leaderUserId))!;
  }
}

export interface VenueCopyDeps {
  readonly copy: CopyService;
  readonly door: UserVenueDoor;
  readonly store: VenueCopyStore;
  /** The agent key secret (`TRADE_AGENT_KEY_SEED`); blank refuses every start. */
  readonly keySeed: string | null;
  /**
   * The follower's account admission (freeze, restriction, screening) for one copy, as a delegated child of the follow's
   * admitted start (`copy.mirror` under `copy.follow:<id>`), the same check every TEST-book copy order passes. It runs
   * before every signature and every re-send, so a follower frozen or flagged after the follow began gets no copy.
   */
  readonly admitCopy: (principal: Principal, businessId: string, payload: unknown, followId: string) => Promise<unknown>;
  readonly now: () => Date;
}

/** What the wallet is asked to sign next for a follow, if anything. */
export interface VenueFollowNext {
  readonly actionKey: string;
  readonly step: 'approve_agent';
  readonly prepared: PreparedVenueAction;
  /** Signed and sent with no definite answer yet: re-send it, never sign a new one. */
  readonly signed: boolean;
}

export interface VenueFollowView {
  readonly followId: string;
  readonly status: VenueFollowStatus;
  readonly venueId: string;
  readonly venueName: string;
  readonly owner: string;
  readonly agentAddress: string;
  readonly asset: string;
  readonly cap: string;
  /** Whether the venue's own record lists the follow's agent permission on the account. */
  readonly permissionOnVenue: boolean;
  readonly next: VenueFollowNext | null;
  /** The venue's refusal of the agent permission, when the follow was abandoned for one. */
  readonly refusal: VenueRefusal | null;
  /** The follow, once written (status active). */
  readonly follow: unknown;
  readonly test: boolean;
}

/** One copy on the follower's own venue account, as the venue reports it. */
export interface VenueCopiedOrder {
  readonly leaderFillId: string;
  readonly actionKey: string;
  readonly venueClientOrderId: string | null;
  readonly state: 'accepted' | 'unknown' | 'refused' | 'not_sent';
  readonly order: UserVenueOrder | null;
  /** The venue's fills of this order, each with its own fee and our builder fee as the venue charged them. */
  readonly fills: readonly UserVenueFill[];
  /** The address that signed it: the follow's agent key. */
  readonly signedBy: string;
  readonly asOf: Date | null;
}

function owned(principal: Principal, f: VenueFollowRecord | null, followId: string): VenueFollowRecord {
  if (!f || f.userId !== principal.userId) throw new CopyError(`No follow ${followId}`, 'trade.copy_not_following');
  return f;
}

/** A venue lead fill's id in the copy tables: unique across venues and accounts. */
export const venueLeadFillId = (venueId: string, owner: string, fillId: string) => `venue:${venueId}:${owner}:${fillId}`;

function parseLeadFillId(id: string): { venueId: string; owner: string; fillId: string } | null {
  const m = /^venue:([^:]+):(0x[0-9a-f]{40}):(.+)$/.exec(id);
  return m ? { venueId: m[1]!, owner: m[2]!, fillId: m[3]! } : null;
}

export class VenueCopy {
  /** The lead fills the driver read, by their copy id, so the plan that follows reads the same fill. */
  private readonly leadFills = new Map<string, { readonly leaderId: string; readonly fill: UserVenueFill }>();

  constructor(private readonly deps: VenueCopyDeps) {}

  private seed(): string {
    const seed = this.deps.keySeed;
    if (seed === null || seed.trim() === '') {
      throw new CopyError(
        'The agent key secret is not set (owner value blank), so no copy permission can be asked for',
        'trade.copy_agent_key_unset',
      );
    }
    return seed;
  }

  private main(f: { venueId: string; owner: string }): UserVenueAccount {
    return { venueId: f.venueId, owner: f.owner, subAccount: null };
  }

  /**
   * #7: Start copying on the venue. Every gate runs before anything is written or asked of the wallet: copy-service.ts
   * `checkVenueFollow` (country list, sub-account, copy tier, leader, a zero amount, a fixed amount above the most per
   * order), then the cap against the free balance the venue reports for the person's own account. Then the follow's
   * agent permission is stored `signing` and prepared for the wallet. The same request key returns the same follow.
   */
  async start(principal: Principal, req: VenueFollowRequest & { readonly owner: string }): Promise<VenueFollowView> {
    const owner = typeof req.owner === 'string' ? req.owner.trim().toLowerCase() : '';
    if (!ADDRESS_RE.test(owner)) throw new CopyError('owner must be your wallet address (0x and 40 hex)', 'trade.copy_envelope_invalid');
    const { owner: _owner, ...request } = req;
    const checked = await this.deps.copy.checkVenueFollow(principal, request);
    const venue = await this.deps.door.venue();
    const had = await this.deps.store.find(checked.followId);
    if (had) {
      const mine = owned(principal, had, checked.followId);
      if (mine.status === 'abandoned') {
        throw new CopyError(
          'This request was ended when the wallet did not sign it; start again for a new one',
          'trade.copy_venue_follow_abandoned',
        );
      }
      return this.advance(principal, mine, venue);
    }
    if (checked.existing) {
      throw new CopyError('This follow was not started on the venue', 'trade.copy_state_invalid');
    }
    const seed = this.seed();
    const account = await this.deps.door.account(owner, null);
    const balances = await venue.balances(account);
    const free = balances.value.find((b) => b.asset === checked.asset)?.free ?? 0n;
    if (compare(checked.cap, free) > 0) {
      throw new CopyError(
        `The most in total, ${formatAmount(checked.cap)} ${checked.asset}, is more than the ${formatAmount(free)} ${checked.asset} ` +
          `free that ${venue.venue.displayName} reports for your account as of ${balances.asOf.toISOString()}; nothing was followed`,
        'trade.copy_venue_balance_short',
      );
    }
    const stored = await this.deps.store.insertOnce({
      followId: checked.followId,
      userId: principal.userId,
      clientRequestId: request.clientRequestId,
      leaderId: checked.leaderId,
      venueId: venue.venue.id,
      owner,
      agentAddress: agentAddressFor(seed, principal.userId, `copy:${checked.followId}`),
      asset: checked.asset,
      cap: checked.cap,
      request,
      status: 'signing',
      expiresAt: checked.expiresAt,
      createdAt: this.deps.now(),
      activeAt: null,
    });
    return this.advance(principal, owned(principal, stored, checked.followId), venue);
  }

  /** The follow's state, read up to the venue's record. */
  async status(principal: Principal, followId: string): Promise<VenueFollowView> {
    const f = owned(principal, await this.deps.store.find(followId), followId);
    return this.advance(principal, f, await this.deps.door.venue());
  }

  /** The wallet's signature of the follow's agent permission, sent once under its key; then the follow is read up. */
  async submit(principal: Principal, followId: string, actionKey: string, signature: VenueSignature): Promise<VenueFollowView> {
    const f = owned(principal, await this.deps.store.find(followId), followId);
    if (actionKey !== copyVenueApproveKey(followId)) {
      throw new CopyError(`${JSON.stringify(actionKey)} is not this follow's permission`, 'trade.copy_venue_action_unknown');
    }
    if (f.status !== 'signing') {
      throw new CopyError(`This follow is ${f.status}; its permission is no longer asked for`, 'trade.copy_state_invalid');
    }
    await this.deps.door.submit(principal, actionKey, signature);
    return this.advance(principal, (await this.deps.store.find(followId))!, await this.deps.door.venue());
  }

  /** The wallet rejected the permission: no follow is written. Only before it was signed, so it can never be sent. */
  async abandon(principal: Principal, followId: string): Promise<VenueFollowView> {
    const f = owned(principal, await this.deps.store.find(followId), followId);
    if (f.status !== 'signing') throw new CopyError(`This follow is ${f.status}`, 'trade.copy_state_invalid');
    if ((await this.deps.door.stored(principal, copyVenueApproveKey(followId)))?.signature) {
      throw new CopyError('The permission is signed, so it is read back from the venue, not abandoned', 'trade.copy_venue_signed');
    }
    return this.advance(principal, await this.deps.store.abandon(followId), await this.deps.door.venue());
  }

  /**
   * Read the follow up to the venue's record: a signing follow becomes active once the venue lists its agent permission
   * on the account, and the follow is then written with the request's terms; abandoned once the venue refused it.
   * Prepares at most one action, stored before it is returned.
   */
  private async advance(principal: Principal, start: VenueFollowRecord, venue: UserVenue): Promise<VenueFollowView> {
    let f = start;
    let next: VenueFollowNext | null = null;
    let refusal: VenueRefusal | null = null;
    let onVenue = false;
    if (f.status !== 'abandoned') {
      onVenue = (await venue.agents(this.main(f))).value.some((a) => a.address.toLowerCase() === f.agentAddress);
    }
    if (f.status === 'signing') {
      if (onVenue) f = await this.deps.store.activate(f.followId, this.deps.now());
      else {
        const o = (await this.deps.door.stored(principal, copyVenueApproveKey(f.followId)))?.lastOutcome ?? null;
        if (o?.definite && !o.accepted) {
          refusal = o.refusal;
          f = await this.deps.store.abandon(f.followId);
        } else {
          const answer = await this.deps.door.prepare(principal, {
            owner: f.owner,
            subAccount: null,
            signer: { role: 'owner', address: f.owner },
            intent: {
              kind: 'approve_agent',
              agentAddress: f.agentAddress,
              agentName: `copy-${f.followId.slice(0, 8)}`,
              validUntil: f.expiresAt,
            },
            actionKey: copyVenueApproveKey(f.followId),
          });
          next = { actionKey: answer.actionKey, step: 'approve_agent', prepared: answer.prepared, signed: answer.signed };
        }
      }
    }
    const follow = f.status === 'active' ? await this.deps.copy.startVenueFollow(principal, f.request) : null;
    return {
      followId: f.followId,
      status: f.status,
      venueId: f.venueId,
      venueName: venue.venue.displayName,
      owner: f.owner,
      agentAddress: f.agentAddress,
      asset: f.asset,
      cap: formatAmount(f.cap),
      permissionOnVenue: onVenue,
      next,
      refusal,
      follow,
      test: isTestVenue(venue.venue),
    };
  }

  // ── the lead's venue account (the operator who lists the lead) ─────────────────────────────────────────────────

  async setLeadAccount(principal: Principal, input: { leaderRef: string; owner: string }): Promise<VenueLeadRecord> {
    requireOperatorWrite(principal);
    const owner = input.owner.trim().toLowerCase();
    if (!ADDRESS_RE.test(owner))
      throw new CopyError('owner must be a venue account address (0x and 40 hex)', 'trade.copy_envelope_invalid');
    const leaderUserId = await this.deps.copy.leaderIdOf(input.leaderRef);
    const venue = await this.deps.door.venue();
    return this.deps.store.setLead({ leaderUserId, venueId: venue.venue.id, owner, setBy: principal.userId, setAt: this.deps.now() });
  }

  // ── the copy driver's ports (copy-service.ts) ───────────────────────────────────────────────────────────────────

  /** The lead's own fills on the venue after `after`, oldest first. A lead with no venue account set has none. */
  async listLeaderFillsSince(
    leaderId: string,
    after: { readonly at: Date; readonly fillId: string | null },
    limit: number,
  ): Promise<{ fillId: string; marketId: string; at: Date }[]> {
    const lead = await this.deps.store.lead(leaderId);
    if (!lead) return [];
    const venue = await this.deps.door.venue();
    if (venue.venue.id !== lead.venueId) return [];
    const fills = (await venue.fills(this.main(lead), after.at)).value;
    const rows = fills
      .map((fill) => ({ id: venueLeadFillId(lead.venueId, lead.owner, fill.fillId), fill }))
      .filter(({ id, fill }) => {
        const t = fill.filledAt.getTime();
        return t > after.at.getTime() || (t === after.at.getTime() && id > (after.fillId ?? ''));
      })
      .sort((a, b) => a.fill.filledAt.getTime() - b.fill.filledAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, limit);
    for (const r of rows) this.leadFills.set(r.id, { leaderId, fill: r.fill });
    return rows.map((r) => ({ fillId: r.id, marketId: r.fill.symbol, at: r.fill.filledAt }));
  }

  /** One lead fill by its copy id, as the venue reports it. */
  async lookupLeaderFill(id: string) {
    let known = this.leadFills.get(id);
    if (!known) {
      const parsed = parseLeadFillId(id);
      if (!parsed) return null;
      const venue = await this.deps.door.venue();
      if (venue.venue.id !== parsed.venueId) return null;
      const since = new Date(this.deps.now().getTime() - LOOKUP_WINDOW_MS);
      const fill = (await venue.fills({ venueId: parsed.venueId, owner: parsed.owner, subAccount: null }, since)).value.find(
        (x) => x.fillId === parsed.fillId,
      );
      const leaderId = await this.leaderOfOwner(parsed.venueId, parsed.owner);
      if (!fill || !leaderId) return null;
      known = { leaderId, fill };
    }
    const { fill } = known;
    return {
      fillId: id,
      userId: known.leaderId,
      marketId: fill.symbol,
      side: fill.side,
      qty: fill.amount,
      notional: mul(fill.amount, fill.price, 'floor'),
      price: fill.price,
    };
  }

  private async leaderOfOwner(venueId: string, owner: string): Promise<string | null> {
    const lead = await this.deps.store.leadByOwner(venueId, owner);
    return lead?.leaderUserId ?? null;
  }

  /** The venue market's lot, so a fixed amount is stepped down to what the venue takes. */
  async inspectMarket(symbol: string): Promise<{ paper: boolean; lotSize?: Amount } | null> {
    const venue = await this.deps.door.venue();
    const m = (await venue.markets(null)).value.find((x) => x.symbol === symbol);
    return m ? { paper: false, lotSize: m.lotSize } : null;
  }

  /**
   * A copy, as the follower's own venue order, placed by the follow's agent key. Our policy has already held it to the
   * follow's limits and cap (copy-service.ts `planMirrorForFollow`, `claimMirrorFill`); this signs only a limit order on
   * the follower's own main account, signed by the follow's own key, and nothing else.
   */
  async placeFollowerOrder(principal: Principal, input: PlaceFollowerOrderInput): Promise<{ orderId: string }> {
    const followId = input.followId ?? '';
    const f = await this.deps.store.find(followId);
    if (!f || f.userId !== principal.userId || f.status !== 'active') {
      throw new CopyError(
        'This follow has no agent permission signed on the venue, so nothing is copied',
        'trade.copy_session_key_missing',
      );
    }
    const key = `${COPY_VENUE_MIRROR_PREFIX}${input.clientOrderId.replace(/^copy-mirror:/, '')}`;
    // Admitted before the key signs or a signed copy is sent again: a refusal here sends nothing.
    await this.deps.admitCopy(
      principal,
      `order:${key}`,
      {
        followId: f.followId,
        owner: f.owner,
        agentAddress: f.agentAddress,
        symbol: input.symbol ?? null,
        side: input.side,
        qty: formatAmount(input.qty),
        price: formatAmount(input.price),
        clientOrderKey: key,
      },
      f.followId,
    );
    const venue = await this.deps.door.venue();
    const stored = await this.deps.door.stored(principal, key);
    let signature = stored?.signature ?? null;
    if (!signature) {
      const market = (await venue.markets(null)).value.find((m) => m.symbol === input.symbol);
      if (!market) throw new CopyError(`${venue.venue.displayName} lists no ${input.symbol}`, 'trade.copy_market_not_permitted');
      const intent: PlaceUserOrderIntent = {
        kind: 'place_order',
        symbol: market.symbol,
        side: input.side,
        type: 'limit',
        amount: input.qty,
        // The leader's price on the venue's tick: a buy never above it, a sell never below it.
        price: input.side === 'buy' ? toTick(input.price, market.tickSize, 'down') : toTick(input.price, market.tickSize, 'up'),
        timeInForce: 'GTC',
        reduceOnly: false,
        clientOrderKey: key,
        builderFee: null,
      };
      const answer = await this.deps.door.prepare(
        principal,
        { owner: f.owner, subAccount: null, signer: { role: 'agent', address: f.agentAddress }, intent },
        { ownWorstPrice: true },
      );
      const p = answer.prepared;
      // The invariant this port keeps: a copy names the follower's own main account and the follow's own key, nothing else.
      if (
        p.account.owner.toLowerCase() !== f.owner ||
        p.account.subAccount !== null ||
        p.signer.role !== 'agent' ||
        p.signer.address.toLowerCase() !== f.agentAddress ||
        p.intent.kind !== 'place_order'
      ) {
        throw new Error(`copy ${key} was prepared outside its follow's account or key; nothing is signed`);
      }
      signature = answer.signed && answer.reused ? ((await this.deps.door.stored(principal, key))?.signature ?? null) : null;
      if (!signature) {
        const agent = agentKeyFor(this.seed(), f.userId, `copy:${f.followId}`);
        if (agent.address.toLowerCase() !== f.agentAddress)
          throw new Error(`the agent key of follow ${f.followId} does not derive to its address`);
        signature = {
          digest: p.digest,
          signature: await agent.signTypedData(p.typedData as TypedDataDefinition),
          signedBy: f.agentAddress,
        };
      }
    } else {
      const read = await this.deps.door.orderByKey(principal, key);
      if (read.state === 'accepted') return { orderId: read.venueClientOrderId ?? key };
      if (read.state === 'refused') {
        throw new CopyError(
          `${venue.venue.displayName} refused the copy: ${read.refusal?.detail ?? 'no reason given'}`,
          'trade.copy_venue_refused',
        );
      }
    }
    const sent = await this.deps.door.submit(principal, key, signature);
    if (sent.outcome.definite && !sent.outcome.accepted) {
      throw new CopyError(`${venue.venue.displayName} refused the copy: ${sent.outcome.refusal.detail}`, 'trade.copy_venue_refused');
    }
    const cloid = (await this.deps.door.stored(principal, key))?.prepared.venueClientOrderId ?? key;
    return { orderId: cloid };
  }

  /** #8: the follow's copies on the follower's own venue account, each read back from the venue by its key. Reads only. */
  async copiedOrders(
    principal: Principal,
    followId: string,
    mirrors: readonly { fillId: string; clientOrderId: string }[],
  ): Promise<{
    readonly venueName: string;
    readonly test: boolean;
    readonly orders: readonly VenueCopiedOrder[];
  }> {
    const f = owned(principal, await this.deps.store.find(followId), followId);
    const venue = await this.deps.door.venue();
    const since = f.activeAt ?? f.createdAt;
    const fills = (await venue.fills(this.main(f), since)).value;
    const out: VenueCopiedOrder[] = [];
    for (const m of mirrors) {
      const key = `${COPY_VENUE_MIRROR_PREFIX}${m.clientOrderId.replace(/^copy-mirror:/, '')}`;
      const read = await this.deps.door.orderByKey(principal, key);
      const cloid = read.venueClientOrderId;
      out.push({
        leaderFillId: m.fillId,
        actionKey: key,
        venueClientOrderId: cloid,
        state: read.state,
        order: read.order,
        fills: cloid ? fills.filter((x) => x.venueClientOrderId === cloid) : [],
        signedBy: f.agentAddress,
        asOf: read.asOf,
      });
    }
    return { venueName: venue.venue.displayName, test: isTestVenue(venue.venue), orders: out };
  }
}

/** `x` on a whole number of ticks, down or up. */
function toTick(x: Amount, tick: Amount, way: 'down' | 'up'): Amount {
  const steps = div(x, tick, way === 'down' ? 'floor' : 'ceil');
  const ONE = parseAmount('1');
  const whole = steps - (steps % ONE);
  const up = way === 'up' && whole !== steps ? whole + ONE : whole;
  return mul(up, tick, 'floor');
}
