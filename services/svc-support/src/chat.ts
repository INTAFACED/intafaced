/**
 * Live support chat (SP-chat-01, J-support-public-05).
 *
 * A customer chats with a person from the site or the app, signed in or as a guest; a closed chat becomes one request
 * holding the transcript. Our own channel, so it is built, never labelled not connected. New messages are read with a
 * cursor every `SUPPORT_CHAT_POLL_MS`; a push channel would be a transport change on svc-ws and svc-edge, not here.
 *
 * Identity. A session belongs to the signed principal, or to the account a claim names when svc-support signed that claim
 * for that account (`identityToken`, short-lived, the owner's `SUPPORT_CHAT_IDENTITY_TTL_SECONDS`). Any other claim fails:
 * a signed-in caller keeps their own identity, a caller with no session of ours is a guest. The body never names the owner.
 * Every session has an access token (only its hash is kept), the way back in for a guest or an embedding page.
 *
 * Keys, never clocks or random ids: an open is keyed by its `clientKey`, a message by (session, `clientMessageId`), the
 * request a chat becomes by `chat:<session>`. Close writes first and acts second: the session is closed, then the request is
 * made under its key, then linked; a crash between leaves a closed session that the same close finishes.
 *
 * Owner values, each blank by default and refused by name: the per-chat message rate and its window
 * (`support.chat_rate_limit_unset`), the identity claim lifetime (`support.chat_identity_ttl_unset`) and the pre-chat
 * fields (blank asks for a free-text first message only). A guest's address is sealed with the guest address key and
 * erased after the guest retention, as a guest request's is.
 *
 * Continuing a chat by email needs a mailbox, which this build does not connect: it answers `vendor.email` and leaves the
 * chat as it was.
 */
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Sql } from 'postgres';
import {
  campaignParticipantSchema,
  serviceCallSigner,
  SUPPORT_CHAT_AGENT_NOT_ONLINE,
  SUPPORT_CHAT_AGENT_UNAVAILABLE,
  SUPPORT_CHAT_ALREADY_ACCEPTED,
  SUPPORT_CHAT_CLOSED,
  SUPPORT_CHAT_IDENTITY_INVALID,
  SUPPORT_CHAT_IDENTITY_TTL_UNSET,
  SUPPORT_CHAT_MESSAGE_CONFLICT,
  SUPPORT_CHAT_NOT_ACCEPTED,
  SUPPORT_CHAT_NOT_FOUND,
  SUPPORT_CHAT_PAGE_MAX,
  SUPPORT_CHAT_POLL_MS,
  SUPPORT_CHAT_PRECHAT_INVALID,
  SUPPORT_CHAT_RATE_LIMITED,
  SUPPORT_CHAT_RATE_LIMIT_UNSET,
  SUPPORT_GUEST_ADDRESS_KEY_UNSET,
  SUPPORT_GUEST_RETENTION_UNSET,
  type ServiceAuthMode,
  type ServiceSigner,
  type SupportChatAgents,
  type SupportChatAvailability,
  type SupportChatDeskSession,
  type SupportChatEmailResult,
  type SupportChatEnquiry,
  type SupportChatIdentityToken,
  type SupportChatMessage,
  type SupportChatOpenInput,
  type SupportChatOpenResult,
  type SupportChatPrechatField,
  type SupportChatProfileType,
  type SupportChatSession,
  type SupportChatStatus,
  type SupportRequestSource,
  type SupportTicket,
} from '@intafaced/contracts';
import { seal } from './guest-requests.js';
import { refuseCommentSecret, SupportError } from './support-service.js';
import type { StaffMember } from './desk-staff.js';

// ---------------------------------------------------------------------------------------------------------------------
// What the chat needs from the rest of the service.

/** The part of the support service a chat uses: the desk's members as they read now, and the request a chat becomes. */
export interface ChatTicketDesk {
  listStaff(): Promise<StaffMember[]>;
  createTicket(input: { userId: string; category: 'other'; subject: string; body: string; clientRequestId: string }): Promise<SupportTicket>;
}

/** The profile type of an account, read from svc-identity per chat; null when identity could not answer. */
export interface ChatProfileSource {
  profileOf(userId: string): Promise<SupportChatProfileType | null>;
}

/** Identity not wired: every account reads unread, never an invented type. */
export const UNREAD_PROFILES: ChatProfileSource = { profileOf: async () => null };

/**
 * svc-identity's `GET /internal/campaign-participant/:userId` (`campaignParticipantSchema`), which answers the account
 * type. S2S, read per chat and never kept as a customer copy; any failure or an answer for another account is unread.
 */
export function createChatProfileClient(
  baseUrl: string,
  internalSecret: string,
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode },
): ChatProfileSource {
  if (!internalSecret) return UNREAD_PROFILES;
  const url = baseUrl.replace(/\/$/, '');
  const sign = serviceCallSigner({ service: 'svc-support', audience: 'svc-identity', legacySecret: internalSecret, s2s });
  return {
    async profileOf(userId) {
      try {
        const target = `${url}/internal/campaign-participant/${encodeURIComponent(userId)}`;
        const response = await fetch(target, {
          method: 'GET',
          headers: { 'content-type': 'application/json', ...sign('', { method: 'GET', url: new URL(target), contentType: 'application/json' }) },
        });
        if (!response.ok) return null;
        const parsed = campaignParticipantSchema.safeParse(await response.json());
        if (!parsed.success || parsed.data.userId !== userId) return null;
        return parsed.data.accountType;
      } catch {
        return null;
      }
    },
  };
}

