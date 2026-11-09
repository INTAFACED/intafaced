import type { Principal } from '@intafaced/auth';
import type { AsOf, UserVenueAgent, VenueRefusal, VenueSubmitOutcome } from '@intafaced/venue-contracts';
import type { PreparedActionStore, StoredVenueAction } from './prepared-action-store.js';
import {
  SESSION_KEY_END_PREFIX,
  SESSION_KEY_PREFIX,
  UserVenueDoorError,
  assertInteractive,
  type PreparedAnswer,
  type UserVenueDoor,
} from './user-venue-door.js';

/**
 * THE TRADING SESSION'S KEY (J-wallet-22 #8; slice D-venue-09, project-state operation-zero/modules/derivatives/specs/
 * deriv-venue.md): one owner approval per session for a key that trades and never withdraws.
 *
 *   · The key is made fresh on the person's device, beside their wallet provider's client, and never reaches us in a
 *     form that can sign: these routes take its ADDRESS only.
 *   · The owner wallet signs `approve_agent` for it once (after the person's passkey, at their provider), unnamed, on the
 *     person's main venue account, with this session's expiry. We store only what the door stores for any action: the
 *     prepared approval (the agent address and its expiry), its signature, and the venue's answer, under the business
 *     key `session-key:<accountId>:<venueId>:<sessionId>`. `accountId` is the person's INTAFACED account; `sessionId` is
 *     their sign-in (the token's `fam`, one per sign-in, kept across refreshes) and the count of trading sessions
 *     started in it (`<fam>.<n>`).
 *   · Orders in the session are prepared through the plain door with `signer: { role: 'agent' }` and signed on the
 *     device by the session key, with no passkey. Withdrawals and approvals stay owner-only: the door refuses them from
 *     an agent key `agent_not_permitted` before anything else (user-venue.ts `OWNER_ONLY_INTENTS`).
 *   · Ending the session signs `revoke_agent` (under `session-key-end:` with the same tail), or the expiry ends it. A
 *     sign-out ends it for the device: the next sign-in is a new `sessionId`, so the old key is never this session's.
 *   · A new session always approves a new key. An address once used as a session key is refused for good
 *     (`trade.venue_session_key_reused`), on these routes and on the plain door (user-venue.ts:177-180: a venue that
 *     prunes nonces could accept a replay of an old key's actions).
 *   · One unnamed agent per account (Hyperliquid's "Nonces and API wallets", read by S3b on 9 Nov 2026: a new unnamed API
 *     wallet deregisters the existing one): a session started on a second device replaces the first device's key, and
 *     the first device's status says `replaced`. A named agent (the assistant's key, J-agents-21, on its own
 *     sub-account) is never replaced by a session key, which is always unnamed and always on the main account.
 *
 * The venue is the record: every state below is read against the venue's own `agents()` list, with its time.
 */

/** How long a session key's approval lasts on the venue. A sign-out or End session ends it sooner. */
export const SESSION_KEY_TTL_MS = 8 * 60 * 60 * 1000;

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

export type SessionKeyState =
  /** Prepared; the owner wallet has not signed the approval yet. Nothing was sent. */
  | 'awaiting_signature'
  /** Signed and sent, with no definite answer yet, and the venue does not list the key: re-send the stored approval. */
  | 'approving'
  /** The venue lists the key and its expiry is ahead. Orders may be signed by it. */
  | 'live'
  /** The expiry passed (the venue's own record, or the approval's). */
  | 'expired'
  /** Ended by the person (`revoke_agent` accepted), or the venue no longer lists it and no later session explains why. */
  | 'ended'
  /** A later session's key, on this device or another, took the account's one unnamed agent slot. */
  | 'replaced'
  /** The venue refused the approval. Nothing is approved. */
  | 'refused';

export interface SessionKeyView {
  readonly sessionId: string;
  readonly actionKey: string;
  readonly endActionKey: string;
  readonly venueId: string;
  readonly owner: string;
  readonly agentAddress: string;
  readonly validUntil: Date | null;
  readonly state: SessionKeyState;
  /** Set when `state` is `replaced`: whether the session that replaced it was started in this sign-in or another. */
  readonly replacedBy: 'this_sign_in' | 'another_sign_in' | null;
  readonly refusal: VenueRefusal | null;
  /** The approval's last answer from the venue, as stored. */
  readonly venueAnswer: VenueSubmitOutcome | null;
  /** The venue's own entry for the key, when it lists it. */
  readonly onVenue: UserVenueAgent | null;
}

export interface SessionStatus {
  readonly venueId: string;
  readonly owner: string;
  /** The latest trading session of THIS sign-in, or `null` when none was started in it. */
  readonly current: SessionKeyView | null;
  /** When the venue's `agents()` list was read. */
  readonly asOf: Date;
}

export interface SessionKeysDeps {
  readonly door: UserVenueDoor;
  readonly store: Pick<PreparedActionStore, 'listByPrefix'>;
  readonly now: () => Date;
}

