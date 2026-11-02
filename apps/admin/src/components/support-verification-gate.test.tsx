import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SupportVerificationChecks, SupportVerificationView, VerificationReply } from '@/lib/support/verification';
import { VerificationGateView, type VerificationGateViewProps } from './support-verification-gate';

/**
 * J-support-public-20 #2 on the desk ("Verify the customer", RC-support-public-01): how many of the two checks match, both
 * check inputs with the service that answers each, the three reads disabled with the named blocker until the gate holds,
 * and refusals as svc-support gave them.
 */

const T1 = '22222222-2222-4222-8222-222222222222';
const W1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OP = '33333333-3333-4333-8333-333333333333';

const data = (over: Partial<SupportVerificationChecks> = {}): SupportVerificationChecks => ({
  required: 2,
  matched: 0,
  attemptsAllowed: 5,
  attemptsUsed: 0,
  checks: [],
  ...over,
});
const view = (checks: SupportVerificationView['checks']): SupportVerificationView => ({ asOf: '2026-11-02T02:00:00.000Z', checks });
const html = (over: Partial<VerificationGateViewProps> = {}) =>
  renderToStaticMarkup(
    <VerificationGateView
      view={view({ kind: 'ok', data: data() })}
      loading={false}
      email=""
      recordKind="withdrawal_id"
      recordValue=""
      busy={false}
      outcome={null}
      onField={() => undefined}
      onRecordEmail={() => undefined}
      onRecordId={() => undefined}
      onRead={() => undefined}
      {...over}
    />,
  );
const disabled = (out: string, label: string) => new RegExp(`disabled=""[^>]*>${label}<`).test(out);

describe('verify the customer card', () => {
  it('shows the count, both checks with the service that answers each, and the three reads', () => {
    const out = html();
    expect(out).toContain('Verify the customer');
    expect(out).toContain('0 of 2 checks matched');
    expect(out).toContain('confirmed by svc-identity');
    expect(out).toContain('Withdrawal id (confirmed by svc-pay)');
    expect(out).toContain('Deposit id (confirmed by svc-pay)');
    expect(out).toContain('Client order id (confirmed by svc-trade)');
    for (const label of ['Read the balance', 'Read the fills', 'Read the withdrawal destination']) {
      expect(out).toContain(label);
      expect(disabled(out, label)).toBe(true);
    }
    expect(out).toContain('Needs the customer’s email and one of their record ids matched (0 of 2).');
  });

  it('the reads open only when the gate holds', () => {
    const out = html({ view: view({ kind: 'ok', data: data({ matched: 2 }) }) });
    expect(disabled(out, 'Read the balance')).toBe(false);
    expect(out).not.toContain('data-testid="verification-read-blocker"');
  });

  it('lists a check by kind and whether it matched, with who and when, and never a value', () => {
    const out = html({
      view: view({
        kind: 'ok',
        data: data({
          matched: 1,
          checks: [{ ticketId: T1, kind: 'email', matched: true, checkedBy: OP, checkedAt: '2026-11-02T01:00:00.000Z' }],
        }),
      }),
    });
    expect(out).toContain('1 of 2 checks matched');
    expect(out).toContain('aria-label="Checks recorded"');
    expect(out).toContain('<td>Email</td><td>Yes</td>');
    expect(out).not.toMatch(/@|amount|balance:/i);
  });

  it('a check is sent only in the shape of its kind, and never while the attempts value is blank', () => {
    expect(disabled(html({ recordValue: 'w-1' }), 'Check the record id')).toBe(true);
    expect(disabled(html({ recordValue: W1 }), 'Check the record id')).toBe(false);
    expect(disabled(html({ email: 'nope' }), 'Check the email')).toBe(true);
    expect(disabled(html({ email: 'ann@example.com' }), 'Check the email')).toBe(false);
    const unset = html({ email: 'ann@example.com', view: view({ kind: 'ok', data: data({ attemptsAllowed: null }) }) });
    expect(disabled(unset, 'Check the email')).toBe(true);
    expect(unset).toContain('SUPPORT_VERIFICATION_ATTEMPTS');
    const used = html({ recordValue: W1, view: view({ kind: 'ok', data: data({ attemptsAllowed: 2, attemptsUsed: 2 }) }) });
    expect(disabled(used, 'Check the record id')).toBe(true);
    expect(used).toContain('used all 2 check attempts');
  });

  it('shows a refusal as svc-support gave it, and an unread service as unread', () => {
    const refused: VerificationReply = {
      ok: false,
      refusal: {
        title: 'svc-identity serves the desk no door for this yet',
        body: 'Nothing was stored and nothing was read.',
        next: 'Nothing was changed.',
        code: 'support.disclosure_unwired',
        changed: 'no',
      },
    };
    const out = html({ outcome: refused });
    expect(out).toContain('data-code="support.disclosure_unwired"');
    expect(out).toContain('Nothing was stored and nothing was read.');
    expect(html({ view: null })).toContain('Nothing is shown rather than a guess');
  });
});
