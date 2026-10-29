import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ReconciliationControlsView, RunHistoryView, type ReconciliationControlsViewProps } from './reconciliation-controls';
import { CONTROL_ID, controlView, runView } from '@/lib/ledger/reconciliation-fixtures.test-util';

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

describe('pause, resume and retire on screen', () => {
  const list = (state: 'active' | 'paused' | 'retired') => ({
    list: { kind: 'ready' as const, controls: [controlView({ state })], readAt: '2026-10-24T06:00:00.000Z' },
    selectedId: CONTROL_ID,
  });
  it('an active control offers pause and retire, not resume, as a two-founder request', () => {
    const html = render(list('active'));
    expect(html).toContain('data-testid="rc-lifecycle"');
    expect(html).toContain('data-testid="rc-lifecycle-move"');
    expect(html).toContain('<option value="pause" selected="">Pause</option>');
    expect(html).toContain('<option value="retire">Retire</option>');
    expect(html).not.toContain('value="resume"');
    expect(html).toContain('Ask a second founder to approve: pause');
    expect(html).toContain('PAUSE CONTROL');
  });
  it('a paused control says so, offers resume, and its run is held', () => {
    const html = render(list('paused'));
    expect(html).toContain('<td data-testid="rc-state">Paused</td>');
    expect(html).toContain('<option value="resume" selected="">Resume</option>');
    expect(html).toContain('A paused control runs nothing (ops.control_state_illegal). Resume it first.');
  });
  it('a retired control is final: no change form, no lifecycle step, and its run is held', () => {
    const html = render(list('retired'));
    expect(html).toContain('<td data-testid="rc-state">Retired</td>');
    expect(html).toContain('data-testid="rc-retired"');
    expect(html).not.toContain('data-testid="rc-form-update"');
    expect(html).not.toContain('data-testid="rc-lifecycle-move"');
    expect(html).not.toMatch(/(PAUSE|RESUME|RETIRE) CONTROL/);
    expect(html).toContain('A retired control has no pause, resume or retire step (ops.control_state_illegal).');
    expect(html).toContain('A retired control runs nothing');
  });
  it('parked, the step stays on screen and sends nothing', () => {
    const html = render({ ...list('active'), treasuryParked: PARKED });
    expect(html).toContain('data-testid="rc-lifecycle"');
    expect(html).toContain('Pause, resume or retire unavailable');
  });
});

describe("a control's evaluations", () => {
  const retired = controlView({ state: 'retired' });
  const history = (view: Parameters<typeof RunHistoryView>[0]['view']) =>
    renderToStaticMarkup(<RunHistoryView control={retired} view={view} onRead={() => undefined} />);
  it('a retired control still lists every evaluation, newest first, each with its status and evidence', () => {
    const error = runView({
      id: '9a1b2c3d-2222-4222-8333-444455556666',
      status: 'ERROR',
      errorCode: { status: 'set', value: 'ledger.reconcile_source_unavailable' },
      phase: { status: 'set', value: 'outside' },
      assets: [],
      accounts: [],
    });
    const html = history({ kind: 'ready', total: 2, runs: [error, runView()], readAt: '2026-10-24T07:00:00.000Z' });
    expect(html.match(/data-testid="rc-run-row"/g)).toHaveLength(2);
    expect(html.indexOf('data-status="ERROR"')).toBeLessThan(html.indexOf('data-status="PASS"'));
    expect(html).toContain('showing 2 of 2 evaluations');
    expect(html).toContain('Error: ledger.reconcile_source_unavailable at outside.');
    expect(html).toContain('USDT: observed 5, expected unset, difference unset, tolerance 0.');
  });
  it('says how many there are when the page holds fewer, and says so when there are none', () => {
    expect(history({ kind: 'ready', total: 101, runs: [runView()], readAt: '2026-10-24T07:00:00.000Z' })).toContain(
      'showing 1 of 101 evaluations',
    );
    expect(history({ kind: 'ready', total: 0, runs: [], readAt: '2026-10-24T07:00:00.000Z' })).toContain('rc-runs-empty');
  });
  it('a refused read names its code and shows no list', () => {
    const html = history({ kind: 'refused', code: 'scope.denied', status: 403 });
    expect(html).toContain('rc-runs-refused');
    expect(html).toContain('(scope.denied)');
    expect(html).not.toContain('rc-run-row');
  });
  it('shows under the chosen control in every state', () => {
    expect(render({ list: { kind: 'ready', controls: [retired], readAt: '2026-10-24T06:00:00.000Z' }, selectedId: CONTROL_ID })).toContain(
      'data-testid="rc-runs"',
    );
    expect(render()).not.toContain('data-testid="rc-runs"');
  });
});