interface Parsed {
  readonly row: StoredVenueAction;
  readonly sid: string;
  readonly n: number;
  readonly agentAddress: string;
  readonly validUntil: Date | null;
}

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export class SessionKeys {
  constructor(private readonly deps: SessionKeysDeps) {}

  private sid(principal: Principal): string {
    // The sign-in (`fam`: one per sign-in, the same across its refreshes; `sid` changes on every refresh). An API key or a
    // sub-account token has no sign-in of its own, and may never approve an agent.
    assertInteractive(principal, 'approve_agent');
    const sid = (principal.fam ?? '').trim();
    if (!sid || !/^[A-Za-z0-9_-]{1,128}$/.test(sid)) {
      throw new UserVenueDoorError(
        'a trading session belongs to a signed-in session, and this credential names none',
        'trade.venue_session_unavailable',
        403,
      );
    }
    return sid;
  }

  private prefix(principal: Principal, venueId: string, end = false) {
    return `${end ? SESSION_KEY_END_PREFIX : SESSION_KEY_PREFIX}${principal.userId}:${venueId}:`;
  }

  /** This person's session-key approvals on this venue account, oldest first. */
  private async approvals(principal: Principal, venueId: string, owner: string): Promise<Parsed[]> {
    const prefix = this.prefix(principal, venueId);
    const rows = await this.deps.store.listByPrefix(principal.userId, prefix);
    const out: Parsed[] = [];
    for (const row of rows) {
      const intent = row.prepared.intent;
      if (intent.kind !== 'approve_agent' || !sameAddress(row.prepared.account.owner, owner)) continue;
      const m = /^(.+)\.(\d+)$/.exec(row.businessKey.slice(prefix.length));
      if (!m) continue;
      out.push({ row, sid: m[1]!, n: Number(m[2]), agentAddress: intent.agentAddress.toLowerCase(), validUntil: intent.validUntil });
    }
    return out;
  }

  /** Whether the venue took this approval: a definite yes, or the venue lists the key now. */
  private landed(p: Parsed, listed: ReadonlyMap<string, UserVenueAgent>): boolean {
    const answer = p.row.lastOutcome;
    return listed.has(p.agentAddress) || (answer?.definite === true && answer.accepted);
  }

  private view(
    p: Parsed,
    all: readonly Parsed[],
    ends: ReadonlyMap<string, StoredVenueAction>,
    agents: AsOf<readonly UserVenueAgent[]>,
  ): SessionKeyView {
    const listed = new Map(agents.value.map((a) => [a.address.toLowerCase(), a]));
    const onVenue = listed.get(p.agentAddress) ?? null;
    const sessionId = `${p.sid}.${p.n}`;
    const tail = p.row.businessKey.slice(SESSION_KEY_PREFIX.length);
    const answer = p.row.lastOutcome;
    const base = {
      sessionId,
      actionKey: p.row.businessKey,
      endActionKey: `${SESSION_KEY_END_PREFIX}${tail}`,
      venueId: p.row.prepared.venueId,
      owner: p.row.prepared.account.owner.toLowerCase(),
      agentAddress: p.agentAddress,
      validUntil: onVenue ? onVenue.validUntil : p.validUntil,
      replacedBy: null,
      refusal: null,
      venueAnswer: answer,
      onVenue,
    } satisfies Omit<SessionKeyView, 'state'>;
    const end = ends.get(tail);
    const endAnswer = end?.lastOutcome;
    if (endAnswer?.definite && endAnswer.accepted && !onVenue) return { ...base, state: 'ended' };
    if (!p.row.signature) return { ...base, state: 'awaiting_signature' };
    if (answer?.definite && !answer.accepted) return { ...base, state: 'refused', refusal: answer.refusal };
    const until = base.validUntil;
    if (onVenue) return { ...base, state: until !== null && until.getTime() <= agents.asOf.getTime() ? 'expired' : 'live' };
    // Not on the venue. If it never landed, the approval is still out: re-send the stored bytes and read back.
    if (!this.landed(p, listed)) return { ...base, state: 'approving' };
    if (until !== null && until.getTime() <= agents.asOf.getTime()) return { ...base, state: 'expired' };
    // It landed and is gone. A later session's key that landed explains it: the venue keeps one unnamed agent. `all` is
    // oldest first (the store's order), so "later" is a later place in it.
    const later = all.slice(all.indexOf(p) + 1).find((q) => this.landed(q, listed));
    if (later) return { ...base, state: 'replaced', replacedBy: later.sid === p.sid ? 'this_sign_in' : 'another_sign_in' };
    return { ...base, state: 'ended' };
  }

  private async read(principal: Principal, ownerAddress: string) {
    const venue = await this.deps.door.venue();
    const account = await this.deps.door.account(ownerAddress);
    const all = await this.approvals(principal, venue.venue.id, account.owner);
    const endPrefix = this.prefix(principal, venue.venue.id, true);
    const ends = new Map(
      (await this.deps.store.listByPrefix(principal.userId, endPrefix)).map((row) => [
        `${principal.userId}:${venue.venue.id}:${row.businessKey.slice(endPrefix.length)}`,
        row,
      ]),
    );
    const agents = await venue.agents(account);
    return { venue, account, all, ends, agents };
  }

  /** The latest trading session of this sign-in, read against the venue's agent list now. */
  async status(principal: Principal, owner: string): Promise<SessionStatus> {
    const sid = this.sid(principal);
    const { venue, account, all, ends, agents } = await this.read(principal, owner);
    const mine = all.filter((p) => p.sid === sid);
    const latest = mine.length ? mine.reduce((a, b) => (b.n > a.n ? b : a)) : null;
    return {
      venueId: venue.venue.id,
      owner: account.owner,
      current: latest ? this.view(latest, all, ends, agents) : null,
      asOf: agents.asOf,
    };
  }

  /**
   * Prepare the owner's one approval for a fresh session key. The same key asked again while its approval is out is the
   * same stored approval (one prompt); a key used before, or already on the venue, is refused; an approval that was
   * sent and has no answer yet must be read back (re-sent) before another session starts.
   */
  async start(principal: Principal, owner: string, agentAddress: string): Promise<PreparedAnswer & { sessionId: string }> {
    const sid = this.sid(principal);
    const address = (agentAddress ?? '').trim().toLowerCase();
    if (!ADDRESS_RE.test(address)) {
      throw new UserVenueDoorError('agentAddress must be the session key’s address (0x and 40 hex)', 'trade.venue_request_invalid', 400);
    }
    const { venue, account, all, ends, agents } = await this.read(principal, owner);
    if (sameAddress(address, account.owner)) {
      throw new UserVenueDoorError('the owner wallet cannot be its own session key', 'trade.venue_request_invalid', 400);
    }
    const mine = all.filter((p) => p.sid === sid);
    const latest = mine.length ? mine.reduce((a, b) => (b.n > a.n ? b : a)) : null;
    const latestView = latest ? this.view(latest, all, ends, agents) : null;
    const signer = { role: 'owner' as const, address: account.owner };
    const again = (p: Parsed) =>
      this.deps.door.prepare(
        principal,
        {
          owner: account.owner,
          signer,
          intent: { kind: 'approve_agent', agentAddress: p.agentAddress, agentName: '', validUntil: p.validUntil },
          actionKey: p.row.businessKey,
        },
        { sessionKey: true },
      );

    // This sign-in's latest approval for this very key, still out or live: the same stored action, never a second prompt.
    if (
      latest &&
      latest.agentAddress === address &&
      (latestView?.state === 'awaiting_signature' || latestView?.state === 'approving' || latestView?.state === 'live')
    ) {
      return { ...(await again(latest)), sessionId: `${latest.sid}.${latest.n}` };
    }
    if (all.some((p) => p.agentAddress === address) || agents.value.some((a) => sameAddress(a.address, address))) {
      throw new UserVenueDoorError(
        `${address} was approved before on this account; a new session needs a new key, never one used before`,
        'trade.venue_session_key_reused',
        409,
      );
    }
    if (latestView?.state === 'approving') {
      throw new UserVenueDoorError(
        'the last session’s approval was sent and has no answer yet: send it again (the same signed approval) to read it back first',
        'trade.venue_session_pending',
        409,
      );
    }
    const n = mine.reduce((m, p) => Math.max(m, p.n), 0) + 1;
    const key = `${this.prefix(principal, venue.venue.id)}${sid}.${n}`;
    const validUntil = new Date(this.deps.now().getTime() + SESSION_KEY_TTL_MS);
    const answer = await this.deps.door.prepare(
      principal,
      {
        owner: account.owner,
        signer,
        intent: { kind: 'approve_agent', agentAddress: address, agentName: '', validUntil },
        actionKey: key,
      },
      { sessionKey: true },
    );
    return { ...answer, sessionId: `${sid}.${n}` };
  }

  /** Prepare the owner's `revoke_agent` for this sign-in's session key. Ending a session that is not on the venue is refused. */
  async end(principal: Principal, owner: string): Promise<PreparedAnswer & { sessionId: string }> {
    const status = await this.status(principal, owner);
    const current = status.current;
    if (!current || !current.onVenue) {
      throw new UserVenueDoorError('this sign-in has no trading session on the venue to end', 'trade.venue_session_none', 409);
    }
    const answer = await this.deps.door.prepare(
      principal,
      {
        owner: status.owner,
        signer: { role: 'owner', address: status.owner },
        intent: { kind: 'revoke_agent', agentAddress: current.agentAddress },
        actionKey: current.endActionKey,
      },
      { sessionKey: true },
    );
    return { ...answer, sessionId: current.sessionId };
  }
}