export interface ChatSettings {
  /** Customer messages one chat may send per window. */
  readonly rateLimit: number | null;
  readonly rateWindowSeconds: number | null;
  /** How long a signed identity claim works. */
  readonly identityTtlSeconds: number | null;
  /** The pre-chat fields the owner asks a guest for; empty means a free-text first message only. */
  readonly prechatFields: readonly SupportChatPrechatField[];
  /** The guest address key (32 bytes as hex) and retention, shared with guest requests. */
  readonly addressKey: string | null;
  readonly retentionDays: number | null;
  /** Signs identity claims. Derived from the service's internal secret; never sent anywhere. */
  readonly claimSecret: string;
}

// ---------------------------------------------------------------------------------------------------------------------
// Pure rules.

/** Who can answer now, from the desk's members as they read (the heartbeat window already folded in). */
export function agentsNow(staff: readonly Pick<StaffMember, 'availability'>[]): SupportChatAgents {
  if (staff.some((m) => m.availability === 'online')) return 'online';
  if (staff.some((m) => m.availability === 'busy')) return 'busy';
  return 'offline';
}

const b64 = (value: string | Buffer) => Buffer.from(value).toString('base64url');
const mac = (secret: string, payload: string) => createHmac('sha256', secret).update(`support.chat.identity.v1:${payload}`).digest();
export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** A claim naming one account, signed by svc-support, working until `expiresAt`. */
export function signIdentityClaim(secret: string, userId: string, expiresAt: Date): string {
  const payload = b64(JSON.stringify({ u: userId, e: Math.floor(expiresAt.getTime() / 1000), n: randomBytes(9).toString('base64url') }));
  return `${payload}.${b64(mac(secret, payload))}`;
}

/** The account a claim names, or null when it is not one svc-support signed, is malformed or has expired. */
export function verifyIdentityClaim(secret: string, claim: string, now: Date): string | null {
  const [payload = '', signature = '', extra] = claim.split('.');
  if (!payload || !signature || extra !== undefined) return null;
  const expected = mac(secret, payload);
  const given = Buffer.from(signature, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { u?: unknown; e?: unknown };
    if (typeof body.u !== 'string' || typeof body.e !== 'number') return null;
    if (body.e * 1000 <= now.getTime()) return null;
    return body.u;
  } catch {
    return null;
  }
}

export type ChatOwner = {
  userId: string | null;
  claim: 'none' | 'verified' | 'refused';
  claimRefusal: string | null;
};

/**
 * Who a new session belongs to. The signed principal wins; a claim counts only when svc-support signed it and, with a
 * principal present, names that same account. A claim that fails is recorded as refused: the principal keeps its own
 * identity, and with no principal the session is a guest.
 */
export function ownerOf(principalUserId: string | null, claim: string | undefined, verify: (claim: string) => string | null): ChatOwner {
  if (claim === undefined) return { userId: principalUserId, claim: 'none', claimRefusal: null };
  const named = verify(claim);
  if (named === null || (principalUserId !== null && named !== principalUserId))
    return { userId: principalUserId, claim: 'refused', claimRefusal: SUPPORT_CHAT_IDENTITY_INVALID };
  return { userId: named, claim: 'verified', claimRefusal: null };
}

/** The transcript as a request body: one line per message, oldest first. Past the body limit it says where the rest is. */
export function transcriptText(messages: readonly Pick<SupportChatMessage, 'author' | 'body' | 'createdAt'>[], max = 10_000): string {
  const lines = messages.map((m) => `[${m.createdAt}] ${m.author === 'agent' ? 'Support' : 'Customer'}: ${m.body}`);
  const full = `Chat transcript (${messages.length} messages)\n\n${lines.join('\n')}`;
  if (full.length <= max) return full;
  const tail = `\n… the rest of the ${messages.length} messages is in the chat transcript on this request.`;
  return full.slice(0, max - tail.length) + tail;
}

// ---------------------------------------------------------------------------------------------------------------------
// The book: where sessions, messages and enquiries are kept.

export type SessionRow = {
  id: string;
  clientKey: string;
  userId: string | null;
  accessHash: string;
  claim: 'none' | 'verified' | 'refused';
  claimRefusal: string | null;
  status: SupportChatStatus;
  agentId: string | null;
  acceptedAt: string | null;
  profileType: SupportChatProfileType | null;
  profileRead: 'read' | 'unread' | 'guest';
  ticketId: string | null;
  lastSeq: number;
  createdAt: string;
  closedAt: string | null;
  /** The fingerprint of what opened it, so a replayed key with different content is refused. */
  fingerprint: string;
};

export type EnquiryRow = { name: string | null; addressHash: string | null; addressSealed: string | null; eraseAfter: string | null };

export type NewMessage = { author: 'customer' | 'agent'; authorId: string | null; clientMessageId: string; body: string; at: string };

