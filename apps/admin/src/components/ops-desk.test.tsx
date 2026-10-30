import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OpsDeskView, type OpsDeskViewProps } from './ops-desk';
import {
  VendorActions,
  AmbassadorActions,
  ResidencyActions,
  AppointAmbassadorAction,
  CARD_COPY,
  CardStatusAction,
  DisputeActions,
  ListingActions,
} from './ops-actions';
import { DESKS, academySectionDesk, allReads } from '@/lib/ops-desk/catalog';
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
    expect(html).toContain('Not available: Provider heartbeat, fiat provider status and ramp volumes');
    expect(html).toContain('Back-end need 16');
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
    expect(html).toContain('from 03:00:00 UTC');
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
  it('shows the dispute counts as facts, with the ruling shown as switched off with why', () => {
    const html = render(
      props(
        'p2p',
        view('p2p', [okOutcome('p2p', 'p2p.backlog', { open: 3, overdue: 1, escalated: 1, neverSeen: 2, moderationConfigured: true })]),
      ),
    );
    expect(html).toContain('Never seen by a moderator');
    expect(html).toMatch(/<dt>Open<\/dt><dd>3<\/dd>/);
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>Escalate a dispute<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Release or refund escrow<\/button>/);
    expect(html).toContain('Not available: Traded volume, cancel rate and release time over a period');
  });
  it('folds the fiat currency table behind its count and CSV export, with every row still one click away', () => {
    const fiat = Array.from({ length: 119 }, (_, i) => ({
      code: `C${String(i).padStart(2, '0')}`,
      name: `Currency ${i}`,
      symbol: '¤',
      minorUnits: 2,
    }));
    const html = render(props('p2p', view('p2p', [okOutcome('p2p', 'p2p.fiat', fiat)])));
    const block = html.slice(html.indexOf('data-testid="read-p2p.fiat"'));
    expect(block).toContain('119 rows');
    expect(block).toContain('data-testid="export-csv"');
    expect(block).toMatch(/<details data-testid="list-collapsed"><summary>Show all 119 rows<\/summary>/);
    expect(block.indexOf('export-csv')).toBeLessThan(block.indexOf('<table'));
    expect(block).toContain('Currency 118');
  });
  it('leaves work lists such as disputes and offers open', () => {
    for (const spec of allReads(DESKS.p2p)) if (spec.id !== 'p2p.fiat') expect(spec.collapsed, spec.id).toBeUndefined();
  });
});

describe('academy and more desks', () => {
  it('academy reads its grants and enrolments, and links each section to a page of its own', () => {
    const html = render(props('academy', view('academy', [])));
    expect(html).not.toContain('Not available:');
    expect(html).toContain('Certificate grants');
    expect(html).toContain('href="/academy-ops/grants"');
    const page = render({ ...props('academy', view('academy', [])), spec: academySectionDesk('grants') });
    expect(page).toContain('aria-current="page"');
    expect(page).not.toContain('Ambassadors and residencies');
  });
  it('more names mining and campaigns as not available, links the launch issuer lens, and Predict as waiting on a decision', () => {
    const html = render(props('more', view('more', [])));
    expect(html).toContain('Not available: Payouts made and hashrate of the pool');
    // svc-token keeps the issuers now (J-more-catalogue-14): the launch section links its lens instead of naming a gap.
    expect(html).not.toContain('Not available: Issuer state');
    expect(html).toContain('href="/launch"');
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
    expect(freezeHtml).toMatch(/id="[^"]*dk-reason"/);
    const liftHtml = renderToStaticMarkup(<AmbassadorActions row={rowOf(frozen)} userId={ME} onChanged={() => undefined} />);
    expect(liftHtml).toContain('UNFREEZE AMBASSADOR 9f8e7d6c');
    expect(liftHtml).not.toMatch(/id="[^"]*dk-reason"/);
  });
});

