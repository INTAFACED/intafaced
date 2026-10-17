import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OpsDeskView, type OpsDeskViewProps } from './ops-desk';
import { VendorActions, AmbassadorActions, ResidencyActions, AppointAmbassadorAction } from './ops-actions';
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
    expect(html).toContain('As of 03:00:00 UTC');
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
    expect(html).toContain('Ask a second operator to approve: approve');
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

describe('Export CSV on every list read', () => {
  it('a list with rows offers an export of exactly the rows shown, and says so', () => {
    const html = render(props('bank', view('bank', [okOutcome('bank', 'bank.pools', [POOL, { ...POOL, id: 'pool-2' }])])));
    expect(html).toContain('data-testid="export-csv"');
    expect(html).toContain('Export CSV (2 rows shown)');
    expect(html).toContain('Exports the 2 rows shown above (not a full table export), as read at 2026-10-17T03:00:00.000Z.');
  });
  it('a full page says the file is capped and more rows may exist', () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({ ...POOL, id: `p${i}` }));
    const html = render(props('bank', view('bank', [okOutcome('bank', 'bank.pools', rows)])));
    expect(html).toContain('Export CSV (200 rows shown)');
    expect(html).toContain('capped at 200 rows');
    expect(html).toContain('more rows may exist that are not in the file');
  });
  it('an empty list or a failed read has nothing to export', () => {
    expect(render(props('bank', view('bank', [okOutcome('bank', 'bank.pools', [])])))).not.toContain('export-csv');
    expect(render(props('bank', view('bank', [failed('bank.pools')])))).not.toContain('export-csv');
  });
  it('every list read on every desk renders the export when it has rows', () => {
    for (const id of ['bank', 'p2p', 'academy', 'more', 'protocol'] as const) {
      for (const spec of allReads(DESKS[id]).filter((r) => r.shape === 'list')) {
        // One row built from the declared columns, so the check does not depend on a hand-written fixture per read.
        const sample: Record<string, unknown> = {};
        for (const c of spec.columns) {
          const path = c.key.split('.');
          let target = sample;
          for (const part of path.slice(0, -1)) target = (target[part] ??= {}) as Record<string, unknown>;
          target[path[path.length - 1]!] =
            c.kind === 'int' || c.kind === 'bps' ? 1 : c.kind === 'bool' ? true : c.kind === 'time' ? AT : c.kind === 'list' ? ['a'] : 'x';
        }
        const raw = spec.rowsKey ? { [spec.rowsKey]: [sample] } : [sample];
        const html = render(props(id, view(id, [okOutcome(id, spec.id, raw)])));
        expect(html, spec.id).toContain('Export CSV (1 row shown)');
      }
    }
  });
});

describe('plain "could not load" for a service that does not answer', () => {
  it('names the read in plain words, with the time it was tried, and still shows its neighbours', () => {
    const html = render(
      props(
        'protocol',
        view('protocol', [failed('protocol.chain', { message: 'svc-protocol did not answer.' }), failed('protocol.audit')]),
      ),
    );
    expect(html).toContain('Could not load chain status');
    expect(html).toContain('Could not load audit status');
    expect(html).toContain('As of 03:00:00 UTC');
    expect(html).toContain('svc-protocol did not answer.');
    expect(html).not.toMatch(/protocol\.chainStatus/);
  });
});

describe('token section', () => {
  const PROPOSAL = {
    id: '5a3b9c10-1111-4222-8333-444455556666',
    kind: 'fee_param',
    body: {},
    status: 'open',
    opensAt: AT,
    closesAt: '2026-10-24T03:00:00.000Z',
    createdAt: AT,
  };
  it('shows proposals, the burned supply and the next epoch with their times, and names what it cannot read', () => {
    const html = render(
      props(
        'more',
        view('more', [
          okOutcome('more', 'token.proposals', [PROPOSAL]),
          okOutcome('more', 'token.burned', { burned: '1200.5' }),
          okOutcome('more', 'token.epoch', { epoch: 7 }),
        ]),
      ),
    );
    expect(html).toContain('data-testid="section-token"');
    expect(html).toContain('fee_param');
    expect(html).toMatch(/<dt>Burned<\/dt><dd>1200.5<\/dd>/);
    expect(html).toMatch(/<dt>Next epoch<\/dt><dd>7<\/dd>/);
    expect(html).toContain('Export CSV (1 row shown)');
    expect(html).toContain('Not available: Total and circulating supply, total staked, number of stakers');
    expect(html).toContain('Back-end need 29');
  });
  it('a refused token read shows the plain permission sentence and no figure, while the others still render', () => {
    const html = render(
      props(
        'more',
        view('more', [
          failed('token.burned', {
            forbidden: true,
            message:
              'Your console session does not have token read permission yet: svc-token did not accept your founder session for this read (it needs token:read).',
          }),
          okOutcome('more', 'token.epoch', { epoch: 3 }),
        ]),
      ),
    );
    expect(html).toContain('Could not load burned supply');
    expect(html).toContain('Your console session does not have token read permission yet');
    expect(html).toMatch(/<dt>Next epoch<\/dt><dd>3<\/dd>/);
  });
});