export type Rate = { limit: number; windowSeconds: number };

export interface ChatBook {
  /** Stores a new session with its first message (and enquiry), or answers the session the key already opened. */
  open(
    session: Omit<SessionRow, 'id' | 'lastSeq' | 'ticketId' | 'closedAt' | 'agentId' | 'acceptedAt' | 'status'>,
    first: NewMessage,
    enquiry: EnquiryRow | null,
    /** The opening message counts against the rate like any other. */
    rate: Rate,
  ): Promise<{ session: SessionRow; first: SupportChatMessage; created: boolean }>;
  get(sessionId: string): Promise<SessionRow | null>;
  /** The session a key (its hash) opened, or null. */
  byClientKey(clientKeyHash: string): Promise<SessionRow | null>;
  /**
   * Adds a message under the session lock: refused on a closed chat, a replayed key answers the stored message, and a
   * customer message counts against the rate (the window of `at`).
   */
  add(sessionId: string, message: NewMessage, rate: Rate | null): Promise<SupportChatMessage>;
  after(sessionId: string, after: number, limit: number): Promise<SupportChatMessage[]>;
  /** Sets the agent on a waiting session. Refuses one that already has an agent or is closed. */
  accept(sessionId: string, agentId: string, at: string): Promise<SessionRow>;
  /** Marks the session closed (once; a second close changes nothing). */
  close(sessionId: string, by: string, at: string): Promise<SessionRow>;
  /** Links the closed session to its request and writes the request's source row (once). */
  link(sessionId: string, ticketId: string): Promise<SessionRow>;
  openSessions(limit: number): Promise<SessionRow[]>;
  enquiries(sessionId: string | undefined, limit: number): Promise<SupportChatEnquiry[]>;
  sourceOf(ticketId: string): Promise<SessionRow | null>;
  eraseDue(now: string, batch: number): Promise<number>;
}

const windowOf = (at: string, seconds: number) => Math.floor(Date.parse(at) / 1000 / seconds);

export class MemoryChatBook implements ChatBook {
  readonly sessions = new Map<string, SessionRow>();
  readonly messages = new Map<string, SupportChatMessage[]>();
  readonly enquiryRows = new Map<string, EnquiryRow & { id: string; createdAt: string }>();
  readonly sources = new Map<string, string>();
  private readonly rates = new Map<string, number>();

  async open(session: Parameters<ChatBook['open']>[0], first: NewMessage, enquiry: EnquiryRow | null, rate: Rate) {
    const prior = [...this.sessions.values()].find((s) => s.clientKey === session.clientKey);
    if (prior) return { session: prior, first: this.messages.get(prior.id)![0]!, created: false };
    const row: SessionRow = { ...session, id: randomUUID(), status: 'waiting', agentId: null, acceptedAt: null, ticketId: null, lastSeq: 1, closedAt: null };
    const message: SupportChatMessage = {
      id: randomUUID(),
      sessionId: row.id,
      seq: 1,
      author: first.author,
      clientMessageId: first.clientMessageId,
      body: first.body,
      createdAt: first.at,
    };
    this.sessions.set(row.id, row);
    this.messages.set(row.id, [message]);
    if (enquiry) this.enquiryRows.set(row.id, { ...enquiry, id: randomUUID(), createdAt: first.at });
    this.rates.set(`${row.id}:${windowOf(first.at, rate.windowSeconds)}`, 1);
    return { session: row, first: message, created: true };
  }
  async get(id: string) {
    return this.sessions.get(id) ?? null;
  }
  async byClientKey(hash: string) {
    return [...this.sessions.values()].find((s) => s.clientKey === hash) ?? null;
  }
  async add(sessionId: string, m: NewMessage, rate: Rate | null) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new SupportError('no such chat', SUPPORT_CHAT_NOT_FOUND);
    const list = this.messages.get(sessionId)!;
    const replay = list.find((x) => x.clientMessageId === m.clientMessageId);
    if (replay) {
      if (replay.body !== m.body || replay.author !== m.author) throw new SupportError('that message key holds another message', SUPPORT_CHAT_MESSAGE_CONFLICT);
      return replay;
    }
    if (session.status === 'closed') throw new SupportError('this chat is closed', SUPPORT_CHAT_CLOSED);
    if (rate && m.author === 'customer') {
      const key = `${sessionId}:${windowOf(m.at, rate.windowSeconds)}`;
      const sent = this.rates.get(key) ?? 0;
      if (sent >= rate.limit) throw new SupportError('too many messages in this chat for now', SUPPORT_CHAT_RATE_LIMITED);
      this.rates.set(key, sent + 1);
    }
    const message: SupportChatMessage = {
      id: randomUUID(),
      sessionId,
      seq: session.lastSeq + 1,
      author: m.author,
      clientMessageId: m.clientMessageId,
      body: m.body,
      createdAt: m.at,
    };
    list.push(message);
    session.lastSeq = message.seq;
    return message;
  }
  async after(sessionId: string, after: number, limit: number) {
    return (this.messages.get(sessionId) ?? []).filter((m) => m.seq > after).slice(0, limit);
  }
  async accept(sessionId: string, agentId: string, at: string) {
    const s = this.sessions.get(sessionId);
    if (!s) throw new SupportError('no such chat', SUPPORT_CHAT_NOT_FOUND);
    if (s.status === 'closed') throw new SupportError('this chat is closed', SUPPORT_CHAT_CLOSED);
    if (s.agentId !== null) {
      if (s.agentId === agentId) return s;
      throw new SupportError('another agent has this chat', SUPPORT_CHAT_ALREADY_ACCEPTED);
    }
    Object.assign(s, { agentId, acceptedAt: at, status: 'active' });
    return s;
  }
  async close(sessionId: string, _by: string, at: string) {
    const s = this.sessions.get(sessionId);
    if (!s) throw new SupportError('no such chat', SUPPORT_CHAT_NOT_FOUND);
    if (s.status !== 'closed') Object.assign(s, { status: 'closed', closedAt: at });
    return s;
  }
  async link(sessionId: string, ticketId: string) {
    const s = this.sessions.get(sessionId)!;
    if (s.ticketId === null) {
      s.ticketId = ticketId;
      this.sources.set(ticketId, sessionId);
    }
    return s;
  }
  async openSessions(limit: number) {
    return [...this.sessions.values()].filter((s) => s.status !== 'closed').slice(0, limit);
  }
  async enquiries(sessionId: string | undefined, limit: number) {
    return [...this.enquiryRows.entries()]
      .filter(([sid]) => sessionId === undefined || sid === sessionId)
      .slice(0, limit)
      .map(([sid, e]) => ({ id: e.id, source: 'chat' as const, sessionId: sid, name: e.name, hasEmail: e.addressSealed !== null, createdAt: e.createdAt }));
  }
  async sourceOf(ticketId: string) {
    const sid = this.sources.get(ticketId);
    return sid ? (this.sessions.get(sid) ?? null) : null;
  }
  async eraseDue(now: string) {
    let n = 0;
    for (const e of this.enquiryRows.values())
      if (e.addressSealed !== null && e.eraseAfter !== null && e.eraseAfter <= now) {
        e.addressSealed = null;
        n++;
      }
    return n;
  }
}

