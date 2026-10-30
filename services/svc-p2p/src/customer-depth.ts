/**
 * Customer-depth reads and writes the screens already have controls for.
 *
 * Offer edits, chat, follow/block, the party's dispute list, and a CSV of
 * the caller's own trades. Money stays in the ledger. This file does not
 * invent a handle, a fee, or a notification delivery.
 */
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';

export interface BoardOffer {
  id: string;
  makerId: string;
  side: 'buy' | 'sell';
  asset: string;
  fiatCurrency: string;
  priceType: 'fixed' | 'float';
  price: Amount;
  minAmt: Amount;
  maxAmt: Amount;
  totalAmt: Amount;
  remainingAmt: Amount;
  methods: unknown[];
  terms: string;
  /** Maker verification tier at create. Null when the row never stored one. */
  makerTier: string | null;
  /** P-disputes-security-09: the seller consented at post to non-instant methods. */
  acceptsNonInstant: boolean;
  status: 'active' | 'paused' | 'closed';
  /** P-ads-merchant-18: the board lists active ads only, so this is null there unless a row says otherwise. */
  pauseReason: 'method_removed' | null;
  /** P-ads-merchant-06: null on the board, which lists active ads only. */
  closeReason: 'by_you' | 'sold_out' | null;
  statusSince: Date;
  relistedFrom: string | null;
  createdAt: Date;
  /** Postgres `to_char` instant, microsecond precision. Cursor keyset uses this, not a JS Date. */
  createdAtExact: string;
}

export class DepthError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'p2p.idempotency_conflict'
      | 'p2p.idempotency_in_progress'
      | 'p2p.offer_cursor_invalid'
      | 'p2p.blocked'
      | 'p2p.offer_update_empty'
      | 'p2p.offer_not_active'
      | 'p2p.not_a_party'
      | 'p2p.chat_attachment_unwired'
      | 'p2p.chat_text_required'
      | 'p2p.export_range_invalid'
      | 'p2p.contact_self'
      | 'p2p.trade_not_found',
  ) {
    super(message);
    this.name = 'DepthError';
  }
}

export function requestHash(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\n'), 'utf8').digest('hex');
}

export interface WriteClaim {
  readonly kind: 'claimed' | 'replay' | 'conflict' | 'in_progress';
  readonly subjectId: string | null;
}

/** Insert the key or report the earlier write. Caller inserts the subject after `claimed`. */
export async function claimWriteKey(
  tx: Sql,
  input: { actorId: string; scope: string; idempotencyKey: string; requestHash: string },
): Promise<WriteClaim> {
  const inserted = await tx<Array<{ idempotency_key: string }>>`
    INSERT INTO p2p.write_keys (actor_id, scope, idempotency_key, request_hash)
    VALUES (${input.actorId}, ${input.scope}, ${input.idempotencyKey}, ${input.requestHash})
    ON CONFLICT (actor_id, scope, idempotency_key) DO NOTHING
    RETURNING idempotency_key
  `;
  if (inserted[0]) return { kind: 'claimed', subjectId: null };

  const rows = await tx<Array<{ request_hash: string; subject_id: string | null }>>`
    SELECT request_hash, subject_id FROM p2p.write_keys
     WHERE actor_id = ${input.actorId} AND scope = ${input.scope} AND idempotency_key = ${input.idempotencyKey}
  `;
  const row = rows[0];
  if (!row) return { kind: 'in_progress', subjectId: null };
  if (row.request_hash !== input.requestHash) return { kind: 'conflict', subjectId: row.subject_id };
  if (!row.subject_id) return { kind: 'in_progress', subjectId: null };
  return { kind: 'replay', subjectId: row.subject_id };
}

export async function finishWriteKey(
  tx: Sql,
  input: { actorId: string; scope: string; idempotencyKey: string; subjectId: string },
): Promise<void> {
  await tx`
    UPDATE p2p.write_keys SET subject_id = ${input.subjectId}
     WHERE actor_id = ${input.actorId} AND scope = ${input.scope} AND idempotency_key = ${input.idempotencyKey}
  `;
}

