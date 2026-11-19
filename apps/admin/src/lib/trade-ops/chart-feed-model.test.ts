import { describe, expect, it } from 'vitest';
import {
  actionOf,
  CHART_CONTROL_COLUMNS,
  chartControlRows,
  parseChartFeedControlsView,
  parseChartFeedPrepared,
  type ChartFeedControlRow,
} from './chart-feed-model';
import { toCsv } from './csv';

const row: ChartFeedControlRow = {
  id: '1',
  symbol: 'BTC/USDT',
  action: 'switch_source',
  fromSource: 'primary',
  toSource: 'test-backup',
  fromState: 'on',
  toState: 'on',
  version: '1',
  reason: 'TEST: primary tape gap',
  proposerId: 'op-a',
  approverId: 'op-b',
  executorId: 'op-a',
  approvalId: 'ap-1',
  at: '2026-11-19T02:00:00.000Z',
};

describe('chart feed model', () => {
  it('parses the view; a blank fallback list stays null, never a default', () => {
    const view = parseChartFeedControlsView({
      asOf: '2026-11-19T02:00:00.000Z',
      fallbackSources: null,
      exportRowLimit: null,
      canWrite: true,
      markets: [{ symbol: 'BTC/USDT', test: false, source: 'primary', state: 'on', version: '0', delistedAt: null, updatedAt: null }],
      journal: [row],
    });
    expect(view?.fallbackSources).toBeNull();
    expect(view?.journal[0]?.approverId).toBe('op-b');
    expect(
      parseChartFeedControlsView({
        asOf: 'x',
        canWrite: true,
        fallbackSources: null,
        exportRowLimit: null,
        markets: [{ state: 'off' }],
        journal: [],
      }),
    ).toBeNull();
  });

  it('parses a prepared change only with a real payload hash', () => {
    const base = {
      symbol: 'BTC/USDT',
      action: { kind: 'disable' },
      expectedVersion: '0',
      reason: 'TEST reason',
      from: { source: 'primary', state: 'on' },
      to: { source: 'primary', state: 'disabled' },
    };
    expect(parseChartFeedPrepared({ ...base, payloadHash: `sha256:${'a'.repeat(64)}` })?.to.state).toBe('disabled');
    expect(parseChartFeedPrepared({ ...base, payloadHash: 'sha256:short' })).toBeNull();
  });

  it('builds an action from the form: a source only on a switch', () => {
    expect(actionOf('switch_source', ' test-backup ')).toEqual({ kind: 'switch_source', to: 'test-backup' });
    expect(actionOf('switch_source', '')).toBeNull();
    expect(actionOf('disable', 'ignored')).toEqual({ kind: 'disable' });
    expect(actionOf('halt', null)).toBeNull();
  });

  it('writes every change into the file with who proposed, approved and applied it, and when', () => {
    const csv = toCsv(CHART_CONTROL_COLUMNS, chartControlRows([row]));
    const [header, line] = csv.trim().split('\r\n');
    expect(header).toBe(
      'time,symbol,action,from_source,to_source,from_state,to_state,reason,proposed_by,approved_by,applied_by,approval_id,version',
    );
    expect(line).toBe(
      '2026-11-19T02:00:00.000Z,BTC/USDT,switch_source,primary,test-backup,on,on,TEST: primary tape gap,op-a,op-b,op-a,ap-1,1',
    );
  });
});
