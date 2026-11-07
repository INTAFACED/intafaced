import type { Sql } from 'postgres';
import { SUPPORT_PAYEE_SELF, SUPPORT_SCAM_GUIDE_HREF, type SupportPayeeWarning } from '@intafaced/contracts';
import { SupportError } from './support-service.js';

/**
 * THE SCAM WARNING ON A FIRST-TIME PAYEE (BK-safe-02, J-bank-18 #2).
 *
 * A person reviewing a payment to someone sees the scam warning, with the link to the scam guide, until they have read it
 * for that payee; `seen` records that once per (person, payee), and a second `seen` keeps the first time. Nothing here
 * blocks, holds or reads a payment: the warning is guidance, and the transfer goes on through svc-bank as before.
 */
export interface PayeeWarningBook {
  seenAt(userId: string, payeeId: string): Promise<string | null>;
  /** Records the first read; a second read keeps the first time and returns it. */
  markSeen(userId: string, payeeId: string, at: string): Promise<string>;
}

export class MemoryPayeeWarningBook implements PayeeWarningBook {
  readonly seen = new Map<string, string>();
  async seenAt(userId: string, payeeId: string): Promise<string | null> {
    return this.seen.get(`${userId}:${payeeId}`) ?? null;
  }
  async markSeen(userId: string, payeeId: string, at: string): Promise<string> {
    const key = `${userId}:${payeeId}`;
    if (!this.seen.has(key)) this.seen.set(key, at);
    return this.seen.get(key)!;
  }
}

export class SqlPayeeWarningBook implements PayeeWarningBook {
  constructor(private readonly sql: Sql) {}
  async seenAt(userId: string, payeeId: string): Promise<string | null> {
    const rows = await this.sql<{ seen_at: Date }[]>`
      SELECT seen_at FROM support.payee_warnings_seen WHERE user_id = ${userId} AND payee_id = ${payeeId}
    `;
    return rows[0] ? rows[0].seen_at.toISOString() : null;
  }
  async markSeen(userId: string, payeeId: string, at: string): Promise<string> {
    await this.sql`
      INSERT INTO support.payee_warnings_seen (user_id, payee_id, seen_at) VALUES (${userId}, ${payeeId}, ${at})
      ON CONFLICT DO NOTHING
    `;
    const seen = await this.seenAt(userId, payeeId);
    if (!seen) throw new Error('support.payee_warnings_seen: the read was neither written nor found');
    return seen;
  }
}

export class PayeeWarnings {
  constructor(
    private readonly book: PayeeWarningBook,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async warning(userId: string, payeeId: string): Promise<SupportPayeeWarning> {
    const payee = payeeId.toLowerCase();
    refuseSelf(userId, payee);
    const seenAt = await this.book.seenAt(userId.toLowerCase(), payee);
    return { payeeId: payee, show: seenAt === null, seenAt, guideHref: SUPPORT_SCAM_GUIDE_HREF };
  }

  async seen(userId: string, payeeId: string): Promise<SupportPayeeWarning> {
    const payee = payeeId.toLowerCase();
    refuseSelf(userId, payee);
    const seenAt = await this.book.markSeen(userId.toLowerCase(), payee, this.now().toISOString());
    return { payeeId: payee, show: false, seenAt, guideHref: SUPPORT_SCAM_GUIDE_HREF };
  }
}

function refuseSelf(userId: string, payeeId: string) {
  if (userId.toLowerCase() === payeeId) throw new SupportError('a person is not their own payee', SUPPORT_PAYEE_SELF);
}