type SessionDb = {
  id: string;
  client_key: string;
  user_id: string | null;
  access_hash: string;
  claim: SessionRow['claim'];
  claim_refusal: string | null;
  status: SupportChatStatus;
  agent_id: string | null;
  accepted_at: Date | null;
  profile_type: SupportChatProfileType | null;
  profile_read: SessionRow['profileRead'];
  ticket_id: string | null;
  last_seq: number;
  created_at: Date;
  closed_at: Date | null;
  fingerprint: string;
};
type MessageDb = { id: string; session_id: string; seq: number; author_role: 'customer' | 'agent'; client_message_id: string; body: string; created_at: Date };

const iso = (d: Date | string | null) => (d === null ? null : new Date(d).toISOString());
const fromSession = (r: SessionDb): SessionRow => ({
  id: r.id,
  clientKey: r.client_key,
  userId: r.user_id,
  accessHash: r.access_hash,
  claim: r.claim,
  claimRefusal: r.claim_refusal,
  status: r.status,
  agentId: r.agent_id,
  acceptedAt: iso(r.accepted_at),
  profileType: r.profile_type,
  profileRead: r.profile_read,
  ticketId: r.ticket_id,
  lastSeq: r.last_seq,
  createdAt: iso(r.created_at)!,
  closedAt: iso(r.closed_at),
  fingerprint: r.fingerprint,
});
const fromMessage = (r: MessageDb): SupportChatMessage => ({
  id: r.id,
  sessionId: r.session_id,
  seq: r.seq,
  author: r.author_role,
  clientMessageId: r.client_message_id,
  body: r.body,
  createdAt: iso(r.created_at)!,
});

/** One transaction on a reserved connection: committed, or rolled back on any throw. */
async function inTransaction<T>(sql: Sql, body: (tx: Sql) => Promise<T>): Promise<T> {
  const conn = await sql.reserve();
  try {
    await conn`BEGIN`;
    try {
      const result = await body(conn as unknown as Sql);
      await conn`COMMIT`;
      return result;
    } catch (error) {
      await conn`ROLLBACK`.catch(() => undefined);
      throw error;
    }
  } finally {
    conn.release();
  }
}

export class SqlChatBook implements ChatBook {
  constructor(private readonly sql: Sql) {}

