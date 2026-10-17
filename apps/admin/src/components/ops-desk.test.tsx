import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OpsDeskView, type OpsDeskViewProps } from './ops-desk';
import { VendorActions, AmbassadorActions } from './ops-actions';
import { DESKS, allReads } from '@/lib/ops-desk/catalog';
import { readData } from '@/lib/ops-desk/model';
import type { DeskView, OpsDeskId, ReadOutcome, Row } from '@/lib/ops-desk/types';

const ME = '11111111-1111-4111-8111-111111111111';
const AT = '2026-10-17T03:00:00.000Z';

function okOutcome(deskId: OpsDeskId, readId: string, raw: unknown): ReadOutcome {
  const spec = allReads(DESKS[deskId]).find((r) => r.id === readId)!;
  const data = readData(spec, raw);
  if (!data) throw new Error(`fixture for ${readId} does not read`);
  return { id: readId, asOf: AT, part: { kind: 'ok', data } };
}
const failed = (readId: string, over: Record<string, unknown> = {}): ReadOutcome => ({
  id: readId,
  asOf: AT,
  part: { kind: 'failed', message: 'svc-bank refused this read.', code: null, notBuilt: false, forbidden: false, ...over },
});
const view = (deskId: OpsDeskId, outcomes: ReadOutcome[]): DeskView => ({
  deskId,
  asOf: AT,
  reads: Object.fromEntries(outcomes.map((o) => [o.id, o])),
});
const props = (deskId: OpsDeskId, v: DeskView | null, over: Partial<OpsDeskViewProps> = {}): OpsDeskViewProps => ({
  spec: DESKS[deskId],
  view: v,
  loading: false,
  userId: ME,
  openKey: null,
  onOpen: () => undefined,
  onRefresh: () => undefined,
  ...over,
});
const render = (p: OpsDeskViewProps) => renderToStaticMarkup(<OpsDeskView {...p} />);

const POOL = {
  id: 'pool-1',
  assetId: 'USDC',
  kind: 'flexible',
  name: 'Flexible USDC',
  aprBps: 450,
  termDays: null,
  minDeposit: '10.00000000',
};

describe('bank desk', () => {
  it('shows a list with its count, formatted exactly, and the time it was read', () => {
    const html = render(props('bank', view('bank', [okOutcome('bank', 'bank.pools', [POOL])])));
    expect(html).toContain('Flexible USDC');
    expect(html).toContain('4.50%');
    expect(html).toContain('10.00000000');
    expect(html).toContain('1 row');
    expect(html).toContain(`As of ${AT}`);
  });
  it('lists every figure the service cannot give as "Not available" with its reason, never as a number', () => {
    const html = render(props('bank', view('bank', [])));
    for (const section of DESKS.bank.sections) {
      for (const u of section.unavailable) {
        expect(html).toContain(`unavailable-${u.id}`);
        expect(html).toContain(u.reason.slice(0, 40).replace(/&/g, '&amp;').replace(/’/g, '’'));
      }
    }
    expect(html).toContain('Not available: Pool balances, depositors and utilisation');
    expect(html).toContain('Back-end need 13');
  });
  it('a refused read says it refused the session and shows no table; its neighbours still render', () => {
    const html = render(
      props(
        'bank',
        view('bank', [
          okOutcome('bank', 'bank.pools', [POOL]),
          failed('bank.loan-products', {
            forbidden: true,
            message: 'svc-bank did not accept your founder session for this read (it needs bank:read).',
          }),
        ]),
      ),
    );
    expect(html).toContain('refused your session');
    expect(html).toContain('needs bank:read');
    expect(html).toContain('Flexible USDC');
  });
  it('an empty list reads as "none configured", with the caveat, and a full page is not called a total', () => {
    const empty = render(props('bank', view('bank', [okOutcome('bank', 'bank.pools', [])])));
    expect(empty).toContain('none are configured, not that Earn is healthy');
    const rows = Array.from({ length: 200 }, (_, i) => ({ ...POOL, id: `p${i}` }));
    const full = render(props('bank', view('bank', [okOutcome('bank', 'bank.pools', rows)])));
    expect(full).toContain('not a total');
  });
  it('without any read it says nothing was read, and shows no figure', () => {
    const html = render(props('bank', null));
    expect(html).toContain('No read yet');
    expect(html).toContain('Nothing is shown rather than a guess');
    expect(html).not.toContain('Flexible USDC');
  });
  it('a refresh that failed keeps the earlier read but says so with its time', () => {
    const html = render(props('bank', view('bank', [okOutcome('bank', 'bank.pools', [POOL])]), { stale: true }));
    expect(html).toContain('earlier read');
    expect(html).toContain(AT);
  });
  it('disabled actions are real disabled buttons with the reason beside them', () => {
    const html = render(props('bank', view('bank', [])));
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Fund a pool<\/button>/);
    expect(html).toContain('Moves treasury money');
  });
  it('links to the existing controls instead of repeating them', () => {
    const html = render(props('bank', view('bank', [])));
    expect(html).toContain('href="/tools"');
    expect(html).toContain('href="/accounts"');
  });
});

