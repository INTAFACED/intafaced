import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { confirmationPhrase, OperatorToolsView, type OperatorToolsViewProps } from './operator-tools-board';
import type { ToolListItem, ToolListResponse } from '@/lib/operator-tools-browser';

const notWiredKyc: ToolListItem = {
  id: 'identity.kyc.pending',
  group: 'identity',
  label: 'KYC pending queue',
  summary: 'List KYC records waiting for an operator decision.',
  procedure: 'kyc.pending',
  edgeModule: 'identity',
  kind: 'query',
  authority: 'module',
  scope: 'admin:compliance',
  consequential: false,
  fields: [],
  wire: 'not-wired',
  missing: ['EDGE_URL', 'ADMIN_OPERATOR_TOKEN'],
  detail: 'This console cannot halt a module — EDGE_URL and ADMIN_OPERATOR_TOKEN are not set on this app.',
};

const catalog: ToolListResponse = {
  edgeUrl: null,
  moduleConfigured: false,
  treasuryConfigured: false,
  tools: [notWiredKyc],
  residual: {
    reconcile: 'not available — svc-edge has no reconcile route; /ledger says so and shows no figures',
    sso: 'Class X — console has no operator SSO',
  },
};

function base(over: Partial<OperatorToolsViewProps> = {}): OperatorToolsViewProps {
  return {
    catalog,
    selected: notWiredKyc,
    fieldValues: {},
    acknowledged: false,
    typedConfirmation: '',
    result: null,
    pending: false,
    lockedToolId: null,
    wiredCount: 0,
    notWiredCount: 1,
    queueAction: null,
    onSelect: () => undefined,
    onField: () => undefined,
    onAcknowledge: () => undefined,
    onConfirmation: () => undefined,
    onRun: () => undefined,
    onRefresh: () => undefined,
    ...over,
  };
}

describe('OperatorToolsView honesty', () => {
  it('renders not-wired banner and names missing vars', () => {
    const html = renderToStaticMarkup(<OperatorToolsView {...base()} />);
    expect(html).toContain('not-wired');
    expect(html).toContain('EDGE_URL');
    expect(html).toContain('ADMIN_OPERATOR_TOKEN');
    expect(html).toContain('tool-not-wired');
    expect(html).toMatch(/Disabled —/);
  });

  it('shows residual reconcile as not available', () => {
    const html = renderToStaticMarkup(<OperatorToolsView {...base()} />);
    expect(html).toMatch(/not available/i);
    expect(html).toMatch(/reconcile/i);
  });

  it('does not describe a refused query as an applied mutation', () => {
    const html = renderToStaticMarkup(
      <OperatorToolsView
        {...base()}
        result={{
          ok: false,
          status: 503,
          detail: 'EDGE_URL is not set',
          delivered: false,
          data: { wire: 'not-wired' },
          toolId: 'identity.kyc.pending',
          procedure: 'kyc.pending',
          edgePath: '/api/identity/trpc/kyc.pending',
        }}
      />,
    );
    expect(html).toContain('Query was not answered');
    expect(html).toContain('not delivered');
    expect(html).toContain('Query receipt — refused / failed');
    expect(html.slice(html.indexOf('Query receipt'))).not.toMatch(/applied/i);
  });

  it('shows users, orders, and finance queues without inventing withdrawal approval', () => {
    const html = renderToStaticMarkup(<OperatorToolsView {...base()} />);
    expect(html).toContain('Operator tools');
    expect(html).not.toContain('Withdrawal approvals');
  });

  it('labels a row-scoped consequential review with its displayed source version', () => {
    const consequential: ToolListItem = {
      ...notWiredKyc,
      id: 'identity.kyc.approve',
      label: 'KYC approve',
      procedure: 'kyc.approve',
      kind: 'mutation',
      consequential: true,
      wire: 'wired',
      missing: [],
      detail: null,
    };
    const html = renderToStaticMarkup(
      <OperatorToolsView
        {...base({
          catalog: { ...catalog, tools: [consequential] },
          selected: consequential,
          queueAction: {
            recordId: '11111111-1111-4111-8111-111111111111',
            status: 'pending',
            version: '2026-08-31T12:00:00.000Z',
          },
        })}
      />,
    );
    expect(html).toContain('queue-action-context');
    expect(html).toContain('11111111-1111-4111-8111-111111111111');
    expect(html).toContain('2026-08-31T12:00:00.000Z');
    expect(html).toContain('no optimistic version parameter');
  });

  it('requires an exact typed phrase for consequential commands', () => {
    const consequential: ToolListItem = {
      ...notWiredKyc,
      id: 'bank.ops.runDueTransfers',
      group: 'bank',
      label: 'Run due standing transfers',
      procedure: 'ops.runDueTransfers',
      kind: 'mutation',
      authority: 'treasury',
      scope: 'admin:treasury',
      consequential: true,
      wire: 'wired',
      missing: [],
      detail: null,
    };
    const wiredCatalog = { ...catalog, edgeUrl: 'http://edge.test', treasuryConfigured: true, tools: [consequential] };
    const phrase = confirmationPhrase(consequential);
    const blocked = renderToStaticMarkup(
      <OperatorToolsView {...base({ catalog: wiredCatalog, selected: consequential, acknowledged: true })} />,
    );
    const ready = renderToStaticMarkup(
      <OperatorToolsView {...base({ catalog: wiredCatalog, selected: consequential, acknowledged: true, typedConfirmation: phrase })} />,
    );
    expect(blocked).toContain(phrase);
    expect(blocked).toMatch(/adm-btn adm-btn--primary" disabled/);
    expect(ready).not.toMatch(/adm-btn adm-btn--primary" disabled/);
  });

  it('renders a transport-backed query receipt as answered and preserves the pending lock', () => {
    const html = renderToStaticMarkup(
      <OperatorToolsView
        {...base({
          pending: true,
          lockedToolId: notWiredKyc.id,
          result: {
            ok: true,
            status: 200,
            detail: null,
            delivered: true,
            data: { accepted: true },
            toolId: notWiredKyc.id,
            procedure: notWiredKyc.procedure,
            edgePath: '/api/identity/trpc/kyc.pending',
          },
        })}
      />,
    );
    expect(html).toContain('Query receipt');
    expect(html).toContain('>answered<');
    expect(html).toContain('delivery-receipt');
    expect(html).toContain('HTTP 200 · delivered');
    expect(html).toContain('Locked — awaiting edge…');
    expect(html.slice(html.indexOf('Query receipt'))).not.toMatch(/applied/i);
  });
});
