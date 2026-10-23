import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ModuleKillDesk, type ModuleKillDeskProps } from './module-kill-desk';

const empty = { disabledModules: [], reasons: {}, audit: [] } as const;
const killed = {
  disabledModules: ['trade'],
  reasons: { trade: 'market integrity incident' },
  audit: [
    {
      at: '2026-10-17T02:00:00.000Z',
      module: 'trade',
      actor: 'console-operator',
      confirmOperatorId: 'checker-founder',
      reason: 'market integrity incident',
      previous: false,
      next: true,
      changed: true,
    },
  ],
} as const;
const base: ModuleKillDeskProps = {
  module: 'trade',
  snapshot: empty as never,
  readAt: '2026-10-17T03:00:00.000Z',
  loading: false,
  writesBlocked: null,
  userId: '11111111-1111-4111-8111-111111111111',
  onReload: () => undefined,
};
const render = (over: Partial<ModuleKillDeskProps> = {}) => renderToStaticMarkup(<ModuleKillDesk {...base} {...over} />);

describe('the current-state badge', () => {
  it('running: says it is not listed as killed, and as of when this console read the edge', () => {
    const html = render();
    expect(html).toContain('data-state="running"');
    expect(html).toContain('trade is not listed as killed at the edge');
    expect(html).toContain('As of 03:00:00 UTC');
  });
  it('killed: says so, with the recorded reason and the last change with both people', () => {
    const html = render({ snapshot: killed as never });
    expect(html).toContain('data-state="stopped"');
    expect(html).toContain('trade is KILLED at the edge');
    expect(html).toContain('Recorded reason: market integrity incident');
    expect(html).toContain('console-operator');
    expect(html).toContain('run with the console credential console-operator');
    expect(html).toContain('approved by checker-founder');
    expect(html).toContain('the requester is on the approval record');
  });
  it('no usable read: unknown, never running', () => {
    const html = render({ snapshot: null, readAt: null });
    expect(html).toContain('data-state="unknown"');
    expect(html).not.toContain('data-state="running"');
    expect(html).toContain('No successful read yet');
    expect(html).toContain('could not be read');
    expect(html).not.toContain('data-testid="request-form"');
  });
  it('while reading, it says it is reading', () => {
    expect(render({ snapshot: null, readAt: null, loading: true })).toContain('Reading the edge…');
  });
});

describe('the one request that makes sense', () => {
  it('running: offers a kill, with a reason box and the exact phrase', () => {
    const html = render();
    expect(html).toContain('Kill trade');
    expect(html).toContain('<code>KILL trade</code>');
    expect(html).toMatch(/id="[^"]*dk-reason"/);
    expect(html).toContain('Ask a second founder to approve the kill');
    expect(html).toContain('Two different operators must agree');
  });
  it('killed: offers the way back, re-enable, with its own phrase', () => {
    const html = render({ snapshot: killed as never });
    expect(html).toContain('Re-enable trade');
    expect(html).toContain('<code>RE-ENABLE trade</code>');
    expect(html).toContain('Ask a second founder to approve re-enabling');
    expect(html).not.toContain('<code>KILL trade</code>');
  });
  it('the request button starts shut', () => {
    expect(render()).toMatch(/<button type="submit"[^>]*disabled=""/);
  });
});

describe('refusals before any request', () => {
  it('identity is never offered: the console would strand itself', () => {
    const html = render({ module: 'identity' });
    expect(html).toContain('This control is switched off');
    expect(html).toContain('Killing it would stop you from approving the re-enable');
    expect(html).not.toContain('data-testid="request-form"');
  });
  it('a module the edge cannot enforce is not offered', () => {
    const html = render({ module: 'ws' });
    expect(html).toContain('This control is switched off');
    expect(html).toContain('would refuse nothing');
    expect(html).not.toContain('data-testid="request-form"');
  });
  it('a deployment with no operator credential shows the reason and the old disabled button', () => {
    const html = render({ writesBlocked: 'ADMIN_OPERATOR_TOKEN is not set' });
    expect(html).toContain('ADMIN_OPERATOR_TOKEN is not set');
    expect(html).toContain('Kill / re-enable unavailable');
    expect(html).not.toContain('data-testid="request-form"');
  });
  it('the packet workbench stays so a pending request can still be rejected or withdrawn', () => {
    for (const over of [{ module: 'identity' as const }, { writesBlocked: 'x' }, { snapshot: null }])
      expect(render(over)).toContain('data-testid="approval-workbench"');
  });
});
