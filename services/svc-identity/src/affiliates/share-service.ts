/**
 * Affiliate share tokens — ops.social-promotion.
 *
 * Token → referrer id + hit counter. NOT a second attribution tree.
 * Attribution stays on `referral_edges` via `affiliates.attribute`.
 * Revoke deletes the live token; missing/closed referrer is `share.profile_gone`.
 */

import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { IpMinuteWindow, SESSION_KEY_PATTERN, SHARE_SURFACES, signShareTag, verifyShareTag, type ShareSurface } from './share-tag.js';

export type ShareErrorCode =
  | 'share.invalid'
  | 'share.unknown'
  | 'share.revoked'
  | 'share.not_found'
  | 'share.profile_gone'
  | 'share.tag_invalid'
  | 'share.key_unset'
  | 'share.rate_unset'
  | 'share.rate_limited';

export class ShareError extends Error {
  constructor(
    message: string,
    readonly code: ShareErrorCode,
  ) {
    super(message);
    this.name = 'ShareError';
  }
}

export type ShareRecord = {
  readonly token: string;
  readonly referrerId: string;
  readonly hits: number;
  readonly revokedAt: Date | null;
  readonly createdAt: Date;
};

export type ShareHitResult = {
  readonly token: string;
  readonly referrerId: string;
  readonly hits: number;
};

/** One signed tag for the caller's live token and a surface (RC-campaigns-06). */
export type ShareTag = { readonly tag: string; readonly token: string; readonly surface: ShareSurface };

/** A tag's counted visit: `counted` is false when this session already counted on this surface. */
export type ShareTagHit = { readonly token: string; readonly surface: ShareSurface; readonly counted: boolean; readonly visits: number };

/** Visits per surface for the caller's live token; every surface is listed, zero when none. */
export type ShareSurfaceStats = { readonly token: string; readonly surfaces: Array<{ surface: ShareSurface; visits: number }> };

export type ShareTagOptions = {
  /** `IDENTITY_SHARE_TAG_KEY`; blank refuses making and reading tags (`share.key_unset`). */
  readonly tagKey?: string;
  /** `IDENTITY_SHARE_TAG_HITS_PER_IP_MINUTE`; blank keeps the public tag door shut (`share.rate_unset`). */
  readonly hitsPerIpMinute?: number;
  readonly now?: () => number;
};

function requireId(value: string, label: string): string {
  const t = value.trim();
  if (!t) throw new ShareError(`${label} is required`, 'share.invalid');
  return t;
}

/** In-memory store for unit tests. Production uses ShareService (SQL). */
export class MemoryShareStore {
  private readonly byToken = new Map<string, ShareRecord>();
  /** Live referrer ids. Missing / forgotten → share.profile_gone. */
  private readonly alive = new Set<string>();

  rememberUser(userId: string): void {
    this.alive.add(userId);
  }

  /** Profile delete / close — tokens stop attributing. */
  forgetUser(userId: string): void {
    this.alive.delete(userId);
  }

  createShare(referrerId: string, now?: Date): ShareRecord {
    const id = requireId(referrerId, 'referrerId');
    if (!this.alive.has(id)) throw new ShareError('Referrer profile is gone [share.profile_gone]', 'share.profile_gone');
    for (const rec of this.byToken.values()) {
      if (rec.referrerId === id && rec.revokedAt === null) return rec;
    }
    const createdAt = now ?? new Date();
    const rec: ShareRecord = {
      token: randomUUID(),
      referrerId: id,
      hits: 0,
      revokedAt: null,
      createdAt,
    };
    this.byToken.set(rec.token, rec);
    return rec;
  }

  referrerOf(token: string): string | null {
    const rec = this.byToken.get(requireId(token, 'token'));
    return rec && rec.revokedAt === null ? rec.referrerId : null;
  }

  revokeShare(referrerId: string, now?: Date): ShareRecord {
    const id = requireId(referrerId, 'referrerId');
    for (const rec of this.byToken.values()) {
      if (rec.referrerId === id && rec.revokedAt === null) {
        const next: ShareRecord = { ...rec, revokedAt: now ?? new Date() };
        this.byToken.set(rec.token, next);
        return next;
      }
    }
    throw new ShareError('No active share token [share.not_found]', 'share.not_found');
  }