describe('Export CSV on every list read', () => {
  it('a list with rows offers an export of exactly the rows shown, and says so', () => {
    const html = render(props('bank', view('bank', [okOutcome('bank', 'bank.pools', [POOL, { ...POOL, id: 'pool-2' }])])));
    expect(html).toContain('data-testid="export-csv"');
    expect(html).toContain('Export CSV (2 rows shown)');
    expect(html).toContain('Exports the 2 rows shown above (not a full table export), as read at 17 Oct 2026, 03:00:00 UTC.');
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
            c.mustBe !== undefined
              ? c.mustBe
              : c.kind === 'int' || c.kind === 'bps'
                ? 1
                : c.kind === 'bool'
                  ? true
                  : c.kind === 'time'
                    ? AT
                    : c.kind === 'list'
                      ? ['a']
                      : c.kind === 'assetAmounts'
                        ? [{ assetId: 'USDC', amount: '1' }]
                        : 'x';
        }
        const raw = spec.rowsKey ? { [spec.rowsKey]: [sample], ...(spec.cursorKey ? { [spec.cursorKey]: null } : {}) } : [sample];
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
              'Your console session does not have token read permission: svc-token did not accept your founder session for this read (it needs token:read).',
          }),
          okOutcome('more', 'token.epoch', { epoch: 3 }),
        ]),
      ),
    );
    expect(html).toContain('Could not load burned supply');
    expect(html).toContain('Your console session does not have token read permission');
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
    expect(html).not.toMatch(/id="[^"]*dk-reason"/);
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