  async open(session: Parameters<ChatBook['open']>[0], first: NewMessage, enquiry: EnquiryRow | null, rate: Rate) {
    return inTransaction(this.sql, async (tx) => {
      const inserted = await tx<SessionDb[]>`
        INSERT INTO support.chat_sessions (client_key, user_id, access_hash, claim, claim_refusal, status, profile_type, profile_read, last_seq, created_at, updated_at, fingerprint)
        VALUES (${session.clientKey}, ${session.userId}, ${session.accessHash}, ${session.claim}, ${session.claimRefusal}, 'waiting',
                ${session.profileType}, ${session.profileRead}, 1, ${session.createdAt}, ${session.createdAt}, ${session.fingerprint})
        ON CONFLICT (client_key) DO NOTHING
        RETURNING *`;
      if (!inserted[0]) {
        const prior = await tx<SessionDb[]>`SELECT * FROM support.chat_sessions WHERE client_key = ${session.clientKey}`;
        const firstRow = await tx<MessageDb[]>`SELECT * FROM support.chat_messages WHERE session_id = ${prior[0]!.id} AND seq = 1`;
        return { session: fromSession(prior[0]!), first: fromMessage(firstRow[0]!), created: false };
      }
      const row = inserted[0];
      const message = await tx<MessageDb[]>`
        INSERT INTO support.chat_messages (session_id, seq, author_role, author_id, client_message_id, body, created_at)
        VALUES (${row.id}, 1, ${first.author}, ${first.authorId}, ${first.clientMessageId}, ${first.body}, ${first.at})
        RETURNING *`;
      if (enquiry)
        await tx`INSERT INTO support.chat_enquiries (session_id, source, name, address_hash, address_sealed, erase_after, created_at)
          VALUES (${row.id}, 'chat', ${enquiry.name}, ${enquiry.addressHash}, ${enquiry.addressSealed}, ${enquiry.eraseAfter}, ${first.at})`;
      await tx`INSERT INTO support.chat_rate_windows (session_id, window_start, sent) VALUES (${row.id}, ${windowOf(first.at, rate.windowSeconds)}, 1)`;
      return { session: fromSession(row), first: fromMessage(message[0]!), created: true };
    });
  }

  async get(sessionId: string) {
    const rows = await this.sql<SessionDb[]>`SELECT * FROM support.chat_sessions WHERE id = ${sessionId}`;
    return rows[0] ? fromSession(rows[0]) : null;
  }

  async byClientKey(hash: string) {
    const rows = await this.sql<SessionDb[]>`SELECT * FROM support.chat_sessions WHERE client_key = ${hash}`;
    return rows[0] ? fromSession(rows[0]) : null;
  }

  async add(sessionId: string, m: NewMessage, rate: Rate | null) {
    return inTransaction(this.sql, async (tx) => {
      const locked = await tx<SessionDb[]>`SELECT * FROM support.chat_sessions WHERE id = ${sessionId} FOR UPDATE`;
      const session = locked[0];
      if (!session) throw new SupportError('no such chat', SUPPORT_CHAT_NOT_FOUND);
      const replay = await tx<MessageDb[]>`SELECT * FROM support.chat_messages WHERE session_id = ${sessionId} AND client_message_id = ${m.clientMessageId}`;
      if (replay[0]) {
        if (replay[0].body !== m.body || replay[0].author_role !== m.author)
          throw new SupportError('that message key holds another message', SUPPORT_CHAT_MESSAGE_CONFLICT);
        return fromMessage(replay[0]);
      }
      if (session.status === 'closed') throw new SupportError('this chat is closed', SUPPORT_CHAT_CLOSED);
      if (rate && m.author === 'customer') {
        const window = windowOf(m.at, rate.windowSeconds);
        const counted = await tx<{ sent: number }[]>`
          INSERT INTO support.chat_rate_windows (session_id, window_start, sent) VALUES (${sessionId}, ${window}, 1)
          ON CONFLICT (session_id, window_start) DO UPDATE SET sent = support.chat_rate_windows.sent + 1
          RETURNING sent`;
        if (counted[0]!.sent > rate.limit) throw new SupportError('too many messages in this chat for now', SUPPORT_CHAT_RATE_LIMITED);
      }
      const seq = session.last_seq + 1;
      const message = await tx<MessageDb[]>`
        INSERT INTO support.chat_messages (session_id, seq, author_role, author_id, client_message_id, body, created_at)
        VALUES (${sessionId}, ${seq}, ${m.author}, ${m.authorId}, ${m.clientMessageId}, ${m.body}, ${m.at})
        RETURNING *`;
      await tx`UPDATE support.chat_sessions SET last_seq = ${seq}, updated_at = ${m.at} WHERE id = ${sessionId}`;
      return fromMessage(message[0]!);
    });
  }

  async after(sessionId: string, after: number, limit: number) {
    const rows = await this.sql<MessageDb[]>`
      SELECT * FROM support.chat_messages WHERE session_id = ${sessionId} AND seq > ${after} ORDER BY seq ASC LIMIT ${limit}`;
    return rows.map(fromMessage);
  }

  async accept(sessionId: string, agentId: string, at: string) {
    return inTransaction(this.sql, async (tx) => {
      const locked = await tx<SessionDb[]>`SELECT * FROM support.chat_sessions WHERE id = ${sessionId} FOR UPDATE`;
      const s = locked[0];
      if (!s) throw new SupportError('no such chat', SUPPORT_CHAT_NOT_FOUND);
      if (s.status === 'closed') throw new SupportError('this chat is closed', SUPPORT_CHAT_CLOSED);
      if (s.agent_id !== null) {
        if (s.agent_id === agentId) return fromSession(s);
        throw new SupportError('another agent has this chat', SUPPORT_CHAT_ALREADY_ACCEPTED);
      }
      const rows = await tx<SessionDb[]>`
        UPDATE support.chat_sessions SET agent_id = ${agentId}, accepted_at = ${at}, status = 'active', updated_at = ${at}
        WHERE id = ${sessionId} RETURNING *`;
      return fromSession(rows[0]!);
    });
  }

