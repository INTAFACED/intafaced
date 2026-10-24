import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FREEZE_CONFIRM_PHRASE, LedgerOpsView, UNFREEZE_CONFIRM_PHRASE, type LedgerOpsViewProps } from './ledger-ops';
import { freezeUnavailable } from '@/lib/ledger-freeze-contract';
const state = {
  frozen: true,
  reason: 'Opaque <script>never execute</script> & Δ',
  actor: 'env:LEDGER_POSTING_ENABLED',
  changedAt: '2026-10-09T16:00:00.000Z',
  version: '2026-10-09 16:00:00.123456+00',
};
const READ_AT = '2026-10-17T03:00:00.000Z';
const base: LedgerOpsViewProps = {
  treasury: { authority: 'treasury', tokenVar: 'ADMIN_TREASURY_TOKEN', configured: true, missing: [] },
  freeze: { ok: true, status: 200, kind: 'reachable', state, detail: null },
  readAt: READ_AT,
  userId: '11111111-1111-4111-8111-111111111111',
  onRead: () => undefined,
};
const render = (x: Partial<LedgerOpsViewProps> = {}) => renderToStaticMarkup(<LedgerOpsView {...base} {...x} />);
const open = { ...state, frozen: false, reason: null, actor: 'reconciliation' };
describe('standing record', () => {
  it('preserves exact opaque bytes, escapes HTML, and labels last change and read time without claiming an original receipt', () => {
    const html = render();
    expect(html).toContain('Opaque &lt;script&gt;never execute&lt;/script&gt; &amp; Δ');
    expect(html).toContain(state.actor);
    expect(html).toContain('9 Oct 2026, 16:00:00 UTC');
    expect(html).toContain('Last change · not read time');
    expect(html).toContain('As of · when this console read the ledger');
    expect(html).toContain(`<time dateTime="${READ_AT}">03:00:00 UTC</time>`);
    expect(html).not.toContain(`>${state.changedAt}<`);
    expect(html).not.toContain(`>${READ_AT}<`);
    expect(html).toContain('Original operation lookup is unavailable');
    expect(html).not.toContain('Service command receipt');
    expect(html).not.toContain('Not applied');
    expect(html).not.toContain('ACCEPTING');
  });
  for (const kind of ['loading', 'unconfigured', 'absent', 'refused', 'unreachable', 'invalid_response'] as const)
    it(`${kind} hides prior reason, actor and timestamp, and no request can be made`, () => {
      const freeze = { ...freezeUnavailable(kind, 'Isolated unavailable read', 'isolated.refusal'), state };
      const html = render({ freeze, readAt: null });
      expect(html).not.toContain(state.actor);
      expect(html).not.toContain(state.changedAt);
      expect(html).not.toContain('posting-record');
      expect(html).not.toContain('never execute');
      expect(html).toContain('GET only');
      expect(html).not.toContain('data-testid="request-form"');
      expect(html).toContain('could not be read');
    });
  it('nullable reason and actor remain explicit and open state is not a live-health claim', () => {
    const html = render({ freeze: { ...base.freeze, state: { ...open, actor: null } } });
    expect(html).toContain('Posting not frozen');
    expect(html).toContain('No actor recorded');
    expect(html).toContain('No reason recorded');
    expect(html).not.toContain('(null)');
    expect(html).not.toContain('value moves');
  });
});