describe('operator reads wired onto the desks', () => {
  const ASSET_TOTALS = [
    { assetId: 'USDC', amount: '1000' },
    { assetId: 'BTC', amount: '0.5' },
  ];
  const LOAN_BOOK = {
    asOf: AT,
    openCount: 4,
    outstandingPrincipal: ASSET_TOTALS,
    bands: { healthy: 2, marginCall: 1, liquidation: 0, unpriced: 1 },
    unpriced: [{ loanId: 'loan-9', reason: 'bank.loan_health_price_unset' }],
    oldestPending: { id: 'loan-3', ageSeconds: 90 },
  };
  it('bank: the loan book shows its counts, the principal per asset, the unpriced loan with its reason in words, and the time read', () => {
    const html = render(
      props(
        'bank',
        view('bank', [
          okOutcome('bank', 'bank.loan-book', LOAN_BOOK),
          okOutcome('bank', 'bank.loans-unpriced', LOAN_BOOK),
          okOutcome('bank', 'bank.pool-totals', {
            asOf: AT,
            pools: [
              {
                poolId: 'pool-2',
                assetId: 'BTC',
                amountHeld: null,
                amountReason: 'ledger_unavailable',
                depositorCount: 2,
                utilisation: null,
                utilisationReason: 'utilisation_not_recorded',
              },
            ],
          }),
        ]),
      ),
    );
    expect(html).toContain('1000 USDC, 0.5 BTC');
    expect(html).toContain('Without a usable price');
    expect(html).toContain('loan-9');
    expect(html).toContain('Loan health price unset');
    expect(html).toContain('The ledger could not be read');
    expect(html).toContain('Not recorded by svc-bank');
    // The pool whose ledger could not be read has a dash for the figure, never 0.
    expect(html).toMatch(/<td>—<\/td>/);
    expect(html).toContain('3 of 3 reads answered');
    expect(html).toContain('As of 03:00:00 UTC');
  });
  it('bank: the card freeze control is on the cards section, asks for a card id first, and is not a disabled placeholder', () => {
    const html = render(props('bank', view('bank', [])));
    expect(html).toContain('data-testid="card-status-action"');
    expect(html).toContain('Enter the card id above first');
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>Freeze a card<\/button>/);
  });
  it('the card freeze names the card in the phrase to type, and says the owner cannot undo it', () => {
    const html = renderToStaticMarkup(<CardStatusAction userId={ME} onChanged={() => undefined} />);
    expect(html).toContain('Freeze or unfreeze a card');
    expect(html).toContain('its owner cannot unfreeze it');
    expect(html).toContain('the reason is recorded with the freeze but is not part of what they sign');
  });
  it('lifting a freeze warns that it lifts any freeze, including one the owner set, and is a danger action', () => {
    expect(CARD_COPY.active.danger).toBe(true);
    expect(CARD_COPY.active.consequence).toContain('the owner set themselves');
    expect(CARD_COPY.active.consequence).toContain('check with the owner first');
  });
  const DISPUTE = {
    id: '5a3b9c10-1111-4222-8333-444455556666',
    tradeId: '6b4c0d21-1111-4222-8333-444455556666',
    openedBy: ME,
    openedVia: 'party',
    reason: 'seller never released',
    chatThreadId: null,
    status: 'open',
    moderatorId: null,
    resolution: null,
    resolutionNotes: null,
    deadlineAt: AT,
    openedAt: AT,
    resolvedAt: null,
    evidence: [],
    overdue: true,
    escalatedAt: null,
    escalations: 0,
    escalatedBy: null,
    escalationReason: null,
    fourEyes: null,
    lastSeenByModeratorAt: null,
  };
  const disputeRow = (over: Record<string, unknown> = {}): Row => {
    const o = okOutcome('p2p', 'p2p.disputes', { disputes: [{ ...DISPUTE, ...over }], nextCursor: null });
    if (o.part.kind !== 'ok' || o.part.data.shape !== 'list') throw new Error('list expected');
    return o.part.data.rows[0]!;
  };
  it('p2p: an open dispute row opens to the escalation form, with the reason box, and no ruling', () => {
    const o = okOutcome('p2p', 'p2p.disputes', { disputes: [DISPUTE], nextCursor: null });
    const html = render(props('p2p', view('p2p', [o]), { openKey: `p2p.disputes:${DISPUTE.tradeId}` }));
    expect(html).toContain('data-testid="dispute-actions"');
    expect(html).toContain('Escalate this dispute');
    expect(html).toContain('asks for no second');
    expect(html).toContain('No money moves');
    // The form itself offers an escalation and nothing else: no ruling button inside it.
    const form = renderToStaticMarkup(<DisputeActions row={disputeRow()} userId={ME} onChanged={() => undefined} />);
    expect(form).toContain('Escalate this dispute');
    expect(form).not.toMatch(/Release|Refund/);
  });
  it('p2p: a resolved dispute offers nothing to escalate', () => {
    const html = renderToStaticMarkup(<DisputeActions row={disputeRow({ status: 'resolved' })} userId={ME} onChanged={() => undefined} />);
    expect(html).toContain('dispute-no-action');
    expect(html).not.toContain('<form');
  });
  it('p2p: the offers, trades and counts blocks name what the service gave and print blanks as blanks', () => {
    const html = render(
      props(
        'p2p',
        view('p2p', [
          okOutcome('p2p', 'p2p.counts', {
            offers: { active: 2, paused: 0, closed: 5 },
            trades: { created: 1, escrowed: 0, fiat_sent: 0, released: 9, cancelled: 3, disputed: 1 },
          }),
          okOutcome('p2p', 'p2p.dispute-rate', { disputesOpened24h: 0, tradesCreated24h: 0, rate: null }),
        ]),
      ),
    );
    expect(html).toMatch(/<dt>Offers open<\/dt><dd>2<\/dd>/);
    expect(html).toMatch(/<dt>Trades released<\/dt><dd>9<\/dd>/);
    expect(html).toMatch(/<dt>Disputes out of trades<\/dt><dd>—<\/dd>/);
  });
  const LISTING = {
    id: '5a3b9c10-1111-4222-8333-444455556666',
    vendorId: '9f8e7d6c-1111-4222-8333-444455556666',
    title: 'Chart pack',
    description: 'd',
    offerType: 'one_time',
    price: '9.99',
    assetId: 'USDC',
    status: 'active',
    periodSeconds: null,
    createdAt: AT,
  };
  const listingRow = (over: Record<string, unknown> = {}): Row => {
    const o = okOutcome('more', 'market.listings', [{ ...LISTING, ...over }]);
    if (o.part.kind !== 'ok' || o.part.data.shape !== 'list') throw new Error('list expected');
    return o.part.data.rows[0]!;
  };
  it('market: an active listing opens to the takedown request, which says it is permanent and signs the reason', () => {
    const html = renderToStaticMarkup(<ListingActions row={listingRow()} userId={ME} onChanged={() => undefined} />);
    expect(html).toContain('TAKE DOWN LISTING 5a3b9c10');
    expect(html).toContain('leaves the market for good');
    expect(html).toContain('nothing is refunded');
    expect(html).toContain('signed by the approver');
  });
  it('market: a listing that is not on sale has no takedown to ask for', () => {
    const html = renderToStaticMarkup(<ListingActions row={listingRow({ status: 'archived' })} userId={ME} onChanged={() => undefined} />);
    expect(html).toContain('listing-no-action');
  });
  it('more: mining and sales sit on the desk, and nothing about them claims a payout or a hashrate', () => {
    const html = render(props('more', view('more', [])));
    expect(html).toContain('data-testid="read-mining.windows"');
    expect(html).toContain('data-testid="read-market.sales"');
    expect(html).toContain('Not available: Payouts made and hashrate of the pool');
  });
});

