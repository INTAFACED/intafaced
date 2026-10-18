import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ComplianceLiveView, type ComplianceViewProps } from './compliance-live';
import type { ComplianceRead, QueueItem } from '@/lib/compliance/model';

const item: QueueItem = { id: 'case-1', kind: 'screening_hit', subjectId: 'user-9', openedAt: '2026-10-17T02:00:00.000Z' };
const read = (over: Partial<ComplianceRead> = {}): ComplianceRead => ({
  asOf: '2026-10-17T03:00:00.000Z',
  status: {
    kind: 'ok',
    data: {
      region: { code: 'XX', regionResolved: false, source: 'default', statusLine: 'region unresolved' },
      geoBlock: {
        allowed: false,
        code: 'refuse',
        reason: 'screening is not configured',
        screeningDeclaration: 'unset',
        screeningConfigured: false,
        listHitCount: null,
        regionResolved: false,
      },
      networkSignal: {
        declaration: 'unset',
        partnerConfigured: false,
        statusLine: 'no partner',
        accessAllowed: false,
        accessCode: 'refuse',
        summary: 'unknown',
      },
      freezeAuthority: { soleKey: 'ledger.posting', note: 'one key' },
    },
  },
  queue: {
    kind: 'ok',
    data: {
      items: [item],
      partnerConfigured: false,
      empty: false,
      summary: 'compliance queue: 1 pending; partner=absent.',
      recentAudit: [],
    },
  },
  ...over,
});
const base: ComplianceViewProps = {
  read: read(),
  loading: false,
  picked: null,
  reason: '',
  confirm: '',
  busy: false,
  reply: null,
  onRead: () => undefined,
  onPick: () => undefined,
  onReason: () => undefined,
  onConfirm: () => undefined,
  onSubmit: () => undefined,
};
const render = (over: Partial<ComplianceViewProps> = {}) => renderToStaticMarkup(<ComplianceLiveView {...base} {...over} />);

describe('live compliance state', () => {
  it('shows the edge’s verdicts with their time, and says the geo verdict is for the console’s own request', () => {
    const html = render();
    expect(html).toContain('As of 03:00:00 UTC');
    expect(html).toContain('Geo-block verdict: refused');
    expect(html).toContain('THIS console’s own request');
    expect(html).toContain('no blocked list is invented');
    expect(html).toContain('Region resolution: NOT resolved');
  });
  it('lists the queue, and says it lives in edge memory and that a decision is one founder’s', () => {
    const html = render();
    expect(html).toContain('case-1');
    expect(html).toContain('lives in the edge’s memory');
    expect(html).toContain('one founder’s decision');
  });
  it('an empty queue shows the edge’s own sentence and no table', () => {
    const html = render({
      read: read({
        queue: {
          kind: 'ok',
          data: {
            items: [],
            partnerConfigured: true,
            empty: true,
            summary: 'compliance queue: EMPTY — partner configured, nothing pending.',
            recentAudit: [],
          },
        },
      }),
    });
    expect(html).toContain('EMPTY');
    expect(html).not.toContain('aria-label="Compliance cases"');
  });
  it('a failed section is a failure with its reason and no data', () => {
    const html = render({
      read: read({ queue: { kind: 'failed', message: 'ADMIN_OPERATOR_TOKEN is missing', code: 'admin.kill_unconfigured' } }),
    });
    expect(html).toContain('Compliance queue unavailable');
    expect(html).toContain('ADMIN_OPERATOR_TOKEN is missing');
    expect(html).not.toContain('Compliance cases');
  });
  it('no read at all says so', () => {
    expect(render({ read: null })).toContain('Nothing is shown rather than a guess');
  });
});

describe('a decision on a case', () => {
  const picked = { item, status: 'cleared' as const };
  const decide = (over: Partial<ComplianceViewProps> = {}) => render({ picked, ...over });
  const submit = (html: string) => /<button type="submit"[^>]*>[^<]*<\/button>/.exec(html)?.[0] ?? '';
  it('is shut until there is a reason and the phrase naming THIS case', () => {
    expect(submit(decide())).toContain('disabled=""');
    expect(submit(decide({ reason: 'reviewed: false positive', confirm: 'CLEAR case-1' }))).not.toContain('disabled');
    expect(submit(decide({ reason: 'reviewed: false positive', confirm: 'CLEAR case-2' }))).toContain('disabled=""');
    expect(submit(decide({ reason: 'reviewed: false positive', confirm: 'REJECT case-1' }))).toContain('disabled=""');
  });
  it('says clearing cannot be undone from here', () => {
    expect(decide()).toContain('cannot be undone from here');
  });
  it('rejecting has its own phrase and a danger button', () => {
    const html = decide({ picked: { item, status: 'rejected' } });
    expect(html).toContain('<code>REJECT case-1</code>');
    expect(html).toContain('data-tone="danger"');
  });
  it('the answer is the edge’s: applied, refused, or not known', () => {
    expect(decide({ reply: { ok: true, itemId: 'case-1', status: 'cleared' } })).toContain('svc-edge confirmed it');
    const unknown = decide({
      reply: { ok: false, refusal: { title: 'The outcome is not known', body: 'b', next: 'n', code: null, changed: 'unknown' } },
    });
    expect(unknown).toContain('data-tone="warn"');
  });
});
