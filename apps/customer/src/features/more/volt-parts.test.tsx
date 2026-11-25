import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// Server rendering has no browser store; read the stored preferences once.
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
import { EmptyNote, FailureNote, KitLimit, KitRead, ScrollTable, Section, Waiting } from './volt-parts';
import { formatBpsPercent, Limit } from './catalogue-parts';
import type { ApiResult } from '../../shared/api';

type Refusal = Extract<ApiResult<unknown>, { ok: false }>;
const refusal = (over: Partial<Refusal>): Refusal => ({ ok: false, reason: 'error', message: 'No earn rates are configured', ...over });
const noop = () => undefined;

describe('the More rooms’ kit parts', () => {
  it('words a failure as the old Failure does, with Try again only where it can help', () => {
    const down = renderToStaticMarkup(<FailureNote result={refusal({ reason: 'unreachable', message: 'Down' })} retry={noop} />);
    expect(down).toContain('Try again');
    expect(down).toContain('role="status"');
    expect(renderToStaticMarkup(<FailureNote result={refusal({ code: 'bank.earn_rate_unset' })} retry={noop} />)).not.toContain(
      'Try again',
    );
  });
  it('never calls a write whose outcome is unknown refused', () => {
    const html = renderToStaticMarkup(
      <FailureNote
        result={refusal({ reason: 'uncertain', message: 'trade.matching_unavailable', code: 'trade.matching_unavailable' })}
        retry={noop}
      />,
    );
    expect(html).toContain('Outcome not confirmed');
    expect(html).toContain('role="alert"');
    expect(html).not.toMatch(/refused|trade\.matching|Try again/i);
  });
  it('draws waiting, empty, a section and a table that scrolls in a named region', () => {
    expect(renderToStaticMarkup(<Waiting />)).toContain('Loading');
    expect(renderToStaticMarkup(<EmptyNote title="No drops yet">Later</EmptyNote>)).toContain('lt-empty');
    expect(renderToStaticMarkup(<Section title="Pools">x</Section>)).toBe('<section><h2>Pools</h2>x</section>');
    const table = renderToStaticMarkup(
      <ScrollTable label="Pools" headers={['Name']}>
        <tr>
          <td>A</td>
        </tr>
      </ScrollTable>,
    );
    expect(table).toContain('role="region"');
    expect(table).toContain('aria-label="Pools"');
  });
  it('answers a read with waiting, its failure, empty or the data', () => {
    const child = (data: string[]) => <b>{data.join()}</b>;
    expect(
      renderToStaticMarkup(
        <KitRead resource={{ status: 'loading' }} retry={noop}>
          {child}
        </KitRead>,
      ),
    ).toContain('Loading');
    expect(
      renderToStaticMarkup(
        <KitRead resource={{ status: 'failed', failure: refusal({ reason: 'unreachable', message: 'Down' }) }} retry={noop}>
          {child}
        </KitRead>,
      ),
    ).toContain('Try again');
    expect(
      renderToStaticMarkup(
        <KitRead resource={{ status: 'ready', data: [] }} retry={noop} empty="Nothing here">
          {child}
        </KitRead>,
      ),
    ).toContain('Nothing here');
    expect(
      renderToStaticMarkup(
        <KitRead resource={{ status: 'ready', data: ['a'] }} retry={noop}>
          {child}
        </KitRead>,
      ),
    ).toBe('<b>a</b>');
  });
  it('formats basis points as an exact percentage without float error', () => {
    expect(formatBpsPercent(0)).toBe('0');
    expect(formatBpsPercent(10)).toBe('0.1');
    expect(formatBpsPercent(25)).toBe('0.25');
    expect(formatBpsPercent(100)).toBe('1');
    expect(formatBpsPercent(150)).toBe('1.5');
    expect(formatBpsPercent(-25)).toBe('-0.25');
  });
  it('hides the window counter when fewer rows than the limit are shown', () => {
    expect(renderToStaticMarkup(<Limit count={0} limit={50} cap={200} onChange={noop} />)).toBe('');
    expect(renderToStaticMarkup(<KitLimit count={12} limit={50} cap={200} onChange={noop} />)).toBe('');
    const full = renderToStaticMarkup(<Limit count={50} limit={50} cap={200} onChange={noop} />);
    expect(full).toContain('Show more');
  });
});
