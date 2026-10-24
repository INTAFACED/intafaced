import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ReconciliationControlsView, type ReconciliationControlsViewProps } from './reconciliation-controls';
import { CONTROL_ID, controlView } from '@/lib/ledger/reconciliation-fixtures.test-util';

const BUILTIN = '5b5b5b5b-1111-4222-8333-444455556666';
const builtin = controlView({
  id: BUILTIN,
  builtin: true,
  template: 'ledger_invariant',
  checkKind: { status: 'set', value: 'replay' },
  accountSet: { mode: 'all' },
  threshold: { status: 'unset' },
  explanation: 'Built-in replay check',
  version: 1,
});
const draft = controlView({ state: 'draft', tolerance: { status: 'unset' } });
const PARKED = 'Treasury controls are not configured: ADMIN_TREASURY_TOKEN is missing.';
const base: ReconciliationControlsViewProps = {
  list: { kind: 'ready', controls: [builtin, draft], readAt: '2026-10-24T06:00:00.000Z' },
  selectedId: null,
  onSelect: () => undefined,
  onRead: () => undefined,
  treasuryParked: null,
  userId: '11111111-1111-4111-8111-111111111111',
};
const render = (x: Partial<ReconciliationControlsViewProps> = {}) => renderToStaticMarkup(<ReconciliationControlsView {...base} {...x} />);

describe('the controls list', () => {
  it('shows each control with its state, UTC schedule, blanks as not set, and built-ins marked', () => {
    const html = render();
    expect(html.match(/data-testid="rc-row"/g)).toHaveLength(2);
    expect(html).toContain('Built-in');
    expect(html).toContain('Draft');
    expect(html).toContain('Daily at 06:30 UTC');
    expect(html).toContain('Not set');
    expect(html).toContain('The whole book');
    expect(html).toContain('Every account with asset USDT, matched at each run');
  });
  it('a refused read names the reason and its code, and shows no table', () => {
    const html = render({ list: { kind: 'refused', code: 'scope.denied', status: 403 } });
    expect(html).toContain('data-testid="rc-list-refused"');
    expect(html).toContain('(scope.denied)');
    expect(html).not.toContain('data-testid="rc-table"');
  });
});

describe('parked treasury doors stay on screen with their blocker', () => {
  it('names the missing setting, keeps the define form, and switches off its button and the run', () => {
    const html = render({ treasuryParked: PARKED, selectedId: CONTROL_ID });
    expect(html).toContain('data-testid="rc-treasury-parked"');
    expect(html).toContain(PARKED);
    expect(html).toContain('data-testid="rc-form-define"');
    expect(html).toContain('data-testid="rc-form-update"');
    expect(html).toContain('Parked: this console holds no treasury credential.');
    expect(html).toContain('data-testid="control-blocked"');
    expect(html).toContain('Run control unavailable');
  });
});

describe('the chosen control', () => {
  it('a built-in one cannot be changed, only run', () => {
    const html = render({ selectedId: BUILTIN });
    expect(html).toContain('data-testid="rc-builtin"');
    expect(html).not.toContain('data-testid="rc-form-update"');
    expect(html).toContain('RUN CONTROL 5b5b5b5b');
  });
  it('an active one says how it stays active, with no box that looks like it could deactivate it', () => {
    const html = render({ list: { kind: 'ready', controls: [controlView()], readAt: '2026-10-24T06:00:00.000Z' }, selectedId: CONTROL_ID });
    expect(html).toContain('data-testid="rc-active-note"');
    expect(html).not.toContain('Keep it active');
  });
  it('a refused re-read keeps the earlier list on screen and says so', () => {
    const html = render({
      list: {
        kind: 'ready',
        controls: [builtin],
        readAt: '2026-10-24T06:00:00.000Z',
        stale: { code: 'admin.upstream_unavailable', status: 503 },
      },
    });
    expect(html).toContain('data-testid="rc-list-stale"');
    expect(html).toContain('data-testid="rc-table"');
  });
  it('a draft one can be changed, and its run is held until it is active', () => {
    const html = render({ selectedId: CONTROL_ID });
    expect(html).toContain('data-testid="rc-form-update"');
    expect(html).toContain('ops.control_state_illegal');
  });
});