export function throwWriteClaim(claim: WriteClaim): void {
  if (claim.kind === 'conflict') {
    throw new DepthError('p2p.idempotency_conflict', 'p2p.idempotency_conflict');
  }
  if (claim.kind === 'in_progress') {
    throw new DepthError('p2p.idempotency_in_progress', 'p2p.idempotency_in_progress');
  }
}

export async function eitherBlocked(sql: Sql, a: string, b: string): Promise<boolean> {
  const rows = await sql<Array<{ n: number }>>`
    SELECT 1 AS n FROM p2p.contacts
     WHERE kind = 'block'
       AND ((owner_id = ${a} AND peer_id = ${b}) OR (owner_id = ${b} AND peer_id = ${a}))
     LIMIT 1
  `;
  return Boolean(rows[0]);
}

/** Board order (P-trade-orders-01): fixed-price ads by price, then floating ads, which have no fiat price to rank by. */
export const BOARD_SORTS = ['price_asc', 'price_desc'] as const;
export type BoardSort = (typeof BOARD_SORTS)[number];

export interface OfferCursor {
  sort: BoardSort;
  float: boolean;
  price: string;
  createdAt: string;
  id: string;
}

/** Opaque keyset position. It carries its sort, so a cursor read under another sort refuses instead of skipping rows. */
export function encodeOfferCursor(offer: Pick<BoardOffer, 'priceType' | 'price' | 'createdAtExact' | 'id'>, sort: BoardSort): string {
  const parts = [sort, offer.priceType === 'float' ? '1' : '0', formatAmount(offer.price), offer.createdAtExact, offer.id];
  return Buffer.from(parts.join('\n'), 'utf8').toString('base64url');
}

export function decodeOfferCursor(cursor: string): OfferCursor {
  let raw: string;
  try {
    raw = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new DepthError('p2p.offer_cursor_invalid', 'p2p.offer_cursor_invalid');
  }
  const [sort, float, price, createdAt, id, extra] = raw.split('\n');
  if (
    extra !== undefined ||
    !(BOARD_SORTS as readonly string[]).includes(sort ?? '') ||
    (float !== '0' && float !== '1') ||
    !price ||
    !createdAt ||
    !id ||
    !/^\d+(\.\d{1,18})?$/.test(price) ||
    !/^\d{20}$/.test(createdAt)
  ) {
    throw new DepthError('p2p.offer_cursor_invalid', 'p2p.offer_cursor_invalid');
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
    throw new DepthError('p2p.offer_cursor_invalid', 'p2p.offer_cursor_invalid');
  }
  return { sort: sort as BoardSort, float: float === '1', price, createdAt, id };
}

export interface BoardFilter {
  asset?: string;
  fiatCurrency?: string;
  side?: 'buy' | 'sell';
  makerId?: string;
  methodId?: string;
  minFiat?: Amount | null;
  /** A fiat amount the ad can take whole: fixed price, and within its limits and what is left. */
  fiatAmount?: Amount | null;
  sort?: BoardSort;
  viewerId?: string | null;
  limit: number;
  cursor?: string | null;
}

interface BoardRow {
  id: string;
  maker_id: string;
  side: 'buy' | 'sell';
  asset: string;
  fiat_currency: string;
  price_type: 'fixed' | 'float';
  price: string;
  min_amt: string;
  max_amt: string;
  total_amt: string;
  remaining_amt: string;
  methods: unknown[];
  terms: string;
  maker_tier: string | null;
  accepts_non_instant?: boolean;
  status: 'active' | 'paused' | 'closed';
  pause_reason?: 'method_removed' | null;
  close_reason?: 'by_you' | 'sold_out' | null;
  status_since?: Date;
  relisted_from?: string | null;
  created_at: Date;
  created_at_exact: string;
}