  async close(sessionId: string, by: string, at: string) {
    const rows = await this.sql<SessionDb[]>`
      UPDATE support.chat_sessions SET status = 'closed', closed_at = ${at}, closed_by = ${by}, updated_at = ${at}
      WHERE id = ${sessionId} AND status <> 'closed' RETURNING *`;
    if (rows[0]) return fromSession(rows[0]);
    const prior = await this.get(sessionId);
    if (!prior) throw new SupportError('no such chat', SUPPORT_CHAT_NOT_FOUND);
    return prior;
  }

  async link(sessionId: string, ticketId: string) {
    return inTransaction(this.sql, async (tx) => {
      const locked = await tx<SessionDb[]>`SELECT * FROM support.chat_sessions WHERE id = ${sessionId} FOR UPDATE`;
      const s = locked[0]!;
      if (s.ticket_id !== null) return fromSession(s);
      await tx`INSERT INTO support.ticket_sources (ticket_id, source, chat_session_id, profile_type, profile_read)
        VALUES (${ticketId}, 'chat', ${sessionId}, ${s.profile_type}, ${s.profile_read}) ON CONFLICT DO NOTHING`;
      const rows = await tx<SessionDb[]>`UPDATE support.chat_sessions SET ticket_id = ${ticketId} WHERE id = ${sessionId} RETURNING *`;
      return fromSession(rows[0]!);
    });
  }

  async openSessions(limit: number) {
    const rows = await this.sql<SessionDb[]>`
      SELECT * FROM support.chat_sessions WHERE status <> 'closed' ORDER BY created_at ASC, id ASC LIMIT ${limit}`;
    return rows.map(fromSession);
  }

  async enquiries(sessionId: string | undefined, limit: number) {
    const rows = await this.sql<{ id: string; session_id: string; name: string | null; has_email: boolean; created_at: Date }[]>`
      SELECT id, session_id, name, address_sealed IS NOT NULL AS has_email, created_at FROM support.chat_enquiries
      WHERE (${sessionId ?? null}::uuid IS NULL OR session_id = ${sessionId ?? null}::uuid)
      ORDER BY created_at DESC, id DESC LIMIT ${limit}`;
    return rows.map((r) => ({ id: r.id, source: 'chat' as const, sessionId: r.session_id, name: r.name, hasEmail: r.has_email, createdAt: iso(r.created_at)! }));
  }

  async sourceOf(ticketId: string) {
    const rows = await this.sql<SessionDb[]>`
      SELECT s.* FROM support.ticket_sources t JOIN support.chat_sessions s ON s.id = t.chat_session_id WHERE t.ticket_id = ${ticketId}`;
    return rows[0] ? fromSession(rows[0]) : null;
  }