describe('academy decide residency and appoint ambassador', () => {
  const APPLICATION = {
    id: '5a3b9c10-1111-4222-8333-444455556666',
    userId: '9f8e7d6c-1111-4222-8333-444455556666',
    cohortSlug: 'autumn-2026',
    status: 'applied',
    appliedAt: AT,
    statement: 'I want to <b>build</b>',
  };
  const outcome = okOutcome('academy', 'academy.residencies', [APPLICATION]);
  const rowOf = (o: ReadOutcome): Row => {
    if (o.part.kind !== 'ok' || o.part.data.shape !== 'list') throw new Error('list expected');
    return o.part.data.rows[0]!;
  };
  it('the two controls are no longer disabled placeholders: the desk renders the appoint form and the residency decision', () => {
    const html = render(props('academy', view('academy', [outcome]), { openKey: `academy.residencies:${APPLICATION.id}` }));
    expect(html).not.toContain('this console does not carry it yet');
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>Decide a residency<\/button>/);
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>Appoint an ambassador<\/button>/);
    expect(html).toContain('data-testid="appoint-ambassador"');
    expect(html).toContain('data-testid="residency-actions"');
  });
  it('appoint renders with no ambassador list at all, asks for a user id first, and holds the send until it is a real id', () => {
    const html = render(props('academy', null));
    expect(html).toContain('data-testid="appoint-ambassador"');
    expect(html).toContain('User id of the person to appoint');
    expect(html).toContain('Enter the person’s user id above first');
    expect(html).toContain('Ask a second operator to approve the appointment');
    // The other founder's approve-and-run workbench is not held back by the missing id.
    expect(html).toContain('Approve, reject, withdraw or run a request');
    expect(html).not.toContain('This control is switched off');
  });
  it('an open residency offers accept and reject as a two-founder request with the phrase to type, and sends no note', () => {
    const html = renderToStaticMarkup(<ResidencyActions row={rowOf(outcome)} userId={ME} onChanged={() => undefined} />);
    expect(html).toContain('>Accept<');
    expect(html).toContain('>Reject<');
    expect(html).toContain('ACCEPT RESIDENCY 5a3b9c10');
    expect(html).toContain('Ask a second operator to approve: accept the application');
    expect(html).toContain('No note is sent');
    expect(html).not.toContain('id="dk-reason"');
  });
  it('a decided application has no decision to take', () => {
    const decided = okOutcome('academy', 'academy.residencies', [{ ...APPLICATION, status: 'accepted' }]);
    const html = renderToStaticMarkup(<ResidencyActions row={rowOf(decided)} userId={ME} onChanged={() => undefined} />);
    expect(html).toContain('residency-no-action');
    expect(html).not.toContain('ACCEPT RESIDENCY');
  });
  it('the appoint control renders on its own as well', () => {
    expect(renderToStaticMarkup(<AppointAmbassadorAction userId={ME} onChanged={() => undefined} />)).toContain('id="appoint-user"');
  });
});

describe('protocol ops desk', () => {
  const CHAIN = {
    reachable: false,
    configuredChainId: 84532,
    observedChainId: null,
    blockNumber: null,
    suiteConfigured: false,
    suiteDeployed: false,
    tokenFactoryConfigured: false,
    tokenFactoryDeployed: false,
    refusalCode: 'protocol.chain_unconfigured',
    reason: 'no rpc url configured',
    usable: false,
    launchUsable: false,
  };
  it('with every service down it says "could not load" for each, shows no number, and every action still has its blockers', () => {
    const html = render(
      props(
        'protocol',
        view(
          'protocol',
          ['protocol.chain', 'protocol.audit', 'protocol.indexer', 'protocol.dex', 'protocol.health'].map((id) => failed(id)),
        ),
      ),
    );
    for (const name of ['chain status', 'audit status', 'indexer finality', 'DEX health', 'protocol service health']) {
      expect(html, name).toContain(`Could not load ${name}`);
    }
    expect(html).toContain('data-testid="protocol-blockers"');
    for (const action of ['swap', 'bridge', 'stake', 'launchToken']) expect(html).toContain(`blockers-${action}`);
    expect(html).toContain('Not audited. Passing tests is not an audit.');
    expect(html).toContain('No chain reported');
    expect(html).toContain('Not confirmed as INTACHAIN.');
    expect(html).toContain('0 of 5 reads answered');
  });
  it('a reachable test chain is labelled as a test network, never INTACHAIN, and the audit reads "no"', () => {
    const html = render(
      props(
        'protocol',
        view('protocol', [
          okOutcome('protocol', 'protocol.chain', { ...CHAIN, reachable: true, observedChainId: 84532, blockNumber: '55' }),
          okOutcome('protocol', 'protocol.audit', {
            id: 'smart-accounts-internal',
            kind: 'internal',
            packagePath: 'services/svc-protocol/audit',
            artifactHash: `0x${'a'.repeat(64)}`,
            signedBy: null,
            signedAt: null,
            audited: false,
          }),
        ]),
      ),
    );
    expect(html).toContain('Base Sepolia test network');
    expect(html).toContain('Testnet only.');
    expect(html).toMatch(/<dt>Audited by an outside firm<\/dt><dd>no<\/dd>/);
    expect(html).not.toMatch(/Base[^<]*INTACHAIN network is live/);
  });
  it('has no actions at all: no form, no request, no export of a record', () => {
    const html = render(props('protocol', view('protocol', [okOutcome('protocol', 'protocol.chain', CHAIN)])));
    expect(html).not.toContain('request-form');
    expect(html).not.toContain('control-desk');
    expect(html).not.toContain('export-csv');
  });
});