export function boardRowToOffer(row: BoardRow): BoardOffer {
  return {
    id: row.id,
    makerId: row.maker_id,
    side: row.side,
    asset: row.asset,
    fiatCurrency: row.fiat_currency,
    priceType: row.price_type,
    price: parseAmount(row.price),
    minAmt: parseAmount(row.min_amt),
    maxAmt: parseAmount(row.max_amt),
    totalAmt: parseAmount(row.total_amt),
    remainingAmt: parseAmount(row.remaining_amt),
    methods: Array.isArray(row.methods) ? row.methods : [],
    terms: row.terms,
    makerTier: row.maker_tier ?? null,
    acceptsNonInstant: row.accepts_non_instant === true,
    status: row.status,
    pauseReason: row.pause_reason ?? null,
    closeReason: row.close_reason ?? null,
    statusSince: row.status_since ?? (row.created_at instanceof Date ? row.created_at : new Date(row.created_at)),
    relistedFrom: row.relisted_from ?? null,
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    createdAtExact: row.created_at_exact,
  };
}

export async function selectOfferBoard(sql: Sql, filter: BoardFilter): Promise<BoardRow[]> {
  const sort = filter.sort ?? 'price_asc';
  const cursor = filter.cursor ? decodeOfferCursor(filter.cursor) : null;
  if (cursor && cursor.sort !== sort) throw new DepthError('p2p.offer_cursor_invalid', 'p2p.offer_cursor_invalid');
  const minFiat = filter.minFiat == null ? null : formatAmount(filter.minFiat);
  const fiatAmount = filter.fiatAmount == null ? null : formatAmount(filter.fiatAmount);
  const desc = sort === 'price_desc';
  return sql<BoardRow[]>`
    SELECT p2p.offers.*,
           to_char(p2p.offers.created_at AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISSUS') AS created_at_exact
      FROM p2p.offers
     WHERE status = 'active'
       AND remaining_amt >= min_amt
       AND (${filter.asset ?? null}::text IS NULL OR asset = ${filter.asset ?? null})
       AND (${filter.fiatCurrency ?? null}::text IS NULL OR fiat_currency = ${filter.fiatCurrency ?? null})
       AND (${filter.side ?? null}::text IS NULL OR side::text = ${filter.side ?? null})
       AND (${filter.makerId ?? null}::text IS NULL OR maker_id = ${filter.makerId ?? null})
       AND (
         ${filter.methodId ?? null}::text IS NULL
         OR EXISTS (
           SELECT 1 FROM jsonb_array_elements(methods) elem
            WHERE elem #>> '{}' = ${filter.methodId ?? null}
               OR elem->>'id' = ${filter.methodId ?? null}
         )
       )
       AND (
         ${minFiat}::numeric IS NULL
         OR (price_type = 'fixed' AND price * max_amt >= ${minFiat}::numeric)
       )
       AND (
         ${fiatAmount}::numeric IS NULL
         OR (
           price_type = 'fixed'
           AND price * min_amt <= ${fiatAmount}::numeric
           AND price * LEAST(max_amt, remaining_amt) >= ${fiatAmount}::numeric
         )
       )
       AND (
         ${filter.viewerId ?? null}::text IS NULL
         OR NOT EXISTS (
           SELECT 1 FROM p2p.contacts c
            WHERE c.kind = 'block'
              AND (
                (c.owner_id = ${filter.viewerId ?? null} AND c.peer_id = p2p.offers.maker_id)
                OR (c.owner_id = p2p.offers.maker_id AND c.peer_id = ${filter.viewerId ?? null})
              )
         )
       )
       AND (
         ${cursor?.id ?? null}::uuid IS NULL
         OR (price_type = 'float') > ${cursor?.float ?? false}::boolean
         OR (
           (price_type = 'float') = ${cursor?.float ?? false}::boolean
           AND price ${desc ? sql`<` : sql`>`} ${cursor?.price ?? '0'}::numeric
         )
         OR (
           (price_type = 'float') = ${cursor?.float ?? false}::boolean
           AND price = ${cursor?.price ?? '0'}::numeric
           AND to_char(created_at AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISSUS') > ${cursor?.createdAt ?? ''}::text
         )
         OR (
           (price_type = 'float') = ${cursor?.float ?? false}::boolean
           AND price = ${cursor?.price ?? '0'}::numeric
           AND to_char(created_at AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISSUS') = ${cursor?.createdAt ?? ''}::text
           AND id > ${cursor?.id ?? '00000000-0000-0000-0000-000000000000'}::uuid
         )
       )
     ORDER BY (price_type = 'float') ASC, price ${desc ? sql`DESC` : sql`ASC`}, created_at ASC, id ASC
     LIMIT ${filter.limit}
  `;
}

