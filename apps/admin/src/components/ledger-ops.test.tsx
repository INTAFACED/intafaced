import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FREEZE_CONFIRM_PHRASE, LedgerOpsView, UNFREEZE_CONFIRM_PHRASE, type LedgerOpsViewProps } from './ledger-ops';
import { freezeUnavailable } from '@/lib/ledger-freeze-contract';
const state = {
  frozen: true,
  reason: 'Opaque <script>never execute</script> & Δ',
  actor: 'env:LEDGER_POSTING_ENABLED',
  changedAt: '2026-10-09T16:00:00.000Z',
};
const base: LedgerOpsViewProps = {
  treasury: { authority: 'treasury', tokenVar: 'ADMIN_TREASURY_TOKEN', configured: true, missing: [] },
  freeze: { ok: true, status: 200, kind: 'reachable', state, detail: null },
  reconcile: null,
  onRead: () => undefined,
  onReconcile: () => undefined,
};
const render = (x: Partial<LedgerOpsViewProps> = {}) => renderToStaticMarkup(<LedgerOpsView {...base} {...x} />);
describe('standing record and unavailable actions', () => {
  it('preserves exact opaque bytes, escapes HTML, and labels last change without claiming original receipt', () => {
    const html = render();
    expect(html).toContain('Opaque &lt;script&gt;never execute&lt;/script&gt; &amp; Δ');
    expect(html).toContain(state.actor);
    expect(html).toContain(state.changedAt);
    expect(html).toContain('Last change · not read time');
    expect(html).toContain('Original operation lookup is unavailable');
    expect(html).not.toContain('Service command receipt');
    expect(html).not.toContain('Not applied');
    expect(html).not.toContain('ACCEPTING');
  });
  it('transport and valid read never enable either write; both exact phrases and acknowledgements remain inspectable', () => {
    const html = render();
    expect(html).toContain(`disabled="" aria-describedby="lo-command-boundary">Freeze ledger</button>`);
    expect(html).toContain(`disabled="" aria-describedby="lo-command-boundary">Unfreeze ledger</button>`);
    expect(html).toContain(FREEZE_CONFIRM_PHRASE);
    expect(html).toContain(UNFREEZE_CONFIRM_PHRASE);
    expect(html).toContain('minimum 12 characters');
    expect(html).toContain('identity-issued approval and original operation guards');
    expect(html).toContain('<details');
    expect(html).toContain('Reconciliation is clean and the cause of the freeze is resolved.');
  });
  for (const kind of ['loading', 'unconfigured', 'absent', 'refused', 'unreachable', 'invalid_response'] as const)
    it(`${kind} hides prior reason, actor and timestamp`, () => {
      const freeze = { ...freezeUnavailable(kind, 'Isolated unavailable read', 'isolated.refusal'), state };
      const html = render({ freeze });
      expect(html).not.toContain(state.actor);
      expect(html).not.toContain(state.changedAt);
      expect(html).not.toContain('posting-record');
      expect(html).not.toContain('never execute');
      expect(html).toContain('GET only');
    });
  it('nullable reason and actor remain explicit and open state is not a live-health claim', () => {
    const html = render({ freeze: { ...base.freeze, state: { ...state, frozen: false, reason: null, actor: null } } });
    expect(html).toContain('Posting not frozen');
    expect(html).toContain('No actor recorded (null)');
    expect(html).toContain('No reason recorded (null)');
    expect(html).not.toContain('value moves');
  });
  it('local reconciliation zeros never become observed book counts or readiness', () => {
    const html = render({
      reconcile: {
        intent: { id: 'reconcile-isolated', at: state.changedAt, detail: 'local', delivered: false },
        simulated: { ok: false, accountsChecked: 0, chainLength: 0, unbalancedAssets: [] },
        simulatedNotice: 'Simulated',
      },
    });
    expect(html).toContain('Not counted');
    expect(html).toContain('Not checked');
    expect(html).toContain('Nothing was sent');
    expect(html).toContain('not the book');
    expect(html).not.toContain('<dd>0</dd>');
  });
  for (const locale of ['es', 'fr'] as const)
    it(`${locale} uses local copy while keeping wire bytes and exact confirmation phrases`, () => {
      const html = render({ locale });
      expect(html).toContain(`lang="${locale}"`);
      expect(html).toContain(state.changedAt);
      expect(html).toContain(FREEZE_CONFIRM_PHRASE);
      expect(html).toContain(UNFREEZE_CONFIRM_PHRASE);
      expect(html).not.toContain('>Freeze ledger</button>');
    });
});

describe('supplied text language boundaries (SSR component seams, no mounted locale synchronization claim)', () => {
  for (const locale of ['en', 'es', 'fr'] as const)
    it(`${locale} keeps opaque prose/tokens apart from authored null fallbacks and fixed English phrases`, () => {
      const html = render({ locale, treasury: { ...base.treasury, configured: false, missing: ['EDGE_URL', 'ADMIN_TREASURY_TOKEN'] } });
      expect(html).toContain('<dd lang="und">Opaque &lt;script&gt;never execute&lt;/script&gt; &amp; Δ</dd>');
      expect(html).toContain(`<dd lang="zxx">${state.actor}</dd>`);
      expect(html).toContain(`<dd lang="zxx"><time dateTime="${state.changedAt}">${state.changedAt}</time></dd>`);
      expect(html).toContain('<span lang="zxx">EDGE_URL, ADMIN_TREASURY_TOKEN</span>');
      expect(html).toContain(`<code lang="en">${FREEZE_CONFIRM_PHRASE}</code>`);
      expect(html).toContain(`<code lang="en">${UNFREEZE_CONFIRM_PHRASE}</code>`);
      const nulls = render({ locale, freeze: { ...base.freeze, state: { ...state, frozen: false, reason: null, actor: null } } });
      const dds = [...nulls.matchAll(/<dd([^>]*)>(.*?)<\/dd>/g)];
      expect(dds[0]?.[1]).toBe('');
      expect(dds[1]?.[1]).toBe('');
      expect(nulls).toContain(`lang="${locale}"`);
      const failure = render({
        locale,
        freeze: {
          ok: false,
          status: 403,
          kind: 'refused',
          state: null,
          detail: 'Diagnóstico opaco sin idioma publicado',
          code: 'scope.denied',
        },
      });
      expect(failure).toContain('lang="und">Diagnóstico opaco sin idioma publicado</p>');
      expect(failure).toContain('class="lo-diagnostic" lang="zxx">HTTP 403 · scope.denied</p>');
      const fallback = render({ locale, freeze: { ok: false, status: 403, kind: 'refused', state: null, detail: null } });
      expect(fallback).not.toContain('lang="und"');
    });
});