describe('Personal Pay desk', () => {
  const EXEC = '5a3b9c10-1111-4222-8333-444455556666';
  const FAILED = {
    id: EXEC,
    kind: 'standing_order',
    amount: '25.50',
    assetId: 'USDC',
    status: 'rejected',
    rejectionCode: 'bank.recipient_cannot_receive',
    reason: 'This recipient cannot receive payments',
    attemptedAt: AT,
    sender: { handle: 'alice', reason: null },
    receiver: { handle: null, reason: 'handle_unresolved' },
  };
  const HEALTH = {
    asOf: AT,
    standingOrders: { pending: 0, settled: 0, rejected: 0, skipped: 0, total: 0, failureRate: null, oldestPendingAgeSeconds: null },
    oneOff: {
      available: true,
      reserved: 0,
      posted: 0,
      total: 0,
      failureRate: null,
      failureRateReason: 'failures_not_recorded',
      oldestPendingAgeSeconds: null,
    },
    p2p: { available: false, reason: 'served_by_p2p_ops' },
    bills: {
      available: true,
      submitted: 0,
      accepted: 0,
      paid: 0,
      failed: 0,
      returned: 0,
      total: 0,
      failureRate: null,
      oldestPendingAgeSeconds: null,
    },
  };
  it('puts the lists first, then the metrics, then the actions', () => {
    const html = render(props('pay', view('pay', [])));
    const order = ['section-failures', 'section-bills', 'section-global', 'section-health', 'section-actions'].map((id) =>
      html.indexOf(`data-testid="${id}"`),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
  it('a rejected standing order shows its reason and the dash for a name the directory could not give, with why', () => {
    const html = render(props('pay', view('pay', [okOutcome('pay', 'pay.failed-standing', { items: [FAILED], nextCursor: null })])));
    expect(html).toContain('This recipient cannot receive payments');
    expect(html).toContain('25.50');
    expect(html).toContain('The directory could not name this person');
    expect(html).toContain('As of 03:00:00 UTC');
  });
  it('an open row offers to read the full record on request; it is not read with the page', () => {
    const outcome = okOutcome('pay', 'pay.failed-standing', { items: [FAILED], nextCursor: null });
    const closed = render(props('pay', view('pay', [outcome])));
    expect(closed).not.toContain('data-testid="transfer-detail"');
    const open = render(props('pay', view('pay', [outcome]), { openKey: `pay.failed-standing:${EXEC}` }));
    expect(open).toContain('data-testid="transfer-detail"');
    expect(open).toContain('Read the full transfer record');
    expect(open).toContain('logs your account and this id');
  });
  it('an empty window shows dashes with their reason, never a zero rate; one-off failures say they are not recorded', () => {
    const html = render(
      props(
        'pay',
        view('pay', [
          okOutcome('pay', 'pay.standing-24h', HEALTH),
          okOutcome('pay', 'pay.oneoff-24h', HEALTH),
          okOutcome('pay', 'pay.p2p-pointer', HEALTH),
        ]),
      ),
    );
    expect(html).toMatch(/<dt>Rejected out of attempts<\/dt><dd>—<\/dd>/);
    expect(html).toMatch(/<dt>Failed out of created<\/dt><dd>—<\/dd>/);
    expect(html).toContain('svc-bank does not record a refused one-off send, so it has no failure figure');
    expect(html).toContain('Counted on the P2P desk; svc-bank gives no P2P figure');
    expect(html).toContain('Computed by svc-bank at');
    expect(html).toContain('Standing orders attempted, last 24 hours');
  });
  it('a refused read says which permission it needs, and its neighbours still render', () => {
    const html = render(
      props(
        'pay',
        view('pay', [
          failed('pay.failed-standing', {
            forbidden: true,
            code: 'forbidden',
            message:
              'svc-bank did not accept your founder session for this read (it needs the operator permission admin:compliance on an interactive sign-in; admin:read alone is refused).',
          }),
          okOutcome('pay', 'pay.standing-24h', HEALTH),
        ]),
      ),
    );
    expect(html).toContain('Could not load the rejected standing orders');
    expect(html).toContain('admin:compliance');
    expect(html).toContain('Standing orders attempted, last 24 hours');
  });
  it('a typed refusal is shown in its own sentence', () => {
    const sentence = DESKS.pay.sections[0]!.reads[0]!.refusals!['bank.party_handles_unset']!;
    const html = render(
      props('pay', view('pay', [failed('pay.failed-standing', { code: 'bank.party_handles_unset', message: sentence })])),
    );
    expect(html).toContain('IDENTITY_URL');
    expect(html).toContain('refuses the whole list rather than show rows without names');
  });
  it('every figure it cannot give is named as not available with its reason and need number', () => {
    const html = render(props('pay', view('pay', [])));
    expect(html).toContain('Not available: Failed one-off sends');
    expect(html).toContain('Back-end need 40');
    expect(html).toContain('Not available: List of pending standing-order executions and reserved one-off sends');
    expect(html).toContain('Back-end need 41');
    expect(html).toContain('Not available: Global sends in the transfer-health windows');
    expect(html).toContain('Back-end need 43');
  });
  it('shows no enabled action: the four are real disabled buttons with the reason beside them', () => {
    const html = render(props('pay', view('pay', [])));
    for (const label of [
      'Cancel, pause or resume a standing order',
      'Retry one rejected standing-order execution',
      'Reverse or release a one-off send',
      'Retry, refund or return a bill payment',
    ]) {
      expect(html).toMatch(new RegExp(`<button[^>]*disabled[^>]*>${label}</button>`));
    }
    expect(html).toContain('only lets the owner of a standing order cancel');
    expect(html).toContain('href="/tools"');
  });
  it('a list with a next page offers “Next 50” and says more exist; the last page says that is all', () => {
    const more = render(props('pay', view('pay', [okOutcome('pay', 'pay.failed-standing', { items: [FAILED], nextCursor: 'abc_-1' })])));
    expect(more).toContain('data-testid="next-page"');
    expect(more).toContain('Next 50');
    expect(more).toContain('more rows exist');
    const last = render(props('pay', view('pay', [okOutcome('pay', 'pay.failed-standing', { items: [FAILED], nextCursor: null })])));
    expect(last).not.toContain('data-testid="next-page"');
    expect(last).toContain('that is all of them');
  });
  it('the global list has no page marker, so exactly 50 rows are described as “may exist”', () => {
    const send = {
      id: EXEC,
      userId: 'u',
      fromSpaceId: 's',
      assetId: 'USDC',
      amount: '1',
      toCurrency: 'EUR',
      recipientId: 'r',
      country: 'DE',
      deliveryMethod: 'bank',
      status: 'failed',
      failureCode: null,
      failureBlocker: null,
      providerRef: null,
      quoteRate: null,
      quoteFee: null,
      quoteFeeAsset: null,
      quoteReceive: null,
      quoteValidUntil: null,
      quoteEta: null,
      ledgerTxId: null,
      createdAt: AT,
      updatedAt: AT,
    };
    const rows = Array.from({ length: 50 }, (_, i) => ({ ...send, id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` }));
    const html = render(props('pay', view('pay', [okOutcome('pay', 'pay.global-failed', rows)])));
    expect(html).toContain('more may exist');
    expect(html).not.toContain('data-testid="next-page"');
  });
  it('a stuck-transfer age reads as a duration with the window named', () => {
    const html = render(
      props(
        'pay',
        view('pay', [
          okOutcome('pay', 'pay.oneoff-7d', {
            ...HEALTH,
            oneOff: { ...HEALTH.oneOff, reserved: 1, total: 1, oldestPendingAgeSeconds: 604_000 },
          }),
        ]),
      ),
    );
    expect(html).toContain('6 d 23 h');
    expect(html).toContain('older ones are not counted');
  });
  it('has a lookup box for one transfer by id', () => {
    const html = render(props('pay', view('pay', [])));
    expect(html).toContain('data-testid="transfer-lookup"');
    expect(html).toContain('Look up one transfer');
  });
});
