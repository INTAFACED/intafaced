import { describe, expect, it } from 'vitest';
import { userCopy } from './user-copy.js';

/**
 * Unit card — user-visible support copy resolves @intafaced/i18n keys
 * 1. Promise: TRK-infra.i18n slice — public/ops refuse + KB door strings
 * 2. Break: unknown key invents English instead of echoing the dotted name
 * 3. Done bar: known key renders catalog copy; unknown key === key string
 * 4. Class N
 * 5. Paths: services/svc-support + packages/i18n consumer pin (do not edit catalog)
 * 6. RED: unknown key becomes a sentence
 * 7. Collision: none vs svc-edge / packages/i18n catalog
 */
describe('userCopy — catalog keys, never invented English', () => {
  it('resolves a known catalog key from @intafaced/i18n', () => {
    expect(userCopy('error.notFound')).toBe('We could not find that.');
    expect(userCopy('support.not_found')).toBe('We could not find that.');
    expect(userCopy('support.claim.not_found')).toBe('We could not find that.');
    expect(userCopy('support.kb.not_published')).toBe('We could not find that.');
    expect(userCopy('error.forbidden')).toBe('You do not have access to this.');
    expect(userCopy('scope.denied')).toBe('You do not have access to this.');
    expect(userCopy('error.generic')).toBe('Something went wrong. Try again.');
    expect(userCopy('error.unauthorized')).toBe('Sign in to continue.');
  });

  it('renders the dotted key when the key is not in the catalog', () => {
    const missing = 'support.refuse.this.key.does.not.exist';
    const rendered = userCopy(missing);

    expect(rendered).toBe(missing);
    expect(rendered).not.toMatch(/ /);
    expect(rendered).not.toMatch(/please try|something went wrong|could not find|ticket not found/i);
  });

  it('does not invent copy for unkeyed support refuse codes', () => {
    const terminal = userCopy('support.comment.terminal');
    expect(terminal).toBe('support.comment.terminal');
    expect(terminal).not.toMatch(/ /);
    expect(terminal).not.toMatch(/comment refused|ticket is terminal/i);

    const stale = userCopy('support.kb_revision_stale');
    expect(stale).toBe('support.kb_revision_stale');
    expect(stale).not.toMatch(/ /);
    expect(stale).not.toMatch(/revision is stale|KB article refused/i);

    const vendor = userCopy('support.kb_vendor_name');
    expect(vendor).toBe('support.kb_vendor_name');
    expect(vendor).not.toMatch(/ /);
    expect(vendor).not.toMatch(/vendor-clean|binance/i);

    const unknownVersion = userCopy('support.kb_version_unknown');
    expect(unknownVersion).toBe('support.kb_version_unknown');
    expect(unknownVersion).not.toMatch(/ /);
    expect(unknownVersion).not.toMatch(/older body|not published/i);

    const settle = userCopy('support.settle.refused');
    expect(settle).toBe('support.settle.refused');
    expect(settle).not.toMatch(/ /);
    expect(settle).not.toMatch(/payout|refund|unfreeze/i);

    const queueLimit = userCopy('support.queue_list_limit_unset');
    expect(queueLimit).toBe('support.queue_list_limit_unset');
    expect(queueLimit).not.toMatch(/ /);
    expect(queueLimit).not.toMatch(/100-row|default 100/i);

    const listAllLimit = userCopy('support.list_all_limit_unset');
    expect(listAllLimit).toBe('support.list_all_limit_unset');
    expect(listAllLimit).not.toMatch(/ /);
    expect(listAllLimit).not.toMatch(/100-row|default 100/i);

    const listMineLimit = userCopy('support.list_mine_limit_unset');
    expect(listMineLimit).toBe('support.list_mine_limit_unset');
    expect(listMineLimit).not.toMatch(/ /);
    expect(listMineLimit).not.toMatch(/100-row|default 100/i);

    const listCommentsLimit = userCopy('support.list_comments_limit_unset');
    expect(listCommentsLimit).toBe('support.list_comments_limit_unset');
    expect(listCommentsLimit).not.toMatch(/ /);
    expect(listCommentsLimit).not.toMatch(/100-row|default 100/i);

    const listEventsLimit = userCopy('support.list_events_limit_unset');
    expect(listEventsLimit).toBe('support.list_events_limit_unset');
    expect(listEventsLimit).not.toMatch(/ /);
    expect(listEventsLimit).not.toMatch(/100-row|default 100/i);

    const listKbLimit = userCopy('support.list_kb_limit_unset');
    expect(listKbLimit).toBe('support.list_kb_limit_unset');
    expect(listKbLimit).not.toMatch(/ /);
    expect(listKbLimit).not.toMatch(/100-row|default 100/i);
  });

  it('resolves existing KB spine catalog keys without expanding the catalog', () => {
    expect(userCopy('support.kb.account_access.title')).toBe('Sign-in and account access');
    expect(userCopy('support.kb.security_basics.title')).toBe('Security basics');
    expect(userCopy('support.kb.orders_status.title')).toBe('Order status');
    expect(userCopy('support.kb.deposit_withdraw.title')).toBe('Deposits and withdrawals');
    expect(userCopy('support.kb.paper_vs_live.title')).toBe('Paper vs live trading');
  });
});