describe('freeze and unfreeze take two founders', () => {
  it('not frozen: offers exactly one request, a freeze, with a reason box and the exact phrase', () => {
    const html = render({ freeze: { ...base.freeze, state: open } });
    expect(html).toContain('data-testid="request-form"');
    expect(html).toContain('Freeze the ledger');
    expect(html).toContain(`<code>${FREEZE_CONFIRM_PHRASE}</code>`);
    expect(html).not.toContain(`<code>${UNFREEZE_CONFIRM_PHRASE}</code> to confirm`);
    expect(html).toContain('Ask a second founder to approve the freeze');
    expect(html).toContain('Two different operators must agree');
    // The request button starts disabled: no reason, nothing typed.
    expect(html).toMatch(/<button type="submit"[^>]*disabled=""[^>]*>Ask a second founder to approve the freeze/);
  });
  it('frozen: offers exactly one request, an unfreeze, with no reason box', () => {
    const html = render();
    expect(html).toContain('Unfreeze the ledger');
    expect(html).toContain(`<code>${UNFREEZE_CONFIRM_PHRASE}</code>`);
    expect(html).not.toMatch(/id="[^"]*dk-reason"/);
    expect(html).toContain('Two different current founders must agree');
  });
  it('a read that returns no version switches the whole control off and says exactly why', () => {
    const { version: _omit, ...withoutVersion } = state;
    const html = render({ freeze: { ...base.freeze, state: withoutVersion } });
    expect(html).toContain('This control is switched off');
    expect(html).toContain('does not return the posting version');
    expect(html).toContain('Unfreeze ledger unavailable');
    expect(html).not.toContain('data-testid="request-form"');
  });
  it('a deployment with no treasury credential switches it off and names the missing variable', () => {
    const html = render({ treasury: { ...base.treasury, configured: false, missing: ['ADMIN_TREASURY_TOKEN'] } });
    expect(html).toContain('This control is switched off');
    expect(html).toContain('ADMIN_TREASURY_TOKEN');
    expect(html).not.toContain('data-testid="request-form"');
  });
  it('the workbench for pasting a request packet is always present, so a pending request can still be rejected or withdrawn', () => {
    const html = render({ treasury: { ...base.treasury, configured: false, missing: ['ADMIN_TREASURY_TOKEN'] } });
    expect(html).toContain('data-testid="approval-workbench"');
  });
});

describe('reconciliation lives in its own section', () => {
  it('the posting desk shows no reconcile figure, button or simulation', () => {
    const html = render();
    expect(html).not.toContain('reconcile-unavailable');
    expect(html).not.toContain('Simulated');
    expect(html).not.toContain('Accounts checked');
    expect(html).not.toContain('<dd>0</dd>');
  });
});

describe('local language seams', () => {
  for (const locale of ['es', 'fr'] as const)
    it(`${locale} uses local copy while keeping wire bytes, and the two-founder workbench stays English`, () => {
      const html = render({ locale });
      expect(html).toContain(`lang="${locale}"`);
      expect(html).toContain(`dateTime="${state.changedAt}"`);
      expect(html).toContain('<div lang="en">');
      expect(html).not.toContain('>Reconciliation</h2>');
    });
});

describe('supplied text language boundaries (SSR component seams, no mounted locale synchronization claim)', () => {
  for (const locale of ['en', 'es', 'fr'] as const)
    it(`${locale} keeps opaque prose/tokens apart from authored null fallbacks`, () => {
      const html = render({ locale, treasury: { ...base.treasury, configured: false, missing: ['EDGE_URL', 'ADMIN_TREASURY_TOKEN'] } });
      expect(html).toContain('<dd lang="und">Opaque &lt;script&gt;never execute&lt;/script&gt; &amp; Δ</dd>');
      expect(html).toContain(`<dd lang="zxx">${state.actor}</dd>`);
      expect(html).toContain(`<dd lang="zxx"><time dateTime="${state.changedAt}">9 Oct 2026, 16:00:00 UTC</time></dd>`);
      expect(html).toContain('<span lang="zxx">EDGE_URL, ADMIN_TREASURY_TOKEN</span>');
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

describe('who made the last change', () => {
  const ACTOR_ID = '3faadae7-1111-4111-8111-1234567f1f3a';
  const withActor = (actor: string, extra: Partial<LedgerOpsViewProps> = {}) =>
    render({ freeze: { ...base.freeze, state: { ...state, actor } }, ...extra });
  it('shows a short labelled reference, never the whole id', () => {
    const html = withActor(ACTOR_ID);
    expect(html).toContain('Account, id ends …1f3a');
    expect(html).not.toContain('3faadae7');
  });
  it('names the founder when the founder directory gave the name, and says You for the signed-in founder', () => {
    expect(withActor(ACTOR_ID, { owners: [{ userId: ACTOR_ID, displayName: 'Phantom' }] })).toContain('<dd>Phantom</dd>');
    expect(withActor(base.userId)).toContain('<dd>You</dd>');
  });
});
