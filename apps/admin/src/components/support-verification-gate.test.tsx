import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SupportVerificationView, VerificationReply } from '@/lib/support/verification';
import { VerificationGateView, type VerificationGateViewProps } from './support-verification-gate';

/** J-support-public-20 #2 on the desk: the count of checks, every record kind with the service that confirms it, and refusals as svc-support gave them. */

const T1 = '22222222-2222-4222-8222-222222222222';
const W1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OP = '33333333-3333-4333-8333-333333333333';

const view = (checks: SupportVerificationView['checks']): SupportVerificationView => ({ asOf: '2026-11-02T02:00:00.000Z', checks });
const html = (over: Partial<VerificationGateViewProps> = {}) =>
  renderToStaticMarkup(
    <VerificationGateView
      view={view({ kind: 'ok', data: { required: 2, checks: [] } })}
      loading={false}
      recordKind="withdrawal"
      recordId=""
      busy={false}
      outcome={null}
      onField={() => undefined}
      onRecord={() => undefined}
      onRead={() => undefined}
      {...over}
    />,
  );

describe('balance and withdrawal destination panel', () => {
  it('says how many of the two checks are recorded and offers every record kind with the service that confirms it', () => {
    const out = html();
    expect(out).toContain('0 of 2 checks recorded');
    expect(out).toContain('Withdrawal (confirmed by svc-pay)');
    expect(out).toContain('Deposit (confirmed by svc-pay)');
    expect(out).toContain('Order (confirmed by svc-trade)');
    expect(out).toContain('Read the balance');
    expect(out).toContain('Read the withdrawal destination');
    expect(out).not.toContain('Checks recorded');
  });

  it('lists a recorded check by record and id, with who and when, and no amount', () => {
    const out = html({
      view: view({
        kind: 'ok',
        data: {
          required: 2,
          checks: [
            {
              ticketId: T1,
              kind: 'owned_record',
              recordKind: 'withdrawal',
              recordId: W1,
              recordedBy: OP,
              recordedAt: '2026-11-02T01:00:00.000Z',
            },
          ],
        },
      }),
    });
    expect(out).toContain('1 of 2 checks recorded');
    expect(out).toContain('aria-label="Checks recorded"');
    expect(out).toContain('Withdrawal');
    expect(out).not.toMatch(/amount|balance:/i);
  });

  it('a check cannot be sent without a full id', () => {
    expect(html({ recordId: 'w-1' })).toMatch(/<button type="button" class="adm-btn" disabled="">Record as a check/);
    expect(html({ recordId: W1 })).not.toMatch(/disabled="">Record as a check/);
  });

  it('shows a refusal as svc-support gave it, and an unread service as unread', () => {
    const refused: VerificationReply = {
      ok: false,
      refusal: {
        title: 'Two checks the customer can confirm are needed first',
        body: 'svc-support refused to read it: 0 of 2 recorded. Nothing was read.',
        next: 'Ask the customer for the ids of two of their own records.',
        code: 'support.verification_checks_required',
        changed: 'no',
      },
    };
    const out = html({ outcome: refused });
    expect(out).toContain('data-code="support.verification_checks_required"');
    expect(out).toContain('Nothing was read.');
    expect(html({ view: null })).toContain('Nothing is shown rather than a guess');
  });
});