  shareHits(token: string): ShareHitResult {
    const t = requireId(token, 'token');
    const rec = this.byToken.get(t);
    if (!rec) throw new ShareError('Share token is unknown [share.unknown]', 'share.unknown');
    if (rec.revokedAt) throw new ShareError('Share token is revoked [share.revoked]', 'share.revoked');
    if (!this.alive.has(rec.referrerId)) {
      throw new ShareError('Referrer profile is gone [share.profile_gone]', 'share.profile_gone');
    }
    const next: ShareRecord = { ...rec, hits: rec.hits + 1 };
    this.byToken.set(t, next);
    return { token: next.token, referrerId: next.referrerId, hits: next.hits };
  }
}

type TokenRow = {
  token: string;
  referrer_id: string;
  hits: number;
  revoked_at: Date | null;
  created_at: Date;
};

function toRecord(row: TokenRow): ShareRecord {
  return {
    token: row.token,
    referrerId: row.referrer_id,
    hits: Number(row.hits),
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}

/**
 * Durable share tokens. Search_path is `identity`.
 * Hits are a counter (not money). Attribution is not stored here.
 */
export class ShareService {
  private readonly window: IpMinuteWindow | undefined;

  constructor(
    private readonly sql: Sql,
    private readonly tags: ShareTagOptions = {},
  ) {
    this.window = tags.hitsPerIpMinute === undefined ? undefined : new IpMinuteWindow(tags.hitsPerIpMinute, tags.now);
  }

  private requireKey(): string {
    if (!this.tags.tagKey) throw new ShareError('Share tags are off: the signing key is not set [share.key_unset]', 'share.key_unset');
    return this.tags.tagKey;
  }

  /**
   * A signed tag for the referrer's live token on one surface. It never makes a link: the link is made through its own
   * reviewed request (createShare), so no live link is `share.not_found`.
   */
  async createTag(referrerId: string, surface: ShareSurface): Promise<ShareTag> {
    const key = this.requireKey();
    const id = requireId(referrerId, 'referrerId');
    await this.assertReferrerAlive(id);
    const live = await this.sql<Array<{ token: string }>>`
      SELECT token FROM affiliate_share_tokens WHERE referrer_id = ${id} AND revoked_at IS NULL LIMIT 1
    `;
    const token = live[0]?.token;
    if (!token) throw new ShareError('No active share token [share.not_found]', 'share.not_found');
    return { tag: signShareTag(key, token, surface), token, surface };
  }

  /**
   * The public visit of a signed tag. Order: the owner's IP limit, the signature (an edited tag counts nothing), the token
   * (unknown, revoked, gone profile), then one row per (token, surface, session key): a second open in the same session
   * is answered with the same count and `counted: false`.
   */
  async tagHit(tag: string, sessionKey: string, ip: string | undefined): Promise<ShareTagHit> {
    if (!this.window) {
      throw new ShareError('The share door is shut: its per-IP visit limit is not set [share.rate_unset]', 'share.rate_unset');
    }
    const key = this.requireKey();
    if (!this.window.take(ip ?? 'unknown')) {
      throw new ShareError('Too many share visits from this address; try again in a minute [share.rate_limited]', 'share.rate_limited');
    }
    if (!SESSION_KEY_PATTERN.test(sessionKey)) throw new ShareError('Session key is malformed [share.invalid]', 'share.invalid');
    const verified = verifyShareTag(key, tag.trim());
    if (!verified) throw new ShareError('This share link was changed or is not ours [share.tag_invalid]', 'share.tag_invalid');
    const rows = await this.sql<TokenRow[]>`
      SELECT token, referrer_id, hits, revoked_at, created_at
        FROM affiliate_share_tokens
       WHERE token = ${verified.token}
       LIMIT 1
    `;
    const rec = rows[0];
    if (!rec) throw new ShareError('Share token is unknown [share.unknown]', 'share.unknown');
    if (rec.revoked_at) throw new ShareError('Share token is revoked [share.revoked]', 'share.revoked');
    await this.assertReferrerAlive(rec.referrer_id);
    const inserted = await this.sql<Array<{ id: string }>>`
      INSERT INTO affiliate_share_hits (token, surface, session_key)
      VALUES (${verified.token}, ${verified.surface}, ${sessionKey})
      ON CONFLICT (token, surface, session_key) DO NOTHING
      RETURNING id
    `;
    const counted = await this.sql<Array<{ visits: number }>>`
      SELECT count(*)::int AS visits FROM affiliate_share_hits WHERE token = ${verified.token} AND surface = ${verified.surface}
    `;
    return { token: verified.token, surface: verified.surface, counted: inserted.length > 0, visits: Number(counted[0]?.visits ?? 0) };
  }

  /** Visits per surface on the referrer's live token. No live token: `share.not_found`. */
  async surfaceStats(referrerId: string): Promise<ShareSurfaceStats> {
    const id = requireId(referrerId, 'referrerId');
    const live = await this.sql<Array<{ token: string }>>`
      SELECT token FROM affiliate_share_tokens WHERE referrer_id = ${id} AND revoked_at IS NULL LIMIT 1
    `;
    const token = live[0]?.token;
    if (!token) throw new ShareError('No active share token [share.not_found]', 'share.not_found');
    const rows = await this.sql<Array<{ surface: string; visits: number }>>`
      SELECT surface, count(*)::int AS visits FROM affiliate_share_hits WHERE token = ${token} GROUP BY surface
    `;
    const by = new Map(rows.map((r) => [r.surface, Number(r.visits)]));
    return { token, surfaces: SHARE_SURFACES.map((surface) => ({ surface, visits: by.get(surface) ?? 0 })) };
  }

  private async assertReferrerAlive(referrerId: string): Promise<void> {
    const rows = await this.sql<Array<{ id: string; status: string }>>`
      SELECT id, status FROM users WHERE id = ${referrerId} LIMIT 1
    `;
    const row = rows[0];
    if (!row || row.status === 'closed') {
      throw new ShareError('Referrer profile is gone [share.profile_gone]', 'share.profile_gone');
    }
  }

  async createShare(referrerId: string): Promise<ShareRecord> {
    const id = requireId(referrerId, 'referrerId');
    await this.assertReferrerAlive(id);
    const existing = await this.sql<TokenRow[]>`
      SELECT token, referrer_id, hits, revoked_at, created_at
        FROM affiliate_share_tokens
       WHERE referrer_id = ${id} AND revoked_at IS NULL
       LIMIT 1
    `;
    if (existing[0]) return toRecord(existing[0]);
    try {
      const rows = await this.sql<TokenRow[]>`
        INSERT INTO affiliate_share_tokens (referrer_id)
        VALUES (${id})
        RETURNING token, referrer_id, hits, revoked_at, created_at
      `;
      return toRecord(rows[0]!);
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      if (code === '23505') {
        const again = await this.sql<TokenRow[]>`
          SELECT token, referrer_id, hits, revoked_at, created_at
            FROM affiliate_share_tokens
           WHERE referrer_id = ${id} AND revoked_at IS NULL
           LIMIT 1
        `;
        if (again[0]) return toRecord(again[0]);
      }
      throw err;
    }
  }

  /** Who a live link belongs to, without counting a visit; null for an unknown or revoked link. */
  async referrerOf(token: string): Promise<string | null> {
    const rows = await this.sql<Array<{ referrer_id: string }>>`
      SELECT referrer_id FROM affiliate_share_tokens WHERE token = ${requireId(token, 'token')} AND revoked_at IS NULL LIMIT 1
    `;
    return rows[0]?.referrer_id ?? null;
  }

  async revokeShare(referrerId: string): Promise<ShareRecord> {
    const id = requireId(referrerId, 'referrerId');
    const rows = await this.sql<TokenRow[]>`
      UPDATE affiliate_share_tokens
         SET revoked_at = now()
       WHERE referrer_id = ${id} AND revoked_at IS NULL
      RETURNING token, referrer_id, hits, revoked_at, created_at
    `;
    if (!rows[0]) throw new ShareError('No active share token [share.not_found]', 'share.not_found');
    return toRecord(rows[0]);
  }

  async shareHits(token: string): Promise<ShareHitResult> {
    const t = requireId(token, 'token');
    const rows = await this.sql<TokenRow[]>`
      SELECT token, referrer_id, hits, revoked_at, created_at
        FROM affiliate_share_tokens
       WHERE token = ${t}
       LIMIT 1
    `;
    const rec = rows[0];
    if (!rec) throw new ShareError('Share token is unknown [share.unknown]', 'share.unknown');
    if (rec.revoked_at) throw new ShareError('Share token is revoked [share.revoked]', 'share.revoked');
    await this.assertReferrerAlive(rec.referrer_id);
    const updated = await this.sql<Array<{ hits: number }>>`
      UPDATE affiliate_share_tokens
         SET hits = hits + 1
       WHERE token = ${t} AND revoked_at IS NULL
      RETURNING hits
    `;
    if (!updated[0]) throw new ShareError('Share token is revoked [share.revoked]', 'share.revoked');
    return { token: rec.token, referrerId: rec.referrer_id, hits: Number(updated[0].hits) };
  }
}
