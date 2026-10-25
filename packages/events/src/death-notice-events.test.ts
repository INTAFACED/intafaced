import { describe, expect, it } from 'vitest';
import { EVENT_CATALOG } from './catalog.js';

const base = () => ({ userId: crypto.randomUUID(), noticeId: crypto.randomUUID(), at: new Date().toISOString() });

describe('RC-identity-02 death notice events', () => {
  it('declares both subjects under identity', () => {
    expect(EVENT_CATALOG.deathNoticeCreated.subject).toBe('intafaced.identity.death_notice.created');
    expect(EVENT_CATALOG.deathNoticeConfirmed.subject).toBe('intafaced.identity.death_notice.confirmed');
  });

  it('needs the account, the notice and the time, and carries no reporter or evidence on the bus', () => {
    for (const event of [EVENT_CATALOG.deathNoticeCreated, EVENT_CATALOG.deathNoticeConfirmed]) {
      expect(event.schema.safeParse(base()).success).toBe(true);
      const { noticeId: _n, ...noNotice } = base();
      expect(event.schema.safeParse(noNotice).success).toBe(false);
      const parsed = event.schema.parse({ ...base(), reporter: 'executor', evidenceDocumentIds: ['doc-1'], caseRef: 'C-1' });
      expect(Object.keys(parsed).sort()).toEqual(['at', 'noticeId', 'userId']);
    }
  });
});