  async eraseDue(now: string, batch: number) {
    const done = await this.sql`
      UPDATE support.chat_enquiries SET address_sealed = NULL, erased_at = ${now}
      WHERE id IN (SELECT id FROM support.chat_enquiries WHERE address_sealed IS NOT NULL AND erase_after <= ${now} ORDER BY erase_after LIMIT ${batch})`;
    return done.count;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The service.

/** Who is calling a session door: the signed principal's account, if any, and the access token the body carried. */
export type ChatCaller = { userId: string | null; accessToken?: string };

export class SupportChat {
  constructor(
    private readonly book: ChatBook,
    private readonly desk: ChatTicketDesk,
    private readonly profiles: ChatProfileSource,
    private readonly settings: ChatSettings,
    /** Reads the contact channels' chat hours (the owner's, or null). */
    private readonly hours: () => Promise<string | null>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async availability(): Promise<SupportChatAvailability> {
    const [staff, hours] = await Promise.all([this.desk.listStaff(), this.hours()]);
    return { agents: agentsNow(staff), hours, prechatFields: [...this.settings.prechatFields], pollMs: SUPPORT_CHAT_POLL_MS };
  }

  identityToken(userId: string): SupportChatIdentityToken {
    if (this.settings.identityTtlSeconds === null)
      throw new SupportError('the identity claim lifetime is not set', SUPPORT_CHAT_IDENTITY_TTL_UNSET);
    const expiresAt = new Date(this.now().getTime() + this.settings.identityTtlSeconds * 1000);
    return { token: signIdentityClaim(this.settings.claimSecret, userId, expiresAt), expiresAt: expiresAt.toISOString() };
  }

  private rate(): Rate {
    const { rateLimit, rateWindowSeconds } = this.settings;
    if (rateLimit === null || rateWindowSeconds === null)
      throw new SupportError('the chat message rate is not set', SUPPORT_CHAT_RATE_LIMIT_UNSET);
    return { limit: rateLimit, windowSeconds: rateWindowSeconds };
  }

  async open(principalUserId: string | null, input: SupportChatOpenInput): Promise<SupportChatOpenResult> {
    const rate = this.rate();
    refuseCommentSecret(input.message);
    const owner = ownerOf(principalUserId, input.identity, (claim) => verifyIdentityClaim(this.settings.claimSecret, claim, this.now()));
    const guest = owner.userId === null;
    // A guest answers the owner's pre-chat fields, and nothing else; an account's identity is its own, so it sends none.
    const prechat = input.prechat ?? {};
    const asked = new Set(this.settings.prechatFields);
    for (const field of Object.keys(prechat) as SupportChatPrechatField[])
      if (!guest || !asked.has(field)) throw new SupportError(`the pre-chat form does not ask for ${field}`, SUPPORT_CHAT_PRECHAT_INVALID);
    if (guest) for (const field of asked) if (!prechat[field]) throw new SupportError(`the pre-chat form needs ${field}`, SUPPORT_CHAT_PRECHAT_INVALID);
    const fingerprint = sha256(JSON.stringify([owner.userId, owner.claim, prechat.name ?? null, prechat.email ?? null, input.message]));
    const known = await this.knownOpen(input.clientKey, fingerprint);
    if (known) return known;

    if (agentsNow(await this.desk.listStaff()) === 'offline')
      throw new SupportError('no one is on the desk to chat now', SUPPORT_CHAT_AGENT_UNAVAILABLE);
    let enquiry: EnquiryRow | null = null;
    if (guest) {
      enquiry = { name: prechat.name ?? null, addressHash: null, addressSealed: null, eraseAfter: null };
      if (prechat.email) {
        if (this.settings.addressKey === null) throw new SupportError('the guest address key is not set', SUPPORT_GUEST_ADDRESS_KEY_UNSET);
        if (this.settings.retentionDays === null) throw new SupportError('the guest retention is not set', SUPPORT_GUEST_RETENTION_UNSET);
        enquiry = {
          ...enquiry,
          addressHash: sha256(prechat.email),
          addressSealed: seal(Buffer.from(this.settings.addressKey, 'hex'), prechat.email),
          eraseAfter: new Date(this.now().getTime() + this.settings.retentionDays * 86_400_000).toISOString(),
        };
      }
    }
    const profileType = guest ? null : await this.profiles.profileOf(owner.userId!);
    const at = this.now().toISOString();
    // The token is derived from the key (a 256-bit capability the page made), so a lost answer is recovered by opening with
    // the same key again; only the key's hash and the token's hash are kept.
    const accessToken = this.accessTokenOf(input.clientKey);
    const opened = await this.book.open(
      {
        clientKey: sha256(input.clientKey),
        userId: owner.userId,
        accessHash: sha256(accessToken),
        claim: owner.claim,
        claimRefusal: owner.claimRefusal,
        profileType,
        profileRead: guest ? 'guest' : profileType === null ? 'unread' : 'read',
        createdAt: at,
        fingerprint,
      },
      { author: 'customer', authorId: owner.userId, clientMessageId: 'open', body: input.message, at },
      enquiry,
      rate,
    );
    if (!opened.created && opened.session.fingerprint !== fingerprint)
      throw new SupportError('that key opened another chat', SUPPORT_CHAT_MESSAGE_CONFLICT);
    return { session: this.view(opened.session), accessToken, first: opened.first };
  }

  private accessTokenOf(clientKey: string): string {
    return createHmac('sha256', this.settings.claimSecret).update(`support.chat.access.v1:${clientKey}`).digest('base64url');
  }

  /** A key that already opened a chat answers that chat (the same content) or is refused (different content). */
  private async knownOpen(clientKey: string, fingerprint: string): Promise<SupportChatOpenResult | null> {
    const prior = await this.book.byClientKey(sha256(clientKey));
    if (!prior) return null;
    if (prior.fingerprint !== fingerprint) throw new SupportError('that key opened another chat', SUPPORT_CHAT_MESSAGE_CONFLICT);
    const [first] = await this.book.after(prior.id, 0, 1);
    return { session: this.view(prior), accessToken: this.accessTokenOf(clientKey), first: first! };
  }

  /** The session, if the caller may use it: its own account's principal, or the access token. Anything else reads as none. */
  private async session(sessionId: string, caller: ChatCaller): Promise<SessionRow> {
    const s = await this.book.get(sessionId);
    const byAccount = s !== null && s.userId !== null && caller.userId === s.userId;
    const byToken = s !== null && caller.accessToken !== undefined && tokenMatches(caller.accessToken, s.accessHash);
    if (!s || !(byAccount || byToken)) throw new SupportError('no such chat', SUPPORT_CHAT_NOT_FOUND);
    return s;
  }

  async send(caller: ChatCaller, input: { sessionId: string; clientMessageId: string; body: string }): Promise<SupportChatMessage> {
    const session = await this.session(input.sessionId, caller);
    refuseCommentSecret(input.body);
    return this.book.add(
      session.id,
      { author: 'customer', authorId: session.userId, clientMessageId: input.clientMessageId, body: input.body, at: this.now().toISOString() },
      this.rate(),
    );
  }

  async poll(caller: ChatCaller, input: { sessionId: string; after: number }) {
    const session = await this.session(input.sessionId, caller);
    const messages = await this.book.after(session.id, input.after, SUPPORT_CHAT_PAGE_MAX);
    return { session: this.view(session), messages, pollMs: SUPPORT_CHAT_POLL_MS };
  }

  async close(caller: ChatCaller, sessionId: string): Promise<SupportChatSession> {
    const session = await this.session(sessionId, caller);
    return this.view(await this.finish(session.id, session.userId ?? `guest:${session.id}`));
  }

  /** Continue by email: there is no mailbox in this build, so it says so and leaves the chat as it was. */
  async continueByEmail(caller: ChatCaller, sessionId: string): Promise<SupportChatEmailResult> {
    const session = await this.session(sessionId, caller);
    if (session.status === 'closed') throw new SupportError('this chat is closed', SUPPORT_CHAT_CLOSED);
    return { status: 'not_connected', code: 'vendor.email', session: this.view(session) };
  }

  // The desk -------------------------------------------------------------------------------------------------------

  async inbox(limit: number): Promise<SupportChatDeskSession[]> {
    return (await this.book.openSessions(limit)).map((s) => this.deskView(s));
  }

  async accept(agentId: string, sessionId: string): Promise<SupportChatDeskSession> {
    const me = (await this.desk.listStaff()).find((m) => m.userId === agentId);
    if (!me) throw new SupportError('only desk staff can take a chat', 'support.not_staff');
    if (me.availability !== 'online') throw new SupportError('set yourself online to take a chat', SUPPORT_CHAT_AGENT_NOT_ONLINE);
    return this.deskView(await this.book.accept(sessionId, agentId, this.now().toISOString()));
  }

  async reply(agentId: string, input: { sessionId: string; clientMessageId: string; body: string }): Promise<SupportChatMessage> {
    const s = await this.book.get(input.sessionId);
    if (!s) throw new SupportError('no such chat', SUPPORT_CHAT_NOT_FOUND);
    if (s.agentId !== agentId) throw new SupportError('take the chat before replying', SUPPORT_CHAT_NOT_ACCEPTED);
    refuseCommentSecret(input.body);
    return this.book.add(
      s.id,
      { author: 'agent', authorId: agentId, clientMessageId: input.clientMessageId, body: input.body, at: this.now().toISOString() },
      null,
    );
  }

  async deskPoll(input: { sessionId: string; after: number }) {
    const s = await this.book.get(input.sessionId);
    if (!s) throw new SupportError('no such chat', SUPPORT_CHAT_NOT_FOUND);
    return { session: this.deskView(s), messages: await this.book.after(s.id, input.after, SUPPORT_CHAT_PAGE_MAX), pollMs: SUPPORT_CHAT_POLL_MS };
  }

  async deskClose(agentId: string, sessionId: string): Promise<SupportChatDeskSession> {
    const s = await this.book.get(sessionId);
    if (!s) throw new SupportError('no such chat', SUPPORT_CHAT_NOT_FOUND);
    return this.deskView(await this.finish(s.id, agentId));
  }

  enquiries(sessionId: string | undefined, limit: number): Promise<SupportChatEnquiry[]> {
    return this.book.enquiries(sessionId, limit);
  }

  async requestSource(ticketId: string): Promise<SupportRequestSource | null> {
    const s = await this.book.sourceOf(ticketId);
    if (!s) return null;
    return {
      ticketId,
      source: 'chat',
      sessionId: s.id,
      profileType: s.profileType,
      profileRead: s.profileRead,
      transcript: await this.transcript(s.id),
    };
  }

  eraseDue(batch = 100): Promise<number> {
    return this.book.eraseDue(this.now().toISOString(), batch);
  }

  /** Close, then the request under `chat:<session>`, then the link. Each step is safe to repeat. */
  private async finish(sessionId: string, by: string): Promise<SessionRow> {
    const closed = await this.book.close(sessionId, by, this.now().toISOString());
    if (closed.ticketId !== null) return closed;
    const transcript = await this.transcript(sessionId);
    const first = transcript[0]?.body ?? '';
    const ticket = await this.desk.createTicket({
      userId: closed.userId ?? closed.id,
      category: 'other',
      subject: `Chat: ${first.length > 180 ? `${first.slice(0, 179)}…` : first}`,
      body: transcriptText(transcript),
      clientRequestId: `chat:${sessionId}`,
    });
    return this.book.link(sessionId, ticket.id);
  }

  private async transcript(sessionId: string): Promise<SupportChatMessage[]> {
    const all: SupportChatMessage[] = [];
    for (;;) {
      const page = await this.book.after(sessionId, all.at(-1)?.seq ?? 0, SUPPORT_CHAT_PAGE_MAX);
      all.push(...page);
      if (page.length < SUPPORT_CHAT_PAGE_MAX) return all;
    }
  }

  private view(s: SessionRow): SupportChatSession {
    return {
      id: s.id,
      status: s.status,
      identity: s.userId === null ? 'guest' : 'account',
      claim: s.claim,
      claimRefusal: s.claimRefusal,
      waitingForAgent: s.status === 'waiting',
      ticketId: s.ticketId,
      createdAt: s.createdAt,
      closedAt: s.closedAt,
    };
  }

  private deskView(s: SessionRow): SupportChatDeskSession {
    return {
      ...this.view(s),
      userId: s.userId,
      agentId: s.agentId,
      acceptedAt: s.acceptedAt,
      profileType: s.profileType,
      profileRead: s.profileRead,
      lastSeq: s.lastSeq,
    };
  }
}

function tokenMatches(token: string, storedHash: string): boolean {
  const a = Buffer.from(sha256(token), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