describe('p2p desk', () => {
  it('shows the dispute counts as facts, with escalation and ruling shown as switched off with why', () => {
    const html = render(
      props(
        'p2p',
        view('p2p', [okOutcome('p2p', 'p2p.backlog', { open: 3, overdue: 1, escalated: 1, neverSeen: 2, moderationConfigured: true })]),
      ),
    );
    expect(html).toContain('Never seen by a moderator');
    expect(html).toMatch(/<dt>Open<\/dt><dd>3<\/dd>/);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Escalate a dispute<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Release or refund escrow<\/button>/);
    expect(html).toContain('Not available: Offers: open, paused, closed');
  });
});

describe('academy and more desks', () => {
  it('academy names the two things it cannot audit', () => {
    const html = render(props('academy', view('academy', [])));
    expect(html).toContain('Not available: Enrolments, lesson completions and completion rate');
    expect(html).toContain('Not available: Certificate grant audit');
  });
  it('more names mining, launch and campaigns as not available, and Predict as waiting on a decision', () => {
    const html = render(props('more', view('more', [])));
    expect(html).toContain('Not available: Workers, shares accepted and rejected, payout windows');
    expect(html).toContain('Not available: Issuer state');
    expect(html).toContain('Not available: Campaign participation');
    expect(html).toContain('Waiting on a decision, not on code.');
  });
});

describe('row detail and actions', () => {
  const APPLICATION = {
    id: '5a3b9c10-1111-4222-8333-444455556666',
    userId: '9f8e7d6c-1111-4222-8333-444455556666',
    displayName: 'Acme <b>Ltd</b>',
    description: 'Sells charts',
    status: 'applied',
    createdAt: AT,
    updatedAt: AT,
  };
  const outcome = okOutcome('more', 'market.applications', [APPLICATION]);
  const rowOf = (o: ReadOutcome): Row => {
    if (o.part.kind !== 'ok' || o.part.data.shape !== 'list') throw new Error('list expected');
    return o.part.data.rows[0]!;
  };
  it('a closed row shows only the table columns, and escapes what a vendor typed', () => {
    const html = render(props('more', view('more', [outcome])));
    expect(html).toContain('Acme &lt;b&gt;Ltd&lt;/b&gt;');
    expect(html).not.toContain('<b>Ltd</b>');
    expect(html).not.toContain('Sells charts');
  });
  it('an open row shows the detail columns and the two-founder decision form', () => {
    const html = render(props('more', view('more', [outcome]), { openKey: `market.applications:${APPLICATION.id}` }));
    expect(html).toContain('Sells charts');
    expect(html).toContain('data-testid="vendor-actions"');
    expect(html).toContain('Ask a second founder to approve: approve');
    expect(html).toContain('APPROVE VENDOR 5a3b9c10');
  });
  it('only one row is open across the desk', () => {
    const html = render(props('more', view('more', [outcome]), { openKey: 'market.approved:other' }));
    expect(html).not.toContain('vendor-actions');
  });
  it('a rejected vendor has no decision to take', () => {
    const rejected = okOutcome('more', 'market.applications', [{ ...APPLICATION, status: 'rejected' }]);
    expect(renderToStaticMarkup(<VendorActions row={rowOf(rejected)} userId={ME} onChanged={() => undefined} />)).toContain(
      'vendor-no-action',
    );
  });
  it('an approved vendor can only be suspended; an applied one can be approved or rejected', () => {
    const approved = okOutcome('more', 'market.approved', [{ ...APPLICATION, status: 'approved' }]);
    const a = renderToStaticMarkup(<VendorActions row={rowOf(approved)} userId={ME} onChanged={() => undefined} />);
    expect(a).toContain('SUSPEND VENDOR 5a3b9c10');
    expect(a).not.toContain('>Reject<');
    const b = renderToStaticMarkup(<VendorActions row={rowOf(outcome)} userId={ME} onChanged={() => undefined} />);
    expect(b).toContain('>Approve<');
    expect(b).toContain('>Reject<');
  });
  it('an active ambassador offers a freeze with a reason; a frozen one offers lifting it without one', () => {
    const base = {
      userId: '9f8e7d6c-1111-4222-8333-444455556666',
      appointedBy: ME,
      appointedAt: AT,
      frozenAt: null,
      frozenBy: null,
      freezeReason: null,
    };
    const active = okOutcome('academy', 'academy.ambassadors', [{ ...base, status: 'active' }]);
    const frozen = okOutcome('academy', 'academy.ambassadors', [
      { ...base, status: 'frozen', frozenAt: AT, frozenBy: ME, freezeReason: 'complaint' },
    ]);
    const freezeHtml = renderToStaticMarkup(<AmbassadorActions row={rowOf(active)} userId={ME} onChanged={() => undefined} />);
    expect(freezeHtml).toContain('FREEZE AMBASSADOR 9f8e7d6c');
    expect(freezeHtml).toContain('id="dk-reason"');
    const liftHtml = renderToStaticMarkup(<AmbassadorActions row={rowOf(frozen)} userId={ME} onChanged={() => undefined} />);
    expect(liftHtml).toContain('UNFREEZE AMBASSADOR 9f8e7d6c');
    expect(liftHtml).not.toContain('id="dk-reason"');
  });
});