export async function releasedCounts(sql: Sql, offerIds: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (offerIds.length === 0) return out;
  const rows = await sql<Array<{ offer_id: string; n: number }>>`
    SELECT offer_id, count(*)::int AS n
      FROM p2p.p2p_trades
     WHERE status = 'released' AND offer_id IN ${sql(offerIds as unknown as string[])}
     GROUP BY offer_id
  `;
  for (const row of rows) out.set(row.offer_id, Number(row.n));
  return out;
}

export async function tradesReleasedIn30Days(sql: Sql, userId: string): Promise<number> {
  const rows = await sql<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM p2p.p2p_trades
     WHERE status = 'released'
       AND (buyer_id = ${userId} OR seller_id = ${userId})
       AND created_at >= now() - interval '30 days'
  `;
  return Number(rows[0]?.n ?? 0);
}

export interface ChatMessageRow {
  id: string;
  trade_id: string;
  sender_id: string;
  client_id: string;
  body: string;
  created_at: Date;
}

export interface ChatMessage {
  id: string;
  tradeId: string;
  senderId: string;
  clientId: string;
  text: string;
  createdAt: Date;
}

export function toChatMessage(row: ChatMessageRow): ChatMessage {
  return {
    id: row.id,
    tradeId: row.trade_id,
    senderId: row.sender_id,
    clientId: row.client_id,
    text: row.body,
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
  };
}

export async function insertChatMessage(
  sql: Sql,
  input: { tradeId: string; senderId: string; clientId: string; text: string },
): Promise<{ message: ChatMessage; created: boolean }> {
  const text = input.text.trim();
  if (!text) throw new DepthError('p2p.chat_text_required', 'p2p.chat_text_required');
  if (text.length > 2000) throw new DepthError('p2p.chat_text_required', 'p2p.chat_text_required');
  const inserted = await sql<ChatMessageRow[]>`
    INSERT INTO p2p.chat_messages (trade_id, sender_id, client_id, body)
    VALUES (${input.tradeId}, ${input.senderId}, ${input.clientId}, ${text})
    ON CONFLICT (trade_id, sender_id, client_id) DO NOTHING
    RETURNING *
  `;
  if (inserted[0]) return { message: toChatMessage(inserted[0]), created: true };
  const rows = await sql<ChatMessageRow[]>`
    SELECT * FROM p2p.chat_messages
     WHERE trade_id = ${input.tradeId} AND sender_id = ${input.senderId} AND client_id = ${input.clientId}
  `;
  const row = rows[0];
  if (!row) throw new DepthError('p2p.idempotency_in_progress', 'p2p.idempotency_in_progress');
  if (row.body !== text) throw new DepthError('p2p.idempotency_conflict', 'p2p.idempotency_conflict');
  return { message: toChatMessage(row), created: false };
}

export async function listChatMessages(
  sql: Sql,
  input: { tradeId: string; cursor: string | null; limit: number },
): Promise<{ messages: ChatMessage[]; nextCursor: string | null }> {
  const rows = await sql<ChatMessageRow[]>`
    SELECT * FROM p2p.chat_messages
     WHERE trade_id = ${input.tradeId}
       AND (
         ${input.cursor}::uuid IS NULL
         OR (created_at, id) > (
           (SELECT c.created_at FROM p2p.chat_messages c WHERE c.id = ${input.cursor}::uuid),
           ${input.cursor}::uuid
         )
       )
     ORDER BY created_at ASC, id ASC
     LIMIT ${input.limit}
  `;
  const messages = rows.map(toChatMessage);
  const last = messages[messages.length - 1];
  return { messages, nextCursor: messages.length === input.limit && last ? last.id : null };
}

export async function unreadChatCount(sql: Sql, tradeId: string, userId: string): Promise<number> {
  const rows = await sql<Array<{ n: number }>>`
    SELECT count(*)::int AS n
      FROM p2p.chat_messages m
      LEFT JOIN p2p.chat_reads r ON r.trade_id = m.trade_id AND r.user_id = ${userId}
     WHERE m.trade_id = ${tradeId}
       AND m.sender_id <> ${userId}
       AND (r.read_at IS NULL OR m.created_at > r.read_at)
  `;
  return Number(rows[0]?.n ?? 0);
}

export async function markChatRead(sql: Sql, tradeId: string, userId: string): Promise<void> {
  await sql`
    INSERT INTO p2p.chat_reads (trade_id, user_id, read_at)
    VALUES (${tradeId}, ${userId}, now())
    ON CONFLICT (trade_id, user_id) DO UPDATE SET read_at = now()
  `;
}

export async function disputeOpenForTrade(sql: Sql, tradeId: string): Promise<boolean> {
  const rows = await sql<Array<{ id: string }>>`
    SELECT id FROM p2p.p2p_disputes WHERE trade_id = ${tradeId} AND status = 'open' LIMIT 1
  `;
  return Boolean(rows[0]);
}

export async function setContact(
  sql: Sql,
  input: { ownerId: string; peerId: string; kind: 'follow' | 'block'; idempotencyKey: string; present: boolean },
): Promise<void> {
  if (input.ownerId === input.peerId) throw new DepthError('p2p.contact_self', 'p2p.contact_self');
  const hash = requestHash([input.kind, input.present ? '1' : '0', input.peerId]);
  await transaction(sql, async (tx) => {
    const claim = await claimWriteKey(tx, {
      actorId: input.ownerId,
      scope: `contacts.${input.kind}.${input.present ? 'set' : 'clear'}`,
      idempotencyKey: input.idempotencyKey,
      requestHash: hash,
    });
    if (claim.kind === 'replay') return;
    throwWriteClaim(claim);
    if (input.present) {
      await tx`
        INSERT INTO p2p.contacts (owner_id, peer_id, kind)
        VALUES (${input.ownerId}, ${input.peerId}, ${input.kind})
        ON CONFLICT DO NOTHING
      `;
    } else {
      await tx`
        DELETE FROM p2p.contacts
         WHERE owner_id = ${input.ownerId} AND peer_id = ${input.peerId} AND kind = ${input.kind}
      `;
    }
    await finishWriteKey(tx, {
      actorId: input.ownerId,
      scope: `contacts.${input.kind}.${input.present ? 'set' : 'clear'}`,
      idempotencyKey: input.idempotencyKey,
      subjectId: '00000000-0000-4000-8000-000000000001',
    });
  });
}

export async function listContacts(sql: Sql, ownerId: string): Promise<{ following: string[]; blocking: string[] }> {
  const rows = await sql<Array<{ peer_id: string; kind: 'follow' | 'block' }>>`
    SELECT peer_id, kind FROM p2p.contacts WHERE owner_id = ${ownerId} ORDER BY created_at ASC, peer_id ASC
  `;
  return {
    following: rows.filter((r) => r.kind === 'follow').map((r) => r.peer_id),
    blocking: rows.filter((r) => r.kind === 'block').map((r) => r.peer_id),
  };
}

export function csvCell(value: string): string {
  // Formula injection: a cell a spreadsheet would evaluate (= + - @ tab CR)
  // is prefixed with ' so it opens as text, then quoted like any other.
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  if (/[",\n\r]/.test(safe) || safe !== value) return `"${safe.replace(/"/g, '""')}"`;
  return safe;
}

export function tradesCsv(
  userId: string,
  rows: ReadonlyArray<{
    id: string;
    offerId: string;
    sellerId: string;
    buyerId: string;
    asset: string;
    amount: string;
    fiatCurrency: string;
    fiatAmount: string;
    price: string;
    method: string;
    status: string;
    resolution: string | null;
    createdAt: string;
  }>,
): string {
  const header = 'tradeId,offerId,role,asset,amount,fiatCurrency,fiatAmount,price,method,status,resolution,createdAt';
  const lines = rows.map((row) => {
    const role = row.sellerId === userId ? 'seller' : 'buyer';
    return [
      row.id,
      row.offerId,
      role,
      row.asset,
      row.amount,
      row.fiatCurrency,
      row.fiatAmount,
      row.price,
      row.method,
      row.status,
      row.resolution ?? '',
      row.createdAt,
    ]
      .map(csvCell)
      .join(',');
  });
  return [header, ...lines].join('\n');
}
